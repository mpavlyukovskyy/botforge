import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['bots/argus/**/*.test.ts', 'bots/trainer/**/*.test.js'],
    environment: 'node',
    globals: true,
  },
});
