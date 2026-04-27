import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';

export default {
    input: 'splat-viewer-entry.js',
    output: {
        file: 'Assets/splat-viewer.bundle.js',
        format: 'es',
        inlineDynamicImports: true,
    },
    plugins: [
        nodeResolve({ browser: true }),
        terser(),
    ],
    onwarn(warning, warn) {
        if (warning.code === 'CIRCULAR_DEPENDENCY') { return; }
        if (warning.code === 'EVAL') { return; }
        warn(warning);
    },
};
