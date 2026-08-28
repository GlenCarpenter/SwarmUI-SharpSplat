/**
 * sharp_splat.js
 * SwarmUI SharpSplat extension — integrates Apple ml-sharp into the generate tab.
 * Adds a "Generate 3D Splat" button to the image viewer area.
 * On click, sends the current image to the server, runs `sharp predict`,
 * converts the output to .splat format, then navigates to the dedicated
 * Splat Viewer tab and loads the result.
 *
 * Viewer: runs @mkkellogg/gaussian-splats-3d in a same-origin sandboxed iframe.
 * Run `npm install` in the extension folder to build Assets/splat-viewer-frame.bundle.js.
 */

'use strict';

/** Serves the isolated GaussianSplats3D viewer document. */
let sharpSplatFrameUrl = '/ExtensionFile/SharpSplatExtension/Assets/splat-viewer-frame.html';

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
        /** @type {HTMLIFrameElement|null} Active isolated viewer frame. */
        this._viewerFrame = null;
        /** @type {boolean} Whether the active viewer frame has initialized. */
        this._viewerFrameReady = false;
        /** @type {boolean} Whether the frame has an active splat. */
        this._viewerLoaded = false;
        /** @type {Object|null} Latest serializable camera/canvas state from the frame. */
        this._cameraState = null;
        /** @type {number} Sequence used to correlate frame requests and responses. */
        this._frameRequestId = 0;
        /** @type {Map<number, {resolve: Function, reject: Function, timeout: number}>} Pending frame requests. */
        this._frameRequests = new Map();
        /** @type {string|null} URL of the currently loaded splat. */
        this._currentUrl = null;
        /** @type {string|null} Display name of the currently selected splat. */
        this._currentFilename = null;
        /** @type {boolean} Whether the Splat Viewer tab is currently visible. */
        this._tabActive = false;
        /** @type {boolean} Whether DOM event handlers have been wired up. */
        this._uiReady = false;
        /** @type {Object|null} Camera/target state captured after the first auto-framing, used by resetCamera(). */
        this._initialCameraState = null;
        /** @type {string|null} Base64 image data selected in the sidebar dropzone (ml-sharp single-image mode). */
        this._inputImageBase64 = null;
        /** @type {string|null} Selected sidebar image filename (ml-sharp single-image mode). */
        this._inputImageName = null;
        /** @type {string|null} Data URL used for sidebar thumbnail preview (ml-sharp single-image mode). */
        this._inputImagePreviewDataUrl = null;
        /** @type {Array<{base64: string, name: string, dataUrl: string}>} Selected images in VGGT multi-image mode. */
        this._inputImages = [];
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
        // Restore and persist the invert-controls toggle.
        let invertToggle = document.getElementById('sharpsplat_setting_invert_controls');
        if (invertToggle) {
            invertToggle.checked = localStorage.getItem('sharpsplat_invert_controls') === 'true';
            invertToggle.addEventListener('change', () => {
                localStorage.setItem('sharpsplat_invert_controls', invertToggle.checked ? 'true' : 'false');
                this._sendFrameCommand('setInvertControls', { enabled: invertToggle.checked });
            });
        }
        // Accordion toggles — restore open state from localStorage.
        for (let id of ['sharpsplat_acc_input', 'sharpsplat_acc_camera', 'sharpsplat_acc_splats', 'sharpsplat_acc_settings', 'sharpsplat_acc_export']) {
            let acc = document.getElementById(id);
            if (!acc) {
                continue;
            }
            let stored = localStorage.getItem(id);
            // Camera and Splats open by default; Settings and Export Canvas closed by default.
            let isOpen = stored !== null ? stored === 'true' : (id !== 'sharpsplat_acc_settings' && id !== 'sharpsplat_acc_export');
            this._setAccordionState(acc, isOpen, false);
            let btn = acc.querySelector('.sharpsplat-accordion-header');
            if (btn) {
                let toggle = () => this._setAccordionState(acc, !acc.classList.contains('open'), true);
                btn.addEventListener('click', toggle);
                if (btn.getAttribute('role') === 'button') {
                    btn.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            toggle();
                        }
                    });
                }
            }
        }
        this._setupSidebarResize();
        this._setupExportCanvas();
        // Restore and persist the auto-navigate toggle.
        let autoNavToggle = document.getElementById('sharpsplat_setting_auto_navigate');
        if (autoNavToggle) {
            autoNavToggle.checked = localStorage.getItem('sharpsplat_auto_navigate') !== 'false';
            autoNavToggle.addEventListener('change', () => {
                localStorage.setItem('sharpsplat_auto_navigate', autoNavToggle.checked ? 'true' : 'false');
            });
        }
        // Restore and persist the repair prompt feature flag, and sync button visibility.
        let repairPromptToggle = document.getElementById('sharpsplat_setting_repair_prompt');
        if (repairPromptToggle) {
            repairPromptToggle.checked = localStorage.getItem('sharpsplat_repair_prompt') === 'true';
            repairPromptToggle.addEventListener('change', () => {
                localStorage.setItem('sharpsplat_repair_prompt', repairPromptToggle.checked ? 'true' : 'false');
                this._syncRepairPromptButtonVisibility();
            });
        }
        this._syncRepairPromptButtonVisibility();
        // Restore and persist the output format select, and keep the hidden T2I param in sync.
        let formatSelect = document.getElementById('sharpsplat_setting_output_format');
        if (formatSelect) {
            formatSelect.value = localStorage.getItem('sharpsplat_output_format') || 'ply';
            let syncFormatParam = () => {
                let hiddenInput = document.getElementById('input_sharpsplatoutputformat');
                if (hiddenInput) {
                    hiddenInput.value = formatSelect.value;
                }
            };
            syncFormatParam();
            formatSelect.addEventListener('change', () => {
                localStorage.setItem('sharpsplat_output_format', formatSelect.value);
                syncFormatParam();
            });
        }
        // Restore and persist the model selector; rebuild dropzone mode on change.
        let modelSelect = document.getElementById('sharpsplat_setting_model');
        if (modelSelect) {
            modelSelect.value = localStorage.getItem('sharpsplat_model') || 'mlsharp';
            modelSelect.addEventListener('change', () => {
                localStorage.setItem('sharpsplat_model', modelSelect.value);
                this._onModelChange();
            });
        }
        // Restore and persist the VGGT pad-to-square checkbox.
        let padCheck = document.getElementById('sharpsplat_setting_pad_to_square');
        if (padCheck) {
            padCheck.checked = localStorage.getItem('sharpsplat_vggt_pad_to_square') === 'true';
            padCheck.addEventListener('change', () => {
                localStorage.setItem('sharpsplat_vggt_pad_to_square', padCheck.checked ? 'true' : 'false');
            });
        }
        this._setupInputDropzone();
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
        window.addEventListener('message', (e) => this._handleViewerMessage(e));
        // Mount WebGL only while this tab is visible. This releases renderer and worker
        // resources on every tab change without moving the host controls into an iframe.
        let tabBtn = document.getElementById('maintab_splatviewer');
        if (tabBtn) {
            tabBtn.addEventListener('click', () => {
                this.refreshList();
            });
            tabBtn.addEventListener('shown.bs.tab', () => this._activateTab());
            tabBtn.addEventListener('hidden.bs.tab', () => this._deactivateTab());
        }
        let tabPane = document.getElementById('splatviewer');
        this._tabActive = !!(tabPane && (tabPane.classList.contains('active') || tabPane.classList.contains('show')));
    }

    /**
     * Opens or closes an accordion, optionally animating to its measured content height.
     * @param {HTMLElement} accordion
     * @param {boolean} open
     * @param {boolean} animate
     */
    _setAccordionState(accordion, open, animate) {
        let body = accordion.querySelector(':scope > .sharpsplat-accordion-body');
        let header = accordion.querySelector(':scope > .sharpsplat-accordion-header');
        accordion.classList.toggle('open', open);
        if (header) {
            header.setAttribute('aria-expanded', open ? 'true' : 'false');
        }
        localStorage.setItem(accordion.id, open ? 'true' : 'false');
        if (!body) {
            return;
        }
        if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            body.hidden = !open;
            return;
        }
        if (body._sharpSplatAnimation) {
            body._sharpSplatAnimation.cancel();
        }
        body.hidden = false;
        let fullHeight = body.scrollHeight;
        let animation = body.animate(
            open ? [{ height: '0px', opacity: 0 }, { height: fullHeight + 'px', opacity: 1 }]
                : [{ height: fullHeight + 'px', opacity: 1 }, { height: '0px', opacity: 0 }],
            { duration: 180, easing: 'ease-out' }
        );
        body._sharpSplatAnimation = animation;
        animation.onfinish = () => {
            body.hidden = !open;
            body._sharpSplatAnimation = null;
        };
    }

    /** Sets up pointer, keyboard, and persisted sizing for the viewer sidebar. */
    _setupSidebarResize() {
        let root = document.querySelector('.sharpsplat-tab-root');
        let sidebar = document.querySelector('.sharpsplat-sidebar');
        let handle = document.getElementById('sharpsplat_sidebar_resizer');
        if (!root || !sidebar || !handle) {
            return;
        }
        let storedWidth = parseInt(localStorage.getItem('sharpsplat_sidebar_width'));
        if (isFinite(storedWidth)) {
            sidebar.style.width = Math.max(210, Math.min(520, storedWidth)) + 'px';
        }
        let resize = (clientX, clientY) => {
            let mobile = window.matchMedia('(max-width: 720px)').matches;
            if (mobile) {
                let rootRect = root.getBoundingClientRect();
                let height = Math.max(180, Math.min(rootRect.height * 0.7, clientY - rootRect.top));
                sidebar.style.height = height + 'px';
            }
            else {
                let rootRect = root.getBoundingClientRect();
                let width = Math.max(210, Math.min(Math.min(520, rootRect.width * 0.46), clientX - rootRect.left));
                sidebar.style.width = width + 'px';
                localStorage.setItem('sharpsplat_sidebar_width', Math.round(width).toString());
            }
        };
        handle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            handle.classList.add('dragging');
            handle.setPointerCapture(e.pointerId);
        });
        handle.addEventListener('pointermove', (e) => {
            if (handle.hasPointerCapture(e.pointerId)) {
                resize(e.clientX, e.clientY);
            }
        });
        let endResize = (e) => {
            if (handle.hasPointerCapture(e.pointerId)) {
                handle.releasePointerCapture(e.pointerId);
            }
            handle.classList.remove('dragging');
        };
        handle.addEventListener('pointerup', endResize);
        handle.addEventListener('pointercancel', endResize);
        handle.addEventListener('dblclick', () => {
            sidebar.style.width = '280px';
            sidebar.style.height = '';
            localStorage.removeItem('sharpsplat_sidebar_width');
        });
        handle.addEventListener('keydown', (e) => {
            let mobile = window.matchMedia('(max-width: 720px)').matches;
            let delta = e.shiftKey ? 40 : 10;
            if ((!mobile && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) || (mobile && (e.key === 'ArrowUp' || e.key === 'ArrowDown'))) {
                e.preventDefault();
                let rect = sidebar.getBoundingClientRect();
                resize(rect.right + (e.key === 'ArrowLeft' ? -delta : delta), rect.bottom + (e.key === 'ArrowUp' ? -delta : delta));
            }
        });
    }

    /** Restores the selected splat when the viewer tab becomes visible. */
    _activateTab() {
        this._tabActive = true;
        this.refreshList();
        this._mountViewerFrame();
    }

    /** Releases WebGL resources when the viewer tab is no longer visible. */
    _deactivateTab() {
        this._tabActive = false;
        this._disposeViewer();
        let status = document.getElementById('sharpsplat_status');
        if (status && this._currentFilename) {
            status.textContent = this._currentFilename + ' · Viewer paused while tab is inactive';
        }
    }

    /** Removes the viewer iframe, destroying its event realm, WebGL context, and workers. */
    _disposeViewer() {
        if (this._viewerFrameReady) {
            this._sendFrameCommand('dispose');
        }
        for (let request of this._frameRequests.values()) {
            clearTimeout(request.timeout);
            request.reject(new Error('Viewer frame was closed.'));
        }
        this._frameRequests.clear();
        if (this._viewerFrame) {
            this._viewerFrame.remove();
            this._viewerFrame = null;
        }
        this._viewerFrameReady = false;
        this._viewerLoaded = false;
        this._cameraState = null;
        this._initialCameraState = null;
        let wrap = document.getElementById('sharpsplat_canvas_wrap');
        if (wrap) {
            wrap.innerHTML = '';
        }
    }

    /** Creates the sandboxed iframe that owns all GaussianSplats3D execution. */
    _mountViewerFrame() {
        if (!this._tabActive || this._viewerFrame) {
            return;
        }
        let wrap = document.getElementById('sharpsplat_canvas_wrap');
        if (!wrap) {
            return;
        }
        let frame = document.createElement('iframe');
        frame.className = 'sharpsplat-viewer-frame';
        frame.title = 'Gaussian splat viewer';
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        frame.src = sharpSplatFrameUrl;
        this._viewerFrame = frame;
        wrap.replaceChildren(frame);
    }

    /** Posts a one-way command to the active viewer frame. */
    _sendFrameCommand(type, payload = {}, requestId = null) {
        if (!this._viewerFrameReady || !this._viewerFrame || !this._viewerFrame.contentWindow) {
            return false;
        }
        this._viewerFrame.contentWindow.postMessage({ source: 'sharpsplat-host', type: type, payload: payload, requestId: requestId }, window.location.origin);
        return true;
    }

    /** Sends a frame command and resolves with its correlated response. */
    _requestFrame(type, payload = {}) {
        return new Promise((resolve, reject) => {
            let requestId = ++this._frameRequestId;
            let timeout = setTimeout(() => {
                this._frameRequests.delete(requestId);
                reject(new Error('Viewer frame did not respond.'));
            }, 10000);
            this._frameRequests.set(requestId, { resolve: resolve, reject: reject, timeout: timeout });
            if (!this._sendFrameCommand(type, payload, requestId)) {
                clearTimeout(timeout);
                this._frameRequests.delete(requestId);
                reject(new Error('Viewer frame is not ready.'));
            }
        });
    }

    /** Handles status, camera, and request messages from the active viewer frame. */
    _handleViewerMessage(event) {
        if (event.origin !== window.location.origin || !this._viewerFrame || event.source !== this._viewerFrame.contentWindow
            || !event.data || event.data.source !== 'sharpsplat-viewer') {
            return;
        }
        let message = event.data;
        let payload = message.payload || {};
        if (message.type === 'ready') {
            this._viewerFrameReady = true;
            if (this._currentUrl) {
                this._loadCurrentSplatInFrame();
            }
        }
        else if (message.type === 'loaded') {
            this._viewerLoaded = true;
            let status = document.getElementById('sharpsplat_status');
            if (status) {
                status.textContent = this._currentFilename + ' · Orbit: left-drag · Zoom: scroll · Pan: right-drag';
            }
        }
        else if (message.type === 'cameraChanged') {
            this._cameraState = payload;
            this._syncCameraInputs();
            this._updateExportViewportBox();
        }
        else if (message.type === 'initialCamera') {
            this._initialCameraState = payload;
        }
        else if (message.type === 'error') {
            this._viewerLoaded = false;
            let status = document.getElementById('sharpsplat_status');
            if (status) {
                status.textContent = 'Error loading ' + (this._currentFilename || 'splat') + ': ' + payload.message;
            }
        }
        else if (message.type === 'response' && message.requestId !== null) {
            let request = this._frameRequests.get(message.requestId);
            if (request) {
                clearTimeout(request.timeout);
                this._frameRequests.delete(message.requestId);
                request.resolve(payload);
            }
        }
    }

    /** Sends the selected splat and current control settings into the ready frame. */
    _loadCurrentSplatInFrame() {
        if (!this._currentUrl) {
            return;
        }
        let invertToggle = document.getElementById('sharpsplat_setting_invert_controls');
        this._viewerLoaded = false;
        this._cameraState = null;
        this._initialCameraState = null;
        this._sendFrameCommand('load', { url: this._currentUrl, invertControls: !!(invertToggle && invertToggle.checked) });
    }

    /**
     * Returns the currently selected model ('mlsharp', 'vggt', or 'instantsplat').
     */
    _getModel() {
        let sel = document.getElementById('sharpsplat_setting_model');
        return sel ? (sel.value || 'mlsharp') : 'mlsharp';
    }

    /**
     * Called whenever the model selector changes. Re-applies dropzone mode and clears state.
     */
    _onModelChange() {
        this._inputImageBase64 = null;
        this._inputImageName = null;
        this._inputImagePreviewDataUrl = null;
        this._inputImages = [];
        this._applyDropzoneMode();
        this._updateInputImageState();
    }

    /**
     * Returns true when the selected model uses multi-image input (VGGT or InstantSplat).
     */
    _isMultiViewModel() {
        let model = this._getModel();
        return model === 'vggt' || model === 'instantsplat';
    }

    /**
     * Applies single-image or multi-image dropzone mode based on current model selection.
     * Toggles the `multiple` attribute on the file input and updates hint text.
     */
    _applyDropzoneMode() {
        let fileInput = document.getElementById('sharpsplat_input_file');
        let mainHint = document.getElementById('sharpsplat_dropzone_main');
        let subHint = document.getElementById('sharpsplat_dropzone_sub');
        if (!fileInput) {
            return;
        }
        let isMultiView = this._isMultiViewModel();
        if (isMultiView) {
            fileInput.setAttribute('multiple', '');
            if (mainHint) { mainHint.textContent = 'Drop images here (multiple allowed)'; }
            if (subHint) { subHint.textContent = 'or click Browse to select one or more'; }
        }
        else {
            fileInput.removeAttribute('multiple');
            if (mainHint) { mainHint.textContent = 'Drop a single image here'; }
            if (subHint) { subHint.textContent = 'or click Browse to select'; }
        }
        // Show/hide multi-view-only settings rows.
        let padRow = document.getElementById('sharpsplat_row_pad_to_square');
        if (padRow) {
            padRow.style.display = isMultiView ? '' : 'none';
        }
    }

    /**
     * Shows or hides the Generate Repair Prompt button based on the feature flag setting.
     */
    _syncRepairPromptButtonVisibility() {
        let btn = document.getElementById('sharpsplat_repair_prompt_btn');
        if (!btn) {
            return;
        }
        let toggle = document.getElementById('sharpsplat_setting_repair_prompt');
        btn.style.display = (toggle && toggle.checked) ? '' : 'none';
    }

    /**
     * Briefly shows a non-blocking toast notification inside the viewer panel.
     * @param {string} message - Text to display.
     */
    _showToast(message) {
        let container = document.getElementById('sharpsplat_toast_container');
        if (!container) {
            return;
        }
        let toast = document.createElement('div');
        toast.className = 'sharpsplat-toast';
        toast.textContent = message;
        container.appendChild(toast);
        // Trigger fade-in on next frame.
        requestAnimationFrame(() => {
            toast.classList.add('visible');
        });
        setTimeout(() => {
            toast.classList.remove('visible');
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
            }, 220);
        }, 2500);
    }

    /**
     * Builds the repair prompt string with the current camera-movement delta encoded as JSON,
     * copies it to the clipboard, and shows a toast confirmation.
     *
     * The delta is computed between the initial auto-framed camera state (position of camera
     * at scene load) and the current camera position. Values are rounded to 3 decimal places.
     * When no splat is loaded, or the initial state has not been captured yet, all deltas are 0.
     *
     * The prompt is designed for use with the flux2-klein9b-lora-mlsharp-3d-repair LoRA:
     * https://huggingface.co/cyrildiagne/flux2-klein9b-lora-mlsharp-3d-repair
     */
    _generateRepairPrompt() {
        let dx = 0, dy = 0, dz = 0, dpitch = 0, dyaw = 0, droll = 0;
        if (this._cameraState && this._initialCameraState) {
            let pos = this._cameraState.position;
            let init = this._initialCameraState.position;
            dx = Math.round((pos.x - init.x) * 1000) / 1000;
            dy = Math.round((pos.y - init.y) * 1000) / 1000;
            dz = Math.round((pos.z - init.z) * 1000) / 1000;
            let rot = this._cameraState.rotation;
            let toDeg = v => Math.round(v * (180 / Math.PI) * 1000) / 1000;
            dpitch = toDeg(rot.x - this._initialCameraState.rotation.x);
            dyaw   = toDeg(rot.y - this._initialCameraState.rotation.y);
            droll  = toDeg(rot.z - this._initialCameraState.rotation.z);
        }
        let cameraJson = JSON.stringify({ x: dx, y: dy, z: dz, pitch: dpitch, yaw: dyaw, roll: droll });
        let prompt = 'Referring to the scene in image 1, restore the perspective of the scene in image 2. Repair the perspective and missing areas. The camera has moved by: ' + cameraJson;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(prompt).catch(() => {
                this._clipboardFallback(prompt);
            });
        }
        else {
            this._clipboardFallback(prompt);
        }
        this._showToast('Repair prompt copied to clipboard');
    }

    /**
     * Fallback clipboard write using a temporary textarea and execCommand.
     * @param {string} text
     */
    _clipboardFallback(text) {
        let ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    }

    /**
     * Wires up export canvas UI — resolution dropdown, custom dims, and overlay buttons.
     */
    _setupExportCanvas() {
        let exportBtn = document.getElementById('sharpsplat_export_btn');
        let resolutionSel = document.getElementById('sharpsplat_export_resolution');
        let customDims = document.getElementById('sharpsplat_export_custom_dims');
        let overlay = document.getElementById('sharpsplat_export_overlay');
        let cancelBtn = document.getElementById('sharpsplat_export_cancel_btn');
        let saveBtn = document.getElementById('sharpsplat_export_save_btn');
        let dlBtn = document.getElementById('sharpsplat_export_download_btn');
        if (!exportBtn || !resolutionSel || !overlay) {
            return;
        }
        // Show/hide custom dimension inputs.
        resolutionSel.addEventListener('change', () => {
            if (customDims) {
                customDims.style.display = resolutionSel.value === 'custom' ? '' : 'none';
            }
            // Update viewport box if overlay is currently visible.
            if (overlay.style.display !== 'none') {
                this._updateExportViewportBox();
            }
        });
        // Stop propagation on custom dimension inputs so the viewer never sees these keys.
        // Also update the viewport box live as the user types.
        for (let input of [document.getElementById('sharpsplat_export_custom_w'), document.getElementById('sharpsplat_export_custom_h')]) {
            if (input) {
                input.addEventListener('keydown', (e) => { e.stopPropagation(); });
                input.addEventListener('input', () => {
                    if (overlay.style.display !== 'none') {
                        this._updateExportViewportBox();
                    }
                });
            }
        }
        exportBtn.addEventListener('click', () => {
            if (!this._viewerLoaded) {
                showError('SharpSplat: Load a splat first before exporting.');
                return;
            }
            this._showExportOverlay();
        });
        let repairPromptBtn = document.getElementById('sharpsplat_repair_prompt_btn');
        if (repairPromptBtn) {
            repairPromptBtn.addEventListener('click', () => {
                this._generateRepairPrompt();
            });
        }
        cancelBtn.addEventListener('click', () => {
            this._hideExportOverlay();
        });
        // Close overlay on Escape.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay.style.display !== 'none') {
                this._hideExportOverlay();
            }
        });
        saveBtn.addEventListener('click', async () => {
            await this._doExportCanvas(true);
        });
        dlBtn.addEventListener('click', async () => {
            await this._doExportCanvas(false);
        });
    }

    /**
     * Shows the export overlay and positions the viewport box.
     */
    _showExportOverlay() {
        let overlay = document.getElementById('sharpsplat_export_overlay');
        let exportBtn = document.getElementById('sharpsplat_export_btn');
        let actions = document.getElementById('sharpsplat_export_actions');
        let canvasWrap = document.getElementById('sharpsplat_canvas_wrap');
        if (!overlay) {
            return;
        }
        // Position the overlay to cover only the canvas-wrap, not the status bar above it.
        if (canvasWrap && canvasWrap.parentElement) {
            let panelRect = canvasWrap.parentElement.getBoundingClientRect();
            let wrapRect = canvasWrap.getBoundingClientRect();
            overlay.style.top = Math.round(wrapRect.top - panelRect.top) + 'px';
            overlay.style.left = '0';
            overlay.style.right = '0';
            overlay.style.bottom = '0';
            overlay.style.height = '';
        }
        overlay.style.display = 'flex';
        if (exportBtn) {
            exportBtn.style.display = 'none';
        }
        if (actions) {
            actions.style.display = '';
        }
        this._updateExportViewportBox();
    }

    /**
     * Hides the export overlay.
     */
    _hideExportOverlay() {
        let overlay = document.getElementById('sharpsplat_export_overlay');
        let exportBtn = document.getElementById('sharpsplat_export_btn');
        let actions = document.getElementById('sharpsplat_export_actions');
        if (overlay) {
            overlay.style.display = 'none';
        }
        if (exportBtn) {
            exportBtn.style.display = '';
        }
        if (actions) {
            actions.style.display = 'none';
        }
    }

    /**
     * Computes the crop rectangle (in canvas pixels) for the current resolution selection.
     * Returns {x, y, w, h} relative to the canvas top-left.
    * @param {{width: number, height: number}} canvas
     */
    _computeExportCropRect(canvas) {
        let cw = canvas.width;
        let ch = canvas.height;
        let sel = document.getElementById('sharpsplat_export_resolution');
        let value = sel ? sel.value : 'none';
        if (value === 'none') {
            return { x: 0, y: 0, w: cw, h: ch };
        }
        let targetAspect;
        if (value === 'custom') {
            let wInput = document.getElementById('sharpsplat_export_custom_w');
            let hInput = document.getElementById('sharpsplat_export_custom_h');
            let cw2 = parseInt(wInput ? wInput.value : 1920) || 1920;
            let ch2 = parseInt(hInput ? hInput.value : 1080) || 1080;
            targetAspect = cw2 / ch2;
        }
        else {
            let parts = value.split(':');
            targetAspect = parseInt(parts[0]) / parseInt(parts[1]);
        }
        let canvasAspect = cw / ch;
        let cropW, cropH;
        if (targetAspect > canvasAspect) {
            // Letterbox — constrained by width.
            cropW = cw;
            cropH = Math.round(cw / targetAspect);
        }
        else {
            // Pillarbox — constrained by height.
            cropH = ch;
            cropW = Math.round(ch * targetAspect);
        }
        let x = Math.round((cw - cropW) / 2);
        let y = Math.round((ch - cropH) / 2);
        return { x, y, w: cropW, h: cropH };
    }

    /**
     * Repositions and resizes the viewport box to reflect the current crop region
     * projected from canvas pixels onto the overlay/display coordinates.
     */
    _updateExportViewportBox() {
        let canvasWrap = document.getElementById('sharpsplat_canvas_wrap');
        let viewportDiv = document.getElementById('sharpsplat_export_viewport');
        let viewportBox = document.getElementById('sharpsplat_export_viewport_box');
        if (!canvasWrap || !viewportDiv || !viewportBox) {
            return;
        }
        let canvas = this._cameraState ? this._cameraState.canvas : null;
        if (!canvas || !canvas.width || !canvas.height) {
            viewportBox.style.display = 'none';
            return;
        }
        viewportBox.style.display = '';
        let crop = this._computeExportCropRect(canvas);
        // Scale from canvas pixels to display pixels.
        let displayW = canvasWrap.clientWidth;
        let displayH = canvasWrap.clientHeight;
        let scaleX = displayW / canvas.width;
        let scaleY = displayH / canvas.height;
        let boxLeft = Math.round(crop.x * scaleX);
        let boxTop = Math.round(crop.y * scaleY);
        let boxW = Math.round(crop.w * scaleX);
        let boxH = Math.round(crop.h * scaleY);
        viewportBox.style.left = boxLeft + 'px';
        viewportBox.style.top = boxTop + 'px';
        viewportBox.style.width = boxW + 'px';
        viewportBox.style.height = boxH + 'px';
    }

    /**
     * Captures the current canvas, crops to the selected region, and either
     * saves it to the server outputs or triggers a browser download.
     * @param {boolean} saveToServer - true = Save to Outputs; false = Download.
     */
    async _doExportCanvas(saveToServer) {
        let capture;
        try {
            capture = await this._requestFrame('capture');
        }
        catch (err) {
            showError('SharpSplat: ' + err.message);
            return;
        }
        let dataUrl = capture.dataUrl;
        if (!dataUrl || dataUrl === 'data:,') {
            showError('SharpSplat: Canvas capture returned empty data. The viewer may need preserveDrawingBuffer enabled.');
            return;
        }
        // Crop the captured image using an offscreen 2D canvas.
        let img = new Image();
        img.src = dataUrl;
        await new Promise((resolve) => { img.onload = resolve; });
        let crop = this._computeExportCropRect({ width: capture.width, height: capture.height });
        let offscreen = document.createElement('canvas');
        offscreen.width = crop.w;
        offscreen.height = crop.h;
        let ctx = offscreen.getContext('2d');
        ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
        let croppedDataUrl = offscreen.toDataURL('image/png');
        // Build filename from the loaded splat name + timestamp.
        let splatName = this._getCurrentSplatName();
        let timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 15);
        let filename = (splatName ? splatName + '_' : 'canvas_') + timestamp + '.png';
        if (saveToServer) {
            let base64 = croppedDataUrl.split(',')[1];
            try {
                await new Promise((resolve, reject) => {
                    genericRequest('SharpSaveCanvasExport', { imageBase64: base64, filename: filename }, (data) => {
                        if (data.success) {
                            resolve(data);
                        }
                        else {
                            reject(new Error(data.error || 'Save failed.'));
                        }
                    });
                });
                this._hideExportOverlay();
            }
            catch (err) {
                showError('SharpSplat Export: ' + err.message);
            }
        }
        else {
            // Browser download.
            let link = document.createElement('a');
            link.href = croppedDataUrl;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            this._hideExportOverlay();
        }
    }

    /**
     * Returns a safe filename prefix derived from the currently loaded splat URL/filename.
     */
    _getCurrentSplatName() {
        if (!this._currentUrl) {
            return 'canvas';
        }
        try {
            let pathname = new URL(this._currentUrl, window.location.href).pathname;
            let base = pathname.split('/').pop();
            let dot = base.lastIndexOf('.');
            return dot > 0 ? base.slice(0, dot) : base;
        }
        catch (_) {
            return 'canvas';
        }
    }

    /**
     * Wires drop/click input handlers for the dropzone.
     * Supports both single-image (ml-sharp) and multi-image (VGGT) modes.
     */
    _setupInputDropzone() {
        let dropzone = document.getElementById('sharpsplat_dropzone');
        let fileInput = document.getElementById('sharpsplat_input_file');
        let browseBtn = document.getElementById('sharpsplat_input_browse');
        let clearBtn = document.getElementById('sharpsplat_input_clear');
        let generateBtn = document.getElementById('sharpsplat_generate_btn');
        if (!dropzone || !fileInput || !browseBtn || !clearBtn || !generateBtn) {
            return;
        }
        // Cache the preview img element so it survives innerHTML clears.
        this._previewImgEl = document.getElementById('sharpsplat_input_preview');

        // Apply initial mode from restored setting.
        this._applyDropzoneMode();

        let preventEvent = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };
        for (let eventName of ['dragenter', 'dragover']) {
            dropzone.addEventListener(eventName, (e) => {
                preventEvent(e);
                dropzone.classList.add('drag-active');
            });
        }
        for (let eventName of ['dragleave', 'dragend', 'drop']) {
            dropzone.addEventListener(eventName, (e) => {
                preventEvent(e);
                dropzone.classList.remove('drag-active');
            });
        }

        dropzone.addEventListener('click', () => {
            fileInput.click();
        });
        browseBtn.addEventListener('click', () => {
            fileInput.click();
        });

        fileInput.addEventListener('change', async () => {
            if (!fileInput.files || fileInput.files.length < 1) {
                return;
            }
            if (this._isMultiViewModel()) {
                await this._addVggtInputFiles(fileInput.files);
            }
            else {
                await this._setInputImageFromFile(fileInput.files[0]);
            }
            fileInput.value = '';
        });

        dropzone.addEventListener('drop', async (e) => {
            let files = e.dataTransfer && e.dataTransfer.files;
            if (!files || files.length < 1) {
                return;
            }
            if (this._isMultiViewModel()) {
                await this._addVggtInputFiles(files);
            }
            else {
                await this._setInputImageFromFile(files[0]);
            }
        });

        clearBtn.addEventListener('click', () => {
            this._inputImageBase64 = null;
            this._inputImageName = null;
            this._inputImagePreviewDataUrl = null;
            this._inputImages = [];
            this._updateInputImageState();
        });

        generateBtn.addEventListener('click', async () => {
            if (this._getModel() === 'vggt') {
                if (this._inputImages.length < 1) {
                    return;
                }
                let prefix = sharpSplatGetFilenamePrefix(this._inputImages[0].name || 'output');
                await sharpSplatGenerateVggt(this._inputImages, prefix);
            }
            else if (this._getModel() === 'instantsplat') {
                if (this._inputImages.length < 1) {
                    return;
                }
                let prefix = sharpSplatGetFilenamePrefix(this._inputImages[0].name || 'output');
                await sharpSplatGenerateInstantSplat(this._inputImages, prefix);
            }
            else if (this._getModel() === 'triposplat') {
                if (!this._inputImageBase64) {
                    return;
                }
                let filenamePrefix = sharpSplatGetFilenamePrefix(this._inputImageName || 'output');
                await sharpSplatGenerateTripoSplat(this._inputImageBase64, filenamePrefix);
            }
            else {
                if (!this._inputImageBase64) {
                    return;
                }
                let filenamePrefix = sharpSplatGetFilenamePrefix(this._inputImageName || 'output');
                await sharpSplatGenerateFromBase64(this._inputImageBase64, filenamePrefix);
            }
        });

        this._updateInputImageState();
    }

    /**
     * Reads one or more files into the VGGT multi-image list, deduplicating by name.
     * @param {FileList} files
     */
    async _addVggtInputFiles(files) {
        for (let file of files) {
            if (!file || !file.type || !file.type.startsWith('image/')) {
                showError('SharpSplat: Please choose image files only.');
                continue;
            }
            // Deduplicate by name.
            if (this._inputImages.some(img => img.name === file.name)) {
                continue;
            }
            try {
                let imageData = await this._readFileAsDataUrl(file);
                this._inputImages.push({ base64: imageData.base64Data, name: file.name, dataUrl: imageData.dataUrl });
            }
            catch (err) {
                showError('SharpSplat: ' + err.message);
            }
        }
        this._updateInputImageState();
    }

    /**
     * Reads a File as a data URL and returns {dataUrl, base64Data}.
     * @param {File} file
     */
    _readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            let reader = new FileReader();
            reader.onloadend = () => {
                let dataUrl = typeof reader.result === 'string' ? reader.result : '';
                let commaIndex = dataUrl.indexOf(',');
                if (commaIndex < 0) {
                    reject(new Error('Invalid image data.'));
                    return;
                }
                resolve({ dataUrl: dataUrl, base64Data: dataUrl.slice(commaIndex + 1) });
            };
            reader.onerror = () => reject(new Error('Failed to read image file.'));
            reader.readAsDataURL(file);
        });
    }

    /**
     * Reads the selected file as base64 and updates input UI state.
     * @param {File} file
     */
    async _setInputImageFromFile(file) {
        if (!file || !file.type || !file.type.startsWith('image/')) {
            showError('SharpSplat: Please choose an image file.');
            return;
        }
        try {
            let imageData = await this._readFileAsDataUrl(file);
            this._inputImageBase64 = imageData.base64Data;
            this._inputImageName = file.name || 'image';
            this._inputImagePreviewDataUrl = imageData.dataUrl;
            this._updateInputImageState();
        }
        catch (err) {
            showError('SharpSplat: ' + err.message);
        }
    }

    /**
     * Updates the sidebar input controls based on whether an image (or images) is selected.
     */
    _updateInputImageState() {
        let nameLabel = document.getElementById('sharpsplat_input_name');
        let generateBtn = document.getElementById('sharpsplat_generate_btn');
        let previewWrap = document.getElementById('sharpsplat_input_preview_wrap');
        let previewImg = this._previewImgEl || document.getElementById('sharpsplat_input_preview');
        let isVggt = this._isMultiViewModel();

        if (isVggt) {
            let count = this._inputImages.length;
            if (nameLabel) {
                nameLabel.textContent = count > 0 ? count + ' image' + (count === 1 ? '' : 's') + ' selected' : 'No images selected.';
            }
            // Render thumbnail strip.
            if (previewWrap) {
                if (count > 0) {
                    previewWrap.classList.add('active');
                    if (previewImg && previewImg.parentNode === previewWrap) {
                        previewWrap.removeChild(previewImg);
                    }
                    previewWrap.innerHTML = '';
                    let strip = createDiv(null, 'sharpsplat-multi-preview-strip');
                    for (let i = 0; i < count; i++) {
                        let img = this._inputImages[i];
                        let thumb = document.createElement('div');
                        thumb.className = 'sharpsplat-multi-thumb';
                        thumb.title = img.name;
                        let imgEl = document.createElement('img');
                        imgEl.src = img.dataUrl;
                        imgEl.alt = img.name;
                        let removeBtn = document.createElement('button');
                        removeBtn.className = 'sharpsplat-multi-thumb-remove';
                        removeBtn.innerHTML = '&times;';
                        removeBtn.title = 'Remove ' + img.name;
                        // Capture index via closure.
                        removeBtn.onclick = ((idx) => () => {
                            this._inputImages.splice(idx, 1);
                            this._updateInputImageState();
                        })(i);
                        thumb.appendChild(imgEl);
                        thumb.appendChild(removeBtn);
                        strip.appendChild(thumb);
                    }
                    previewWrap.appendChild(strip);
                }
                else {
                    previewWrap.classList.remove('active');
                    if (previewImg && previewImg.parentNode === previewWrap) {
                        previewWrap.removeChild(previewImg);
                    }
                    previewWrap.innerHTML = '';
                }
            }
            if (generateBtn) {
                generateBtn.disabled = count < 1;
            }
        }
        else {
            if (nameLabel) {
                if (this._inputImageName) {
                    nameLabel.textContent = 'Selected: ' + this._inputImageName;
                }
                else {
                    nameLabel.textContent = 'No image selected.';
                }
            }
            if (previewWrap && previewImg) {
                if (this._inputImagePreviewDataUrl) {
                    previewWrap.innerHTML = '';
                    previewWrap.appendChild(previewImg);
                    previewImg.src = this._inputImagePreviewDataUrl;
                    previewWrap.classList.add('active');
                }
                else {
                    previewImg.removeAttribute('src');
                    previewWrap.classList.remove('active');
                    previewWrap.innerHTML = '';
                    previewWrap.appendChild(previewImg);
                }
            }
            if (generateBtn) {
                generateBtn.disabled = !this._inputImageBase64;
            }
        }
    }

    /**
     * Reads the latest frame camera state into the X/Y/Z inputs.
     */
    _syncCameraInputs() {
        if (!this._cameraState) {
            return;
        }
        let active = document.activeElement;
        if (active && active.classList.contains('sharpsplat-camera-input')) {
            return;
        }
        let pos = this._cameraState.position;
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
        if (this._cameraState.target) {
            let tgt = this._cameraState.target;
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
        if (!this._viewerLoaded) {
            return;
        }
        let x = parseFloat(document.getElementById('sharpsplat_cam_x').value) || 0;
        let y = parseFloat(document.getElementById('sharpsplat_cam_y').value) || 0;
        let z = parseFloat(document.getElementById('sharpsplat_cam_z').value) || 0;
        let lx = parseFloat(document.getElementById('sharpsplat_cam_lx').value) || 0;
        let ly = parseFloat(document.getElementById('sharpsplat_cam_ly').value) || 0;
        let lz = parseFloat(document.getElementById('sharpsplat_cam_lz').value) || 0;
        this._sendFrameCommand('setCamera', { position: { x: x, y: y, z: z }, target: { x: lx, y: ly, z: lz } });
    }

    /**
     * Resets the camera to the auto-framed state captured after scene load,
     * then re-primes OrbitControls and syncs the position inputs.
     */
    resetCamera() {
        if (!this._initialCameraState || !this._viewerLoaded) {
            return;
        }
        this._sendFrameCommand('resetCamera');
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
                this._currentFilename = null;
                this._disposeViewer();
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
     * Loads a .splat file into the viewer by HTTP URL.
     * Disposes any previously active viewer instance before creating a new one.
     * @param {string} url - URL of the .splat file (e.g. /View/...).
     * @param {string} filename - Display name shown in the status bar.
     */
    async loadSplat(url, filename) {
        let status = document.getElementById('sharpsplat_status');
        this._currentUrl = url;
        this._currentFilename = filename;
        for (let row of document.querySelectorAll('.sharpsplat-file-row')) {
            let nameBtn = row.querySelector('.sharpsplat-file-entry');
            row.classList.toggle('active', nameBtn && nameBtn.dataset.url === url);
        }
        if (status) {
            status.textContent = 'Loading ' + filename + '\u2026';
        }
        if (!this._tabActive) {
            if (status) {
                status.textContent = filename + ' · Ready when Splat Viewer is opened';
            }
            return;
        }
        this._mountViewerFrame();
        if (this._viewerFrameReady) {
            this._loadCurrentSplatInFrame();
        }
    }
}

/** Singleton tab manager. */
let sharpSplatTab = new SharpSplatTabManager();

/**
 * Converts a filename or URL basename to a safe filename prefix.
 * @param {string} rawName
 */
function sharpSplatGetFilenamePrefix(rawName) {
    if (!rawName) {
        return 'output';
    }
    let base = rawName.split('/').pop().split('\\').pop();
    let dot = base.lastIndexOf('.');
    if (dot > 0) {
        return base.slice(0, dot);
    }
    return base;
}

/**
 * Generates a splat from base64 image data and loads it in the viewer.
 * @param {string} base64Data
 * @param {string} filenamePrefix
 */
async function sharpSplatGenerateFromBase64(base64Data, filenamePrefix) {
    let outputFormatSelect = document.getElementById('sharpsplat_setting_output_format');
    let outputFormat = outputFormatSelect ? outputFormatSelect.value : 'ply';
    let requestParams = { imageBase64: base64Data, filenamePrefix: filenamePrefix || 'output', outputFormat: outputFormat };
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
        await sharpSplatFinishGeneration(result);
    }
    catch (err) {
        console.error('SharpSplat error:', err);
        showError('SharpSplat: ' + err.message);
    }
}

