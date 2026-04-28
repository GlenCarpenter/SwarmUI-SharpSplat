import { nodeResolve } from '@rollup/plugin-node-resolve';

/** Monkey-patch fixes applied to @mkkellogg/gaussian-splats-3d at bundle time. */
export function gaussianSplatsPatch() {
    return {
        name: 'gaussian-splats-patch',
        transform(code, id) {
            if (!id.includes('gaussian-splats-3d')) { return null; }
            // Patch 1 (OrbitControls): skip key events when an input/textarea is focused.
            code = code.replace(
                `if ( scope.enabled === false || scope.enablePan === false ) return;\n\n            handleKeyDown( event );`,
                `if ( scope.enabled === false || scope.enablePan === false ) return;\n\n            const target = event.target;\n            if ( target && ( target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable ) ) return;\n\n            handleKeyDown( event );`
            );
            // Patch 2 (Viewer): add setControlsEnabled helper method.
            code = code.replace(
                `    setRenderMode(renderMode) {\n        this.renderMode = renderMode;\n    }\n\n    setActiveSphericalHarmonicsDegrees(`,
                `    setRenderMode(renderMode) {\n        this.renderMode = renderMode;\n    }\n\n    setControlsEnabled(enabled) {\n        for (const controls of [this.perspectiveControls, this.orthographicControls]) {\n            if (controls) { controls.enabled = enabled; }\n        }\n    }\n\n    setActiveSphericalHarmonicsDegrees(`
            );
            return { code, map: null };
        },
    };
}

export default {
    input: 'splat-viewer-entry.js',
    output: {
        file: 'Assets/splat-viewer.bundle.js',
        format: 'es',
        inlineDynamicImports: true,
    },
    plugins: [
        gaussianSplatsPatch(),
        nodeResolve({ browser: true }),
    ],
    onwarn(warning, warn) {
        // Suppress common noise from large third-party libraries.
        if (warning.code === 'CIRCULAR_DEPENDENCY') { return; }
        if (warning.code === 'EVAL') { return; }
        warn(warning);
    },
};
