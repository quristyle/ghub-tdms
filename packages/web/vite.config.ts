import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    // 개발 중에는 Vite 가 API 로 넘긴다. 운영에서는 nginx 가 같은 일을 한다.
    proxy: { '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false, rewrite: (p) => p.replace(/^\/api/, '') } },
  },
  build: {
    target: 'es2022',
    // 라우트별 코드 스플리팅 — 첫 진입 번들을 150KB(gzip) 아래로
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['vue', 'vue-router', 'pinia'],
          query: ['@tanstack/vue-query', '@tanstack/vue-virtual'],
        },
      },
    },
  },
})
