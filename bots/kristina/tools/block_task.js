import { z } from 'zod';
import { ensureDb, findTaskByIdPrefix, updateItem } from '../lib/atlas-client.js';
import { isAdmin } from '../lib/db.js';

/**
 * Mark a task as blocked / "waiting on X" (e.g. waiting on a vendor, the client,
 * or Mark). While blocked it's excluded from status-nudges and from the $0.10
 * deductions and from overdue-decay flagging — being stuck on someone else is
 * not the assistant's fault. Uses dedicated blocked_at/blocked_on (NOT the
 * handoff freeze, which would let someone lock in full value by blocking at the
 * deadline). Authorized to the task's requester/assignee or Mark.
 */
const blockTask = {
  name: 'block_task',
  description: "Mark a task as blocked/waiting on someone (so it stops nudging). Provide the task id and who/what it's waiting on.",
  schema: {
    item_id: z.string().describe('Task ID (8-char prefix or full)'),
    blocked_on: z.string().optional().describe('Who/what it is waiting on: Mark, the client, a vendor, etc.'),
  },
  execute: async (args, ctx) => {
    const db = ensureDb(ctx.config);
    const task = findTaskByIdPrefix(ctx, args.item_id);
    if (!task) return `No task found matching "${args.item_id}".`;
    if (!isAdmin(ctx) && String(task.requester_chat_id) !== String(ctx.chatId)) {
      return `You can only block your own tasks.`;
    }
    // Normalize blocker into a coarse category (drives whether the decay clock
    // pauses in S7 — only MARK pauses it, so self-blocking can't freeze value).
    const raw = String(args.blocked_on || '').toLowerCase();
    const cat = /mark|boss|you\b/.test(raw) ? 'MARK' : (/vendor|client|airline|booking|support|third|external|company/.test(raw) ? 'VENDOR' : 'INTERNAL');
    const label = args.blocked_on || cat.toLowerCase();
    db.prepare("UPDATE tasks SET blocked_at = datetime('now'), blocked_on = ?, updated_at = datetime('now') WHERE id = ?")
      .run(cat, task.id);
    if (task.spok_id) {
      try { await updateItem(ctx, task.spok_id, { blockedAt: new Date().toISOString(), blockedOn: cat }); }
      catch (err) { ctx.log.warn(`block_task: Atlas update failed: ${err}`); }
    }
    return `Paused "${task.title}" — waiting on ${label}. I'll stop nudging until you unblock it.`;
  },
};

export default blockTask;
