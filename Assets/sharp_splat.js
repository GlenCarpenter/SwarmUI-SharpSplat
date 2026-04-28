/**
 * sharp_splat.js
 * SwarmUI SharpSplat extension — integrates Apple ml-sharp into the generate tab.
 * Adds a "Generate 3D Splat" button to the image viewer area.
 * On click, sends the current image to the server, runs `sharp predict`,
 * converts the output to .splat format, then navigates to the dedicated
 * Splat Viewer tab and loads the result.
 *
 * Viewer: uses @mkkellogg/gaussian-splats-3d bundled locally via npm + rollup.
 * Run `npm install` in the extension folder to build Assets/splat-viewer.bundle.js.
 */

'use strict';

/** Serves the locally-built GaussianSplats3D ES module bundle. */
let sharpSplatBundleUrl = '/ExtensionFile/SharpSplatExtension/Assets/splat-viewer.bundle.js';

/**
 * Fetches an image from a src URL (or data-URL) as a base64-encoded string.
 * Returns null if no image is available.
 * @param {string} src - Image URL or data-URL passed by registerMediaButton.
 */
async function sharpSplatGetImageBase64(src) {
    if (src.startsWith('data:')) {
        let b64 = src.split(',')[1];
        return b64 || null;
    }
    let fetchResponse = await fetch(src);
    let blob = await fetchResponse.blob();
    return new Promise((resolve, reject) => {
        let reader = new FileReader();
        reader.onloadend = () => {
            let b64 = reader.result.split(',')[1];
            resolve(b64 || null);
        };
        reader.onerror = () => reject(new Error('Failed to read image data.'));
        reader.readAsDataURL(blob);
    });
}

/**
 * Manages the Splat Viewer tab — file list sidebar and persistent WebGL viewer.
 */
class SharpSplatTabManager {
    constructor() {
        /** @type {Promise|null} Cached import() promise for the viewer bundle. */
        this._modulePromise = null;
        /** @type {Object|null} Active GaussianSplats3D.Viewer instance. */
        this._viewer = null;
        /** @type {string|null} URL of the currently loaded splat. */
        this._currentUrl = null;
        /** @type {boolean} Whether DOM event handlers have been wired up. */
        this._uiReady = false;
        /** @type {boolean} Whether the mouse is currently over the canvas. */
        this._canvasHovered = false;
        /** @type {Object|null} Camera/target state captured after the first auto-framing, used by resetCamera(). */
        this._initialCameraState = null;
        /** @type {number} Incremented each time a new viewer is created so orphaned RAF loops self-terminate. */
        this._cameraSyncGen = 0;
    }

