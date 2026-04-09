/**
 * Cron handler: operations_sync
 *
 * Daily operations status compilation. Covers W3 (delegated) commitments,
 * internal emails, and internal notes.
 * Runs 9:10am ET weekdays.
 */
import { searchEmails, getNotes } from '../lib/email-intel-db.js';
import { compile } from '../lib/claude.js';
import { listCommitments } from '../lib/commitments-db.js';
import { writePage, readPage } from '../lib/kb.js';

export default {
  name: 'operations_sync',
  async execute(ctx) {
    // 1. Get all active W3 (delegated) commitments
    const delegated = listCommitments(ctx, { type: 'W3', status: 'active' });

    // 2. Get internal-category emails from last 14 days
    const since14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const internalEmails = searchEmails(null, { category: 'internal', since: since14d, limit: 50 });

    // 3. Get internal notes
    const internalNotes = getNotes({ project: 'internal' });

    // 4. Get existing page
    const existingPage = readPage('operations/internal-status.md');

    // 5. Build context
    const contextParts = [];

    if (delegated.length > 0) {
      contextParts.push('=== DELEGATED (W3) COMMITMENTS ===');
      for (const c of delegated) {
        const due = c.due_date ? ` (due ${c.due_date})` : '';
        const age = c.created_at ? ` [created ${c.created_at.slice(0, 10)}]` : '';
        contextParts.push(`- ${c.description}${due} \u2014 delegated to ${c.counterparty}${age}`);
        if (c.notes) contextParts.push(`  Notes: ${c.notes.slice(0, 200)}`);
      }
    }

    if (internalEmails.length > 0) {
      contextParts.push('\n=== INTERNAL EMAILS (last 14d) ===');
      for (const e of internalEmails) {
        const dir = e.direction === 'received' ? '\u2190' : '\u2192';
        contextParts.push(`[${e.date?.slice(0, 10)}] ${dir} ${e.from_name || e.from_address}: ${e.subject}`);
        if (e.body_text) contextParts.push(`  ${e.body_text.slice(0, 200)}`);
      }
    }

    if (internalNotes.length > 0) {
      contextParts.push('\n=== INTERNAL NOTES ===');
      for (const n of internalNotes.slice(0, 15)) {
        contextParts.push(`[${n.date}] ${n.content?.slice(0, 300)}`);
      }
    }

    if (existingPage) {
      contextParts.push('\n=== PREVIOUS STATUS PAGE ===');
      contextParts.push(existingPage.content.slice(0, 2000));
    }

    if (contextParts.length === 0) {
      ctx.log.info('operations_sync: no data to compile');
      return;
    }

    const context = contextParts.join('\n');

    // 6. Compile via Sonnet
    const systemPrompt = `You are an operations status compiler for Science Corp.
Compile a concise internal operations status page in markdown. Include sections for:
- Operations Overview (one paragraph summary of current state)
- Delegated Items (table: task | delegated to | due date | status/notes)
- Internal Communications Summary (key themes from recent emails)
- Open Issues & Blockers
- Mark's Action Items (specific follow-ups Mark needs to do)

Be factual, concise, reference specific dates and people. Today is ${new Date().toISOString().slice(0, 10)}.`;

    const result = await compile(systemPrompt, context, 'Compile the internal operations status page.');

    if (result.is_error) {
      ctx.log.error(`operations_sync failed: ${result.text}`);
      return;
    }

    // 7. Write KB page
    writePage('operations/internal-status.md', {
      title: 'Internal Operations Status',
      content: result.text,
      category: 'operations',
      entityType: 'project',
      entityName: 'internal',
    });

    ctx.log.info(`operations_sync: compiled operations page (${result.text.length} chars)`);
  },
};
