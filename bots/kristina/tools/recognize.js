import { z } from 'zod';
import { findTaskByIdPrefix } from '../lib/db.js';
import { isAdmin } from '../lib/db.js';
import { postRecognition } from '../lib/atlas-client.js';

/**
 * Record positive recognition ("that mattered / thank you"). Mark-only — the
 * carrot the system was missing. Optionally attached to a task. No money.
 */
const recognize = {
  name: 'recognize',
  description: 'Give the assistant recognition / a thank-you for good work. Mark only. Optionally reference a task id.',
  schema: {
    note: z.string().describe('The recognition / thank-you message'),
    item_id: z.string().optional().describe('Optional task id this is about'),
  },
  execute: async (args, ctx) => {
    if (!isAdmin(ctx)) return `Only Mark can give recognition.`;
    const note = String(args.note || '').slice(0, 500);
    if (!note) return `What should the recognition say?`;
    let task = null;
    if (args.item_id) task = findTaskByIdPrefix(ctx, args.item_id);
    await postRecognition(ctx, {
      taskId: task?.spok_id || null,
      note,
    });
    return `Recognition recorded${task ? ` for "${task.title}"` : ''}: "${note}" 🌟`;
  },
};

export default recognize;
