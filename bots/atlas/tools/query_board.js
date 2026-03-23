import { z } from 'zod';
import { getItems, getColumns, findColumnByName } from '../lib/spok-client.js';

const queryBoard = {
  name: 'query_board',
  description: 'Query the task board with optional filters. Use this to look up tasks by status, column, or assignee.',
  schema: {
    status: z.string().optional().describe('Filter by status: OPEN, DONE, ARCHIVED'),
    column: z.string().optional().describe('Filter by column name'),
    assignee: z.string().optional().describe('Filter by assignee name'),
  },
  execute: async (args, ctx) => {
    const opts = {};
    if (args.status) opts.status = args.status;

    // Resolve column name to ID
    if (args.column) {
      const columns = await getColumns(ctx);
      const col = findColumnByName(args.column, columns);
      if (col) {
        opts.columnId = col.id;
      } else {
        return `No column matching "${args.column}".`;
      }
    }

    let items = await getItems(ctx, opts);

    // Filter by assignee client-side if requested
    if (args.assignee) {
      const assignee = args.assignee.toLowerCase();
      items = items.filter(i => i.assignee?.toLowerCase().includes(assignee));
    }

    if (items.length === 0) return 'No matching items found.';

    const lines = items.map((item, idx) => {
      const num = idx + 1;
      let line = `${num}. ID:${item.id.slice(0, 8)} | ${item.title} | ${item.columnName || 'Unassigned'}`;
      if (item.assignee) line += ` | @${item.assignee}`;
      if (item.deadline) line += ` | due:${item.deadline}`;
      line += ` | status:${item.status}`;
      return line;
    });

    return `Found ${items.length} items:\n${lines.join('\n')}`;
  },
};

export default queryBoard;
