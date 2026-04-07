/**
 * Cron handler: draft_pregenerate
 *
 * Pre-generates Opus drafts for top 3 priority queue entries.
 * Runs every 15 min (offset from email_check).
 */
import { getEntriesNeedingDraft, updateDraftStatus, updateStatus } from '../lib/priority-queue.js';
import { generateDraft } from '../lib/draft-engine.js';
import { getThread, getEmailByMessageId, getThreadBySubject } from '../lib/email-intel-db.js';

export default {
  name: 'draft_pregenerate',
  async execute(ctx) {
    // Register event handler once for reactive draft generation
    if (!ctx.store.get('_draftEventRegistered')) {
      const bus = ctx.store.get('eventBus');
      if (bus) {
        bus.on('queue.entry.created', async (event) => {
          ctx.log.info(`Event-triggered draft check for ${event.email} (entry ${event.entryId})`);
          try {
            const entries = getEntriesNeedingDraft(ctx, 1);
            if (entries.length > 0) {
              // Trigger the normal draft generation logic for the entry
              for (const entry of entries) {
                let hasEmailBody = false;
                if (entry.thread_id) {
                  try {
                    const thread = getThread(entry.thread_id);
                    hasEmailBody = thread.some(m => m.body_text && m.body_text.length > 0);
                  } catch { /* fall through */ }
                }
                if (!hasEmailBody && entry.message_id) {
                  try {
                    const single = getEmailByMessageId(entry.message_id);
                    hasEmailBody = !!(single && single.body_text);
                  } catch { /* fall through */ }
                }
                if (!hasEmailBody && entry.subject) {
                  try {
                    const subjectThread = getThreadBySubject(entry.subject, entry.from_address, 14);
                    hasEmailBody = subjectThread.some(m => m.body_text && m.body_text.length > 0);
                  } catch { /* fall through */ }
                }
                if (!hasEmailBody) continue;

                updateDraftStatus(ctx, entry.id, 'generating');
                try {
                  const result = await generateDraft(ctx, {
                    threadId: entry.thread_id || undefined,
                    contactEmail: entry.from_address,
                  });
                  if (result && result.draftId) {
                    updateDraftStatus(ctx, entry.id, 'ready', result.draftId);
                    updateStatus(ctx, entry.id, 'draft_ready');
                    ctx.log.info(`Event-triggered draft created for ${entry.from_name || entry.from_address}`);
                  } else if (result?.draftText) {
                    updateDraftStatus(ctx, entry.id, 'ready');
                    updateStatus(ctx, entry.id, 'draft_ready');
                  } else {
                    updateDraftStatus(ctx, entry.id, 'none');
                  }
                } catch (err) {
                  updateDraftStatus(ctx, entry.id, 'none');
                  ctx.log.warn(`Event-triggered draft failed: ${err.message}`);
                }
              }
            }
          } catch (err) {
            ctx.log.warn(`Event handler queue.entry.created error: ${err.message}`);
          }
        });
        ctx.store.set('_draftEventRegistered', true);
        ctx.log.info('Draft pregenerate: registered queue.entry.created event listener');
      }
    }

    // Get top 3 entries that need drafts (pending/draft_ready with draft_status none or stale)
    const entries = getEntriesNeedingDraft(ctx, 3);

    if (entries.length === 0) {
      ctx.log.info('Draft pregenerate: no entries needing drafts');
      return;
    }

    let generated = 0;
    let failed = 0;

    for (const entry of entries) {
      // Gate: verify email body exists before drafting
      let hasEmailBody = false;

      if (entry.thread_id) {
        try {
          const thread = getThread(entry.thread_id);
          hasEmailBody = thread.some(m => m.body_text && m.body_text.length > 0);
        } catch { /* fall through */ }
      }

      if (!hasEmailBody && entry.message_id) {
        try {
          const single = getEmailByMessageId(entry.message_id);
          hasEmailBody = !!(single && single.body_text);
        } catch { /* fall through */ }
      }

      if (!hasEmailBody && entry.subject) {
        try {
          const thread = getThreadBySubject(entry.subject, entry.from_address, 14);
          hasEmailBody = thread.some(m => m.body_text && m.body_text.length > 0);
        } catch { /* fall through */ }
      }

      if (!hasEmailBody) {
        ctx.log.warn(`Draft skipped for ${entry.from_name || entry.from_address} "${entry.subject}" — no email body available`);
        continue;
      }

      // Mark as generating so concurrent runs don't pick it up
      updateDraftStatus(ctx, entry.id, 'generating');

      try {
        const result = await generateDraft(ctx, {
          threadId: entry.thread_id || undefined,
          contactEmail: entry.from_address,
        });

        if (result && result.draftId) {
          // Draft created in Gmail successfully
          updateDraftStatus(ctx, entry.id, 'ready', result.draftId);
          updateStatus(ctx, entry.id, 'draft_ready');
          generated++;

          ctx.log.info(
            `Draft pregenerate: created draft for ${entry.from_name || entry.from_address} — "${entry.subject}"`
          );
        } else {
          // generateDraft returned but no Gmail draft ID (e.g. Gmail API down)
          // Still mark as ready if we have draft text, otherwise reset to none
          if (result?.draftText) {
            updateDraftStatus(ctx, entry.id, 'ready');
            updateStatus(ctx, entry.id, 'draft_ready');
            generated++;
          } else {
            updateDraftStatus(ctx, entry.id, 'none');
            failed++;
          }
        }
      } catch (err) {
        // Reset to none so it gets retried next cycle
        updateDraftStatus(ctx, entry.id, 'none');
        failed++;
        ctx.log.warn(
          `Draft pregenerate failed for ${entry.from_address} (${entry.id}): ${err.message}`
        );
      }
    }

    ctx.log.info(
      `Draft pregenerate: generated=${generated}, failed=${failed}, candidates=${entries.length}`
    );
  },
};
