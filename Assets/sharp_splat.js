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
                if (this._viewer && this._viewer.controls) {
                    this._viewer.controls.rotateSpeed = invertToggle.checked ? -0.5 : 0.5;
                }
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
            acc.classList.toggle('open', isOpen);
            let btn = acc.querySelector('.sharpsplat-accordion-header');
            if (btn) {
                btn.addEventListener('click', () => {
                    let open = acc.classList.toggle('open');
                    localStorage.setItem(id, open ? 'true' : 'false');
                });
            }
        }
        this._setupExportCanvas();
        // Restore and persist the auto-navigate toggle.
        let autoNavToggle = document.getElementById('sharpsplat_setting_auto_navigate');
        if (autoNavToggle) {
            autoNavToggle.checked = localStorage.getItem('sharpsplat_auto_navigate') !== 'false';
            autoNavToggle.addEventListener('change', () => {
                localStorage.setItem('sharpsplat_auto_navigate', autoNavToggle.checked ? 'true' : 'false');
            });
        }
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
        // Track hover over the canvas wrap. On mouseenter we also focus the canvas so
        // the keyboard listeners (redirected to the canvas by the rollup patch) fire only
        // while the user is actively hovering the viewer.
        let canvasWrap = document.getElementById('sharpsplat_canvas_wrap');
        if (canvasWrap) {
            canvasWrap.addEventListener('mouseenter', () => {
                this._canvasHovered = true;
                let c = canvasWrap.querySelector('canvas');
                if (c) { c.focus({ preventScroll: true }); }
            });
            canvasWrap.addEventListener('mouseleave', () => { this._canvasHovered = false; });
        }
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
            if (!this._viewer) {
                showError('SharpSplat: Load a splat first before exporting.');
                return;
            }
            this._showExportOverlay();
        });
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
     * @param {HTMLCanvasElement} canvas
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
        let canvas = canvasWrap.querySelector('canvas');
        if (!canvas) {
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
        let canvasWrap = document.getElementById('sharpsplat_canvas_wrap');
        if (!canvasWrap) {
            return;
        }
        let canvas = canvasWrap.querySelector('canvas');
        if (!canvas) {
            showError('SharpSplat: No canvas found. Load a splat first.');
            return;
        }
        // Capture the canvas — schedule within a rAF so the frame buffer is populated.
        let dataUrl = await new Promise((resolve) => {
            requestAnimationFrame(() => {
                try {
                    let raw = canvas.toDataURL('image/png');
                    resolve(raw);
                }
                catch (e) {
                    resolve(null);
                }
            });
        });
        if (!dataUrl || dataUrl === 'data:,') {
            showError('SharpSplat: Canvas capture returned empty data. The viewer may need preserveDrawingBuffer enabled.');
            return;
        }
        // Crop the captured image using an offscreen 2D canvas.
        let img = new Image();
        img.src = dataUrl;
        await new Promise((resolve) => { img.onload = resolve; });
        let crop = this._computeExportCropRect(canvas);
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
                let _invertToggle = document.getElementById('sharpsplat_setting_invert_controls');
                if (_invertToggle && _invertToggle.checked) {
                    this._viewer.controls.rotateSpeed = -0.5;
                }
            }

            let _canvas = wrap.querySelector('canvas');
            if (_canvas) {
                // Make the canvas focusable so the redirected keydown listeners
                // (on the canvas element, via rollup patches 3-5) only fire while
                // the canvas has focus — preventing keyboard bleed to other tabs.
                _canvas.tabIndex = -1;
                _canvas.style.outline = 'none';
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
    await sharpSplatGenerateFromBase64(base64Data, filenamePrefix);
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
