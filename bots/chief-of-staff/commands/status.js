/**
 * Command: /status
 *
 * Shows Chief of Staff operational status: KB stats, commitment stats,
 * email intel stats, next calendar event, and uptime.
 */
import { getStats as getCommitmentStats } from '../lib/commitments-db.js';
import { getKbStats } from '../lib/kb.js';
import { getStats as getEmailStats } from '../lib/email-intel-db.js';
import { findNextEvent } from '../lib/calendar-client.js';

export default {
  command: 'status',
  description: 'Show Chief of Staff status',
  async execute(args, ctx) {
    const lines = ['*Chief of Staff Status*', ''];

    // Commitments
    try {
      const cs = getCommitmentStats(ctx);
      const byTypeStr = cs.byType.map((t) => `${t.type}:${t.count}`).join(', ');
      lines.push('*Commitments*');
      lines.push(`  Active: ${cs.totalActive} (${byTypeStr || 'none'})`);
      lines.push(`  Overdue: ${cs.overdue}`);
      lines.push(`  Fulfilled this week: ${cs.fulfilledThisWeek}`);
      lines.push('');
    } catch {
      lines.push('*Commitments*');
      lines.push('  Unable to load');
      lines.push('');
    }

    // Knowledge Base
    try {
      const kb = getKbStats();
      const catStr = kb.byCategory.map((c) => `${c.category}:${c.count}`).join(', ');
      lines.push('*Knowledge Base*');
      lines.push(`  Pages: ${kb.totalPages} (${kb.totalWords.toLocaleString()} words)`);
      lines.push(`  Categories: ${catStr || 'none'}`);
      lines.push(`  Dirty pages: ${kb.dirtyCount}`);
      lines.push('');
    } catch {
      lines.push('*Knowledge Base*');
      lines.push('  Unable to load');
      lines.push('');
    }

    // Email Intel
    try {
      const es = getEmailStats();
      lines.push('*Email Intel*');
      lines.push(`  Emails indexed: ${es.totalEmails.toLocaleString()}`);
      lines.push(`  Contacts: ${es.totalContacts}`);
      if (es.lastSync) {
        lines.push(`  Last sync: ${es.lastSync}`);
      }
      lines.push('');
    } catch {
      lines.push('*Email Intel*');
      lines.push('  Unable to load');
      lines.push('');
    }

    // Next calendar event
    try {
      const next = await findNextEvent();
      lines.push('*Calendar*');
      if (next) {
        const startTime = new Date(next.start).toLocaleString('en-US', {
          timeZone: 'America/New_York',
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        });
        lines.push(`  Next: ${next.summary} at ${startTime}`);
      } else {
        lines.push('  No upcoming events');
      }
      lines.push('');
    } catch {
      lines.push('*Calendar*');
      lines.push('  Unable to load');
      lines.push('');
    }

    // Uptime
    const uptimeMs = process.uptime() * 1000;
    const hours = Math.floor(uptimeMs / 3_600_000);
    const minutes = Math.floor((uptimeMs % 3_600_000) / 60_000);
    lines.push(`*Uptime:* ${hours}h ${minutes}m`);

    await ctx.adapter.send({
      chatId: ctx.chatId,
      text: lines.join('\n'),
      parseMode: 'Markdown',
    });
  },
};
