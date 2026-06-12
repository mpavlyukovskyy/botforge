import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../scripts/whoop-reauth.mjs');

const FAKE_ACCESS = 'dryrun-access-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FAKE_REFRESH = 'dryrun-refresh-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

const SCHEMA_SQL = `
CREATE TABLE oauth_tokens (
  provider TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER,
  locked_at INTEGER,
  updated_at TEXT,
  status TEXT DEFAULT 'active',
  dead_reason TEXT,
  dead_at INTEGER,
  consecutive_invalid_request INTEGER DEFAULT 0,
  first_transient_failure_at INTEGER,
  lock_token TEXT,
  last_dead_probe_at INTEGER
);
`;

const SEED_DEAD_ROW_SQL = `
INSERT INTO oauth_tokens (
  provider, access_token, refresh_token, expires_at, locked_at, updated_at,
  status, dead_reason, dead_at, consecutive_invalid_request,
  first_transient_failure_at, lock_token, last_dead_probe_at
) VALUES (
  'whoop', 'old-access-token', 'old-refresh-token', 100, 999, '2026-01-01T00:00:00Z',
  'dead', 'invalid_grant', 123, 3,
  NULL, 'someone-elses-lock', 456
);
`;

let tmpDir;
let shimDir;
let sshLog;
let stdinCapture;

function sqlite(db, sql) {
  return execFileSync('sqlite3', [db, sql], { encoding: 'utf8' });
}

function createDb(name, { seedDeadRow }) {
  const db = path.join(tmpDir, name);
  sqlite(db, SCHEMA_SQL);
  if (seedDeadRow) sqlite(db, SEED_DEAD_ROW_SQL);
  return db;
}

// quote() prints NULL literally and quotes text, so NULL vs '' is unambiguous.
function readWhoopRow(db) {
  const out = sqlite(
    db,
    `SELECT quote(status), quote(dead_reason), quote(dead_at),
            quote(consecutive_invalid_request), quote(first_transient_failure_at),
            quote(last_dead_probe_at), quote(access_token), quote(refresh_token),
            quote(expires_at), quote(locked_at), quote(lock_token)
     FROM oauth_tokens WHERE provider = 'whoop';`
  ).trim();
  if (!out) return null;
  const [
    status, deadReason, deadAt, consecutiveInvalidRequest, firstTransientFailureAt,
    lastDeadProbeAt, accessToken, refreshToken, expiresAt, lockedAt, lockToken,
  ] = out.split('|');
  return {
    status, deadReason, deadAt, consecutiveInvalidRequest, firstTransientFailureAt,
    lastDeadProbeAt, accessToken, refreshToken, expiresAt, lockedAt, lockToken,
  };
}

function shimLogLines() {
  if (!existsSync(sshLog)) return [];
  return readFileSync(sshLog, 'utf8').split('\n').filter(Boolean);
}

