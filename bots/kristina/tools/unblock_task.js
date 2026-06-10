import { z } from 'zod';
import { ensureDb, findTaskByIdPrefix, updateItem } from '../lib/atlas-client.js';
import { isAdmin } from '../lib/db.js';

/**
 * Clear a task's blocked/"waiting on X" state — it resumes normal nudging/decay.
 * Accrues the blocked interval into blocked_seconds_total so S7 can subtract it
 * from the decay clock (so being blocked past a deadline isn't held against the
 * assistant). Authorized to the task's requester/assignee or Mark.
 */
const unblockTask = {
  name: 'unblock_task',
  description: 'Unblock a task that was waiting on someone (the vendor replied, etc.) so it resumes.',
  schema: {
    item_id: z.string().describe('Task ID (8-char prefix or full)'),
  },
  execute: async (args, ctx) => {
    const db = ensureDb(ctx.config);
    const task = findTaskByIdPrefix(ctx, args.item_id);
    if (!task) return `No task found matching "${args.item_id}".`;
    if (!isAdmin(ctx) && String(task.requester_chat_id) !== String(ctx.chatId)) {
      return `You can only unblock your own tasks.`;
    }
    // Compute elapsed blocked seconds in SQLite's own (UTC) frame to avoid the
    // SQLite-datetime(UTC) vs JS-Date(local) parsing skew.
    const row = db.prepare(
      "SELECT blocked_at, blocked_on, blocked_seconds_total, CAST((julianday('now') - julianday(blocked_at)) * 86400 AS INTEGER) AS elapsed FROM tasks WHERE id = ?"
    ).get(task.id);
    if (!row?.blocked_at) return `"${task.title}" isn't blocked.`;
    // Only credit decay-pause time for waits that aren't the assistant's fault
    // (blocked on Mark or an external vendor). Self-declared INTERNAL blocks do
    // NOT pause the clock — otherwise self-blocking would be a free decay-freeze.
    const credits = row.blocked_on === 'MARK' || row.blocked_on === 'VENDOR';
    const blockedSecs = credits ? Math.max(0, row.elapsed || 0) : 0;
    const total = (row.blocked_seconds_total || 0) + blockedSecs;
    db.prepare("UPDATE tasks SET blocked_at = NULL, blocked_on = NULL, blocked_seconds_total = ?, updated_at = datetime('now') WHERE id = ?")
      .run(total, task.id);
    if (task.spok_id) {
      try { await updateItem(ctx, task.spok_id, { blockedAt: null, blockedOn: null, blockedSecondsTotal: total }); }
      catch (err) { ctx.log.warn(`unblock_task: Atlas update failed: ${err}`); }
    }
    return `Resumed "${task.title}". Welcome back.`;
  },
};

export default unblockTask;
