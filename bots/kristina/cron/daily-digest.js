/**
 * Cron handler: daily_digest
 *
 * Sends a morning digest of open tasks to all registered chats.
 */
import { getItems, getColumns } from '../lib/atlas-client.js';
import { getAllRegisteredChats, storeMessageRefs } from '../lib/db.js';

export default {
  name: 'daily_digest',
  async execute(ctx) {
    const chats = getAllRegisteredChats(ctx);
    if (chats.length === 0) return;

    for (const chat of chats) {
      try {
        const items = await getItems(ctx, { status: 'OPEN' });
        const filtered = items.filter(i => !i.requester || i.requester === chat.requester_name);

        if (filtered.length === 0) {
          await ctx.adapter.send({ chatId: chat.chat_id, text: 'Good morning! Board is clear.' });
          continue;
        }

        const now = new Date();
        const overdue = [];
        const dueThisWeek = [];
        const byColumn = {};

        for (const item of filtered) {
          if (item.deadline) {
            const deadline = new Date(item.deadline);
            if (deadline < now) {
              overdue.push(item);
              continue;
            }
            const daysUntil = (deadline - now) / (1000 * 60 * 60 * 24);
            if (daysUntil <= 7) {
              dueThisWeek.push(item);
              continue;
            }
          }
          const col = item.columnName || 'Unassigned';
          if (!byColumn[col]) byColumn[col] = [];
          byColumn[col].push(item);
        }

        let num = 0;
        const refs = [];
        let text = '*Daily Digest*\n';

        if (overdue.length > 0) {
          text += '\n\u26a0 *Overdue*\n';
          for (const item of overdue) {
            num++;
            refs.push({ num, taskId: item.id, spokId: item.spokId, title: item.title });
            text += `${num}. ${item.title} (due: ${item.deadline})\n`;
          }
        }

        if (dueThisWeek.length > 0) {
          text += '\n\ud83d\udcc5 *Due This Week*\n';
          for (const item of dueThisWeek) {
            num++;
            refs.push({ num, taskId: item.id, spokId: item.spokId, title: item.title });
            text += `${num}. ${item.title} (due: ${item.deadline})\n`;
          }
        }

        for (const [colName, colItems] of Object.entries(byColumn)) {
          text += `\n*${colName}*\n`;
          for (const item of colItems) {
            num++;
            refs.push({ num, taskId: item.id, spokId: item.spokId, title: item.title });
            text += `${num}. ${item.title}\n`;
          }
        }

        // Truncate if too long
        if (text.length > 3800) text = text.slice(0, 3800) + '\n...';

        const msgId = await ctx.adapter.send({
          chatId: chat.chat_id,
          text,
          parseMode: 'Markdown',
        });

        if (msgId && refs.length > 0) {
          storeMessageRefs(ctx, msgId, refs);
        }
      } catch (err) {
        ctx.log.error(`Daily digest failed for chat ${chat.chat_id}: ${err}`);
      }
    }
  },
};
