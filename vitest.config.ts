import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['bots/argus/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
});
