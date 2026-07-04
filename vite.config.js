import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // Bật các headers bắt buộc để kích hoạt Cross-Origin Isolation
    // Giúp FFmpeg và Web Worker chạy mượt mà không bị treo trình duyệt
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util']
  }
});
