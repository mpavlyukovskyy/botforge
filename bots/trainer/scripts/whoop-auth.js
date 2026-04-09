#!/usr/bin/env node
/**
 * One-time Whoop OAuth 2.0 flow.
 *
 * Run on Mac (not server) — opens browser for consent.
 * Uses mkcert for HTTPS (Whoop requires https redirect URI).
 *
 * Prerequisites:
 *   brew install mkcert && mkcert -install && mkcert localhost
 *   → creates localhost.pem and localhost-key.pem in CWD
 *
 * Usage:
 *   WHOOP_CLIENT_ID=... WHOOP_CLIENT_SECRET=... node scripts/whoop-auth.js
 */

import https from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';

const CLIENT_ID = process.env.WHOOP_CLIENT_ID;
const CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET;
const REDIRECT_URI = 'https://localhost:8090/callback';
const PORT = 8090;
// Note: 'offline' scope grants refresh tokens but may not be available in all Whoop apps.
// Without it, tokens expire in ~1 hour and you'll need to re-run this script.
const SCOPES = 'offline read:recovery read:sleep read:cycles read:profile read:workout';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET env vars');
  process.exit(1);
}

// Find mkcert certs
const certPaths = [
  ['./localhost.pem', './localhost-key.pem'],
  ['./localhost+1.pem', './localhost+1-key.pem'],
];

let certFile, keyFile;
for (const [c, k] of certPaths) {
  if (existsSync(c) && existsSync(k)) {
    certFile = c;
    keyFile = k;
    break;
  }
}

if (!certFile) {
  console.error('No mkcert certs found. Run: mkcert localhost');
  process.exit(1);
}

// Build auth URL
const authUrl = new URL('https://api.prod.whoop.com/oauth/oauth2/auth');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPES);
authUrl.searchParams.set('state', 'trainer-auth');

console.log('\nOpening browser for Whoop authorization...\n');
console.log(`Auth URL: ${authUrl.toString()}\n`);

// Start HTTPS server to catch the callback
const server = https.createServer(
  {
    cert: readFileSync(certFile),
    key: readFileSync(keyFile),
  },
  async (req, res) => {
    const url = new URL(req.url, `https://localhost:${PORT}`);

    if (url.pathname !== '/callback') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<h1>Auth failed</h1><p>${error}</p>`);
      console.error(`Auth error: ${error}`);
      process.exit(1);
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h1>No code received</h1>');
      return;
    }

    console.log('Authorization code received. Exchanging for tokens...');

    try {
      const tokenRes = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
        }),
      });

      if (!tokenRes.ok) {
        const body = await tokenRes.text();
        throw new Error(`Token exchange failed: ${tokenRes.status} ${body}`);
      }

      const tokens = await tokenRes.json();
      const expiresAt = Math.floor(Date.now() / 1000) + (tokens.expires_in || 3600);

      // Store in SQLite
      mkdirSync('data', { recursive: true });
      const db = new Database('data/Trainer-trainer.db');
      db.pragma('journal_mode = WAL');

      db.exec(`
        CREATE TABLE IF NOT EXISTS oauth_tokens (
          provider TEXT PRIMARY KEY,
          access_token TEXT NOT NULL,
          refresh_token TEXT,
          expires_at INTEGER,
          locked_at INTEGER,
          updated_at TEXT DEFAULT (datetime('now'))
        );
      `);

      db.prepare(`
        INSERT OR REPLACE INTO oauth_tokens (provider, access_token, refresh_token, expires_at, updated_at)
        VALUES ('whoop', ?, ?, ?, datetime('now'))
      `).run(tokens.access_token, tokens.refresh_token || null, expiresAt);

      db.close();

      console.log('\nTokens stored in data/Trainer-trainer.db');
      console.log(`  Access token: ${tokens.access_token.slice(0, 20)}...`);
      console.log(`  Refresh token: ${tokens.refresh_token ? 'present' : 'MISSING (check offline scope!)'}`);
      console.log(`  Expires at: ${new Date(expiresAt * 1000).toISOString()}`);

      if (!tokens.refresh_token) {
        console.warn('\n⚠️  No refresh token! Go to developer.whoop.com → edit app → check "offline" scope');
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Auth complete!</h1><p>You can close this tab. Tokens saved to SQLite.</p>');

      setTimeout(() => process.exit(0), 500);
    } catch (err) {
      console.error(`Token exchange failed: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h1>Token exchange failed</h1><p>${err.message}</p>`);
      process.exit(1);
    }
  }
);

server.listen(PORT, () => {
  console.log(`HTTPS callback server listening on port ${PORT}`);
  try {
    execSync(`open "${authUrl.toString()}"`);
  } catch {
    console.log('Could not open browser. Visit the URL above manually.');
  }
});
