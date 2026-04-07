import { z } from 'zod';
import { listQueue, getQueueCount } from '../lib/priority-queue.js';

const listQueueTool = {
  name: 'list_queue',
  description: 'List the priority email queue — emails ranked by importance that need Mark\'s attention. Shows subject, sender, score, category, and draft status.',
  schema: {
    limit: z.number().optional().describe('Max entries to show (default: 10)'),
    status: z.string().optional().describe('Filter by status: pending, draft_ready, presented (default: pending+draft_ready)'),
  },
  permissions: { db: 'read' },
  execute: async (args, ctx) => {
    const limit = args.limit ?? 10;
    const statuses = args.status ? [args.status] : ['pending', 'draft_ready', 'presented'];
    const entries = listQueue(ctx, { status: statuses, limit });
    const total = getQueueCount(ctx);

    if (entries.length === 0) {
      return 'Priority queue is empty — no emails currently need attention.';
    }

    const lines = entries.map((e, i) => {
      const score = (e.priority_score * 100).toFixed(0);
      const draft = e.draft_status === 'ready' ? ' [draft ready]' : '';
      const cat = e.contact_category ? ` [${e.contact_category}]` : '';
      const customer = e.customer_name ? ` (${e.customer_name})` : '';
      const name = e.from_name || e.from_address;
      const seen = e.status === 'presented' ? ' [seen]' : '';
      return `Q${i + 1}. [${score}%] ${name}${customer}${cat}${draft}${seen}\n   ${e.subject}`;
    });

    return `Priority Queue (${entries.length} of ${total} active):\n\n${lines.join('\n\n')}`;
  },
};

export default listQueueTool;