    /**
     * Wires up DOM event handlers. Safe to call multiple times.
     */
    setupUI() {
        if (this._uiReady) {
            return;
        }
        this._uiReady = true;
        let refreshBtn = document.getElementById('sharpsplat_refresh_btn');
        if (refreshBtn) {
            // Stop propagation so the click doesn't bubble to the accordion header.
            refreshBtn.onclick = (e) => { e.stopPropagation(); this.refreshList(); };
        }
        // Camera controls.
        let camApply = document.getElementById('sharpsplat_cam_apply');
        if (camApply) {
            camApply.onclick = () => this.applyCameraPosition();
        }
        let camReset = document.getElementById('sharpsplat_cam_reset');
        if (camReset) {
            camReset.onclick = () => this.resetCamera();
        }
        // Accordion toggles — restore open state from localStorage.
        for (let id of ['sharpsplat_acc_camera', 'sharpsplat_acc_splats', 'sharpsplat_acc_settings']) {
            let acc = document.getElementById(id);
            if (!acc) {
                continue;
            }
            let stored = localStorage.getItem(id);
            // Camera and Splats open by default; Settings closed by default.
            let isOpen = stored !== null ? stored === 'true' : id !== 'sharpsplat_acc_settings';
            acc.classList.toggle('open', isOpen);
            let btn = acc.querySelector('.sharpsplat-accordion-header');
            if (btn) {
                btn.addEventListener('click', () => {
                    let open = acc.classList.toggle('open');
                    localStorage.setItem(id, open ? 'true' : 'false');
                });
            }
        }
        // Restore and persist the auto-navigate toggle.
        let autoNavToggle = document.getElementById('sharpsplat_setting_auto_navigate');
        if (autoNavToggle) {
            autoNavToggle.checked = localStorage.getItem('sharpsplat_auto_navigate') !== 'false';
            autoNavToggle.addEventListener('change', () => {
                localStorage.setItem('sharpsplat_auto_navigate', autoNavToggle.checked ? 'true' : 'false');
            });
        }
        // Apply on Enter for any camera input; stop propagation so viewer never sees these keys.
        for (let input of document.querySelectorAll('.sharpsplat-camera-input')) {
            input.addEventListener('keydown', (e) => {
                // Always stop propagation so viewer keyboard handlers never see these events.
                e.stopPropagation();
                if (e.key === 'Enter') {
                    this.applyCameraPosition();
                }
            });
        }
        // Track hover over the canvas wrap so keyboard gating knows when the viewer is active.
        let canvasWrap = document.getElementById('sharpsplat_canvas_wrap');
        if (canvasWrap) {
            canvasWrap.addEventListener('mouseenter', () => { this._canvasHovered = true; });
            canvasWrap.addEventListener('mouseleave', () => { this._canvasHovered = false; });
        }
        // Intercept keyboard events in capture phase on window — OrbitControls also attaches
        // to window in capture phase, so we must intercept here (before document capture) to
        // beat it. Block all keys unless the mouse is over the canvas.
        window.addEventListener('keydown', (e) => {
            let tag = e.target && e.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) {
                return;
            }
            if (!this._canvasHovered) {
                e.stopPropagation();
            }
        }, true);
        // When the tab is activated, refresh the file list and pre-warm the viewer bundle.
        let tabBtn = document.getElementById('maintab_splatviewer');
        if (tabBtn) {
            tabBtn.addEventListener('click', () => {
                this.refreshList();
                this._loadModule();
            });
        }
    }

    /**
     * Starts a per-frame RAF loop that syncs camera position inputs whenever
     * the camera moves (including click-to-focus, which doesn't emit a
     * controls 'change' event). The loop self-terminates when a new viewer
     * is created (via the generation counter) or when the viewer is disposed.
     */
    _startCameraSync() {
        let gen = ++this._cameraSyncGen;
        let lastX = null, lastY = null, lastZ = null;
        let lastLX = null, lastLY = null, lastLZ = null;
        const loop = () => {
            if (gen !== this._cameraSyncGen) {
                return;
            }
            if (!this._viewer || !this._viewer.camera) {
                requestAnimationFrame(loop);
                return;
            }
            let pos = this._viewer.camera.position;
            let tgt = this._viewer.controls && this._viewer.controls.target;
            let posValid = isFinite(pos.x) && isFinite(pos.y) && isFinite(pos.z);
            let tgtValid = tgt && isFinite(tgt.x) && isFinite(tgt.y) && isFinite(tgt.z);
            if (posValid || tgtValid) {
                let active = document.activeElement;
                if (!active || !active.classList.contains('sharpsplat-camera-input')) {
                    let posChanged = posValid && (pos.x !== lastX || pos.y !== lastY || pos.z !== lastZ);
                    let tgtChanged = tgtValid && (tgt.x !== lastLX || tgt.y !== lastLY || tgt.z !== lastLZ);
                    if (posChanged || tgtChanged) {
                        if (posValid) { lastX = pos.x; lastY = pos.y; lastZ = pos.z; }
                        if (tgtValid) { lastLX = tgt.x; lastLY = tgt.y; lastLZ = tgt.z; }
                        this._syncCameraInputs();
                    }
                }
            }
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }

    /**
     * Reads the current viewer camera position into the X/Y/Z inputs.
     * No-op when no viewer is active.
     */
    _syncCameraInputs() {
        if (!this._viewer || !this._viewer.camera) {
            return;
        }
        let pos = this._viewer.camera.position;
        // Bail out if camera has degenerate values (e.g. camera === target → OrbitControls produces ±Infinity).
        if (!isFinite(pos.x) || !isFinite(pos.y) || !isFinite(pos.z)) {
            return;
        }
        let xInput = document.getElementById('sharpsplat_cam_x');
        let yInput = document.getElementById('sharpsplat_cam_y');
        let zInput = document.getElementById('sharpsplat_cam_z');
        if (xInput) { xInput.value = Math.round(pos.x * 1000) / 1000; }
        if (yInput) { yInput.value = Math.round(pos.y * 1000) / 1000; }
        if (zInput) { zInput.value = Math.round(pos.z * 1000) / 1000; }
        if (this._viewer.controls) {
            let tgt = this._viewer.controls.target;
            if (isFinite(tgt.x) && isFinite(tgt.y) && isFinite(tgt.z)) {
                let lxInput = document.getElementById('sharpsplat_cam_lx');
                let lyInput = document.getElementById('sharpsplat_cam_ly');
                let lzInput = document.getElementById('sharpsplat_cam_lz');
                if (lxInput) { lxInput.value = Math.round(tgt.x * 1000) / 1000; }
                if (lyInput) { lyInput.value = Math.round(tgt.y * 1000) / 1000; }
                if (lzInput) { lzInput.value = Math.round(tgt.z * 1000) / 1000; }
            }
        }
    }

    /**
     * Reads the X/Y/Z inputs and moves the viewer camera to that position.
     * No-op when no viewer is active.
     */
    applyCameraPosition() {
        if (!this._viewer) {
            return;
        }
        let x = parseFloat(document.getElementById('sharpsplat_cam_x').value) || 0;
        let y = parseFloat(document.getElementById('sharpsplat_cam_y').value) || 0;
        let z = parseFloat(document.getElementById('sharpsplat_cam_z').value) || 0;
        if (this._viewer.camera) {
            this._viewer.camera.position.set(x, y, z);
        }
        if (this._viewer.controls) {
            let lx = parseFloat(document.getElementById('sharpsplat_cam_lx').value) || 0;
            let ly = parseFloat(document.getElementById('sharpsplat_cam_ly').value) || 0;
            let lz = parseFloat(document.getElementById('sharpsplat_cam_lz').value) || 0;
            this._viewer.controls.target.set(lx, ly, lz);
            this._viewer.controls.update();
        }
    }

    /**
     * Resets the camera to the auto-framed state captured after scene load,
     * then re-primes OrbitControls and syncs the position inputs.
     */
    resetCamera() {
        if (!this._initialCameraState || !this._viewer) return;

        this._viewer.camera.position.copy(this._initialCameraState.position);
        this._viewer.camera.quaternion.copy(this._initialCameraState.quaternion);
        this._viewer.camera.up.copy(this._initialCameraState.up);
        this._viewer.controls.target.copy(this._initialCameraState.target);
        this._viewer.controls.update();

        // Reflect the reset position in the camera inputs.
        this._syncCameraInputs();
    }

    /**
     * Navigates the UI to the Splat Viewer top-level tab.
     */
    navigateToTab() {
        let tabBtn = document.getElementById('maintab_splatviewer');
        if (tabBtn) {
            tabBtn.click();
        }
    }

    /**
     * Refreshes the sidebar file list by calling the SharpListSplats API.
     */
    async refreshList() {
        let listDiv = document.getElementById('sharpsplat_file_list');
        if (!listDiv) {
            return;
        }
        listDiv.innerHTML = '<span class="sharpsplat-hint">Loading\u2026</span>';
        try {
            let result = await new Promise((resolve, reject) => {
                genericRequest('SharpListSplats', {}, (data) => {
                    if (data.success) {
                        resolve(data);
                    }
                    else {
                        reject(new Error(data.error || 'Failed to list splats.'));
                    }
                });
            });
            let splats = result.splats || [];
            if (splats.length === 0) {
                listDiv.innerHTML = '<span class="sharpsplat-hint">No splats generated yet.</span>';
                return;
            }
            listDiv.innerHTML = '';
            for (let splat of splats) {
                let row = createDiv(null, 'sharpsplat-file-row' + (splat.url === this._currentUrl ? ' active' : ''));
                // Name button — loads the splat into the viewer.
                let nameBtn = document.createElement('button');
                nameBtn.className = 'sharpsplat-file-entry';
                nameBtn.textContent = splat.filename;
                nameBtn.title = splat.filename;
                nameBtn.dataset.url = splat.url;
                nameBtn.onclick = () => this.loadSplat(splat.url, splat.filename);
                // Download button — triggers a browser file download.
                let dlBtn = document.createElement('a');
                dlBtn.className = 'sharpsplat-icon-btn';
                dlBtn.title = 'Download ' + splat.filename;
                dlBtn.href = splat.url;
                dlBtn.download = splat.filename;
                dlBtn.innerHTML = '&#8615;';
                // Delete button — removes the file after confirmation.
                let delBtn = document.createElement('button');
                delBtn.className = 'sharpsplat-icon-btn sharpsplat-delete-btn';
                delBtn.title = 'Delete ' + splat.filename;
                delBtn.innerHTML = '&#x1F5D1;';
                delBtn.onclick = () => this.deleteSplat(splat.filename, row);
                row.appendChild(nameBtn);
                row.appendChild(dlBtn);
                row.appendChild(delBtn);
                listDiv.appendChild(row);
            }
        }
        catch (err) {
            listDiv.innerHTML = '<span class="sharpsplat-hint" style="color:#c66;">Error: ' + escapeHtml(err.message) + '</span>';
        }
    }

    /**
     * Deletes a splat file after a confirmation prompt.
     * @param {string} filename - Bare filename of the splat to delete.
     * @param {HTMLElement} rowElem - The sidebar row element to remove on success.
     */
    async deleteSplat(filename, rowElem) {
        if (!uiImprover.lastShift && getUserSetting('ui.checkifsurebeforedelete', true) && !confirm('Are you sure you want to delete ' + filename + '?\nHold shift to bypass.')) {
            return;
        }
        try {
            await new Promise((resolve, reject) => {
                genericRequest('SharpDeleteSplat', { filename: filename }, (data) => {
                    if (data.success) {
                        resolve();
                    }
                    else {
                        reject(new Error(data.error || 'Delete failed.'));
                    }
                });
            });
            // If the deleted splat was loaded in the viewer, dispose and clear it.
            if (this._currentUrl && this._currentUrl.includes(encodeURIComponent(filename))) {
                this._currentUrl = null;
                if (this._viewer) {
                    this._viewer.dispose();
                    this._viewer = null;
                }
                let wrap = document.getElementById('sharpsplat_canvas_wrap');
                if (wrap) {
                    wrap.innerHTML = '';
                }
                let status = document.getElementById('sharpsplat_status');
                if (status) {
                    status.textContent = 'Select a splat from the list, or click \u201cGenerate 3D Splat\u201d on an image in the Generate tab.';
                }
            }
            rowElem.remove();
            // Show hint if the list is now empty.
            let listDiv = document.getElementById('sharpsplat_file_list');
            if (listDiv && listDiv.children.length === 0) {
                listDiv.innerHTML = '<span class="sharpsplat-hint">No splats generated yet.</span>';
            }
        }
        catch (err) {
            showError('SharpSplat: ' + err.message);
        }
    }

    /**
     * Loads the GaussianSplats3D ES module bundle, caching the result.
     * Returns a Promise resolving to the module namespace object.
     */
    _loadModule() {
        if (!this._modulePromise) {
            this._modulePromise = import(sharpSplatBundleUrl);
        }
        return this._modulePromise;
    }

    /**
     * Loads a .splat file into the viewer by HTTP URL.
     * Disposes any previously active viewer instance before creating a new one.
     * @param {string} url - URL of the .splat file (e.g. /View/...).
     * @param {string} filename - Display name shown in the status bar.
     */
    async loadSplat(url, filename) {
        let status = document.getElementById('sharpsplat_status');
        this._currentUrl = url;
        for (let row of document.querySelectorAll('.sharpsplat-file-row')) {
            let nameBtn = row.querySelector('.sharpsplat-file-entry');
            row.classList.toggle('active', nameBtn && nameBtn.dataset.url === url);
        }
        if (status) {
            status.textContent = 'Loading ' + filename + '\u2026';
        }
        // Dispose previous viewer before mounting a new one.
        if (this._viewer) {
            this._viewer.dispose();
            this._viewer = null;
        }
        let wrap = document.getElementById('sharpsplat_canvas_wrap');
        if (wrap) {
            wrap.innerHTML = '';
        }
        try {
            let GS3D = await this._loadModule();
            let renderWidth = (wrap && wrap.clientWidth) || 800;
            let renderHeight = (wrap && wrap.clientHeight) || 600;
            this._viewer = new GS3D.Viewer({
                'rootElement': wrap,
                'cameraUp': [0, -1, 0],
                'initialCameraPosition': [0, 0, 1],
                'renderWidth': renderWidth,
                'renderHeight': renderHeight,
                'sharedMemoryForWorkers': false,
                'gpuAcceleratedSort': false,
                'sceneRevealMode': GS3D.SceneRevealMode.Instant,
                'logLevel': GS3D.LogLevel.None,
            });
            await this._viewer.addSplatScene(url, {
                'splatAlphaRemovalThreshold': 5,
                'showLoadingUI': false,
                'rotation': [0, 1, 0, 0],
            });
            this._viewer.start();
            this._startCameraSync();

            if (this._viewer.controls) {
                this._viewer.controls.enabled = true;
            }

            let _canvas = wrap.querySelector('canvas');
            if (_canvas) {
                // Poll each frame until the viewer has auto-framed the scene and the camera
                // has a valid non-origin position, then snapshot it for resetCamera().
                const waitForCamera = () => {
                    const p = this._viewer.camera?.position;
                    const t = this._viewer.controls?.target;
                    if (p && t &&
                        isFinite(p.x) && isFinite(p.y) && isFinite(p.z) &&
                        isFinite(t.x) && isFinite(t.y) && isFinite(t.z) &&
                        (p.x !== 0 || p.y !== 0 || p.z !== 0))
                    {
                        this._initialCameraState = {
                            position: p.clone(),
                            quaternion: this._viewer.camera.quaternion.clone(),
                            up: this._viewer.camera.up.clone(),
                            target: t.clone(),
                        };
                        this._syncCameraInputs();
                    }
                    else {
                        requestAnimationFrame(waitForCamera);
                    }
                };
                requestAnimationFrame(waitForCamera);
            }
            // Camera input sync is handled by the _startCameraSync() RAF loop above,
            // which catches all camera movements including click-to-focus.
            if (this._currentUrl === url && status) {
                status.textContent = filename + ' \u00b7 Orbit: left-drag \u00b7 Zoom: scroll \u00b7 Pan: right-drag';
            }
        }
        catch (err) {
            if (status) {
                status.textContent = 'Error loading ' + filename + ': ' + err.message;
            }
            console.error('SharpSplat: loadSplat error', err);
        }
    }
}

