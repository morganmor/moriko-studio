// TEMPORARY preview config: dep optimization (esbuild's deps_temp writes) is
// blocked in this environment, so the built app is served with the same API
// proxy the dev server uses.
import base from './vite.config.ts';

export default {
  ...base,
  cacheDir: 'node_modules/.vite',
  preview: {
    port: 5588,
    strictPort: false,
    host: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8826', changeOrigin: true, ws: true },
    },
  },
};
