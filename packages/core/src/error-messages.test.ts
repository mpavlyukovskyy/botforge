import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, renderError, maybeNotifyAdmin, type ErrorClass } from './error-messages.js';

const USAGE_LIMIT_400 =
  'Brain query failed: Claude Code returned an error result: API Error: 400 ' +
  '{"type":"error","error":{"type":"invalid_request_error","message":' +
  '"You have reached your specified API usage limits. You will regain access on 2026-06-01 at 00:00 UTC."}}';

// Deployed (truncated) shape of the credit-exhaustion error — the actual bug.
const CREDIT_TRUNCATED =
  'Brain query failed: Claude Code returned an error result: Credit balance is too low';
const CREDIT_FULL =
  'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';

const ALL_CLASSES: ErrorClass[] = [
  'credit_balance', 'usage_limit', 'payment_required', 'auth', 'permission',
  'overloaded', 'rate_limited', 'context_too_long', 'server_error', 'network',
  'brain_timeout', 'db_error', 'cli_failure', 'tool_error', 'unknown',
];

// ─── classifyError ──────────────────────────────────────────────────────────

test('classifyError: credit_balance — the bug (truncated + full forms)', () => {
  assert.equal(classifyError(new Error(CREDIT_TRUNCATED)), 'credit_balance');
  assert.equal(classifyError(new Error(CREDIT_FULL)), 'credit_balance');
});

test('classifyError: spend cap (usage_limit) still matched', () => {
  assert.equal(classifyError(new Error(USAGE_LIMIT_400)), 'usage_limit');
  assert.equal(classifyError('You have reached your specified API usage limits'), 'usage_limit');
});

test('classifyError: billing/auth/permission classes', () => {
  assert.equal(classifyError(new Error('402 payment required')), 'payment_required');
  assert.equal(classifyError(new Error('401 unauthorized')), 'auth');
  assert.equal(classifyError(new Error('invalid x-api-key')), 'auth');
  assert.equal(classifyError(new Error('authentication_error: invalid api key')), 'auth');
  assert.equal(classifyError(new Error('403 permission_error: model not allowed')), 'permission');
});

test('classifyError: overload / rate / context / server / network', () => {
  assert.equal(classifyError(new Error('529 {"type":"overloaded_error"}')), 'overloaded');
  assert.equal(classifyError(new Error('Overloaded')), 'overloaded');
  assert.equal(classifyError(new Error('HTTP 429 rate limit')), 'rate_limited');
  assert.equal(classifyError(new Error('400 invalid_request_error: prompt is too long')), 'context_too_long');
  assert.equal(classifyError(new Error('input is too many tokens for this model')), 'context_too_long');
  assert.equal(classifyError(new Error('500 api_error')), 'server_error');
  assert.equal(classifyError(new Error('503 service unavailable')), 'server_error');
  assert.equal(classifyError(new Error('connect ECONNRESET 1.2.3.4:443')), 'network');
  assert.equal(classifyError(new Error('socket hang up')), 'network');
  assert.equal(classifyError(new Error('fetch failed')), 'network');
});

test('classifyError: timeout / db / cli / tool / unknown', () => {
  const ab = new Error('aborted'); ab.name = 'AbortError';
  assert.equal(classifyError(ab), 'brain_timeout');
  assert.equal(classifyError(new Error('Brain CLI query timed out after 120s')), 'brain_timeout');
  assert.equal(classifyError(new Error('SqliteError: ON CONFLICT clause does not match any PRIMARY KEY')), 'db_error');
  assert.equal(classifyError(new Error('Claude CLI call failed (exit 1): boom')), 'cli_failure');
  assert.equal(classifyError(new Error('tool execution failed')), 'tool_error');
  assert.equal(classifyError(new Error('something weird')), 'unknown');
  assert.equal(classifyError(null), 'unknown');
});

test('classifyError: ordering guards (specific cause beats generic bucket)', () => {
  // A CLI-wrapped credit error must classify as credit_balance, NOT cli_failure.
  assert.equal(
    classifyError(new Error('Claude CLI call failed (exit 1): Your credit balance is too low. Plans & Billing.')),
    'credit_balance',
  );
  // A CLI-wrapped auth error → auth, not cli_failure.
  assert.equal(
    classifyError(new Error('Claude CLI call failed (exit 1): 401 authentication_error invalid x-api-key')),
    'auth',
  );
  // Network connection errors must be network, not brain_timeout.
  assert.equal(classifyError(new Error('request to api.anthropic.com failed: ECONNRESET')), 'network');
  assert.equal(classifyError(new Error('connect ETIMEDOUT 1.2.3.4:443')), 'network');
});

// ─── renderError ──────────────────────────────────────────────────────────

test('renderError(credit_balance): names credits + admin, NO console URL to the group', () => {
  const m = renderError('credit_balance', { ref: 'x' });
  assert.match(m, /out of Anthropic API credits/i);
  assert.match(m, /admin/i);
  assert.doesNotMatch(m, /console\.anthropic\.com/i); // console steps are admin-only
  assert.match(m, /ref x/);
});

test('renderError(usage_limit) parses the regain date', () => {
  const msg = renderError('usage_limit', { errorMessage: USAGE_LIMIT_400, ref: 'abcd1234' });
  assert.match(msg, /monthly API budget/);
  assert.match(msg, /2026-06-01 at 00:00 UTC/);
  assert.match(msg, /ref abcd1234/);
});

