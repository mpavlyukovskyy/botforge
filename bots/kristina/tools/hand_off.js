import { z } from 'zod';
import { ensureDb, updateItem } from '../lib/atlas-client.js';
import { findTaskByIdPrefix } from '../lib/db.js';

/**
 * Hand off a task — locks the bounty at $1.00 while waiting on something
 * external (a vendor, a counterparty, a 3rd-party process). Decay halts.
 *
 * If the task is already handed off, this just updates the note. The
 * existing handed_off_at timestamp is preserved (so the bounty-lock
 * remains anchored to when the wait actually started).
 */
const handOff = {
  name: 'hand_off',
  description: 'Mark a task as handed off (waiting on external). Locks bounty at $1.00, decay halts. Provide a note describing what we are waiting for.',
  schema: {
    item_ids: z.array(z.string()).describe('Array of task IDs (or 8-char prefixes) to hand off'),
    note: z.string().describe('What we are waiting for (max 200 chars)'),
  },
  execute: async (args, ctx) => {
    const db = ensureDb(ctx.config);
    const ids = args.item_ids || [];
    const note = String(args.note || '').slice(0, 200);
    const results = [];

    for (const idPrefix of ids) {
      const task = findTaskByIdPrefix(ctx, idPrefix);
      if (!task) {
        results.push(`ID "${idPrefix}": not found`);
        continue;
      }

      if (task.handed_off_at) {
        // Already handed off — just update the note (preserve the original
        // handoff timestamp so the bounty-lock anchor doesn't slide).
        db.prepare(
          "UPDATE tasks SET handed_off_note = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(note, task.id);
        if (task.spok_id) {
          await updateItem(ctx, task.spok_id, { handedOffNote: note });
        }
        const handedDate = task.handed_off_at.split('T')[0];
        results.push(`"${task.title}": already handed off on ${handedDate}. Updated the note.`);
      } else {
        const now = new Date().toISOString();
        db.prepare(
          "UPDATE tasks SET handed_off_at = ?, handed_off_note = ?, updated_at = datetime('now') WHERE id = ?"
        ).run(now, note, task.id);
        if (task.spok_id) {
          await updateItem(ctx, task.spok_id, { handedOffAt: now, handedOffNote: note });
        }
        results.push(`"${task.title}": marked as handed off. Waiting for: ${note}`);
      }
    }

    return results.join('\n');
  },
};

export default handOff;
