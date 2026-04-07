import { z } from 'zod';
import { getByPosition, updateStatus } from '../lib/priority-queue.js';
import { logAudit } from '../lib/db.js';

const dismissQueueItemTool = {
  name: 'dismiss_queue_item',
  description:
    'Remove an email from the priority queue. Use when Mark says he already dealt with it, ' +
    'wants to skip it permanently, or it\'s no longer relevant. Accepts 1-indexed position.',
  schema: {
    position: z.number().describe('1-indexed position in the priority queue'),
  },
  permissions: { db: 'write' },
  execute: async (args, ctx) => {
    const entry = getByPosition(ctx, args.position);
    if (!entry) return `No item at position ${args.position}.`;

    updateStatus(ctx, entry.id, 'dismissed');
    logAudit(ctx, 'queue_dismissed', `${entry.from_name || entry.from_address}: ${entry.subject}`);

    return `Dismissed: "${entry.subject}" from ${entry.from_name || entry.from_address}. Removed from active queue.`;
  },
};

export default dismissQueueItemTool;
