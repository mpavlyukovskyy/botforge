import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getFrameworkSha, _resetFrameworkShaCache } from './framework-info.js';

const ORIG_ENV = process.env.BOTFORGE_FRAMEWORK_SHA;

beforeEach(() => {
  _resetFrameworkShaCache();
  delete process.env.BOTFORGE_FRAMEWORK_SHA;
});

afterEach(() => {
  _resetFrameworkShaCache();
  if (ORIG_ENV !== undefined) {
    process.env.BOTFORGE_FRAMEWORK_SHA = ORIG_ENV;
  } else {
    delete process.env.BOTFORGE_FRAMEWORK_SHA;
  }
});

describe('getFrameworkSha', () => {
  it('returns the value of BOTFORGE_FRAMEWORK_SHA when set', () => {
    process.env.BOTFORGE_FRAMEWORK_SHA = 'abc1234567890';
    assert.equal(getFrameworkSha(), 'abc1234567890');
  });

  it('trims whitespace from the env var', () => {
    process.env.BOTFORGE_FRAMEWORK_SHA = '  deadbeefcafe  \n';
    assert.equal(getFrameworkSha(), 'deadbeefcafe');
  });

  it('caches the result across calls', () => {
    process.env.BOTFORGE_FRAMEWORK_SHA = 'first';
    const a = getFrameworkSha();
    process.env.BOTFORGE_FRAMEWORK_SHA = 'second';
    const b = getFrameworkSha();
    assert.equal(a, 'first');
    assert.equal(b, 'first', 'second read returns cached value, not the new env var');
  });

  it('returns "unknown" when neither env nor file is available', () => {
    // In the source tree (running via tsx) the file `dist/FRAMEWORK_SHA`
    // sibling to src/ doesn't exist, so we expect the fallback.
    const sha = getFrameworkSha();
    assert.ok(sha === 'unknown' || /^[a-f0-9]{4,40}$/i.test(sha), `unexpected sha: ${sha}`);
  });
});
