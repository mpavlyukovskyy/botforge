/**
 * Tests for runtime.ts structured-error helpers.
 *
 * These cover the classification + rendering of brain errors that surfaced
 * from the 2026-05-18 kristina outage (Anthropic spending cap). Before this
 * change, all errors were swallowed into "Sorry, I couldn't process that."
 * with no class, ref, or timestamp.
 *
 * Uses node:test (not vitest) to match the rest of @botforge/core.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, renderStructuredError, type ErrorClass } from './runtime.js';

describe('classifyError', () => {
  it('classifies Anthropic spending-cap error as usage_limit', () => {
    // The exact body Anthropic returned on 2026-05-18
    const err = new Error(
      'Brain query failed: Claude Code returned an error result: API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-06-01 at 00:00 UTC."}}'
    );
    assert.strictEqual(classifyError(err), 'usage_limit');
  });

  it('classifies 429 as rate_limited', () => {
    assert.strictEqual(classifyError(new Error('Request failed with status 429')), 'rate_limited');
  });

  it('classifies 529 (overloaded) as rate_limited', () => {
    assert.strictEqual(classifyError(new Error('API Error: 529 — overloaded')), 'rate_limited');
  });

  it('classifies 401 as auth', () => {
    assert.strictEqual(classifyError(new Error('API Error: 401 invalid api key')), 'auth');
  });

  it('classifies AbortError by name as atlas_timeout', () => {
    const err = new Error('This operation was aborted');
    err.name = 'AbortError';
    assert.strictEqual(classifyError(err), 'atlas_timeout');
  });

  it('classifies generic abort message as atlas_timeout', () => {
    assert.strictEqual(classifyError(new Error('This operation was aborted')), 'atlas_timeout');
  });

  it('classifies "timed out" message as brain_timeout', () => {
    assert.strictEqual(classifyError(new Error('Brain query timed out after 120s')), 'brain_timeout');
  });

  it('classifies MCP tool failure as tool_error', () => {
    assert.strictEqual(classifyError(new Error('MCP tool execute failed')), 'tool_error');
  });

  it('classifies unknown errors as unknown', () => {
    assert.strictEqual(classifyError(new Error('something completely unrelated')), 'unknown');
  });

  it('classifies undefined/null as unknown', () => {
    assert.strictEqual(classifyError(undefined), 'unknown');
    assert.strictEqual(classifyError(null), 'unknown');
  });

  it('classifies string errors', () => {
    assert.strictEqual(classifyError('You have reached your specified API usage limits'), 'usage_limit');
  });

  // Precedence: usage_limit must win over rate_limited if both keywords match —
  // a hard cap shouldn't be auto-retried like a transient 429.
  it('prioritises usage_limit over rate_limited when both present', () => {
    const err = new Error('rate limit: You have reached your specified API usage limits (HTTP 429)');
    assert.strictEqual(classifyError(err), 'usage_limit');
  });

  it('prioritises auth over unknown when 401 present', () => {
    const err = new Error('401 unauthorized — invalid api key');
    assert.strictEqual(classifyError(err), 'auth');
  });
});

describe('renderStructuredError', () => {
  const fixedDate = new Date('2026-05-18T05:54:29.798Z');
  const incidentId = 'a1f2b3c4-d5e6-7890-abcd-ef1234567890';

  it('renders the expected format', () => {
    const out = renderStructuredError({
      errorClass: 'usage_limit',
      incidentId,
      timestamp: fixedDate,
    });
    assert.strictEqual(
      out,
      '⚠️ Failed to process (usage_limit @ 2026-05-18T05:54:29.798Z, ref a1f2b3c4). Logged for review.'
    );
  });

  it('uses first 8 hex chars of UUID as ref (dashes stripped)', () => {
    const out = renderStructuredError({
      errorClass: 'atlas_timeout',
      incidentId: 'abc12345-9999-9999-9999-999999999999',
      timestamp: fixedDate,
    });
    assert.ok(out.includes('ref abc12345'), `expected ref abc12345 in: ${out}`);
  });

  it('defaults to now() if no timestamp supplied', () => {
    const before = new Date();
    const out = renderStructuredError({ errorClass: 'unknown', incidentId });
    const after = new Date();
    const match = out.match(/@ ([^,]+),/);
    assert.ok(match, `expected timestamp in: ${out}`);
    const ts = new Date(match![1]!);
    assert.ok(ts.getTime() >= before.getTime() - 100);
    assert.ok(ts.getTime() <= after.getTime() + 100);
  });

  it('handles all error classes without throwing', () => {
    const classes: ErrorClass[] = [
      'atlas_timeout', 'brain_timeout', 'tool_error',
      'rate_limited', 'auth', 'usage_limit', 'unknown',
    ];
    for (const cls of classes) {
      assert.doesNotThrow(() => renderStructuredError({ errorClass: cls, incidentId }));
    }
  });
});
