#!/usr/bin/env node
/**
 * One-command Whoop re-authorization — browser consent on the Mac, token
 * installed directly into the LIVE bot DB on acemagic, verified end-to-end.
 *
 *   node scripts/whoop-reauth.mjs            # the real thing
 *   node scripts/whoop-reauth.mjs --watch    # + poll journalctl for the bot's recovery
 *   node scripts/whoop-reauth.mjs --dry-run --db /tmp/test.db   # no browser, fake tokens
 *
 * Safety rules (docs/PLAN-whoop-token-hardening.md, Workstream D):
 *  - Installs by ABSOLUTE path /opt/botforge/data/Trainer-trainer.db — never
 *    the decoy bots/trainer/data/ DB.
 *  - Token values travel via stdin, never shell-interpolated.
 *  - UPSERT preserves/clears state columns explicitly; lock columns untouched.
 *  - Verification uses the fresh ACCESS token only (/user/profile/basic).
 *    NEVER a script-side refresh: it could race the bot's refresher and
 *    rotation+reuse-detection would revoke the brand-new chain.
 *  - No service restart needed: the bot re-reads row truth every tick.
 */

import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { execSync, execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const WATCH = args.includes('--watch');
const dbFlagIdx = args.indexOf('--db');
const DB_OVERRIDE = dbFlagIdx >= 0 ? args[dbFlagIdx + 1] : null;

const LIVE_DB = '/opt/botforge/data/Trainer-trainer.db';
const SSH_HOST = 'acemagic';
const REDIRECT_URI = 'https://localhost:8090/callback';
const PORT = 8090;
const SCOPES = 'offline read:recovery read:sleep read:cycles read:profile read:workout';
const SECRETS_FILE = path.join(homedir(), '.claude/secrets/api-keys.env');

if (DB_OVERRIDE && !DRY_RUN) {
  console.error('--db is only valid together with --dry-run (the prod target is not overridable)');
  process.exit(1);
}
const TARGET_DB = DRY_RUN ? (DB_OVERRIDE || '/tmp/whoop-reauth-dryrun.db') : LIVE_DB;

function log(msg) { console.log(msg); }
function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }

// ─── Credentials ────────────────────────────────────────────────────────────

function loadCredentials() {
  let id = process.env.WHOOP_CLIENT_ID;
  let secret = process.env.WHOOP_CLIENT_SECRET;
  if (id && secret) return { id, secret, source: 'env' };

  if (existsSync(SECRETS_FILE)) {
    const txt = readFileSync(SECRETS_FILE, 'utf8');
    id = id || txt.match(/^WHOOP_CLIENT_ID=(.+)$/m)?.[1]?.trim();
    secret = secret || txt.match(/^WHOOP_CLIENT_SECRET=(.+)$/m)?.[1]?.trim();
    if (id && secret) return { id, secret, source: SECRETS_FILE };
  }

  // Fall back to the server's env (the bot refreshes with these same creds).
  try {
    const remote = execFileSync('ssh', [SSH_HOST, 'grep -E "^WHOOP_CLIENT_(ID|SECRET)=" /opt/botforge/.env'], { encoding: 'utf8' });
    id = id || remote.match(/^WHOOP_CLIENT_ID=(.+)$/m)?.[1]?.trim();
    secret = secret || remote.match(/^WHOOP_CLIENT_SECRET=(.+)$/m)?.[1]?.trim();
    if (id && secret) return { id, secret, source: 'acemagic:/opt/botforge/.env' };
  } catch { /* fall through */ }

  fail('WHOOP_CLIENT_ID/SECRET not found in env, ~/.claude/secrets/api-keys.env, or acemagic:/opt/botforge/.env');
}

// ─── Install (UPSERT into the live DB over SSH, tokens via stdin) ──────────

function installTokens({ accessToken, refreshToken, expiresAt }) {
  // The whole SQL script travels via stdin (spawnSync input) - tokens never
  // appear in argv or a shell-interpolated string. Token values are strictly
  // validated to the Whoop token charset, so embedding them in single-quoted
  // SQL literals cannot break quoting.
  for (const [name, v] of [['access', accessToken], ['refresh', refreshToken]]) {
    if (!/^[A-Za-z0-9._~-]+$/.test(v)) fail(`${name} token contains unexpected characters - refusing to install`);
  }
  if (!Number.isInteger(expiresAt)) fail('expiresAt must be an integer epoch-seconds value');

  const script = [
    '.timeout 5000',
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, status, dead_reason, dead_at, consecutive_invalid_request, first_transient_failure_at, last_dead_probe_at, updated_at)`,
    `VALUES ('whoop', '${accessToken}', '${refreshToken}', ${expiresAt}, 'active', NULL, NULL, 0, NULL, NULL, datetime('now'))`,
    `ON CONFLICT(provider) DO UPDATE SET`,
    `  access_token = excluded.access_token,`,
    `  refresh_token = excluded.refresh_token,`,
    `  expires_at = excluded.expires_at,`,
    `  status = 'active', dead_reason = NULL, dead_at = NULL,`,
    `  consecutive_invalid_request = 0, first_transient_failure_at = NULL,`,
    `  last_dead_probe_at = NULL, updated_at = datetime('now');`,
    // lock columns deliberately untouched — never clobber an in-flight holder
    `SELECT changes();`,
  ].join('\n');

  let out;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = DRY_RUN
      ? spawnSync('ssh', ['dry-run-host', `sqlite3 ${TARGET_DB}`], { input: script, encoding: 'utf8' })
      : spawnSync('ssh', [SSH_HOST, `sqlite3 ${TARGET_DB}`], { input: script, encoding: 'utf8' });
    if (res.status === 0) { out = res.stdout; break; }
    if (attempt === 3) fail(`sqlite install failed after 3 attempts: ${res.stderr || res.stdout}`);
    log(`install attempt ${attempt} failed (${(res.stderr || '').trim()}), retrying in 2s...`);
    execSync('sleep 2');
  }

  const changes = parseInt(String(out).trim().split('\n').pop(), 10);
  if (changes !== 1) fail(`expected exactly 1 row changed, got ${changes} — token NOT installed correctly`);
  log(`Token installed into ${DRY_RUN ? '(dry-run) ' : ''}${TARGET_DB} on ${DRY_RUN ? 'shim' : SSH_HOST} (1 row).`);
}

// ─── Verify (access token only — no rotation risk) ─────────────────────────

async function verifyAccessToken(accessToken) {
  if (DRY_RUN) { log('dry-run: skipping profile verification'); return; }
  const res = await fetch('https://api.prod.whoop.com/developer/v2/user/profile/basic', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) fail(`profile verification failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  const profile = await res.json();
  log(`Profile verified: ${profile.first_name || ''} ${profile.last_name || ''} (user ${profile.user_id})`);
}

