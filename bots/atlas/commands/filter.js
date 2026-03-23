import { getItems, getColumns, findColumnByName } from '../lib/spok-client.js';

export default {
  command: 'filter',
  description: 'Filter items by column name',
  async execute(args, ctx) {
    if (!args.trim()) {
      const columns = await getColumns(ctx);
      const names = columns.map(c => c.name).join(', ');
      await ctx.adapter.send({ chatId: ctx.chatId, text: `Usage: /filter <column>\nAvailable: ${names}` });
      return;
    }

    const columns = await getColumns(ctx);
    const col = findColumnByName(args.trim(), columns);
    if (!col) {
      await ctx.adapter.send({ chatId: ctx.chatId, text: `No column matching "${args.trim()}".` });
      return;
    }

    const items = await getItems(ctx, { columnId: col.id });

    if (items.length === 0) {
      await ctx.adapter.send({ chatId: ctx.chatId, text: `No items in ${col.name}.` });
      return;
    }

    let text = `*${col.name}* (${items.length})\n`;
    for (const item of items.slice(0, 20)) {
      let line = `• ${item.title}`;
      if (item.assignee) line += ` → ${item.assignee}`;
      if (item.deadline) line += ` (due: ${item.deadline})`;
      text += line + '\n';
    }

    await ctx.adapter.send({ chatId: ctx.chatId, text, parseMode: 'Markdown' });
  },
};