/**
 * Generates a point-cloud PLY splat from multiple images using VGGT and loads it in the viewer.
 * Tries the ComfyUI backend route first (VGGTGenerateSplatViaComfy), which queues the
 * VGGT job through Comfy so VRAM is shared with other generations.
 * Falls back to the direct subprocess route (VGGTGenerateSplat) when no backend is available.
 * @param {Array<{base64: string, name: string}>} images
 * @param {string} filenamePrefix
 */
async function sharpSplatGenerateVggt(images, filenamePrefix) {
    let outputFormatSelect = document.getElementById('sharpsplat_setting_output_format');
    let outputFormat = outputFormatSelect ? outputFormatSelect.value : 'ply';
    let padCheck = document.getElementById('sharpsplat_setting_pad_to_square');
    let padToSquare = padCheck ? padCheck.checked : false;
    let imagesBase64 = images.map(img => img.base64);
    let requestParams = { imagesBase64: imagesBase64, filenamePrefix: filenamePrefix || 'output', outputFormat: outputFormat, padToSquare: padToSquare };
    function callVggtAPI(endpoint) {
        return new Promise((resolve, reject) => {
            genericRequest(endpoint, requestParams, (data) => {
                if (data.success) {
                    resolve(data);
                }
                else {
                    reject(new Error(data.error || 'VGGT generation failed.'));
                }
            });
        });
    }
    try {
        let result;
        try {
            let comfyPromise = callVggtAPI('VGGTGenerateSplatViaComfy');
            if (typeof updateGenCount === 'function') {
                updateGenCount();
            }
            result = await comfyPromise;
        }
        catch (comfyErr) {
            if (comfyErr.message && comfyErr.message.includes('No available ComfyUI Backend')) {
                console.warn('SharpSplat VGGT: No ComfyUI backend available, falling back to direct generation.');
                result = await callVggtAPI('VGGTGenerateSplat');
            }
            else {
                throw comfyErr;
            }
        }
        await sharpSplatFinishGeneration(result);
    }
    catch (err) {
        console.error('SharpSplat VGGT error:', err);
        showError('SharpSplat: ' + err.message);
    }
}

