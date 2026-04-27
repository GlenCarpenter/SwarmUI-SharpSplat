/**
 * sharp_splat.js
 * SwarmUI SharpSplat extension — integrates Apple ml-sharp into the generate tab.
 * Adds a "Generate 3D Splat" button to the image viewer area.
 * On click, sends the current image to the server, runs `sharp predict`,
 * converts the output to .splat format, then navigates to the dedicated
 * Splat Viewer tab and loads the result.
 */

'use strict';

/** CDN URL for gsplat.js (ES module). Pinned to a specific version for stability. */
let sharpSplatGsplatUrl = 'https://cdn.jsdelivr.net/npm/gsplat@1.2.9/dist/index.es.js';

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
        /** @type {Object|null} Cached gsplat.js ES module. */
        this._gsplat = null;
        /** @type {Promise|null} Resolves when the WebGL viewer is ready. */
        this._initPromise = null;
        /** @type {Object|null} gsplat WebGL renderer. */
        this._renderer = null;
        /** @type {Object|null} Current gsplat Scene. */
        this._scene = null;
        /** @type {Object|null} gsplat Camera. */
        this._camera = null;
        /** @type {Object|null} gsplat OrbitControls. */
        this._controls = null;
        /** @type {number|null} requestAnimationFrame handle for the render loop. */
        this._rafId = null;
        /** @type {boolean} Whether the render loop is running. */
        this._running = false;
        /** @type {ResizeObserver|null} Watches canvas-wrap for size changes. */
        this._resizeObserver = null;
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
                this.initViewer();
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
                let btn = document.createElement('button');
                btn.className = 'sharpsplat-file-entry' + (splat.url === this._currentUrl ? ' active' : '');
                btn.textContent = splat.filename;
                btn.title = splat.filename;
                btn.dataset.url = splat.url;
                btn.onclick = () => this.loadSplat(splat.url, splat.filename);
                listDiv.appendChild(btn);
            }
        }
        catch (err) {
            listDiv.innerHTML = '<span class="sharpsplat-hint" style="color:#c66;">Error: ' + escapeHtml(err.message) + '</span>';
        }
    }

    /**
     * Initialises the WebGL renderer, scene, camera, and controls once.
     * Returns a Promise that resolves when initialisation is complete.
     * Subsequent calls return the same promise.
     */
    initViewer() {
        if (this._initPromise) {
            return this._initPromise;
        }
        this._initPromise = this._doInitViewer();
        return this._initPromise;
    }

    /** @private */
    async _doInitViewer() {
        let canvas = document.getElementById('sharpsplat_canvas');
        let wrap = document.getElementById('sharpsplat_canvas_wrap');
        if (!canvas || !wrap) {
            throw new Error('Viewer canvas not found in DOM.');
        }
        if (!this._gsplat) {
            this._gsplat = await import(sharpSplatGsplatUrl);
        }
        let SPLAT = this._gsplat;
        canvas.width = wrap.clientWidth || 800;
        canvas.height = wrap.clientHeight || 600;
        this._renderer = new SPLAT.WebGLRenderer(canvas);
        this._camera = new SPLAT.Camera();
        this._controls = new SPLAT.OrbitControls(this._camera, canvas);
        this._resizeObserver = new ResizeObserver(() => {
            canvas.width = wrap.clientWidth;
            canvas.height = wrap.clientHeight;
        });
        this._resizeObserver.observe(wrap);
        // Note: render loop is NOT started here.
        // It is started (and stopped between loads) inside loadSplat(),
        // so that the loop only runs after LoadAsync resolves and the
        // WebAssembly module is fully initialised.
    }

    /**
     * Loads a .splat file into the viewer by HTTP URL.
     * @param {string} url - URL of the .splat file (e.g. /View/...).
     * @param {string} filename - Display name shown in the status bar.
     */
    async loadSplat(url, filename) {
        let status = document.getElementById('sharpsplat_status');
        this._currentUrl = url;
        for (let btn of document.querySelectorAll('.sharpsplat-file-entry')) {
            btn.classList.toggle('active', btn.dataset.url === url);
        }
        if (status) {
            status.textContent = 'Loading ' + filename + '\u2026';
        }

        // Stop any running render loop before touching the scene.
        // This prevents the worker from receiving render commands while
        // its WebAssembly module may still be initialising, which causes
        // "Cannot read properties of undefined (reading 'set')" at RenderData.ts:208.
        this._running = false;
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }

        try {
            await this.initViewer();
            let SPLAT = this._gsplat;
            // Replace the scene to discard the previously loaded splat.
            this._scene = new SPLAT.Scene();
            await SPLAT.Loader.LoadAsync(url, this._scene, (progress) => {
                if (status && this._currentUrl === url && progress >= 0 && progress < 1) {
                    status.textContent = 'Loading ' + filename + '\u2026 ' + Math.round(progress * 100) + '%';
                }
            });

            // WASM is now fully initialised (LoadAsync awaited multiple async steps).
            // Start the render loop.
            this._running = true;
            let self = this;
            function frame() {
                if (!self._running) {
                    return;
                }
                self._controls.update();
                self._renderer.render(self._scene, self._camera);
                self._rafId = requestAnimationFrame(frame);
            }
            self._rafId = requestAnimationFrame(frame);

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
 * Sends the current image to the server, then navigates to the Splat Viewer tab
 * and auto-loads the result.
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
    try {
        let result = await new Promise((resolve, reject) => {
            genericRequest(
                'SharpGenerateSplat',
                { imageBase64: base64Data, filenamePrefix: filenamePrefix },
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
