/**
 * Command: /dbstatus
 *
 * Minimal diagnostic command — tests only the email-intel DB connection.
 * Shows: DB path, connection status, email count, date range,
 * direction value distribution, categories, and last sync.
 *
 * Unlike /status, this has no dependencies on calendar, commitments, or KB,
 * so it can't fail due to unrelated import issues.
 */
import { getDiagnostics, getStats } from '../lib/email-intel-db.js';

export default {
  command: 'dbstatus',
  description: 'Show email-intel database diagnostics',
  async execute(args, ctx) {
    const diag = getDiagnostics();

    const lines = ['*Email Intel DB Diagnostics*', ''];

    lines.push(`*Path:* \`${diag.dbPath}\``);
    lines.push(`*Connected:* ${diag.connected ? '✅ Yes' : '❌ No'}`);

    if (diag.error) {
      lines.push(`*Error:* ${diag.error}`);
    }

    if (diag.connected) {
      lines.push(`*Total emails:* ${diag.totalEmails.toLocaleString()}`);
      lines.push(`*Total contacts:* ${diag.totalContacts.toLocaleString()}`);
      lines.push('');

      // Date range
      lines.push('*Date range:*');
      lines.push(`  Earliest: ${diag.dateRange.earliest || 'N/A'}`);
      lines.push(`  Latest: ${diag.dateRange.latest || 'N/A'}`);
      lines.push('');

      // Direction values (the key diagnostic for the mismatch bug)
      if (diag.directionValues.length > 0) {
        lines.push('*Direction values:*');
        for (const dv of diag.directionValues) {
          lines.push(`  ${dv.direction}: ${dv.count.toLocaleString()}`);
        }
        lines.push('');
      }

      // Categories
      if (diag.categories.length > 0) {
        lines.push('*Categories:*');
        for (const cat of diag.categories.slice(0, 10)) {
          lines.push(`  ${cat.category}: ${cat.count.toLocaleString()}`);
        }
        lines.push('');
      }

      // Last sync
      lines.push(`*Last sync:* ${diag.lastSync || 'unknown'}`);
    }

    await ctx.adapter.send({
      chatId: ctx.chatId,
      text: lines.join('\n'),
      parseMode: 'Markdown',
    });
  },
};