function runReauth(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      // PATH-prefix the shim dir so the script's spawnSync('ssh', ...) hits the shim.
      PATH: `${shimDir}:${process.env.PATH}`,
      // Deterministic creds so loadCredentials() never falls through to a real ssh.
      WHOOP_CLIENT_ID: 'test-client-id',
      WHOOP_CLIENT_SECRET: 'test-client-secret',
    },
  });
}

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'whoop-reauth-test-'));
  shimDir = path.join(tmpDir, 'bin');
  sshLog = path.join(tmpDir, 'ssh-invocations.log');
  stdinCapture = path.join(tmpDir, 'stdin-capture.sql');
  execFileSync('mkdir', ['-p', shimDir]);

  // ssh shim: log argv, extract the sqlite3 target from arg 2, run the REAL
  // local sqlite3 against it with stdin passed through (tee'd for inspection).
  const shim = `#!/bin/bash
printf '%s\\n' "$*" >> '${sshLog}'
DB="\${2#sqlite3 }"
tee -a '${stdinCapture}' | exec sqlite3 "$DB"
`;
  const shimPath = path.join(shimDir, 'ssh');
  writeFileSync(shimPath, shim);
  chmodSync(shimPath, 0o755);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('whoop-reauth --dry-run (UPSERT against a real sqlite DB via ssh shim)', () => {
  it('revives a dead row: tokens installed, dead-state cleared, lock columns untouched', () => {
    const db = createDb('dead-row.db', { seedDeadRow: true });
    const before = Math.floor(Date.now() / 1000);

    const res = runReauth(['--dry-run', '--db', db]);

    expect(res.status, `stderr: ${res.stderr}\nstdout: ${res.stdout}`).toBe(0);
    expect(res.stdout).toContain('PASS');
    expect(res.stdout).toContain(db);

    // The shim was invoked as: ssh dry-run-host "sqlite3 <db>"
    const calls = shimLogLines().filter((l) => l.includes(db));
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(`dry-run-host sqlite3 ${db}`);

    const row = readWhoopRow(db);
    expect(row).not.toBeNull();
    expect(row.status).toBe(`'active'`);
    expect(row.deadReason).toBe('NULL');
    expect(row.deadAt).toBe('NULL');
    expect(row.consecutiveInvalidRequest).toBe('0');
    expect(row.firstTransientFailureAt).toBe('NULL');
    expect(row.lastDeadProbeAt).toBe('NULL');
    expect(row.accessToken).toBe(`'${FAKE_ACCESS}'`);
    expect(row.refreshToken).toBe(`'${FAKE_REFRESH}'`);

    const expiresAt = parseInt(row.expiresAt, 10);
    expect(Math.abs(expiresAt - (before + 3600))).toBeLessThanOrEqual(120);

    // Load-bearing safety property: lock columns are never clobbered.
    expect(row.lockedAt).toBe('999');
    expect(row.lockToken).toBe(`'someone-elses-lock'`);
  });

  it('inserts a fresh active row when the DB has no whoop row (INSERT path, changes()==1)', () => {
    const db = createDb('fresh.db', { seedDeadRow: false });

    const res = runReauth(['--dry-run', '--db', db]);

    expect(res.status, `stderr: ${res.stderr}\nstdout: ${res.stdout}`).toBe(0);
    expect(res.stdout).toContain('PASS');
    expect(res.stdout).toContain(db);

    const row = readWhoopRow(db);
    expect(row).not.toBeNull();
    expect(row.status).toBe(`'active'`);
    expect(row.accessToken).toBe(`'${FAKE_ACCESS}'`);
    expect(row.refreshToken).toBe(`'${FAKE_REFRESH}'`);
    expect(row.lockedAt).toBe('NULL');
    expect(row.lockToken).toBe('NULL');
  });

  it('sends the SQL via stdin with a .timeout 5000 prelude', () => {
    const sql = readFileSync(stdinCapture, 'utf8');
    expect(sql).toContain('.timeout 5000');
    expect(sql).toContain(`ON CONFLICT(provider) DO UPDATE SET`);
    expect(sql).toContain('SELECT changes();');
    // Lock columns must not appear anywhere in the UPSERT.
    expect(sql).not.toContain('locked_at');
    expect(sql).not.toContain('lock_token');
  });

  it('rejects --db without --dry-run before touching any DB or ssh', () => {
    const db = createDb('untouched.db', { seedDeadRow: true });
    const logBefore = shimLogLines().length;

    const res = runReauth(['--db', db]);

    expect(res.status).not.toBe(0);
    const combined = `${res.stderr}${res.stdout}`;
    expect(combined).toContain('--db is only valid together with --dry-run');

    // Flag validation runs before anything else: no ssh, no DB writes.
    expect(shimLogLines().length).toBe(logBefore);
    const row = readWhoopRow(db);
    expect(row.status).toBe(`'dead'`);
    expect(row.accessToken).toBe(`'old-access-token'`);
  });
});
