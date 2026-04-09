/**
 * Gmail client — create drafts locally, send via SMTP.
 *
 * Replaces the old OAuth2 / Gmail API approach with:
 *   - Local DB storage for drafts (via better-sqlite3)
 *   - nodemailer SMTP transport for sending (Gmail app password)
 *
 * Usage:
 *   import { initGmail, createDraft, sendDraft } from './gmail-client.js';
 *   await initGmail(email, appPassword, config);
 *   const { draftId } = await createDraft({ to: '...', subject: '...', body: '...' });
 *   const { messageId, threadId } = await sendDraft(draftId);
 */

import { createTransport } from 'nodemailer';
import { randomUUID } from 'node:crypto';
import { ensureDb } from './db.js';

// ─── State ───────────────────────────────────────────────────────────────────

let _transport = null;
let _email = null;
let _config = null;

// ─── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize the Gmail client.
 *
 * @param {string|null} email       - Gmail address (e.g. markp@science.xyz)
 * @param {string|null} appPassword - Gmail app password (16 chars, no spaces)
 * @param {object}      config      - Bot config (needed for DB access via ensureDb)
 */
export async function initGmail(email, appPassword, config) {
  // Always store config so createDraft() can access the DB
  _config = config;

  if (!email || !appPassword) {
    console.log('[gmail-client] No email/password provided — draft storage only (no SMTP)');
    return;
  }

  _email = email;

  const transport = createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: email,
      pass: appPassword,
    },
  });

  // Verify SMTP connection before storing transport (with timeout)
  await Promise.race([
    transport.verify(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('SMTP verify timed out (10s)')), 10_000)),
  ]);
  _transport = transport;

  console.log(`[gmail-client] SMTP initialized as ${email}`);
}

/**
 * Stub — returns null. Kept for any imports that reference it.
 */
export function getOAuth2Client() {
  return null;
}

// ─── Draft Operations ────────────────────────────────────────────────────────

/**
 * Create a draft stored in the local DB.
 *
 * @param {Object} opts
 * @param {string}  opts.to          - Recipient(s), comma-separated
 * @param {string}  opts.subject     - Email subject
 * @param {string}  opts.body        - Plain-text body
 * @param {string}  [opts.cc]        - CC recipients
 * @param {string}  [opts.bcc]       - BCC recipients
 * @param {string}  [opts.threadId]  - Thread ID (for replies)
 * @param {string}  [opts.inReplyTo] - Message-ID header of the message being replied to
 * @returns {{ draftId: string, messageId: null }}
 */
export async function createDraft({ to, subject, body, cc, bcc, threadId, inReplyTo }) {
  if (!_config) {
    throw new Error('[gmail-client] Not initialized. Call initGmail() first.');
  }

  const db = ensureDb(_config);
  const draftId = randomUUID();

  // When replying, prefix subject with "Re: " if not already present
  let finalSubject = subject || '';
  if (threadId && inReplyTo && finalSubject && !finalSubject.startsWith('Re: ')) {
    finalSubject = `Re: ${finalSubject}`;
  }

  db.prepare(`
    INSERT INTO gmail_drafts (draft_id, thread_id, to_address, subject, body_preview, body_text, in_reply_to, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    draftId,
    threadId || null,
    to || null,
    finalSubject,
    (body || '').slice(0, 200),
    body || null,
    inReplyTo || null,
  );

  return { draftId, messageId: null };
}

/**
 * Send a draft by ID via SMTP.
 *
 * @param {string} draftId - Draft ID returned by createDraft()
 * @returns {{ messageId: string, threadId: string|null }}
 */
export async function sendDraft(draftId) {
  if (!_transport) {
    throw new Error('[gmail-client] SMTP not initialized — cannot send. Check SCIENCE_GMAIL_EMAIL / SCIENCE_GMAIL_APP_PASSWORD.');
  }
  if (!_config) {
    throw new Error('[gmail-client] Not initialized. Call initGmail() first.');
  }

  const db = ensureDb(_config);
  const draft = db.prepare('SELECT * FROM gmail_drafts WHERE draft_id = ?').get(draftId);

  if (!draft) {
    throw new Error(`[gmail-client] Draft not found: ${draftId}`);
  }

  const mailOptions = {
    from: _email,
    to: draft.to_address,
    subject: draft.subject || '(no subject)',
    text: draft.body_text || draft.body_preview || '',
  };

  if (draft.in_reply_to) {
    mailOptions.inReplyTo = draft.in_reply_to;
    mailOptions.references = draft.in_reply_to;
  }

  const info = await _transport.sendMail(mailOptions);

  // Update draft status
  db.prepare(
    "UPDATE gmail_drafts SET status = 'sent', message_id = ?, acted_at = datetime('now') WHERE draft_id = ?"
  ).run(info.messageId || null, draftId);

  return {
    messageId: info.messageId || null,
    threadId: draft.thread_id || null,
  };
}
