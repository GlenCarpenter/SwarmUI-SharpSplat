/**
 * sharp_splat.js
 * SwarmUI SharpSplat extension — integrates Apple ml-sharp into the generate tab.
 * Adds a "Generate 3D Splat" button to the image viewer area.
 * On click, sends the current image to the server, runs `sharp predict`, and
 * provides a browser download of the resulting .ply file plus an in-browser
 * 3D Gaussian Splat viewer powered by gsplat.js.
 */

'use strict';

/** CDN URL for gsplat.js (ES module). */
let sharpSplatGsplatUrl = 'https://cdn.jsdelivr.net/npm/gsplat@latest/dist/index.js';

/** Cached gsplat module so we only import once. */
let sharpSplatGsplatModule = null;

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
 * Opens the in-browser 3D Gaussian Splat viewer in a fullscreen overlay.
 * Loads gsplat.js from CDN on first call, then renders the .splat file via its URL.
 * @param {string} splatUrl - URL of the .splat file (e.g. /View/...).
 * @param {string} filename - Filename shown in the viewer title.
 */
async function sharpSplatOpenViewer(splatUrl, filename) {
    // Remove any existing viewer.
    let existing = document.getElementById('sharp_splat_viewer_overlay');
    if (existing) {
        existing.remove();
    }

    console.log('SharpSplat: Loading file: ' + splatUrl)

    // Build the overlay.
    let overlay = document.createElement('div');
    overlay.id = 'sharp_splat_viewer_overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:#111;z-index:99999;display:flex;flex-direction:column;';

    // Top bar.
    let topBar = document.createElement('div');
    topBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 14px;background:#222;flex-shrink:0;gap:8px;';

    let titleSpan = document.createElement('span');
    titleSpan.style.cssText = 'color:#fff;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    titleSpan.textContent = '3D Splat Viewer \u2014 ' + filename;

    let btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex;gap:8px;flex-shrink:0;';

    let downloadBtn = document.createElement('button');
    downloadBtn.className = 'basic-button';
    downloadBtn.textContent = 'Download Splat';
    downloadBtn.onclick = () => {
        let a = document.createElement('a');
        a.href = splatUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    let closeBtn = document.createElement('button');
    closeBtn.className = 'basic-button';
    closeBtn.textContent = '\u2715 Close';
    closeBtn.onclick = () => {
        overlay.remove();
        // Renderer and worker cleanup happens via renderer.dispose() below.
        if (overlay._splatDispose) {
            overlay._splatDispose();
        }
    };

    btnGroup.appendChild(downloadBtn);
    btnGroup.appendChild(closeBtn);
    topBar.appendChild(titleSpan);
    topBar.appendChild(btnGroup);

    // Status / loading text.
    let statusDiv = document.createElement('div');
    statusDiv.style.cssText = 'color:#aaa;font-size:13px;padding:4px 14px;background:#222;flex-shrink:0;';
    statusDiv.textContent = 'Loading gsplat.js\u2026';

    // Canvas area.
    let canvasWrap = document.createElement('div');
    canvasWrap.style.cssText = 'flex:1;overflow:hidden;position:relative;';

    let canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;';

    canvasWrap.appendChild(canvas);
    overlay.appendChild(topBar);
    overlay.appendChild(statusDiv);
    overlay.appendChild(canvasWrap);
    document.body.appendChild(overlay);

    // Size the canvas to fill.
    function resizeCanvas() {
        canvas.width = canvasWrap.clientWidth;
        canvas.height = canvasWrap.clientHeight;
    }
    resizeCanvas();
    let resizeObserver = new ResizeObserver(resizeCanvas);
    resizeObserver.observe(canvasWrap);

    // Load gsplat module once.
    try {
        if (!sharpSplatGsplatModule) {
            sharpSplatGsplatModule = await import(sharpSplatGsplatUrl);
        }
    }
    catch (err) {
        statusDiv.textContent = 'Failed to load gsplat.js: ' + err.message;
        console.error('SharpSplat viewer: gsplat import failed', err);
        return;
    }

    let SPLAT = sharpSplatGsplatModule;
    statusDiv.textContent = 'Parsing splat data\u2026';

    // Set up renderer, scene, camera, controls.
    let renderer, controls;
    try {
        renderer = new SPLAT.WebGLRenderer(canvas);
        let scene = new SPLAT.Scene();
        let camera = new SPLAT.Camera();
        controls = new SPLAT.OrbitControls(camera, canvas);

        // Load the .splat file by URL using the async loader.
        // LoadAsync performs multiple awaits (fetch + stream read) which give gsplat.js's
        // internal WebAssembly module time to finish initialising before the render loop starts.
        await SPLAT.Loader.LoadAsync(splatUrl, scene, null);

        statusDiv.textContent = 'Use mouse to orbit \u00b7 scroll to zoom \u00b7 right-click drag to pan';

        // Render loop.
        let animFrameId = null;
        let running = true;
        function frame() {
            if (!running) {
                return;
            }
            controls.update();
            renderer.render(scene, camera);
            animFrameId = requestAnimationFrame(frame);
        }
        animFrameId = requestAnimationFrame(frame);

        // Cleanup hook attached to the overlay element.
        overlay._splatDispose = () => {
            running = false;
            if (animFrameId !== null) {
                cancelAnimationFrame(animFrameId);
            }
            resizeObserver.disconnect();
            try {
                renderer.dispose();
            }
            catch (_) {}
        };
    }
    catch (err) {
        statusDiv.textContent = 'Viewer error: ' + err.message;
        console.error('SharpSplat viewer error:', err);
    }
}

/**
 * Handles the "Generate 3D Splat" button click.
 * Receives the image src URL from registerMediaButton, calls the SharpGenerateSplat API,
 * downloads the PLY, and opens the in-browser viewer.
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
        await sharpSplatOpenViewer(result.splatUrl, filename);
    }
    catch (err) {
        console.error('SharpSplat error:', err);
        showError('SharpSplat: ' + err.message);
    }
}

// Register a button in the image viewer button bar.
// 'isDefault: true' makes it visible directly rather than hidden under a "More" dropdown.
// 'showInHistory: false' keeps it out of the output history panel (it's a generate-tab action).
(function() {
    if (typeof registerMediaButton !== 'function') {
        console.warn('SharpSplat: registerMediaButton is not available - SwarmUI version may be too old');
        return;
    }
    console.log('SharpSplat: registerMediaButton invoked');
    try {
        registerMediaButton(
            'Generate 3D Splat',
            (src) => handleSharpSplatGenerate(src),
            'Generate a 3D Gaussian Splat (.splat) from this image using ml-sharp',
            ['image'],
            true,
            true
        );
    } catch(error) {
        console.error(error);
    }
})();
