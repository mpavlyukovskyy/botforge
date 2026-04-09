/**
 * Gmail IMAP inbox checker — batch-fetches all INBOX message-ids.
 * Used by queue_maintenance to auto-dismiss archived emails.
 */
import { ImapFlow } from 'imapflow';

/**
 * Fetch all Message-IDs currently in INBOX (last 7 days).
 * Returns Set<string> of normalized message-ids (no angle brackets), or null on failure.
 */
export async function getInboxMessageIds(email, password) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
    emitLogs: false,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });

  const ids = new Set();
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const uids = await client.search({ since });
      if (uids.length > 0) {
        for await (const msg of client.fetch(uids, { envelope: true })) {
          if (msg.envelope?.messageId) {
            ids.add(msg.envelope.messageId.replace(/^<|>$/g, ''));
          }
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    console.warn(`[gmail-imap] IMAP inbox check failed: ${err.message}`);
    return null;
  }
  return ids;
}
