/**
 * Tests: /sync, /status, /progress surface Whoop dead-token state truthfully.
 *
 * Uses the REAL lib/db.js singleton, pointed at a temp dir via process.chdir
 * in beforeAll (the singleton can't be reset, so all tests share one DB and
 * each test UPDATEs/replaces the oauth_tokens whoop row itself).
 *
 * Hermetic: global fetch is stubbed, dailySync and callSonnet are vi.mock'd.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

// vi.mock paths resolve relative to THIS file; vitest intercepts by resolved
// module id, so these also intercept the imports inside commands/sync.js
// ('../cron/daily-sync.js') and commands/progress.js ('../lib/claude.js').
vi.mock('../cron/daily-sync.js', () => ({
  default: { name: 'daily_sync', execute: vi.fn(async () => {}) },
}));
vi.mock('../lib/claude.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    callSonnet: vi.fn(async () => ({ is_error: false, text: 'REPORT' })),
  };
});

import { ensureDb, getDb, runMigrations, nowSec } from '../lib/db.js';
import { whoopStatusLine } from '../lib/alert-state.js';
import statusCmd from '../commands/status.js';
import syncCmd from '../commands/sync.js';
import progressCmd from '../commands/progress.js';

const config = { name: 'CmdTest', platform: { chat_ids: ['123'] } };

const DEAD_AT = 1749600000; // fixed epoch seconds — known ISO date
const DEAD_AT_ISO_DATE = new Date(DEAD_AT * 1000).toISOString().slice(0, 10);

function makeCtx(chatId = '123') {
  return {
    config,
    chatId,
    adapter: { send: vi.fn(async () => {}) },
    store: new Map(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function clearWhoopRow() {
  getDb(config).prepare("DELETE FROM oauth_tokens WHERE provider = 'whoop'").run();
}

function setWhoopRow({ status = 'active', refreshToken = 'rt-abc', deadAt = null, deadReason = null }) {
  const db = getDb(config);
  clearWhoopRow();
  db.prepare(`
    INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, status, dead_reason, dead_at)
    VALUES ('whoop', 'at-xyz', ?, ?, ?, ?, ?)
  `).run(refreshToken, nowSec() + 3600, status, deadReason, deadAt);
}

function lastSendText(ctx) {
  const calls = ctx.adapter.send.mock.calls;
  return calls[calls.length - 1][0].text;
}

beforeAll(() => {
  // Hermetic: no real network ever, regardless of mock coverage.
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: false,
    status: 503,
    text: async () => 'x',
    json: async () => ({}),
  })));

  // MUST happen before the first ensureDb call — the singleton DB file is
  // data/<name>-trainer.db relative to cwd.
  process.chdir(mkdtempSync(join(os.tmpdir(), 'trainer-cmd-test-')));
  ensureDb(config);
  runMigrations({ config });
});

describe('whoopStatusLine', () => {
  it('reports not authorized when there is no whoop row', () => {
    clearWhoopRow();
    const line = whoopStatusLine(config);
    expect(line).toBeTypeOf('string');
    expect(line).toContain('not authorized');
  });

  it('reports dead since <ISO> with the re-auth hint when status=dead', () => {
    setWhoopRow({ status: 'dead', deadAt: DEAD_AT, deadReason: 'invalid_grant' });
    const line = whoopStatusLine(config);
    expect(line).toContain('dead since');
    expect(line).toContain(DEAD_AT_ISO_DATE);
    expect(line).toContain('whoop-reauth');
  });

  it('returns null when status=active with a refresh token', () => {
    setWhoopRow({ status: 'active' });
    expect(whoopStatusLine(config)).toBeNull();
  });
});

describe('/status', () => {
  it('shows the dead banner but still renders the rest of the status (one send only)', async () => {
    setWhoopRow({ status: 'dead', deadAt: DEAD_AT, deadReason: 'invalid_grant' });
    const ctx = makeCtx('123');
    await statusCmd.execute('', ctx);

    // Zero-unsolicited-sends guard: exactly the one reply, no alert sends.
    expect(ctx.adapter.send).toHaveBeenCalledTimes(1);
    const text = lastSendText(ctx);
    expect(text).toContain('Whoop token dead');
    expect(text).toContain('Program:');
  });

  it('shows no banner when the token is active', async () => {
    setWhoopRow({ status: 'active' });
    const ctx = makeCtx('123');
    await statusCmd.execute('', ctx);

    expect(ctx.adapter.send).toHaveBeenCalledTimes(1);
    expect(lastSendText(ctx)).not.toContain('Whoop token dead');
  });
});

describe('/sync', () => {
  // sync.js has a module-level 30s debounce per chatId — each test case uses
  // its own chatId to dodge it.

  it('never claims "Sync complete." with a dead row; reports per-source outcomes', async () => {
    setWhoopRow({ status: 'dead', deadAt: DEAD_AT, deadReason: 'invalid_grant' });
    const ctx = makeCtx('sync-dead-1');
    await syncCmd.execute('', ctx);

    const text = lastSendText(ctx);
    expect(text).not.toContain('Sync complete.');
    expect(text).toContain('Sync finished (Whoop degraded).');
    expect(text).toContain('Whoop:');
    expect(text).toContain('whoop-reauth'); // re-auth hint in the Whoop line
    expect(text).toContain('8Sleep:');
  });

  it('says "Sync complete." with an active row, and "Whoop: no data returned" when no data', async () => {
    setWhoopRow({ status: 'active' });
    const ctx = makeCtx('sync-active-1');
    await syncCmd.execute('', ctx);

    const text = lastSendText(ctx);
    expect(text.startsWith('Sync complete.')).toBe(true);
    expect(text).toContain('Whoop: no data returned');
    expect(text).toContain('8Sleep:');
  });
});

describe('/progress', () => {
  it('prepends the dead banner to a successful report', async () => {
    setWhoopRow({ status: 'dead', deadAt: DEAD_AT, deadReason: 'invalid_grant' });
    const ctx = makeCtx('123');
    await progressCmd.execute('', ctx);

    // Two sends: "Generating progress report..." then the report itself.
    expect(ctx.adapter.send).toHaveBeenCalledTimes(2);
    const text = lastSendText(ctx);
    expect(text).toMatch(/^.*Whoop token dead/);
    expect(text.indexOf('Whoop token dead')).toBeLessThan(text.indexOf('REPORT'));
    expect(text).toContain('REPORT');
  });

  it('sends the bare report with no banner when the token is active', async () => {
    setWhoopRow({ status: 'active' });
    const ctx = makeCtx('123');
    await progressCmd.execute('', ctx);

    expect(ctx.adapter.send).toHaveBeenCalledTimes(2);
    const text = lastSendText(ctx);
    expect(text).toBe('REPORT');
    expect(text).not.toContain('Whoop token dead');
  });
});
