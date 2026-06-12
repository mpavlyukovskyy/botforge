import { z } from 'zod';
import { getColumns, findColumnByName, updateItem, findTaskByIdPrefix, ensureDb } from '../lib/atlas-client.js';
import { isAdmin } from '../lib/db.js';
import { normalizeDeadline } from '../lib/deadline.js';
import { normalizeTier } from '../lib/tier.js';
import { getFlag } from '../lib/flags.js';

const WIP_LIMIT = 3; // S9: max active tasks in In Progress (must match dashboard/server)

const updateTask = {
  name: 'update_task',
  description: 'Update an existing task. Provide the item_id (from board context) and fields to change.',
  schema: {
    item_id: z.string().describe('Task ID (8-char prefix or full ID from board context)'),
    title: z.string().optional().describe('New title'),
    assignee: z.string().optional().describe('New assignee'),
    deadline: z.string().optional().describe('New deadline (YYYY-MM-DD)'),
    column: z.string().optional().describe('Column to move the task to'),
    tier: z.string().optional().describe('Priority tier: ROUTINE | STANDARD | IMPORTANT | P0. Mark only.'),
  },
  execute: async (args, ctx) => {
    const db = ensureDb(ctx.config);
    const task = findTaskByIdPrefix(ctx, args.item_id);
    if (!task) return `No task found matching ID "${args.item_id}".`;

    // Deadline changes are Mark-only — non-admin users can still rename and
    // re-assign, but only Mark sets/extends due dates.
    if (args.deadline && !isAdmin(ctx)) {
      return `Only Mark can change deadlines. Ask him to set "${task.title}" to ${args.deadline}.`;
    }
    // Priority tier is Mark's lever too.
    if (args.tier && !isAdmin(ctx)) {
      return `Only Mark can change a task's priority. Ask him to set "${task.title}" to ${args.tier}.`;
    }

    const spokId = task.spok_id;
    const updates = {};

    // Normalize before it reaches Atlas/SQLite (see lib/deadline.js). A bad
    // value (e.g. "+2h") normalizes to null and is skipped rather than 500ing
    // Atlas / corrupting local datetime() comparisons.
    const deadline = args.deadline ? normalizeDeadline(args.deadline) : undefined;

    if (args.title) updates.title = args.title;
    if (args.assignee) updates.assignee = args.assignee;
    if (deadline) updates.deadline = deadline;
    const tier = args.tier ? normalizeTier(args.tier) : undefined;
    if (tier) updates.priorityTier = tier;

    // Resolve column move
    if (args.column) {
      const columns = await getColumns(ctx);
      const col = findColumnByName(args.column, columns);
      if (col) {
        // S9 WIP cap: refuse a move into In Progress when it's already full, so
        // Kristina gets told here instead of the move bouncing back on reconcile
        // (the dashboard + Atlas API enforce the same limit as the hard backstop).
        const isInProgress = col.slug === 'in-progress' || /in.?progress/i.test(col.name || '');
        const alreadyThere = (task.column_name || '') === col.name;
        if (getFlag('INCENTIVE_V2') && isInProgress && !alreadyThere) {
          const n = db.prepare(
            "SELECT COUNT(*) c FROM tasks WHERE column_id = ? AND id != ? AND status = 'OPEN' AND (blocked_at IS NULL OR blocked_at = '')"
          ).get(col.id, task.id).c;
          if (n >= WIP_LIMIT) {
            return `In Progress is full (${WIP_LIMIT} max) — finish or move one out before starting "${task.title}".`;
          }
        }
        updates.columnId = col.id;
        db.prepare("UPDATE tasks SET column_id = ?, column_name = ?, updated_at = datetime('now') WHERE id = ?")
          .run(col.id, col.name, task.id);
      }
    }

    // Update local DB fields
    if (args.title) {
      db.prepare("UPDATE tasks SET title = ?, updated_at = datetime('now') WHERE id = ?").run(args.title, task.id);
    }
    if (args.assignee) {
      db.prepare("UPDATE tasks SET assignee = ?, updated_at = datetime('now') WHERE id = ?").run(args.assignee, task.id);
    }
    if (deadline) {
      db.prepare("UPDATE tasks SET deadline = ?, updated_at = datetime('now') WHERE id = ?").run(deadline, task.id);
    }
    if (tier) {
      db.prepare("UPDATE tasks SET priority_tier = ?, updated_at = datetime('now') WHERE id = ?").run(tier, task.id);
    }

    // Update on Atlas
    if (spokId && Object.keys(updates).length > 0) {
      await updateItem(ctx, spokId, updates);
    }

    const changedFields = Object.keys(updates);
    return changedFields.length > 0
      ? `Updated "${task.title}": ${changedFields.join(', ')} changed.`
      : `No changes specified for "${task.title}".`;
  },
};

export default updateTask;
