import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, renderError } from './error-messages.js';

const USAGE_LIMIT_400 =
  'Brain query failed: Claude Code returned an error result: API Error: 400 ' +
  '{"type":"error","error":{"type":"invalid_request_error","message":' +
  '"You have reached your specified API usage limits. You will regain access on 2026-06-01 at 00:00 UTC."}}';

test('classifyError detects the Anthropic spend-cap 400', () => {
  assert.equal(classifyError(new Error(USAGE_LIMIT_400)), 'usage_limit');
  assert.equal(classifyError('You have reached your specified API usage limits'), 'usage_limit');
});

test('classifyError detects rate limit, auth, timeout, tool, unknown', () => {
  assert.equal(classifyError(new Error('HTTP 429 rate limit')), 'rate_limited');
  assert.equal(classifyError(new Error('401 unauthorized')), 'auth');
  assert.equal(classifyError(new Error('invalid api key')), 'auth');
  const ab = new Error('aborted'); ab.name = 'AbortError';
  assert.equal(classifyError(ab), 'brain_timeout');
  assert.equal(classifyError(new Error('query timed out after 120s')), 'brain_timeout');
  assert.equal(classifyError(new Error('tool execution failed')), 'tool_error');
  assert.equal(classifyError(new Error('something weird')), 'unknown');
  assert.equal(classifyError(null), 'unknown');
});

test('renderError(usage_limit) is honest and parses the regain date', () => {
  const msg = renderError('usage_limit', { errorMessage: USAGE_LIMIT_400, ref: 'abcd1234' });
  assert.match(msg, /monthly API budget/);
  assert.match(msg, /2026-06-01 at 00:00 UTC/);
  assert.match(msg, /ref abcd1234/);
});

test('renderError(usage_limit) falls back gracefully when no date present', () => {
  const msg = renderError('usage_limit', { errorMessage: 'usage limit reached', ref: 'r1' });
  assert.match(msg, /monthly API budget/);
  assert.match(msg, /until it resets/);
  assert.match(msg, /ref r1/);
});

test('renderError covers auth / rate_limited / brain_timeout / tool_error / unknown', () => {
  assert.match(renderError('auth', { ref: 'a' }), /API key isn't working/);
  assert.match(renderError('rate_limited', { ref: 'a' }), /rate-limited/);
  assert.match(renderError('brain_timeout', { ref: 'a' }), /took too long/);
  assert.match(renderError('tool_error', { ref: 'a' }), /tools? failed/);
  assert.match(renderError('unknown', { ref: 'a' }), /Failed to process/);
});

test('renderError generates a ref when none supplied', () => {
  assert.match(renderError('unknown'), /ref [a-z0-9]{1,}/);
});
