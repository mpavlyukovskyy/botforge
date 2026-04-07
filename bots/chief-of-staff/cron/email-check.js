/**
 * Cron handler: email_check
 *
 * Classifies new incoming emails, inserts into priority queue with scoring,
 * extracts topics, and marks person profiles as stale.
 * Runs every 7 min.
 */
import { getRecentActivity, getContactHistory, getEmailBodyById, getThread } from '../lib/email-intel-db.js';
import { classify, MODELS } from '../lib/claude.js';
import { ensureDb } from '../lib/db.js';
import { calculateScore, upsertQueueEntry, getByMessageId, supersedeByThread, invalidateDrafts, isThreadDismissed } from '../lib/priority-queue.js';
import { createSkeletal, getProfile, markStale } from '../lib/person-profiles.js';
import { getByPerson } from '../lib/commitments-db.js';

let _running = false;

const CATEGORIES = [
  'needs-response',
  'FYI',
  'noise',
  'scheduling',
  'customer',
  'internal',
];

/**
 * Slugify a string into a topic slug (lowercase, hyphenated).
 */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Extract topic slugs from a classification summary.
 * Splits on commas, semicolons, and "and", then slugifies each fragment.
 */
function extractTopics(summary) {
  if (!summary) return [];
  const fragments = summary.split(/[,;]|\band\b/i).map(s => s.trim()).filter(Boolean);
  return fragments
    .map(f => slugify(f))
    .filter(slug => slug.length >= 3 && slug.length <= 60);
}

