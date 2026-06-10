import { z } from 'zod';
import { ensureDb, findDeductionByIdPrefix, patchDeduction } from '../lib/atlas-client.js';
import { isAdmin } from '../lib/db.js';

/**
 * Reverse (refund) a deduction. Mark-only. Sets reversed_at locally + on Atlas
 * (reconciles to the dashboard), so it drops out of the balance on both surfaces.
 */
const reverseDeduction = {
  name: 'reverse_deduction',
  description: 'Reverse/refund a deduction. Mark only. Provide the deduction id (D:xxxx).',
  schema: {
    deduction_id: z.string().describe('Deduction id or 8-char prefix (D:xxxx)'),
  },
  execute: async (args, ctx) => {
    if (!isAdmin(ctx)) return `Only Mark can reverse deductions.`;
    const id = String(args.deduction_id).replace(/^D:/i, '');
    const d = findDeductionByIdPrefix(ctx, id);
    if (!d) return `No deduction found matching "${args.deduction_id}".`;
    if (d.reversed_at) return `That deduction is already reversed.`;
    ensureDb(ctx.config).prepare("UPDATE deductions SET reversed_at = datetime('now') WHERE id = ?").run(d.id);
    await patchDeduction(ctx, d.id, { action: 'reverse' });
    // Tell the person who was charged.
    if (d.requester_chat_id) {
      try { await ctx.adapter.send({ chatId: d.requester_chat_id, text: `✅ A $${Number(d.amount).toFixed(2)} deduction was reversed: "${d.reason}".` }); } catch {}
    }
    return `Reversed $${Number(d.amount).toFixed(2)} — "${d.reason}". (D:${d.id.slice(0, 8)})`;
  },
};

export default reverseDeduction;
