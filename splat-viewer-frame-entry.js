import { Viewer, SceneRevealMode, LogLevel } from '@mkkellogg/gaussian-splats-3d';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

let viewer = null;
let viewerType = null;
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
    viewerType = null;
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
    viewerType = 'splat';
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

/** Disposes every GPU resource owned by a loaded Three.js model. */
function disposeMeshModel(model) {
    if (model) {
        model.traverse((object) => {
            if (object.geometry) {
                object.geometry.dispose();
            }
            let materials = Array.isArray(object.material) ? object.material : [object.material];
            for (let material of materials) {
                if (!material) {
                    continue;
                }
                for (let value of Object.values(material)) {
                    if (value && value.isTexture) {
                        value.dispose();
                    }
                }
                material.dispose();
            }
        });
    }
}

/** Disposes a Three.js mesh viewer and every GPU resource owned by its model. */
function disposeMeshViewer(meshViewer) {
    cancelAnimationFrame(meshViewer.animationFrame);
    meshViewer.resizeObserver.disconnect();
    meshViewer.controls.dispose();
    disposeMeshModel(meshViewer.model);
    meshViewer.renderer.dispose();
    meshViewer.renderer.forceContextLoss();
}

/** Creates a Three.js viewer and loads one GLB URL. */
async function loadMesh(payload) {
    disposeViewer();
    let generation = loadGeneration;
    let root = document.getElementById('viewer-root');
    let scene = new THREE.Scene();
    scene.background = new THREE.Color(0x101214);
    let camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10000);
    let renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    root.appendChild(renderer.domElement);
    let controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.rotateSpeed = payload.invertControls ? -0.5 : 0.5;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x303840, 2));
    let keyLight = new THREE.DirectionalLight(0xffffff, 3);
    keyLight.position.set(4, 6, 5);
    scene.add(keyLight);

    let resize = () => {
        let width = root.clientWidth || 800;
        let height = root.clientHeight || 600;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
    };
    let resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(root);
    resize();

    let meshViewer = {
        scene: scene,
        camera: camera,
        renderer: renderer,
        controls: controls,
        model: null,
        animationFrame: 0,
        resizeObserver: resizeObserver,
        dispose() {
            disposeMeshViewer(this);
        }
    };
    viewer = meshViewer;
    viewerType = 'mesh';

    try {
        let gltf = await new GLTFLoader().loadAsync(payload.url);
        if (generation !== loadGeneration || viewer !== meshViewer) {
            disposeMeshModel(gltf.scene);
            return;
        }
        meshViewer.model = gltf.scene;
        scene.add(gltf.scene);
        let bounds = new THREE.Box3().setFromObject(gltf.scene);
        if (bounds.isEmpty()) {
            throw new Error('The GLB contains no visible geometry.');
        }
        let center = bounds.getCenter(new THREE.Vector3());
        let size = bounds.getSize(new THREE.Vector3());
        let maxSize = Math.max(size.x, size.y, size.z);
        let distance = Math.max(maxSize / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5))) * 1.35, 0.1);
        camera.near = Math.max(distance / 1000, 0.001);
        camera.far = Math.max(distance * 100, 100);
        camera.position.set(center.x + distance * 0.55, center.y + distance * 0.35, center.z + distance);
        camera.updateProjectionMatrix();
        controls.target.copy(center);
        controls.update();

        let render = () => {
            if (generation !== loadGeneration || viewer !== meshViewer) {
                return;
            }
            controls.update();
            renderer.render(scene, camera);
            meshViewer.animationFrame = requestAnimationFrame(render);
        };
        render();
        startCameraSync();
        requestAnimationFrame(() => captureInitialCamera(generation));
        sendToHost('loaded', { url: payload.url, assetType: 'mesh' });
    }
    catch (error) {
        if (generation === loadGeneration) {
            sendToHost('error', { message: error.message || String(error) });
            disposeViewer();
        }
    }
}

/** Loads an asset with the renderer appropriate for its declared type or extension. */
function loadAsset(payload) {
    let assetType = payload.assetType || (/\.glb(?:$|[?#])/i.test(payload.url) ? 'mesh' : 'splat');
    if (assetType === 'mesh') {
        loadMesh(payload);
    }
    else {
        loadSplat(payload);
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
        loadAsset(payload);
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