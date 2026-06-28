import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isLoadableToolFile } from './tool-registry.js';

/**
 * Regression: tool files shipped alongside vitest tests must not be loaded as
 * tools. Loading get_balance.test.js as a tool threw "Vitest mocker was not
 * initialized" on every kristina boot (pre-existing, surfaced Jun 2026).
 */
describe('isLoadableToolFile', () => {
  it('loads real tool source files', () => {
    for (const f of ['get_balance.js', 'create-tier.ts', 'block-unblock.js']) {
      assert.equal(isLoadableToolFile(f), true, f);
    }
  });

  it('excludes test and spec files (.js and .ts) and type decls', () => {
    for (const f of [
      'get_balance.test.js',
      'create-dedup.test.ts',
      'deduction-tools.spec.js',
      'block-unblock.spec.ts',
      'tool-registry.d.ts',
    ]) {
      assert.equal(isLoadableToolFile(f), false, f);
    }
  });
});
