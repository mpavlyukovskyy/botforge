// Pins the SQL semantics of check_whoop_freshness() in infra/fleet-watchdog.sh.
//
// The watchdog script itself can't run on the Mac (STATE_DIR=/opt/health-probes/state
// is hardcoded and mkdir -p fails outside acemagic), so this test:
//   1. runs the EXACT SQL the shell runs (copied verbatim) against fixture
//      SQLite DBs via better-sqlite3 and replays the shell's branching logic,
//   2. statically asserts the deployed artifact still contains the
//      kill-test hooks (WHOOP_DB_OVERRIDE, TG_DRYRUN, ...) and the exact
//      query text, so the SQL pinned here can't silently drift from the script.
//
// dead_at and bot_state alert timestamps are JS epoch SECONDS — see the
// "seconds semantics" tests below.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WATCHDOG_PATH = join(REPO_ROOT, 'infra', 'fleet-watchdog.sh');

// --- SQL copied verbatim from check_whoop_freshness() in infra/fleet-watchdog.sh ---
const SQL_DEAD_ROW =
  "SELECT status || '|' || COALESCE(dead_at,0) FROM oauth_tokens WHERE provider='whoop'";
const SQL_ALERT_KEY_COUNT =
  "SELECT COUNT(*) FROM bot_state WHERE key LIKE 'whoop_%' AND value != ''";
const SQL_DEAD_KEY_PRESENT =
  "SELECT COUNT(*) FROM bot_state WHERE key='whoop_token_dead' AND value != ''";
// The shell interpolates $now into this query string before passing it to sqlite3.
const sqlLastScoreAgeH = (now) => `
      SELECT CAST((${now} - strftime('%s', MAX(date) || 'T12:00:00Z')) / 3600 AS INTEGER)
      FROM recovery_daily WHERE whoop_recovery_score IS NOT NULL`;

// Trainer schema subset (matches the live Trainer-trainer.db tables the probe reads).
function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'probe-sql-'));
  const db = new Database(join(dir, 'trainer.db'));
  db.exec(`
    CREATE TABLE oauth_tokens (
      provider TEXT PRIMARY KEY,
      access_token TEXT,
      refresh_token TEXT,
      expires_at INTEGER,
      status TEXT,
      dead_reason TEXT,
      dead_at INTEGER
    );
    CREATE TABLE bot_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT
    );
    CREATE TABLE recovery_daily (
      date TEXT PRIMARY KEY,
      whoop_recovery_score REAL
    );
  `);
  return db;
}

// Faithful replay of check_whoop_freshness()'s branching over the same SQL.
// Returns the alert reason string ('' = no alert), mirroring the shell's $reason.
function checkWhoopFreshness(db, now, staleHours = 72) {
  // dead_row=$(sqlite3 -readonly "$WHOOP_DB" "$SQL_DEAD_ROW"); empty output when no row
  const deadRow = db.prepare(SQL_DEAD_ROW).pluck().get() ?? '';
  // status="${dead_row%%|*}"  dead_at="${dead_row##*|}"
  const parts = String(deadRow).split('|');
  const status = parts[0];
  const deadAt = Number(parts[parts.length - 1]) || 0;

  const alertKeyCount = db.prepare(SQL_ALERT_KEY_COUNT).pluck().get();

  let reason = '';

  // (a) bot-wedged: dead >1h with no whoop_token_dead alert key
  if (status === 'dead' && deadAt > 0 && now - deadAt > 3600) {
    const deadKeyPresent = db.prepare(SQL_DEAD_KEY_PRESENT).pluck().get();
    if (deadKeyPresent === 0) {
      reason = `trainer marked Whoop token DEAD ${Math.floor((now - deadAt) / 3600)}h ago but never alerted (bot wedged?)`;
    }
  }

  // (b) staleness, suppressed while ANY whoop_* alert key is set
  if (reason === '' && alertKeyCount === 0) {
    // sqlite3 prints '' for a NULL result; the shell's [ -n "$last_score_age_h" ]
    // guard means a NULL MAX(date) (empty/all-NULL table) never fires.
    const lastScoreAgeH = db.prepare(sqlLastScoreAgeH(now)).pluck().get();
    if (lastScoreAgeH !== null && lastScoreAgeH !== undefined && lastScoreAgeH > staleHours) {
      reason = `no Whoop recovery data for ${lastScoreAgeH}h (threshold ${staleHours}h) and trainer is not alerting about it`;
    }
  }

  return reason;
}

