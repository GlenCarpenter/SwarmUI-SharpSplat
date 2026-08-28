import { Viewer, SceneRevealMode, LogLevel } from '@mkkellogg/gaussian-splats-3d';

let viewer = null;
let initialCameraState = null;
let loadGeneration = 0;
let cameraSyncGeneration = 0;

/** Sends an event to the SharpSplat host controller. */
function sendToHost(type, payload = {}, requestId = null) {
    window.parent.postMessage({ source: 'sharpsplat-viewer', type: type, payload: payload, requestId: requestId }, window.location.origin);
}

/** Returns a serializable snapshot of the active camera and canvas. */
function getViewerState() {
    if (!viewer || !viewer.camera || !viewer.controls) {
        return null;
    }
    let position = viewer.camera.position;
    let target = viewer.controls.target;
    let rotation = viewer.camera.rotation;
    let quaternion = viewer.camera.quaternion;
    let up = viewer.camera.up;
    let canvas = viewer.renderer ? viewer.renderer.domElement : null;
    return {
        position: { x: position.x, y: position.y, z: position.z },
        target: { x: target.x, y: target.y, z: target.z },
        rotation: { x: rotation.x, y: rotation.y, z: rotation.z },
        quaternion: { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w },
        up: { x: up.x, y: up.y, z: up.z },
        canvas: { width: canvas ? canvas.width : 0, height: canvas ? canvas.height : 0 }
    };
}

/** Stops and disposes the active viewer and all of its workers and listeners. */
function disposeViewer() {
    loadGeneration++;
    cameraSyncGeneration++;
    initialCameraState = null;
    if (viewer) {
        viewer.dispose();
        viewer = null;
    }
    let root = document.getElementById('viewer-root');
    root.innerHTML = '';
}

/** Posts camera changes at most once per animation frame and stops with the viewer. */
function startCameraSync() {
    let generation = ++cameraSyncGeneration;
    let previousJson = '';
    let lastSentAt = 0;
    let loop = () => {
        if (generation !== cameraSyncGeneration || !viewer) {
            return;
        }
        let now = performance.now();
        if (now - lastSentAt >= 50) {
            let state = getViewerState();
            if (state) {
                let stateJson = JSON.stringify(state);
                if (stateJson !== previousJson) {
                    previousJson = stateJson;
                    lastSentAt = now;
                    sendToHost('cameraChanged', state);
                }
            }
        }
        requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
}

/** Waits for auto-framing, then captures the reset-camera state. */
function captureInitialCamera(generation) {
    if (generation !== loadGeneration || !viewer) {
        return;
    }
    let state = getViewerState();
    if (state && Number.isFinite(state.position.x) && Number.isFinite(state.position.y) && Number.isFinite(state.position.z)
        && (state.position.x !== 0 || state.position.y !== 0 || state.position.z !== 0)) {
        initialCameraState = state;
        sendToHost('initialCamera', state);
        return;
    }
    requestAnimationFrame(() => captureInitialCamera(generation));
}

/** Creates a viewer and loads one splat URL. */
async function loadSplat(payload) {
    disposeViewer();
    let generation = loadGeneration;
    let root = document.getElementById('viewer-root');
    viewer = new Viewer({
        rootElement: root,
        cameraUp: [0, -1, 0],
        initialCameraPosition: [0, 0, 1],
        renderWidth: root.clientWidth || 800,
        renderHeight: root.clientHeight || 600,
        sharedMemoryForWorkers: false,
        gpuAcceleratedSort: false,
        sceneRevealMode: SceneRevealMode.Instant,
        logLevel: LogLevel.None
    });
    try {
        await viewer.addSplatScene(payload.url, {
            splatAlphaRemovalThreshold: 5,
            showLoadingUI: false,
            rotation: [0, 1, 0, 0]
        });
        if (generation !== loadGeneration || !viewer) {
            return;
        }
        viewer.start();
        if (viewer.controls) {
            viewer.controls.rotateSpeed = payload.invertControls ? -0.5 : 0.5;
        }
        startCameraSync();
        requestAnimationFrame(() => captureInitialCamera(generation));
        sendToHost('loaded', { url: payload.url });
    }
    catch (error) {
        if (generation === loadGeneration) {
            sendToHost('error', { message: error.message || String(error) });
        }
    }
}

/** Captures the current WebGL canvas as a PNG data URL. */
function captureCanvas(requestId) {
    requestAnimationFrame(() => {
        let canvas = viewer && viewer.renderer ? viewer.renderer.domElement : null;
        let dataUrl = null;
        try {
            dataUrl = canvas ? canvas.toDataURL('image/png') : null;
        }
        catch (_) {
            dataUrl = null;
        }
        sendToHost('response', {
            dataUrl: dataUrl,
            width: canvas ? canvas.width : 0,
            height: canvas ? canvas.height : 0
        }, requestId);
    });
}

/** Handles commands from the parent SwarmUI document. */
window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin || event.source !== window.parent || !event.data || event.data.source !== 'sharpsplat-host') {
        return;
    }
    let message = event.data;
    let payload = message.payload || {};
    if (message.type === 'load') {
        loadSplat(payload);
    }
    else if (message.type === 'dispose') {
        disposeViewer();
    }
    else if (message.type === 'setCamera' && viewer && viewer.camera && viewer.controls) {
        viewer.camera.position.set(payload.position.x, payload.position.y, payload.position.z);
        viewer.controls.target.set(payload.target.x, payload.target.y, payload.target.z);
        viewer.controls.update();
    }
    else if (message.type === 'resetCamera' && viewer && initialCameraState) {
        let state = initialCameraState;
        viewer.camera.position.set(state.position.x, state.position.y, state.position.z);
        viewer.camera.quaternion.set(state.quaternion.x, state.quaternion.y, state.quaternion.z, state.quaternion.w);
        viewer.camera.up.set(state.up.x, state.up.y, state.up.z);
        viewer.controls.target.set(state.target.x, state.target.y, state.target.z);
        viewer.controls.update();
    }
    else if (message.type === 'setInvertControls' && viewer && viewer.controls) {
        viewer.controls.rotateSpeed = payload.enabled ? -0.5 : 0.5;
    }
    else if (message.type === 'capture') {
        captureCanvas(message.requestId);
    }
});

window.addEventListener('pagehide', disposeViewer);
sendToHost('ready');