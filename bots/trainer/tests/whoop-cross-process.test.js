/**
 * THE cross-process G1 proof: two real OS processes (≈ the bot + a backfill
 * script) racing refreshAccessToken against the SAME SQLite file must produce
 * exactly ONE token-endpoint request — the SQLite ownership lock is the only
 * thing standing between them and Hydra's reuse-revocation.
 *
 * The token endpoint is a local http server (WHOOP_TOKEN_URL override) that
 * counts requests and responds slowly enough that the loser is guaranteed to
 * arrive while the winner is in flight.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';

const TRAINER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function runChild(cwd, env) {
  // Each child imports the real client and forces a refresh attempt.
  const script = `
    const { refreshAccessToken } = await import(${JSON.stringify('file://' + join(TRAINER_DIR, 'lib/whoop-client.js'))});
    try {
      const at = await refreshAccessToken({ name: 'XProc' });
      console.log('RESULT:' + at);
    } catch (err) {
      console.log('ERROR:' + err.name + ':' + err.message);
    }
  `;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', errOut = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { errOut += d; });
    child.on('close', code => resolve({ code, out: out.trim(), errOut: errOut.trim() }));
  });
}

describe('cross-process refresh race', () => {
  it('two processes, one expiring token → exactly one token-endpoint request, both get the new token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trainer-xproc-'));
    mkdirSync(join(dir, 'data'), { recursive: true });

    // Pre-create the DB with the full new shape and an expiring token.
    const db = new Database(join(dir, 'data', 'XProc-trainer.db'));
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE oauth_tokens (
        provider TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at INTEGER,
        locked_at INTEGER,
        updated_at TEXT DEFAULT (datetime('now')),
        status TEXT DEFAULT 'active',
        dead_reason TEXT,
        dead_at INTEGER,
        consecutive_invalid_request INTEGER DEFAULT 0,
        first_transient_failure_at INTEGER,
        lock_token TEXT,
        last_dead_probe_at INTEGER
      );
    `);
    db.prepare(`
      INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, status)
      VALUES ('whoop', 'ATold', 'RTold', ?, 'active')
    `).run(Math.floor(Date.now() / 1000) + 10);
    db.close();

    // Slow token endpoint: 1.2s response, counts hits, rotates RTold → RTnew.
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'ATnew', refresh_token: 'RTnew', expires_in: 3600 }));
      }, 1200);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const env = {
      WHOOP_TOKEN_URL: `http://127.0.0.1:${port}/oauth2/token`,
      WHOOP_CLIENT_ID: 'x',
      WHOOP_CLIENT_SECRET: 'y',
    };

    const [a, b] = await Promise.all([
      runChild(dir, env),
      runChild(dir, env),
    ]);
    server.close();

    expect(hits).toBe(1); // ← the whole point: one rotation, zero reuse

    const results = [a, b].map(r => r.out.split('\n').pop());
    // Winner returns ATnew; loser either picked up ATnew after the lock
    // cleared, or timed out with RefreshUnavailableError — but NEVER refreshed.
    expect(results.filter(r => r === 'RESULT:ATnew').length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r === 'RESULT:ATnew' || r.startsWith('ERROR:RefreshUnavailableError')).toBe(true);
    }

    // The persisted chain is the rotated one, exactly once.
    const check = new Database(join(dir, 'data', 'XProc-trainer.db'), { readonly: true });
    const row = check.prepare("SELECT * FROM oauth_tokens WHERE provider='whoop'").get();
    check.close();
    expect(row.refresh_token).toBe('RTnew');
    expect(row.access_token).toBe('ATnew');
    expect(row.status).toBe('active');
    expect(row.lock_token).toBeNull();
  }, 30_000);
});
