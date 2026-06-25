import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// AgentPrism web client. The backend (ACP bridge + workflow executor) runs on
// :8787; Vite proxies REST (/api) and the WebSocket (/ws) to it in dev.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
      '@shared': path.resolve(import.meta.dirname, './shared'),
      // If the verify build surfaces a "require is not defined" warning from the
      // live Handlebars compile in the prompt preview, uncomment the alias below to
      // force the full CJS build (per prompt-template-system-design §2.2):
      // handlebars: 'handlebars/dist/cjs/handlebars.js',
    },
  },
  // The Handlebars FULL build is required because the prompt live-preview compiles
  // user input at runtime; pre-bundle it so the browser gets a single optimized dep.
  optimizeDeps: {
    include: ['handlebars'],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/ws': { target: 'http://localhost:8787', ws: true },
    },
  },
})
