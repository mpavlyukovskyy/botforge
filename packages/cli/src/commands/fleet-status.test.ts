import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The CLI command is wired to ssh/curl, which would be a network test.
// Here we cover the pure functions we can reach without mocking SSH.

import { currentFrameworkSha } from './build.js';

describe('currentFrameworkSha', () => {
  it('returns either a hex git SHA or the literal "unknown"', () => {
    const sha = currentFrameworkSha();
    if (sha === 'unknown') {
      // not in a git checkout — acceptable
      return;
    }
    assert.match(sha, /^[a-f0-9]{7,40}$/i, `expected hex SHA, got: ${sha}`);
  });
});
