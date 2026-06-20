import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the built page also works when served from a sub-path. The
// voxel worker is an ES module worker; Vite bundles it with no extra plugins.
// Height tiles live under public/pyramid/ and are served as static assets.
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2020' },
});
