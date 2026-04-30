import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,   // 5173 = Reckoner, 5174 = Model Builder — run both simultaneously
    proxy: {
      // Forward /api/mb/* to the Python backend
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      }
    }
  }
})