/**
 * Common post-generation handler: navigates to the viewer tab and loads the result.
 * @param {{splatUrl: string, filename: string}} result
 */
async function sharpSplatFinishGeneration(result) {
    // Force another poll now that the generation is complete so the counter clears promptly.
    if (typeof updateGenCount === 'function') {
        updateGenCount();
    }
    let filename = result.filename || 'output.ply';
    // Only navigate to the viewer tab if the user has the setting enabled (default: on).
    let autoNavToggle = document.getElementById('sharpsplat_setting_auto_navigate');
    if (!autoNavToggle || autoNavToggle.checked) {
        sharpSplatTab.navigateToTab();
    }
    await sharpSplatTab.refreshList();
    await sharpSplatTab.loadSplat(result.splatUrl, filename);
}

/**
 * Handles the "Generate 3D Splat" button click from the image viewer media button.
 * Routes to VGGT or ml-sharp based on the current model setting.
 * Always receives a single image from the media button.
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
    // Derive a filename prefix from the source URL.
    let filenamePrefix = 'output';
    try {
        let urlPath = src.startsWith('data:') ? '' : new URL(src, window.location.href).pathname;
        if (urlPath) {
            filenamePrefix = sharpSplatGetFilenamePrefix(urlPath);
        }
    }
    catch (_) {}
    let model = sharpSplatTab._getModel();
    if (model === 'triposplat') {
        await sharpSplatGenerateTripoSplat(base64Data, filenamePrefix);
    }
    else {
        await sharpSplatGenerateFromBase64(base64Data, filenamePrefix);
    }
}

/**
 * Generates a Gaussian splat from a single image using TripoSplat and loads it in the viewer.
 * Tries the ComfyUI backend route first (TripoSplatGenerateSplatViaComfy), falling back to
 * the direct subprocess route (TripoSplatGenerateSplat) when no backend is available.
 * @param {string} base64Data
 * @param {string} filenamePrefix
 */
