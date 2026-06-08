import { z } from 'zod';
import { getColumns, findColumnByName, updateItem, findTaskByIdPrefix, ensureDb } from '../lib/atlas-client.js';
import { isAdmin } from '../lib/db.js';
import { normalizeDeadline } from '../lib/deadline.js';

const updateTask = {
  name: 'update_task',
  description: 'Update an existing task. Provide the item_id (from board context) and fields to change.',
  schema: {
    item_id: z.string().describe('Task ID (8-char prefix or full ID from board context)'),
    title: z.string().optional().describe('New title'),
    assignee: z.string().optional().describe('New assignee'),
    deadline: z.string().optional().describe('New deadline (YYYY-MM-DD)'),
    column: z.string().optional().describe('Column to move the task to'),
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

    const spokId = task.spok_id;
    const updates = {};

    // Normalize before it reaches Atlas/SQLite (see lib/deadline.js). A bad
    // value (e.g. "+2h") normalizes to null and is skipped rather than 500ing
    // Atlas / corrupting local datetime() comparisons.
    const deadline = args.deadline ? normalizeDeadline(args.deadline) : undefined;

    if (args.title) updates.title = args.title;
    if (args.assignee) updates.assignee = args.assignee;
    if (deadline) updates.deadline = deadline;

    // Resolve column move
    if (args.column) {
      const columns = await getColumns(ctx);
      const col = findColumnByName(args.column, columns);
      if (col) {
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