test('renderError(usage_limit) falls back when no date present', () => {
  const msg = renderError('usage_limit', { errorMessage: 'usage limit reached', ref: 'r1' });
  assert.match(msg, /monthly API budget/);
  assert.match(msg, /until it resets/);
});

test('renderError: each class names its real cause', () => {
  assert.match(renderError('payment_required', { ref: 'a' }), /billing problem/i);
  assert.match(renderError('auth', { ref: 'a' }), /API key isn't working/);
  assert.match(renderError('permission', { ref: 'a' }), /not allowed/i);
  assert.match(renderError('overloaded', { ref: 'a' }), /overloaded/i);
  assert.match(renderError('rate_limited', { ref: 'a' }), /rate-limited/);
  assert.match(renderError('context_too_long', { ref: 'a' }), /too large/i);
  assert.match(renderError('server_error', { ref: 'a' }), /server error/i);
  assert.match(renderError('network', { ref: 'a' }), /network/i);
  assert.match(renderError('brain_timeout', { ref: 'a' }), /took too long/);
  assert.match(renderError('db_error', { ref: 'a' }), /database error/i);
  assert.match(renderError('cli_failure', { ref: 'a' }), /Claude CLI/i);
  assert.match(renderError('tool_error', { ref: 'a' }), /tools? failed/);
  assert.match(renderError('unknown', { ref: 'a' }), /Failed to process/);
});

test('renderError is EXHAUSTIVE: every class is specific; only unknown is generic', () => {
  const generic = /^⚠️ Failed to process/;
  for (const c of ALL_CLASSES) {
    const m = renderError(c, { ref: 'z' });
    assert.ok(m.length > 0, `${c} produced empty message`);
    assert.match(m, /ref z/, `${c} missing ref`);
    if (c === 'unknown') assert.match(m, generic, 'unknown should be the generic message');
    else assert.doesNotMatch(m, generic, `${c} fell through to the generic message`);
  }
});

test('renderError generates a ref when none supplied', () => {
  assert.match(renderError('unknown'), /ref [a-z0-9]+/);
});

// ─── maybeNotifyAdmin ───────────────────────────────────────────────────────

function makeAdapter() {
  const sent: Array<{ chatId: string; text: string }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapter = { send: async (m: any) => { sent.push({ chatId: m.chatId, text: m.text ?? '' }); return 'mid'; } } as any;
  return { adapter, sent };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noopLog = { debug() {}, info() {}, warn() {}, error() {} } as any;

async function withAdmin(id: string | undefined, fn: () => Promise<void>) {
  const prev = process.env.ADMIN_USER_ID;
  if (id === undefined) delete process.env.ADMIN_USER_ID; else process.env.ADMIN_USER_ID = id;
  try { await fn(); } finally {
    if (prev === undefined) delete process.env.ADMIN_USER_ID; else process.env.ADMIN_USER_ID = prev;
  }
}

test('maybeNotifyAdmin alerts ONLY for admin-actionable classes', async () => {
  await withAdmin('999', async () => {
    const ALERTING: ErrorClass[] = ['credit_balance', 'usage_limit', 'payment_required', 'auth', 'permission', 'cli_failure'];
    for (const c of ALERTING) {
      const { adapter, sent } = makeAdapter();
      await maybeNotifyAdmin({ errorClass: c, errMsg: 'boom', botName: 'Kristina', adapter, store: new Map(), log: noopLog });
      assert.equal(sent.length, 1, `${c} should alert`);
      assert.equal(sent[0]!.chatId, '999');
    }
    const SILENT: ErrorClass[] = ['rate_limited', 'overloaded', 'brain_timeout', 'network', 'server_error', 'context_too_long', 'tool_error', 'db_error', 'unknown'];
    for (const c of SILENT) {
      const { adapter, sent } = makeAdapter();
      await maybeNotifyAdmin({ errorClass: c, errMsg: 'boom', botName: 'Kristina', adapter, store: new Map(), log: noopLog });
      assert.equal(sent.length, 0, `${c} should NOT alert`);
    }
  });
});

test('maybeNotifyAdmin throttles repeats (30 min) + credit_balance carries the console fix hint', async () => {
  await withAdmin('999', async () => {
    const { adapter, sent } = makeAdapter();
    const store = new Map<string, unknown>();
    await maybeNotifyAdmin({ errorClass: 'credit_balance', errMsg: 'low', botName: 'Kristina', adapter, store, log: noopLog });
    await maybeNotifyAdmin({ errorClass: 'credit_balance', errMsg: 'low', botName: 'Kristina', adapter, store, log: noopLog });
    assert.equal(sent.length, 1, 'second alert within 30 min must be throttled');
    assert.match(sent[0]!.text, /console\.anthropic\.com/i, 'admin alert should include the fix hint');
    assert.match(sent[0]!.text, /credit_balance/);
  });
});

test('maybeNotifyAdmin no-ops when ADMIN_USER_ID is unset', async () => {
  await withAdmin(undefined, async () => {
    const { adapter, sent } = makeAdapter();
    await maybeNotifyAdmin({ errorClass: 'credit_balance', errMsg: 'low', adapter, store: new Map(), log: noopLog });
    assert.equal(sent.length, 0);
  });
});
