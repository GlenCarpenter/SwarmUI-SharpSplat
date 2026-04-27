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
            refreshBtn.onclick = () => this.refreshList();
        }
        // When the tab is activated, refresh the file list and pre-warm the viewer.
        let tabBtn = document.getElementById('maintab_splatviewer');
        if (tabBtn) {
            tabBtn.addEventListener('click', () => {
                this.refreshList();
                // Pre-warm the module import so the viewer is ready when a splat is clicked.
                this._loadModule();
            });
        }
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
        // Navigate to the tab (triggers refreshList + initViewer via the click handler),
        // then load the newly generated splat into the viewer.
        sharpSplatTab.navigateToTab();
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
