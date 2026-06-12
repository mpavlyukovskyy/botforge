/**
 * DB-layer tests for the Whoop token hardening: schema migration, ownership
 * lock, and the CAS helpers that make token rotation safe.
 * (docs/PLAN-whoop-token-hardening.md Workstreams A0–A2)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// The ensureDb singleton resolves data/ against CWD — isolate into a temp dir
// BEFORE the module's first use.
process.chdir(mkdtempSync(join(tmpdir(), 'trainer-db-test-')));

const {
  ensureDb, getDb, nowSec, OAUTH_LOCK_STEAL_SEC,
  getOAuthToken, upsertOAuthToken,
  lockOAuthToken, unlockOAuthToken,
  casUpdateTokenOnSuccess, casMarkTokenDead, casIncrementInvalidRequest,
  setFirstTransientFailure, casClaimDeadProbe,
} = await import('../lib/db.js');

const config = { name: 'DbTest' };

function seed(overrides = {}) {
  const db = getDb(config);
  db.prepare('DELETE FROM oauth_tokens').run();
  db.prepare(`
    INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, status, consecutive_invalid_request)
    VALUES ('whoop', @access_token, @refresh_token, @expires_at, @status, @consecutive_invalid_request)
  `).run({
    access_token: 'AT1',
    refresh_token: 'RT1',
    expires_at: nowSec() + 3600,
    status: 'active',
    consecutive_invalid_request: 0,
    ...overrides,
  });
}

beforeAll(() => {
  ensureDb(config);
});

beforeEach(() => seed());

describe('oauth_tokens migration', () => {
  it('fresh DB has the full new shape after a single ensureDb', () => {
    const cols = getDb(config).prepare('PRAGMA table_info(oauth_tokens)').all().map(c => c.name);
    for (const col of ['status', 'dead_reason', 'dead_at', 'consecutive_invalid_request',
      'first_transient_failure_at', 'lock_token', 'last_dead_probe_at', 'locked_at']) {
      expect(cols).toContain(col);
    }
  });

  it('pre-existing old-shape table gets the new columns; existing row reads status=active, counter=0', () => {
    // Simulate the live prod DB: created before this change, with a token row.
    const path = join(mkdtempSync(join(tmpdir(), 'oldshape-')), 'old.db');
    const old = new Database(path);
    old.exec(`
      CREATE TABLE oauth_tokens (
        provider TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at INTEGER,
        locked_at INTEGER,
        updated_at TEXT DEFAULT (datetime('now'))
      );
    `);
    old.prepare("INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at) VALUES ('whoop','a','r',123)").run();
    old.close();

    // Re-run the same migration SQL the module applies (the singleton is
    // already initialized, so replicate via the source's ALTER list).
    const dbjs = readFileSync(join(SRC_DIR, 'lib/db.js'), 'utf8');
    const alters = [...dbjs.matchAll(/ALTER TABLE oauth_tokens ADD COLUMN .*?(?=['"],)/g)].map(m => m[0]);
    expect(alters.length).toBeGreaterThanOrEqual(7);

    const re = new Database(path);
    for (const sql of alters) {
      try { re.exec(sql); } catch (err) {
        if (!/duplicate column name/i.test(err.message)) throw err;
      }
    }
    const row = re.prepare("SELECT * FROM oauth_tokens WHERE provider='whoop'").get();
    expect(row.status).toBe('active'); // ALTER default applies to existing rows
    expect(row.consecutive_invalid_request).toBe(0);
    expect(row.last_dead_probe_at).toBeNull();
    re.close();
  });
});

describe('grep guards (banned patterns)', () => {
  it('no INSERT OR REPLACE touches oauth_tokens anywhere in the bot', () => {
    // REPLACE deletes+reinserts the row, silently wiping status/dead columns.
    const files = ['lib/db.js', 'lib/whoop-client.js', 'lib/alert-state.js',
      'cron/token-refresh.js', 'scripts/whoop-reauth.mjs', 'scripts/whoop-auth.js'];
    for (const f of files) {
      const src = readFileSync(join(SRC_DIR, f), 'utf8');
      const hits = [...src.matchAll(/INSERT OR REPLACE INTO oauth_tokens/gi)];
      expect(hits, `${f} must not INSERT OR REPLACE oauth_tokens`).toHaveLength(0);
    }
  });

  it("dead/transient/probe/reminder logic never compares against SQL datetime('now')", () => {
    // Fake-timer-testable by construction: temporal comparisons use JS epoch
    // seconds. datetime('now') may only appear as a display/forensics stamp.
    for (const f of ['lib/whoop-client.js', 'lib/alert-state.js']) {
      const src = readFileSync(join(SRC_DIR, f), 'utf8');
      expect(src.includes("datetime('now')"), `${f} must not use SQL datetime('now')`).toBe(false);
    }
  });
});

describe('ownership lock', () => {
  it('acquire returns a token; second acquire fails while held', () => {
    const t1 = lockOAuthToken(config, 'whoop');
    expect(t1).toBeTruthy();
    expect(lockOAuthToken(config, 'whoop')).toBeNull();
    unlockOAuthToken(config, 'whoop', t1);
    expect(lockOAuthToken(config, 'whoop')).toBeTruthy();
  });

  it('a stale holder cannot release the stealer’s lock', () => {
    const stale = lockOAuthToken(config, 'whoop');
    // Age the lock past the steal threshold.
    getDb(config).prepare("UPDATE oauth_tokens SET locked_at = ? WHERE provider='whoop'")
      .run(nowSec() - OAUTH_LOCK_STEAL_SEC - 1);
    const stealer = lockOAuthToken(config, 'whoop');
    expect(stealer).toBeTruthy();
    // Stale holder's finally-block release must be a no-op.
    unlockOAuthToken(config, 'whoop', stale);
    const row = getOAuthToken(config, 'whoop');
    expect(row.lock_token).toBe(stealer);
    unlockOAuthToken(config, 'whoop', stealer);
    expect(getOAuthToken(config, 'whoop').lock_token).toBeNull();
  });
});

describe('CAS success persist', () => {
  it('persists and resets ALL failure/dead state when the presented token matches', () => {
    getDb(config).prepare(`
      UPDATE oauth_tokens SET status='dead', dead_reason='invalid_grant', dead_at=1,
        consecutive_invalid_request=3, first_transient_failure_at=2, last_dead_probe_at=3
      WHERE provider='whoop'
    `).run();
    const before = getOAuthToken(config, 'whoop').updated_at;
    const ok = casUpdateTokenOnSuccess(config, 'whoop', 'RT1', {
      accessToken: 'AT2', refreshToken: 'RT2', expiresAt: nowSec() + 3600,
    });
    expect(ok).toBe(true);
    const row = getOAuthToken(config, 'whoop');
    expect(row.access_token).toBe('AT2');
    expect(row.refresh_token).toBe('RT2');
    expect(row.status).toBe('active');
    expect(row.dead_reason).toBeNull();
    expect(row.dead_at).toBeNull();
    expect(row.consecutive_invalid_request).toBe(0);
    expect(row.first_transient_failure_at).toBeNull();
    expect(row.last_dead_probe_at).toBeNull();
    expect(typeof row.updated_at).toBe('string'); // forensics stamp present
    void before;
  });

  it('a stale success cannot overwrite a newer token (returns false, row untouched)', () => {
    // Another caller (or re-auth) already rotated RT1 → RT9.
    getDb(config).prepare("UPDATE oauth_tokens SET access_token='AT9', refresh_token='RT9' WHERE provider='whoop'").run();
    const ok = casUpdateTokenOnSuccess(config, 'whoop', 'RT1', {
      accessToken: 'ATstale', refreshToken: 'RTstale', expiresAt: nowSec() + 3600,
    });
    expect(ok).toBe(false);
    const row = getOAuthToken(config, 'whoop');
    expect(row.access_token).toBe('AT9');
    expect(row.refresh_token).toBe('RT9');
  });
});

describe('CAS death + counter', () => {
  it('marks dead only when the presented token matches; anchors the probe timer at dead_at', () => {
    expect(casMarkTokenDead(config, 'whoop', 'RT-other', 'invalid_grant')).toBe(false);
    expect(getOAuthToken(config, 'whoop').status).toBe('active');

    expect(casMarkTokenDead(config, 'whoop', 'RT1', 'invalid_grant')).toBe(true);
    const row = getOAuthToken(config, 'whoop');
    expect(row.status).toBe('dead');
    expect(row.dead_reason).toBe('invalid_grant');
    expect(row.dead_at).toBeGreaterThan(nowSec() - 5);
    expect(row.last_dead_probe_at).toBe(row.dead_at); // first probe at dead_at + 12h
  });

  it('invalid_request counter increments via CAS and reports null after rotation', () => {
    expect(casIncrementInvalidRequest(config, 'whoop', 'RT1')).toBe(1);
    expect(casIncrementInvalidRequest(config, 'whoop', 'RT1')).toBe(2);
    getDb(config).prepare("UPDATE oauth_tokens SET refresh_token='RT2' WHERE provider='whoop'").run();
    expect(casIncrementInvalidRequest(config, 'whoop', 'RT1')).toBeNull();
  });

  it('setFirstTransientFailure stamps once and never overwrites an open window', () => {
    setFirstTransientFailure(config, 'whoop');
    const first = getOAuthToken(config, 'whoop').first_transient_failure_at;
    expect(first).toBeGreaterThan(0);
    setFirstTransientFailure(config, 'whoop');
    expect(getOAuthToken(config, 'whoop').first_transient_failure_at).toBe(first);
  });
});

describe('dead-probe claim (escape hatch)', () => {
  it('claims only once per interval, only while dead, only for the seen token', () => {
    seed({ status: 'dead' });
    const db = getDb(config);
    // Anchored at dead_at: not yet eligible.
    db.prepare("UPDATE oauth_tokens SET dead_at=?, last_dead_probe_at=? WHERE provider='whoop'")
      .run(nowSec(), nowSec());
    expect(casClaimDeadProbe(config, 'whoop', 'RT1')).toBe(false);

    // 12h later (backdate the stamp): exactly one claimant wins.
    db.prepare("UPDATE oauth_tokens SET last_dead_probe_at=? WHERE provider='whoop'")
      .run(nowSec() - 43200 - 1);
    expect(casClaimDeadProbe(config, 'whoop', 'RT1')).toBe(true);
    expect(casClaimDeadProbe(config, 'whoop', 'RT1')).toBe(false);

    // Not dead → never claims.
    db.prepare("UPDATE oauth_tokens SET status='active', last_dead_probe_at=NULL WHERE provider='whoop'").run();
    expect(casClaimDeadProbe(config, 'whoop', 'RT1')).toBe(false);
  });
});

describe('upsertOAuthToken (legacy writer)', () => {
  it('updates token fields without resetting status/dead columns (no REPLACE semantics)', () => {
    getDb(config).prepare("UPDATE oauth_tokens SET status='dead', dead_reason='x', consecutive_invalid_request=2 WHERE provider='whoop'").run();
    upsertOAuthToken(config, 'whoop', 'ATnew', 'RTnew', 42);
    const row = getOAuthToken(config, 'whoop');
    expect(row.access_token).toBe('ATnew');
    // State columns survive — REPLACE would have nulled them.
    expect(row.status).toBe('dead');
    expect(row.dead_reason).toBe('x');
    expect(row.consecutive_invalid_request).toBe(2);
  });
});