// Fixed clock: 2026-06-11T12:00:00Z, epoch SECONDS (like the shell's date -u +%s).
const NOW = Math.floor(Date.UTC(2026, 5, 11, 12, 0, 0) / 1000);

const seedToken = (db, { status = 'dead', deadAt = null, deadReason = 'refresh 401' } = {}) =>
  db.prepare(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, status, dead_reason, dead_at)
     VALUES ('whoop', 'at', 'rt', ?, ?, ?, ?)`
  ).run(NOW - 86400, status, deadReason, deadAt);

const seedState = (db, key, value) =>
  db.prepare(`INSERT INTO bot_state (key, value, updated_at) VALUES (?, ?, ?)`)
    .run(key, value, new Date(NOW * 1000).toISOString());

const seedRecovery = (db, date, score) =>
  db.prepare(`INSERT INTO recovery_daily (date, whoop_recovery_score) VALUES (?, ?)`)
    .run(date, score);

describe('fleet-watchdog check_whoop_freshness SQL semantics', () => {
  describe('condition (a): token dead but bot never alerted (wedged)', () => {
    it('fires when token dead 2h ago and no whoop_token_dead key exists', () => {
      const db = makeDb();
      seedToken(db, { deadAt: NOW - 7200 });
      // fresh recovery data so only (a) can fire
      seedRecovery(db, '2026-06-11', 64);

      const reason = checkWhoopFreshness(db, NOW);
      expect(reason).toContain('never alerted (bot wedged?)');
      expect(reason).toContain('DEAD 2h ago');
    });

    it('is suppressed when bot_state has whoop_token_dead with a non-empty value', () => {
      const db = makeDb();
      seedToken(db, { deadAt: NOW - 7200 });
      seedRecovery(db, '2026-06-11', 64);
      seedState(db, 'whoop_token_dead', String(NOW - 7000));

      expect(checkWhoopFreshness(db, NOW)).toBe('');
    });

    it('is NOT suppressed by a whoop_token_dead key with an EMPTY value (cleared key)', () => {
      const db = makeDb();
      seedToken(db, { deadAt: NOW - 7200 });
      seedRecovery(db, '2026-06-11', 64);
      seedState(db, 'whoop_token_dead', '');

      expect(checkWhoopFreshness(db, NOW)).toContain('never alerted (bot wedged?)');
    });

    it('does NOT fire when the token died only 30 minutes ago (bot still has time to alert)', () => {
      const db = makeDb();
      seedToken(db, { deadAt: NOW - 1800 });
      seedRecovery(db, '2026-06-11', 64);

      expect(checkWhoopFreshness(db, NOW)).toBe('');
    });

    it('does NOT fire for a live token', () => {
      const db = makeDb();
      seedToken(db, { status: 'active', deadAt: null, deadReason: null });
      seedRecovery(db, '2026-06-11', 64);

      expect(checkWhoopFreshness(db, NOW)).toBe('');
    });

    it('does NOT fire when oauth_tokens has no whoop row at all (empty shell output)', () => {
      const db = makeDb();
      seedRecovery(db, '2026-06-11', 64);

      expect(checkWhoopFreshness(db, NOW)).toBe('');
    });
  });

  describe('condition (a): dead_at is epoch SECONDS (boundary + units)', () => {
    it('fires at exactly now-3601 (age 3601s > 3600s)', () => {
      const db = makeDb();
      seedToken(db, { deadAt: NOW - 3601 });
      seedRecovery(db, '2026-06-11', 64);

      expect(checkWhoopFreshness(db, NOW)).toContain('never alerted (bot wedged?)');
    });

    it('does NOT fire at now-3599 (age 3599s is not > 3600s)', () => {
      const db = makeDb();
      seedToken(db, { deadAt: NOW - 3599 });
      seedRecovery(db, '2026-06-11', 64);

      expect(checkWhoopFreshness(db, NOW)).toBe('');
    });

    it('documents seconds semantics: a MILLISECOND dead_at (e.g. Date.now()) computes an absurd negative age and never fires', () => {
      // If the bot ever writes Date.now() (ms) instead of seconds, now - dead_at
      // goes hugely negative and the >3600 check can never pass — the wedged
      // alert would be silently broken. This pins that dead_at MUST be seconds.
      const db = makeDb();
      const msValue = 1781234567000; // an epoch-milliseconds value
      seedToken(db, { deadAt: msValue });
      seedRecovery(db, '2026-06-11', 64);

      expect(NOW - msValue).toBeLessThan(0); // the "absurd age"
      expect(checkWhoopFreshness(db, NOW)).toBe('');
    });
  });

  describe('condition (b): recovery_daily staleness', () => {
    it('fires when the newest score-bearing date is 5 days old at the default 72h threshold', () => {
      const db = makeDb();
      seedToken(db, { status: 'active', deadAt: null, deadReason: null });
      // newest score-bearing row 2026-06-06, anchored at T12:00:00Z → exactly 120h before NOW
      seedRecovery(db, '2026-06-05', 55);
      seedRecovery(db, '2026-06-06', 61);

      const reason = checkWhoopFreshness(db, NOW, 72);
      expect(reason).toContain('no Whoop recovery data for 120h');
      expect(reason).toContain('threshold 72h');
    });

    it('does NOT fire on the same data with a 200h threshold (WHOOP_STALE_HOURS_OVERRIDE path)', () => {
      const db = makeDb();
      seedToken(db, { status: 'active', deadAt: null, deadReason: null });
      seedRecovery(db, '2026-06-05', 55);
      seedRecovery(db, '2026-06-06', 61);

      expect(checkWhoopFreshness(db, NOW, 200)).toBe('');
    });

    it('ignores NULL-score rows newer than the last real score (MAX over score-bearing dates only)', () => {
      const db = makeDb();
      seedToken(db, { status: 'active', deadAt: null, deadReason: null });
      seedRecovery(db, '2026-06-06', 61);
      seedRecovery(db, '2026-06-10', null); // strap synced but no score — must not mask staleness
      seedRecovery(db, '2026-06-11', null);

      expect(checkWhoopFreshness(db, NOW, 72)).toContain('no Whoop recovery data for 120h');
    });

    it('is suppressed when ANY whoop_* alert key with a non-empty value exists (e.g. whoop_config_error)', () => {
      const db = makeDb();
      seedToken(db, { status: 'active', deadAt: null, deadReason: null });
      seedRecovery(db, '2026-06-06', 61);
      seedState(db, 'whoop_config_error', String(NOW - 600));

      expect(checkWhoopFreshness(db, NOW, 72)).toBe('');
    });

    it('does NOT fire on an empty recovery_daily table (MAX(date) is NULL → empty shell output)', () => {
      const db = makeDb();
      seedToken(db, { status: 'active', deadAt: null, deadReason: null });

      expect(db.prepare(sqlLastScoreAgeH(NOW)).pluck().get()).toBeNull();
      expect(checkWhoopFreshness(db, NOW, 72)).toBe('');
    });

    it('does NOT fire when every score is NULL (same NULL guard)', () => {
      const db = makeDb();
      seedToken(db, { status: 'active', deadAt: null, deadReason: null });
      seedRecovery(db, '2026-06-01', null);
      seedRecovery(db, '2026-06-02', null);

      expect(db.prepare(sqlLastScoreAgeH(NOW)).pluck().get()).toBeNull();
      expect(checkWhoopFreshness(db, NOW, 72)).toBe('');
    });

    it('does NOT fire when data is fresh (yesterday at 72h threshold)', () => {
      const db = makeDb();
      seedToken(db, { status: 'active', deadAt: null, deadReason: null });
      seedRecovery(db, '2026-06-10', 70); // 26h old at NOW

      expect(checkWhoopFreshness(db, NOW, 72)).toBe('');
    });
  });

  describe('deployed artifact: infra/fleet-watchdog.sh kill-test hooks', () => {
    const script = readFileSync(WATCHDOG_PATH, 'utf8');

    it.each([
      'WHOOP_DB_OVERRIDE',
      'WHOOP_STALE_HOURS_OVERRIDE',
      'sqlite3 -readonly',
      'check_whoop_freshness',
      'TG_DRYRUN',
    ])('contains %s', (hook) => {
      expect(script).toContain(hook);
    });

    it('still contains the exact queries this test pins (no silent drift)', () => {
      expect(script).toContain(SQL_DEAD_ROW);
      expect(script).toContain(SQL_ALERT_KEY_COUNT);
      expect(script).toContain(SQL_DEAD_KEY_PRESENT);
      expect(script).toContain("strftime('%s', MAX(date) || 'T12:00:00Z')");
    });
  });
});