async function sharpSplatGenerateTripoSplat(base64Data, filenamePrefix) {
    let outputFormatSelect = document.getElementById('sharpsplat_setting_output_format');
    let outputFormat = outputFormatSelect ? outputFormatSelect.value : 'ply';
    let requestParams = { imageBase64: base64Data, filenamePrefix: filenamePrefix || 'output', outputFormat: outputFormat };
    function callTripoAPI(endpoint) {
        return new Promise((resolve, reject) => {
            genericRequest(endpoint, requestParams, (data) => {
                if (data.success) {
                    resolve(data);
                }
                else {
                    reject(new Error(data.error || 'TripoSplat generation failed.'));
                }
            });
        });
    }
    try {
        let result;
        try {
            let comfyPromise = callTripoAPI('TripoSplatGenerateSplatViaComfy');
            if (typeof updateGenCount === 'function') {
                updateGenCount();
            }
            result = await comfyPromise;
        }
        catch (comfyErr) {
            if (comfyErr.message && comfyErr.message.includes('No available ComfyUI Backend')) {
                console.warn('SharpSplat TripoSplat: No ComfyUI backend available, falling back to direct generation.');
                result = await callTripoAPI('TripoSplatGenerateSplat');
            }
            else {
                throw comfyErr;
            }
        }
        await sharpSplatFinishGeneration(result);
    }
    catch (err) {
        console.error('SharpSplat TripoSplat error:', err);
        showError('SharpSplat: ' + err.message);
    }
}

