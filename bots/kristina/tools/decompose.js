import { z } from 'zod';
import { ensureDb, findTaskByIdPrefix, getColumns, findColumnByName, createItem, updateItem } from '../lib/atlas-client.js';
import { isAdmin } from '../lib/db.js';

/**
 * Break a task into milestones. The parent becomes a project container (earns
 * nothing itself); each milestone earns a PARTITION of the parent's tiered
 * value (base = parentTierWeight × share/Σshares), so decomposing never
 * multiplies the payout — it splits it. Milestones flow through the board like
 * normal tasks. Owner-or-Mark.
 */
const decompose = {
  name: 'decompose',
  description: 'Break a task/project into milestones (sub-tasks). Provide the parent task id and a list of milestone titles.',
  schema: {
    item_id: z.string().describe('Parent task ID (8-char prefix or full)'),
    milestones: z.array(z.string()).describe('Milestone titles, in order'),
  },
  execute: async (args, ctx) => {
    const db = ensureDb(ctx.config);
    const parent = findTaskByIdPrefix(ctx, args.item_id);
    if (!parent) return `No task found matching "${args.item_id}".`;
    if (!isAdmin(ctx) && String(parent.requester_chat_id) !== String(ctx.chatId)) {
      return `You can only decompose your own tasks.`;
    }
    const titles = (args.milestones || []).map(t => String(t).trim()).filter(Boolean);
    if (titles.length < 2) return `Give me at least 2 milestones to split "${parent.title}" into.`;

    // Mark the parent a project container.
    db.prepare("UPDATE tasks SET is_project = 1, updated_at = datetime('now') WHERE id = ?").run(parent.id);
    if (parent.spok_id) { try { await updateItem(ctx, parent.spok_id, { isProject: true }); } catch (e) { ctx.log.warn(`decompose: parent patch failed: ${e}`); } }

    const columns = await getColumns(ctx);
    const todo = findColumnByName('To Do', columns) || columns[0];
    const parentRef = parent.spok_id || parent.id;
    const created = [];
    for (const title of titles) {
      const childId = crypto.randomUUID();
      const atlas = await createItem(ctx, {
        title, columnId: todo?.id, requester: undefined, requesterChatId: parent.requester_chat_id,
        externalId: childId, parentTaskId: parentRef, valueShare: 1,
      });
      db.prepare(
        `INSERT INTO tasks (id, spok_id, title, column_name, column_id, status, synced_at, requester_chat_id, parent_task_id, value_share, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, 1, datetime('now'), datetime('now'))`
      ).run(childId, atlas?.atlasId || null, title, todo?.name || null, todo?.id || null,
        atlas ? new Date().toISOString() : null, parent.requester_chat_id, parentRef);
      created.push(title);
    }
    return `Split "${parent.title}" into ${created.length} milestones: ${created.join(', ')}. Each earns a share of the project's value — finishing them all = the project's full value.`;
  },
};

export default decompose;
