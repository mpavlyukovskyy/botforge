/**
 * Cron handler: queue_maintenance
 *
 * Maintains the priority queue: expires old entries, re-scores active entries,
 * caps queue size, and cleans up stale drafts.
 * Runs every 15 min.
 */
import { ensureDb } from '../lib/db.js';
import {
  expireOld,
  listQueue,
  updateScore,
  capQueue,
  updateStatus,
} from '../lib/priority-queue.js';
import { calculateScore } from '../lib/priority-queue.js';
import { getContactHistory, getThread, getEmailByMessageId, hasOutboundReply } from '../lib/email-intel-db.js';
import { getByPerson } from '../lib/commitments-db.js';
import { logAudit } from '../lib/db.js';

export default {
  name: 'queue_maintenance',
  async execute(ctx) {
    const db = ensureDb(ctx.config);

    // 1. Expire entries older than 48h
    const expired = expireOld(ctx, 48);

    // 1.5. Auto-act entries where Mark already replied in the thread
    let autoActed = 0;
    try {
      const checkEntries = listQueue(ctx, { status: ['pending', 'draft_ready', 'presented'], limit: 50 });
      for (const entry of checkEntries) {
        let replied = false;

        // Resolve thread_id: prefer queue entry's, fall back to email's gmail_thread_id
        let threadId = entry.thread_id;
        if (!threadId && entry.message_id) {
          try {
            const email = getEmailByMessageId(entry.message_id);
            if (email?.gmail_thread_id) {
              threadId = email.gmail_thread_id;
            }
          } catch { /* fall through to counterparty check */ }
        }

        // Thread-based detection: check for sent replies after the received email
        if (threadId) {
          try {
            const thread = getThread(threadId);
            const triggeringEmail = thread.find(msg => msg.message_id === entry.message_id);
            const emailDate = triggeringEmail?.date || entry.inserted_at;
            replied = thread.some(
              msg => msg.direction === 'sent' && msg.date > emailDate
            );
          } catch { /* fall through to counterparty check */ }
        }

        // Fall back to counterparty-based: most recent email is outbound
        if (!replied && entry.from_address) {
          replied = hasOutboundReply(entry.from_address);
        }

        if (replied) {
          updateStatus(ctx, entry.id, 'acted');
          logAudit(ctx, 'queue_auto_acted', `${entry.from_name || entry.from_address}: ${entry.subject}`);
          autoActed++;
        }
      }
    } catch (err) {
      ctx.log.warn(`Reply detection failed: ${err.message}`);
    }

    // 1.6. Auto-dismiss entries whose emails are no longer in INBOX (archived by Mark)
    let autoDismissed = 0;
    try {
      const imapEmail = process.env.SCIENCE_GMAIL_EMAIL;
      const imapPassword = process.env.SCIENCE_GMAIL_APP_PASSWORD;
      if (imapEmail && imapPassword) {
        const { getInboxMessageIds } = await import('../lib/gmail-imap.js');
        const inboxIds = await getInboxMessageIds(imapEmail, imapPassword);

        if (inboxIds !== null) { // null = IMAP failed, skip
          const remaining = listQueue(ctx, { status: ['pending', 'draft_ready', 'presented'], limit: 50 });
          for (const entry of remaining) {
            if (!entry.message_id) continue;
            const normalizedId = entry.message_id.replace(/^<|>$/g, '');
            if (!inboxIds.has(normalizedId)) {
              updateStatus(ctx, entry.id, 'dismissed');
              logAudit(ctx, 'queue_auto_dismissed',
                `Archived in Gmail: ${entry.from_name || entry.from_address}: ${entry.subject}`);
              autoDismissed++;
            }
          }
        }
      }
    } catch (err) {
      ctx.log.warn(`IMAP inbox check failed: ${err.message}`);
    }

    // 2. Re-score all active entries (email age + commitments may have changed)
    const activeEntries = listQueue(ctx, { status: ['pending', 'draft_ready', 'presented'], limit: 50 });
    let rescored = 0;

    for (const entry of activeEntries) {
      try {
        const contactHistory = getContactHistory(entry.from_address);
        const commitments = getByPerson(ctx, entry.from_address);
        const activeCommitments = commitments.filter(c => c.status === 'active');
        const today = new Date().toISOString().slice(0, 10);
        const overdueCommitments = commitments.filter(
          c => c.status === 'active' && c.due_date && c.due_date < today
        );

        // Calculate email age from inserted_at timestamp
        const insertedAt = new Date(entry.inserted_at);
        const emailAgeHours = (Date.now() - insertedAt.getTime()) / (1000 * 60 * 60);

        const { score, factors } = calculateScore({
          contactCategory: entry.contact_category,
          customerTier: entry.customer_tier,
          urgency: entry.priority_factors
            ? (JSON.parse(entry.priority_factors).high_urgency ? 'high' : 'normal')
            : 'normal',
          hasCommitments: activeCommitments.length > 0,
          hasOverdueCommitment: overdueCommitments.length > 0,
          emailAgeHours,
        });

        // Only update if score actually changed
        if (Math.abs(score - entry.priority_score) > 0.001) {
          updateScore(ctx, entry.id, score, factors);
          rescored++;
        }
      } catch (err) {
        ctx.log.warn(`Re-score failed for entry ${entry.id}: ${err.message}`);
      }
    }

    // 3. Cap queue at 25 active entries
    const capped = capQueue(ctx, 25);

    // 4. Clean up stale drafts: delete gmail_drafts rows for entries with draft_status = 'stale'
    let staleCleaned = 0;
    try {
      const staleEntries = db.prepare(`
        SELECT id, draft_id FROM priority_queue
        WHERE draft_status = 'stale' AND draft_id IS NOT NULL
      `).all();

      for (const entry of staleEntries) {
        db.prepare('DELETE FROM gmail_drafts WHERE draft_id = ?').run(entry.draft_id);
        db.prepare(
          "UPDATE priority_queue SET draft_status = 'none', draft_id = NULL WHERE id = ?"
        ).run(entry.id);
        staleCleaned++;
      }
    } catch (err) {
      ctx.log.warn(`Stale draft cleanup error: ${err.message}`);
    }

    ctx.log.info(
      `Queue maintenance: expired=${expired}, auto_acted=${autoActed}, auto_dismissed=${autoDismissed}, rescored=${rescored}, capped=${capped}, stale_cleaned=${staleCleaned}`
    );
  },
};