async function watchRecovery() {
  log('Watching journalctl on acemagic for the bot to confirm recovery (sweep runs every ~5 min)...');
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    try {
      const out = execFileSync('ssh', [SSH_HOST,
        'journalctl -u botforge-trainer --since "-6 minutes" --no-pager | grep -E "whoop: (valid-skip|refreshed)|Whoop token recovered" | tail -3'],
        { encoding: 'utf8' });
      if (out.trim()) {
        log('Bot confirmed the new token:\n' + out.trim());
        return;
      }
    } catch { /* keep polling */ }
    execSync('sleep 30');
  }
  log('No confirmation within 10 min — check manually: ssh acemagic "journalctl -u botforge-trainer -n 30"');
}

// ─── OAuth browser flow ─────────────────────────────────────────────────────

async function runOAuthFlow({ id, secret }) {
  if (DRY_RUN) {
    return {
      accessToken: 'dryrun-access-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      refreshToken: 'dryrun-refresh-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  // mkcert certs (Whoop requires an https redirect URI)
  const certPaths = [
    ['./localhost.pem', './localhost-key.pem'],
    ['./localhost+1.pem', './localhost+1-key.pem'],
  ];
  let certFile, keyFile;
  for (const [c, k] of certPaths) {
    if (existsSync(c) && existsSync(k)) { certFile = c; keyFile = k; break; }
  }
  if (!certFile) {
    log('No mkcert certs found — creating (requires: brew install mkcert)...');
    execSync('mkcert -install && mkcert localhost', { stdio: 'inherit' });
    certFile = './localhost.pem';
    keyFile = './localhost-key.pem';
  }

  const authUrl = new URL('https://api.prod.whoop.com/oauth/oauth2/auth');
  authUrl.searchParams.set('client_id', id);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('state', 'trainer-reauth');

  return new Promise((resolve, reject) => {
    const server = https.createServer(
      { cert: readFileSync(certFile), key: readFileSync(keyFile) },
      async (req, res) => {
        const url = new URL(req.url, `https://localhost:${PORT}`);
        if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        if (error || !code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`<h1>Auth failed</h1><p>${error || 'no code'}</p>`);
          server.close();
          return reject(new Error(`authorization failed: ${error || 'no code received'}`));
        }

        try {
          const tokenRes = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              code,
              redirect_uri: REDIRECT_URI,
              client_id: id,
              client_secret: secret,
            }),
          });
          if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
          const tokens = await tokenRes.json();
          if (!tokens.refresh_token) {
            throw new Error('no refresh token returned — check the "offline" scope on developer.whoop.com');
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>Auth complete</h1><p>You can close this tab — installing on acemagic...</p>');
          server.close();
          resolve({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600),
          });
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<h1>Token exchange failed</h1><p>${err.message}</p>`);
          server.close();
          reject(err);
        }
      }
    );
    server.listen(PORT, () => {
      log(`Callback server on https://localhost:${PORT} — opening browser...`);
      try { execSync(`open "${authUrl.toString()}"`); }
      catch { log(`Open manually: ${authUrl.toString()}`); }
    });
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

const creds = loadCredentials();
log(`Using Whoop client credentials from: ${creds.source}`);

const tokens = await runOAuthFlow(creds);
log(`Tokens received (access ${tokens.accessToken.length} chars, refresh ${tokens.refreshToken.length} chars, expires ${new Date(tokens.expiresAt * 1000).toISOString()}).`);

installTokens(tokens);
await verifyAccessToken(tokens.accessToken);

log('');
log('PASS — token installed and verified.');
log(`Target DB: ${TARGET_DB}`);
log('The bot picks it up on its next 5-min tick (no restart needed) and will send');
log('a "Whoop token recovered" message; its first real refresh happens within ~55 min.');

if (WATCH) await watchRecovery();
process.exit(0);