/**
 * Generates a point-cloud PLY splat from multiple images using InstantSplat and loads it in the viewer.
 * Tries the ComfyUI backend route first (InstantSplatGenerateSplatViaComfy), which queues the
 * InstantSplat job through Comfy so VRAM is shared with other generations.
 * Falls back to the direct subprocess route (InstantSplatGenerateSplat) when no backend is available.
 * @param {Array<{base64: string, name: string}>} images
 * @param {string} filenamePrefix
 */
async function sharpSplatGenerateInstantSplat(images, filenamePrefix) {
    let outputFormatSelect = document.getElementById('sharpsplat_setting_output_format');
    let outputFormat = outputFormatSelect ? outputFormatSelect.value : 'ply';
    let padCheck = document.getElementById('sharpsplat_setting_pad_to_square');
    let padToSquare = padCheck ? padCheck.checked : false;
    let imagesBase64 = images.map(img => img.base64);
    let requestParams = { imagesBase64: imagesBase64, filenamePrefix: filenamePrefix || 'output', outputFormat: outputFormat, padToSquare: padToSquare };
    function callInstantSplatAPI(endpoint) {
        return new Promise((resolve, reject) => {
            genericRequest(endpoint, requestParams, (data) => {
                if (data.success) {
                    resolve(data);
                }
                else {
                    reject(new Error(data.error || 'InstantSplat generation failed.'));
                }
            });
        });
    }
    try {
        let result;
        try {
            let comfyPromise = callInstantSplatAPI('InstantSplatGenerateSplatViaComfy');
            if (typeof updateGenCount === 'function') {
                updateGenCount();
            }
            result = await comfyPromise;
        }
        catch (comfyErr) {
            if (comfyErr.message && comfyErr.message.includes('No available ComfyUI Backend')) {
                console.warn('SharpSplat InstantSplat: No ComfyUI backend available, falling back to direct generation.');
                result = await callInstantSplatAPI('InstantSplatGenerateSplat');
            }
            else {
                throw comfyErr;
            }
        }
        await sharpSplatFinishGeneration(result);
    }
    catch (err) {
        console.error('SharpSplat InstantSplat error:', err);
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
