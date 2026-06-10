/**
 * Context builder: board_state
 *
 * Injects current Atlas board state into LLM context.
 */
import { getItems, getColumns } from '../lib/atlas-client.js';
import { getRegisteredChat, isAdmin } from '../lib/db.js';
import { computeDecayValue } from '../lib/decay.js';
import { rankScore, tierTag } from '../lib/tier.js';

export default {
  type: 'board_state',
  async build(ctx) {
    try {
      const columns = await getColumns(ctx);
      const items = await getItems(ctx, { status: 'OPEN' });
      // getItems sets _stale when Atlas was unreachable and it served the
      // local cache. The board may then be incomplete — the brain must NOT
      // conclude a task was removed or recreate it (the 2026-06-07 failure).
      const stale = items._stale === true;
      const staleBanner =
        '⚠ Atlas is temporarily unreachable. This board is served from the local cache and may be incomplete or out of date. Do NOT tell the user a task was removed, and do NOT recreate a task you cannot find right now — the board is just unsynced. Ask them to try again shortly.';

      // Admin (Mark) sees the full board in context. Non-admins see only
      // their own + unattributed. Without this bypass the brain sees a
      // truncated board and reports e.g. 3/16 tasks as if they were the
      // total — that was the 2026-05-18 post-cutover regression.
      let filtered;
      if (isAdmin(ctx)) {
        filtered = items;
      } else {
        const registered = getRegisteredChat(ctx, ctx.chatId, ctx.userId);
        const requester = registered?.requester_name;
        filtered = items.filter(i =>
          !i.requester || (requester && (i.requester === requester || i.assignee === requester))
        );
      }

      if (filtered.length === 0) {
        return stale
          ? `<board_state>\n${staleBanner}\nNo cached tasks to show.\n</board_state>`
          : '<board_state>Board is empty.</board_state>';
      }

      const now = new Date();
      const byColumn = {};
      let overdueCount = 0;

      for (const item of filtered) {
        const col = item.columnName || 'Unassigned';
        if (!byColumn[col]) byColumn[col] = [];

        const tag = tierTag(item.priorityTier);
        let entry = `- ID:${item.id.slice(0, 8)} | ${tag ? tag + ' ' : ''}${item.title}`;
        if (item.blockedAt) entry += ` | ⏸ waiting on ${item.blockedOn || 'someone'}`;
        if (item.assignee) entry += ` | @${item.assignee}`;
        if (item.deadline) {
          entry += ` | due:${item.deadline}`;
          if (new Date(item.deadline) < now) {
            // Surface the live decay value the nudge/deduction crons act on, so
            // the brain sees the same lifecycle state (it was blind to this —
            // it could nudge-reply about a value it couldn't see).
            const { value } = computeDecayValue(item.deadline, undefined, item.blockedSecondsTotal || 0);
            entry += value >= 0 ? ` [OVERDUE $${value.toFixed(2)}]` : ` [OVERDUE -$${Math.abs(value).toFixed(2)}]`;
            overdueCount++;
          }
        }
        byColumn[col].push(entry);
      }

      // WSJF "Today's Top 3" \u2014 highest priority-weight \u00d7 deadline-urgency among
      // not-done items. Gives the brain (and Kristina) an at-a-glance focus list
      // so high-tier / due-soon work is worked first.
      let text = '';
      const active = filtered.filter(i => i.status !== 'DONE' && (i.columnName || '') !== 'Done' && !i.blockedAt);
      if (active.length > 0) {
        const top = [...active].sort((a, b) => rankScore(b, now) - rankScore(a, now)).slice(0, 3);
        text += 'Today\'s Top 3 (by priority \u00d7 urgency):\n';
        top.forEach((i, n) => {
          const tag = tierTag(i.priorityTier);
          text += `${n + 1}. ID:${i.id.slice(0, 8)} | ${tag ? tag + ' ' : ''}${i.title}${i.deadline ? ` | due:${i.deadline}` : ''}\n`;
        });
        text += '\n';
      }

      for (const [colName, entries] of Object.entries(byColumn)) {
        text += `${colName}:\n${entries.join('\n')}\n\n`;
      }

      if (overdueCount > 0) {
        text += `\u26a0 ${overdueCount} overdue item(s)\n`;
      }

      text += `\nAvailable columns: ${columns.map(c => c.name).join(', ')}`;

      const body = stale ? `${staleBanner}\n\n${text.trim()}` : text.trim();
      return `<board_state>\n${body}\n</board_state>`;
    } catch (err) {
      return '<board_state>Failed to load board state.</board_state>';
    }
  },
};