export default {
  name: 'email_check',
  async execute(ctx) {
    // Re-entrancy guard
    if (_running) {
      ctx.log.info('Email check: skipping, already running');
      return;
    }
    _running = true;

    try {
      const db = ensureDb(ctx.config);

      // Always scan 7 days — dedup skips already-classified emails.
      // Per-run cap of 25 prevents API overload during initial backfill.
      const allRecent = getRecentActivity(168);
      const recentEmails = allRecent.filter(e =>
        e.direction === 'received' &&
        e.from_address &&
        !e.from_address.startsWith('no-reply@') &&
        !e.from_address.startsWith('noreply@') &&
        !e.from_address.startsWith('notifications@') &&
        !e.from_address.includes('@calendar.google.com')
      );

      if (recentEmails.length === 0) {
        ctx.log.info('Email check: 0 received candidates in last 7 days');
        return;
      }

      const chatId = ctx.config.platform?.chat_ids?.[0]
        || ctx.config.behavior?.access?.admin_users?.[0];

      const MAX_PER_RUN = 25;
      const highPriorityItems = [];
      let classified = 0;
      let skipped = 0;
      let queued = 0;
      let topicsExtracted = 0;

      for (const email of recentEmails) {
        // Per-run cap to avoid API overload during backfill
        if (classified >= MAX_PER_RUN) break;

        // Skip if already classified
        const existing = db.prepare(
          'SELECT email_id FROM email_classifications WHERE email_id = ?'
        ).get(email.id);
        if (existing) { skipped++; continue; }

        // ── Pre-filter: auto-reply bouncebacks ──
        const autoReplySubject = /^(please update your contact information|out of office|automatic reply|auto-?reply)/i;
        if (autoReplySubject.test(email.subject)) {
          db.prepare(`
            INSERT OR REPLACE INTO email_classifications
              (email_id, classification, urgency, action_required, draft_needed, summary)
            VALUES (?, 'noise', 'normal', 0, 0, 'Auto-reply / bounceback — skipped')
          `).run(email.id);
          skipped++;
          continue;
        }

        // ── Pre-filter: sender dedup (max 3 active queue entries per sender) ──
        const senderCount = db.prepare(
          `SELECT COUNT(*) as c FROM priority_queue
           WHERE from_address = ? COLLATE NOCASE
             AND status IN ('pending', 'draft_ready', 'presented')`
        ).get(email.from_address);
        if (senderCount && senderCount.c >= 3) {
          db.prepare(`
            INSERT OR REPLACE INTO email_classifications
              (email_id, classification, urgency, action_required, draft_needed, summary)
            VALUES (?, 'noise', 'normal', 0, 0, 'Sender already has 3+ entries in queue — deduped')
          `).run(email.id);
          skipped++;
          continue;
        }

        // ── Detect mailing list / Google Group ──
        const bodyText = getEmailBodyById(email.id);
        let toList = [];
        try { toList = JSON.parse(email.to_addresses || '[]'); } catch {}
        const markAddressed = toList.some(a =>
          typeof a === 'string' && /^mark/i.test(a) && a.includes('@science.xyz')
        );
        const isMailingList = !markAddressed && (
          (bodyText && bodyText.includes('You received this message because you are subscribed to the Google Groups'))
        );

        // Also check body for auto-reply patterns missed by subject filter
        const bodyStart = (bodyText || '').slice(0, 200).toLowerCase();
        const isBodyAutoReply = bodyStart.includes('i am currently out of the office')
          || bodyStart.includes('thank you for your email. please update your contact information')
          || bodyStart.includes('this is an automated response');
        if (isBodyAutoReply) {
          db.prepare(`
            INSERT OR REPLACE INTO email_classifications
              (email_id, classification, urgency, action_required, draft_needed, summary)
            VALUES (?, 'noise', 'normal', 0, 0, 'Auto-reply detected in body — skipped')
          `).run(email.id);
          skipped++;
          continue;
        }

        // ── Thread context for classification ──
        let threadNotes = [];
        let threadMsgs = [];
        if (email.gmail_thread_id) {
          threadMsgs = getThread(String(email.gmail_thread_id));
          const markSent = threadMsgs.filter(m => m.direction === 'sent');
          if (markSent.length > 0) {
            const latestReply = markSent[markSent.length - 1];
            threadNotes.push(`Mark already replied in this thread on ${latestReply.date.slice(0,10)}: "${(latestReply.body_text||'').slice(0,200)}"`);
          }
          // Show recent thread messages for context
          const recent = threadMsgs.slice(-3).filter(m => m.id !== email.id);
          if (recent.length > 0) {
            threadNotes.push('Recent thread messages:');
            for (const m of recent) {
              threadNotes.push(`  [${m.direction}] ${m.from_name||m.from_address} (${m.date.slice(0,10)}): ${(m.body_text||'').slice(0,200)}`);
            }
          }
        }
        // Internal forward detection
        const isInternalSender = email.from_address?.endsWith('@science.xyz');
        const isForward = /^(Fwd|Fw):/i.test(email.subject);
        if (isInternalSender && isForward) {
          threadNotes.push('Note: This is a FORWARDED email from an internal team member. Default to FYI unless they explicitly ask Mark to reply.');
        }
        // BCC detection
        const markInRecipients = toList.some(a => typeof a === 'string' && a.includes('markp@science.xyz'));
        if (!markInRecipients && isInternalSender) {
          threadNotes.push('Note: Mark is NOT in To/CC — he appears to be BCC\'d. Likely FYI only.');
        }

        // ── Classify with Sonnet + CEO-specific prompt ──
        const classifyPrompt = [
          'You are an email triage assistant for Mark, a CEO of a manufacturing/science company.',
          'Classify this email into exactly one category:',
          '',
          '- needs-response: The sender is waiting for Mark to reply TO THIS EMAIL — a clear question, request, or decision requiring an email back to the sender',
          '- FYI: Informational, no email reply needed — includes: forwarded emails for awareness, meeting/call prep alerts, status updates, project updates, internal team FYIs',
          '- noise: Spam, newsletters, vendor cold outreach, automated messages, mailing list posts',
          '- scheduling: Calendar invites, meeting scheduling (no reply needed)',
          '- customer: An external customer is directly asking Mark a question or making a request that needs an email reply',
          '- internal: From internal team, informational (no reply needed)',
          '',
          'Key rules:',
          '- Forwarded emails (Fwd:) from internal team are FYI unless the forwarder explicitly asks Mark to reply to someone',
          '- "Prep for a call" or "heads up about a meeting" emails are FYI, not needs-response',
          '- Auto-reply bouncebacks and "please update contact info" messages are noise',
          '- Cold outreach from unknown vendors/investors is noise',
          '- Emails sent to mailing lists (not addressed to Mark personally) are noise',
          '- Calendar invitations are scheduling, not needs-response',
          '- Weekly status reports, project updates, and progress summaries are FYI',
          '- Simple thread replies that are acknowledgments with no new questions are internal or FYI',
          '- needs-response requires the sender to be WAITING for Mark\'s email reply — not just that Mark should read or prep for something',
          '- customer requires an external customer asking a question or making a request that needs an email reply',
          '',
          'Respond with ONLY valid JSON: {"category": "...", "confidence": 0.0-1.0, "summary": "one sentence"}',
        ].join('\n');

        const inputText = [
          `From: ${email.from_name || email.from_address}`,
          `To: ${toList.join(', ')}`,
          `Subject: ${email.subject}`,
          `Direction: ${email.direction}`,
          email.category ? `Contact category: ${email.category}` : '',
          isMailingList ? 'Note: This email was sent to a mailing list, not directly to Mark.' : '',
          bodyText ? `Body:\n${bodyText.slice(0, 1000)}` : '',
        ].filter(Boolean).join('\n')
        + (threadNotes.length > 0 ? '\n\n' + threadNotes.join('\n') : '');

        try {
          const result = await classify(inputText, CATEGORIES, {
            systemPrompt: classifyPrompt,
            model: MODELS.SONNET,
          });
          const category = result.category || 'noise';
          const isCustomer = category === 'customer';
          const urgency = result.confidence >= 0.8 ? 'high' : 'normal';
          const actionRequired = category === 'needs-response' ? 1 : 0;
          const draftNeeded = (actionRequired && isCustomer) ? 1 : 0;

          // Store classification (backward compat)
          db.prepare(`
            INSERT OR REPLACE INTO email_classifications
              (email_id, classification, urgency, action_required, draft_needed, summary)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            email.id,
            category,
            urgency,
            actionRequired,
            draftNeeded,
            result.summary || null,
          );

          // Insert into priority queue for received emails needing attention
          if (email.direction === 'received' && (actionRequired || isCustomer)) {
            const contactHistory = getContactHistory(email.from_address);
            const commitments = getByPerson(ctx, email.from_address);
            const activeCommitments = commitments.filter(c => c.status === 'active');
            const overdueCommitments = commitments.filter(
              c => c.status === 'active' && c.due_date && c.due_date < new Date().toISOString().slice(0, 10)
            );

            const customerTier = contactHistory?.customer?.tier ?? null;
            const customerName = contactHistory?.customer?.name || null;

            // Calculate email age in hours
            const emailDate = new Date(email.date);
            const emailAgeHours = (Date.now() - emailDate.getTime()) / (1000 * 60 * 60);

            const { score, factors } = calculateScore({
              contactCategory: email.category || contactHistory?.contact?.category || null,
              customerTier,
              urgency,
              hasCommitments: activeCommitments.length > 0,
              hasOverdueCommitment: overdueCommitments.length > 0,
              emailAgeHours,
            });

            // If thread_id exists, supersede old entries and invalidate stale drafts
            if (email.gmail_thread_id) {
              invalidateDrafts(ctx, email.gmail_thread_id);
            }

            const threadId = email.gmail_thread_id ? String(email.gmail_thread_id) : null;
            if (!threadId) {
              ctx.log.warn(`Email ${email.id} (${email.from_address}) missing gmail_thread_id`);
            }

            // Skip re-queueing if this thread was previously dismissed
            if (!isThreadDismissed(ctx, threadId)) {
              // Also skip if Mark already replied anywhere in this thread
              const markRepliedInThread = threadMsgs.some(m => m.direction === 'sent');

              if (!markRepliedInThread) {
                const entry = upsertQueueEntry(ctx, {
                  messageId: email.message_id,
                  threadId,
                  fromAddress: email.from_address,
                  fromName: email.from_name || null,
                  subject: email.subject,
                  contactCategory: email.category || contactHistory?.contact?.category || null,
                  customerName,
                  customerTier,
                  priorityScore: score,
                  priorityFactors: factors,
                  status: 'pending',
                  summary: result.summary || null,
                });

                // Supersede older entries for the same thread
                if (email.gmail_thread_id && entry) {
                  supersedeByThread(ctx, email.gmail_thread_id, entry.id);
                }

                queued++;

                // Emit event for reactive draft generation
                const bus = ctx.store.get('eventBus');
                if (bus && entry) {
                  bus.emit('queue.entry.created', {
                    entryId: entry.id,
                    email: email.from_address,
                    priority: score,
                    subject: email.subject,
                  });
                }

                // Track high-priority for notification (only emails < 1h old to avoid backfill spam)
                const emailAgeMs = Date.now() - new Date(email.date).getTime();
                if (score >= 0.7 && emailAgeMs < 3600000) {
                  const label = email.from_name || email.from_address.split('@')[0];
                  highPriorityItems.push(
                    `${label} — ${result.summary || email.subject} (score: ${score})`
                  );
                }
              } else {
                ctx.log.info(`Skipping already-replied thread: ${email.subject}`);
              }
            } else {
              ctx.log.info(`Skipping dismissed thread: ${email.subject}`);
            }
          }

          // Extract topics from summary
          const topics = extractTopics(result.summary);
          if (topics.length > 0 && email.message_id) {
            const insertTopic = db.prepare(`
              INSERT OR IGNORE INTO email_topics (message_id, topic_slug)
              VALUES (?, ?)
            `);
            for (const slug of topics) {
              insertTopic.run(email.message_id, slug);
              topicsExtracted++;
            }
          }

          // Ensure sender has a person_profile (skeletal if new)
          const senderEmail = email.from_address;
          if (senderEmail) {
            const profile = getProfile(ctx, senderEmail);
            if (!profile) {
              createSkeletal(ctx, {
                email: senderEmail,
                displayName: email.from_name || null,
                category: email.category || null,
                company: null,
              });
            }
            // Mark sender profile as stale (new email = stale profile)
            markStale(ctx, senderEmail);

            // Emit event for reactive profile compilation
            const busForProfile = ctx.store.get('eventBus');
            if (busForProfile) {
              busForProfile.emit('profile.stale', { email: senderEmail });
            }
          }

          classified++;
        } catch (err) {
          ctx.log.error(`Classification failed for email ${email.id}: ${err.message}`);
        }
      }

      ctx.log.info(
        `Email check: ${recentEmails.length} candidates (${skipped} already done), classified ${classified}, queued ${queued}`
      );

      // Notify on high-priority items (score >= 0.7)
      if (highPriorityItems.length > 0 && chatId) {
        const text = [
          `\u{1F6A8} ${highPriorityItems.length} high-priority email${highPriorityItems.length > 1 ? 's' : ''}:`,
          ...highPriorityItems.map(item => `\u2022 ${item}`),
        ].join('\n');

        await ctx.adapter.send({ chatId, text, parseMode: 'Markdown' });
      }
    } finally {
      _running = false;
    }
  },
};
