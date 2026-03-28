import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: false,
      injectRegister: 'auto',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        runtimeCaching: [
          { urlPattern: /^https:\/\/api\.open-meteo\.com\//, handler: 'StaleWhileRevalidate', options: { cacheName: 'weather' } },
          { urlPattern: /^https:\/\/api\.nal\.usda\.gov\//, handler: 'CacheFirst', options: { cacheName: 'usda', expiration: { maxAgeSeconds: 86400 } } },
          { urlPattern: /^https:\/\/fonts\.googleapis\.com\//, handler: 'StaleWhileRevalidate', options: { cacheName: 'google-fonts-stylesheets' } },
          { urlPattern: /^https:\/\/fonts\.gstatic\.com\//, handler: 'CacheFirst', options: { cacheName: 'google-fonts-webfonts', expiration: { maxAgeSeconds: 31536000 } } },
        ],
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
