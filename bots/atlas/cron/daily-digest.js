/**
 * Cron handler: daily_digest
 *
 * Sends a morning digest of open tasks to the configured group chat.
 * Atlas is a shared bot — sends to chat_ids[0], no per-user filtering.
 */
import { getItems, getColumns } from '../lib/spok-client.js';
import { storeMessageRefs } from '../lib/db.js';

export default {
  name: 'daily_digest',
  async execute(ctx) {
    const chatId = ctx.config.platform?.chat_ids?.[0];
    if (!chatId) {
      ctx.log.warn('No chat_id configured for daily digest');
      return;
    }

    try {
      const items = await getItems(ctx, { status: 'OPEN' });

      if (items.length === 0) {
        await ctx.adapter.send({ chatId, text: 'Good morning! Board is clear.' });
        return;
      }

      const now = new Date();
      const overdue = [];
      const dueThisWeek = [];
      const byColumn = {};

      for (const item of items) {
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
          let line = `${num}. ${item.title} (due: ${item.deadline})`;
          if (item.assignee) line += ` → ${item.assignee}`;
          text += line + '\n';
        }
      }

      if (dueThisWeek.length > 0) {
        text += '\n\ud83d\udcc5 *Due This Week*\n';
        for (const item of dueThisWeek) {
          num++;
          refs.push({ num, taskId: item.id, spokId: item.spokId, title: item.title });
          let line = `${num}. ${item.title} (due: ${item.deadline})`;
          if (item.assignee) line += ` → ${item.assignee}`;
          text += line + '\n';
        }
      }

      for (const [colName, colItems] of Object.entries(byColumn)) {
        text += `\n*${colName}*\n`;
        for (const item of colItems) {
          num++;
          refs.push({ num, taskId: item.id, spokId: item.spokId, title: item.title });
          let line = `${num}. ${item.title}`;
          if (item.assignee) line += ` → ${item.assignee}`;
          text += line + '\n';
        }
      }

      // Truncate if too long
      if (text.length > 3800) text = text.slice(0, 3800) + '\n...';

      const msgId = await ctx.adapter.send({
        chatId,
        text,
        parseMode: 'Markdown',
      });

      if (msgId && refs.length > 0) {
        storeMessageRefs(ctx, msgId, refs);
      }
    } catch (err) {
      ctx.log.error(`Daily digest failed: ${err}`);
    }
  },
};
