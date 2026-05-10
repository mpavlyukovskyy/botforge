import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['bots/argus/**/*.test.ts', 'bots/trainer/**/*.test.js', 'bots/harry/**/*.test.js', 'bots/maia/**/*.test.js', 'bots/alfred/**/*.test.js'],
    environment: 'node',
    globals: true,
  },
});
