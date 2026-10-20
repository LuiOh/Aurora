import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 빌드 결과를 file:// 로 여므로 상대 경로를 쓴다
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
  test: { include: ['tests/**/*.test.ts'] },
});