/** Singleton tab manager. */
let sharpSplatTab = new SharpSplatTabManager();

/**
 * Handles the "Generate 3D Splat" button click.
 * Tries the ComfyUI-backed route first (SharpGenerateSplatViaComfy), which queues
 * generation through the Comfy backend. Falls back to the direct subprocess route
 * (SharpGenerateSplat) when no ComfyUI backend is available.
 * @param {string} src - Image URL or data-URL, as provided by registerMediaButton.
 */
async function handleSharpSplatGenerate(src) {
    let base64Data;
    try {
        base64Data = await sharpSplatGetImageBase64(src);
    }
    catch (err) {
        showError('SharpSplat: Failed to read the current image. ' + err.message);
        return;
    }
    if (!base64Data) {
        showError('SharpSplat: No image available. Generate an image first.');
        return;
    }
    // Derive a filename prefix from the source URL (strip path and extension).
    let filenamePrefix = 'output';
    try {
        let urlPath = src.startsWith('data:') ? '' : new URL(src, window.location.href).pathname;
        if (urlPath) {
            let base = urlPath.split('/').pop();
            let dot = base.lastIndexOf('.');
            filenamePrefix = dot > 0 ? base.slice(0, dot) : base;
        }
    }
    catch (_) {}
    let requestParams = { imageBase64: base64Data, filenamePrefix: filenamePrefix };
    /**
     * Calls a given API endpoint and returns a Promise resolving to the response.
     * @param {string} endpoint
     */
    function callSplatAPI(endpoint) {
        return new Promise((resolve, reject) => {
            genericRequest(
                endpoint,
                requestParams,
                (data) => {
                    if (data.success) {
                        resolve(data);
                    }
                    else {
                        reject(new Error(data.error || 'Splat generation failed.'));
                    }
                }
            );
        });
    }
    try {
        let result;
        try {
            // Preferred path: submit generation through the ComfyUI backend queue.
            let comfyPromise = callSplatAPI('SharpGenerateSplatViaComfy');
            // Force the status bar to poll the server so the generation counter appears.
            // The normal polling interval can be up to 60 s when backends are idle, so we
            // nudge it immediately after starting the request (the server-side GenClaim will
            // already be active within a few milliseconds).
            if (typeof updateGenCount === 'function') {
                updateGenCount();
            }
            result = await comfyPromise;
        }
        catch (comfyErr) {
            // Fall back to the direct subprocess path when no ComfyUI backend is running.
            if (comfyErr.message && comfyErr.message.includes('No available ComfyUI Backend')) {
                console.warn('SharpSplat: No ComfyUI backend available, falling back to direct generation.');
                result = await callSplatAPI('SharpGenerateSplat');
            }
            else {
                throw comfyErr;
            }
        }
        // Force another poll now that the generation is complete so the counter clears promptly.
        if (typeof updateGenCount === 'function') {
            updateGenCount();
        }
        let filename = result.filename || 'output.splat';
        // Only navigate to the viewer tab if the user has the setting enabled (default: on).
        let autoNavToggle = document.getElementById('sharpsplat_setting_auto_navigate');
        if (!autoNavToggle || autoNavToggle.checked) {
            sharpSplatTab.navigateToTab();
        }
        await sharpSplatTab.loadSplat(result.splatUrl, filename);
    }
    catch (err) {
        console.error('SharpSplat error:', err);
        showError('SharpSplat: ' + err.message);
    }
}

// Wire up UI and register the image viewer button once the page is ready.
setTimeout(() => {
    sharpSplatTab.setupUI();
    if (typeof promptTabComplete !== 'undefined') {
        promptTabComplete.registerPrefix('sharpsplat', 'Automatically generate a 3D Gaussian Splat after this image is generated.', () => [
            '\nAdd "<sharpsplat>" anywhere in your prompt to auto-generate a .splat file from the output image.'
        ], true);
    }
    if (typeof registerMediaButton !== 'function') {
        console.warn('SharpSplat: registerMediaButton is not available \u2014 SwarmUI version may be too old');
        return;
    }
    registerMediaButton(
        'Generate 3D Splat',
        (src) => handleSharpSplatGenerate(src),
        'Generate a 3D Gaussian Splat (.splat) from this image using ml-sharp',
        ['image'],
        true,
        true
    );
}, 0);
