/**
 * Test harness exports. Imported by tests via `@botforge/core/testing`.
 * Not loaded by production runtime.
 *
 * Tests that need an in-memory SQLite should construct one in their own
 * test file with better-sqlite3 — kept out of core to avoid adding a
 * native-module dependency to every framework consumer.
 */

export { MockAdapter, type MockAdapterOptions } from './MockAdapter.js';
export { fakeClock, type FakeClock } from './clock.js';
