/**
 * Context builder: board_state
 *
 * Injects current Spok board state into LLM context.
 * No requester filtering — Atlas is a shared team bot.
 */
import { getItems, getColumns } from '../lib/spok-client.js';

export default {
  type: 'board_state',
  async build(ctx) {
    try {
      const columns = await getColumns(ctx);
      const items = await getItems(ctx, { status: 'OPEN' });

      if (items.length === 0) return '<board_state>Board is empty.</board_state>';

      const now = new Date();
      const byColumn = {};
      let overdueCount = 0;

      for (const item of items) {
        const col = item.columnName || 'Unassigned';
        if (!byColumn[col]) byColumn[col] = [];

        let entry = `- ID:${item.id.slice(0, 8)} | ${item.title}`;
        if (item.assignee) entry += ` | @${item.assignee}`;
        if (item.deadline) {
          entry += ` | due:${item.deadline}`;
          if (new Date(item.deadline) < now) {
            entry += ' [OVERDUE]';
            overdueCount++;
          }
        }
        byColumn[col].push(entry);
      }

      let text = '';
      for (const [colName, entries] of Object.entries(byColumn)) {
        text += `${colName}:\n${entries.join('\n')}\n\n`;
      }

      if (overdueCount > 0) {
        text += `\u26a0 ${overdueCount} overdue item(s)\n`;
      }

      text += `\nAvailable columns: ${columns.map(c => c.name).join(', ')}`;

      return `<board_state>\n${text.trim()}\n</board_state>`;
    } catch (err) {
      return '<board_state>Failed to load board state.</board_state>';
    }
  },
};
