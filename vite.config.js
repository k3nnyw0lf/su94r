import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // injectManifest, NOT generateSW.
      //
      // src/sw.js was written for injectManifest all along — it imports from
      // workbox-precaching and calls precacheAndRoute(self.__WB_MANIFEST). The
      // config never matched, so Workbox generated its own worker and
      // OVERWROTE it at build time. The deployed sw.js was 2.7KB of pure
      // caching with zero push handlers, which silently killed glucose alerts
      // and background CGM polling — the app's most safety-relevant feature,
      // and one the README advertises.
      //
      // Runtime caching now lives in src/sw.js because injectManifest does not
      // accept a runtimeCaching option. That is the correct home for it: the
      // same file owns push, periodicsync and notification handling, none of
      // which a generated worker can express.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      registerType: 'autoUpdate',
      manifest: false,
      injectRegister: 'auto',
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // The exercise catalog and its five translation bundles add ~4MB.
        // Precaching them would make first load on mobile data punitive for a
        // tab most users open occasionally. src/sw.js runtime-caches them
        // instead: first visit to Fitness pays, every visit after is instant.
        globIgnores: ['**/exercises.index-*.js', '**/assets/{en,es,fr,zh,hi}-*.js'],
      },
    }),
  ],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          charts: ['recharts'],
          utils: ['date-fns', 'zustand'],
        },
      },
    },
  },
  server: { port: 3000 },
});
