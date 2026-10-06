import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import react from '@vitejs/plugin-react';

const proxyTarget = process.env.PROXY_TARGET ?? 'http://127.0.0.1:8826';
const MORIKO_HOME = process.env.MORIKO_HOME ?? resolve(homedir(), '.moriko-studio');
const ADDONS_DIR = resolve(MORIKO_HOME, 'addons');
const VITE_CACHE_DIR = resolve(homedir(), 'node_modules', '.vite-cache');

export default defineConfig({
  plugins: [react()],
  cacheDir: VITE_CACHE_DIR,
  server: {
    port: 5588,
    strictPort: false,
    hmr: {
      overlay: false,
    },
    allowedHosts: ['.trycloudflare.com'],
    host: true,
    fs: {
      allow: ['.', ADDONS_DIR],
    },
    proxy: {
      '/api': {
        target: proxyTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  resolve: {
    alias: {
      '/addon-modules': ADDONS_DIR,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        'browser-view': resolve(__dirname, 'browser-view.html'),
      },
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
        },
      },
    },
  },
});
