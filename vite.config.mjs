import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server serves src/ as native ESM and does not convert CommonJS; src/*.cjs files are
// shared with the Node server (require), so wrap them as ESM with a default export in dev.
// The production build already handles CommonJS.
function cjsSourceAsEsm() {
  return {
    name: 'cjs-source-as-esm',
    apply: 'serve',
    transform(code, id) {
      const file = id.split('?')[0];
      if (!file.endsWith('.cjs') || file.includes('/node_modules/')) return null;
      return {
        code: `const module = { exports: {} };\nconst exports = module.exports;\n${code}\nexport default module.exports;\n`,
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [react(), cjsSourceAsEsm()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
