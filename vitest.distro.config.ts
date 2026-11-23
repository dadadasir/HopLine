import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/distro/**/*.test.ts'],
    exclude: [
      ...process.env.HOPLINE_CAPTURE_PROBE ? [] : ['tests/distro/capture.test.ts'],
      ...process.env.HOPLINE_DISTRO_UNIT === '1' ? [] : ['tests/distro/harness.test.ts']
    ],
    testTimeout: 120_000,
    hookTimeout: 1_200_000,
    fileParallelism: false,
    // node_modules 可能是共享软链接，靶机测试不向其中写缓存。
    cache: false,
    fsModuleCache: false
  }
})
