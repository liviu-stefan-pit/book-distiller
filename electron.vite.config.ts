import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        include: ['@napi-rs/canvas', '@myriaddreamin/typst-ts-node-compiler'],
      },
    },
  },
  preload: {
    build: {
      rolldownOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
