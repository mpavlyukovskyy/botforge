/**
 * Cron handler: construction_sync
 *
 * Daily construction status compilation. Gathers Procore data, construction emails,
 * notes, and milestones → Sonnet compiles a dashboard page with action items.
 * Runs 9:00am ET weekdays.
 */
import { getConstructionStatus, getNotes } from '../lib/email-intel-db.js';
import { compile } from '../lib/claude.js';
import { listCommitments } from '../lib/commitments-db.js';
import { writePage, readPage } from '../lib/kb.js';

export default {
  name: 'construction_sync',
  async execute(ctx) {
    // 1. Gather sources
    const construction = getConstructionStatus(14); // last 14 days
    const commitments = listCommitments(ctx, { status: 'active', project: 'construction' });
    const existingPage = readPage('facility/construction-status.md');

    // 2. Build context
    const contextParts = [];

    if (construction.milestones.length > 0) {
      contextParts.push('=== SCHEDULE MILESTONES ===');
      for (const m of construction.milestones) {
        const cp = m.is_critical_path ? ' [CRITICAL PATH]' : '';
        contextParts.push(`- ${m.name}: ${m.status}, ${m.percent_complete || 0}% complete${cp}`);
        if (m.end_date) contextParts.push(`  Due: ${m.end_date}`);
      }
    }

    if (construction.emails.length > 0) {
      contextParts.push('\n=== RECENT CONSTRUCTION EMAILS (last 14d) ===');
      for (const e of construction.emails.slice(0, 30)) {
        const dir = e.direction === 'received' ? '\u2190' : '\u2192';
        const body = e.body_text ? e.body_text.slice(0, 300) : '';
        contextParts.push(`[${e.date?.slice(0, 10)}] ${dir} ${e.from_name || e.from_address}: ${e.subject}`);
        if (body) contextParts.push(`  ${body}`);
      }
    }

    if (construction.notes.length > 0) {
      contextParts.push('\n=== CONSTRUCTION NOTES ===');
      for (const n of construction.notes.slice(0, 10)) {
        contextParts.push(`[${n.date}] ${n.content?.slice(0, 500)}`);
      }
    }

    if (commitments.length > 0) {
      contextParts.push('\n=== ACTIVE CONSTRUCTION COMMITMENTS ===');
      for (const c of commitments) {
        const due = c.due_date ? ` (due ${c.due_date})` : '';
        contextParts.push(`- [${c.type}] ${c.description}${due} \u2014 ${c.bearer} \u2192 ${c.counterparty}`);
      }
    }

    if (existingPage) {
      contextParts.push('\n=== PREVIOUS STATUS PAGE ===');
      contextParts.push(existingPage.content.slice(0, 2000));
    }

    if (contextParts.length === 0) {
      ctx.log.info('construction_sync: no data to compile');
      return;
    }

    const context = contextParts.join('\n');

    // 3. Compile via Sonnet
    const systemPrompt = `You are a construction project status compiler for Science Corp's MEMS foundry in Durham, NC.
Compile a concise status dashboard in markdown. Include sections for:
- Overall Status (one paragraph)
- Key Milestones (table: milestone | status | due date | notes)
- Active Issues & RFIs
- Recent Activity Summary
- Mark's Action Items (specific things Mark needs to do or follow up on)

Be factual, concise, reference specific dates and people. Today is ${new Date().toISOString().slice(0, 10)}.`;

    const result = await compile(systemPrompt, context, 'Compile the construction status dashboard.');

    if (result.is_error) {
      ctx.log.error(`construction_sync failed: ${result.text}`);
      return;
    }

    // 4. Write KB page
    writePage('facility/construction-status.md', {
      title: 'Construction Status',
      content: result.text,
      category: 'facility',
      entityType: 'project',
      entityName: 'construction',
    });

    ctx.log.info(`construction_sync: compiled status page (${result.text.length} chars)`);
  },
};
