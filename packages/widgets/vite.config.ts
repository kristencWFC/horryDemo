import { defineConfig } from 'vite';

// IIFE bundle — the WxCC Agent Desktop loads widgets with a plain <script>
// tag, so ESM output would never register the custom elements.
export default defineConfig({
  build: {
    lib: {
      entry: 'src/main.ts',
      name: 'HorryWidgets',
      formats: ['iife'],
      fileName: () => 'horry-widgets.js',
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
});
