import { getItems, getColumns } from '../lib/spok-client.js';
import { storeMessageRefs } from '../lib/db.js';

export default {
  command: 'status',
  description: 'Show board overview grouped by column',
  async execute(args, ctx) {
    const columns = await getColumns(ctx);
    const items = await getItems(ctx, { status: 'OPEN' });

    if (items.length === 0) {
      await ctx.adapter.send({ chatId: ctx.chatId, text: 'Board is empty.' });
      return;
    }

    // Group by column
    const byColumn = {};
    for (const item of items) {
      const col = item.columnName || 'Unassigned';
      if (!byColumn[col]) byColumn[col] = [];
      byColumn[col].push(item);
    }

    let num = 0;
    const refs = [];
    let text = '*Board Status*\n';

    for (const colName of Object.keys(byColumn)) {
      text += `\n*${colName}*\n`;
      for (const item of byColumn[colName].slice(0, 5)) {
        num++;
        refs.push({ num, taskId: item.id, spokId: item.spokId, title: item.title });
        let line = `${num}. ${item.title}`;
        if (item.assignee) line += ` → ${item.assignee}`;
        if (item.deadline) line += ` (due: ${item.deadline})`;
        text += line + '\n';
      }
      if (byColumn[colName].length > 5) {
        text += `   _...and ${byColumn[colName].length - 5} more_\n`;
      }
    }

    const msgId = await ctx.adapter.send({ chatId: ctx.chatId, text, parseMode: 'Markdown' });
    if (msgId && refs.length > 0) {
      storeMessageRefs(ctx, msgId, refs);
    }
  },
};
