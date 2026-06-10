import { z } from 'zod';
import { ensureDb, findDeductionByIdPrefix, patchDeduction } from '../lib/atlas-client.js';
import { isAdmin } from '../lib/db.js';

/**
 * Contest a deduction (procedural justice). The assistant who was charged — or
 * Mark — can flag a deduction for Mark's review with a note. Sets contested_at
 * locally + on Atlas (which reconciles back to the dashboard). Does NOT reverse
 * it; Mark decides via reverse_deduction. Scoped to the owner (or admin) so one
 * person can't contest another's charge.
 */
const contestDeduction = {
  name: 'contest_deduction',
  description: "Contest/dispute a deduction the user thinks was unfair. Provide the deduction id (D:xxxx from the deduction message) and a short reason.",
  schema: {
    deduction_id: z.string().describe('Deduction id or 8-char prefix (the D:xxxx in the charge message)'),
    reason: z.string().optional().describe('Why it should be reviewed/reversed'),
  },
  execute: async (args, ctx) => {
    const db = ensureDb(ctx.config);
    const id = String(args.deduction_id).replace(/^D:/i, '');
    const d = findDeductionByIdPrefix(ctx, id);
    if (!d) return `No deduction found matching "${args.deduction_id}".`;
    if (d.reversed_at) return `That deduction was already reversed — nothing to contest.`;
    if (d.contested_at) return `That deduction is already flagged for Mark's review.`;
    // Ownership: only the charged person or Mark can contest it.
    if (!isAdmin(ctx) && String(d.requester_chat_id) !== String(ctx.chatId)) {
      return `You can only contest your own deductions.`;
    }
    const note = String(args.reason || '').slice(0, 500);
    db.prepare("UPDATE deductions SET contested_at = datetime('now'), contest_note = ? WHERE id = ?").run(note || null, d.id);
    await patchDeduction(ctx, d.id, { action: 'contest', contestNote: note });

    // Flag Mark (admin chat) so he can decide.
    const adminChat = (ctx.config?.behavior?.access?.admin_users || [])[0] || process.env.TELEGRAM_CHAT_ID;
    if (adminChat) {
      try {
        await ctx.adapter.send({ chatId: adminChat, text: `⚖️ Deduction contested (D:${d.id.slice(0, 8)}, $${Number(d.amount).toFixed(2)} — "${d.reason}")${note ? `\nReason: ${note}` : ''}\nReply "reverse D:${d.id.slice(0, 8)}" to refund it.` });
      } catch { /* best effort */ }
    }
    return `Flagged for Mark's review — he'll decide whether to reverse it. (D:${d.id.slice(0, 8)})`;
  },
};

export default contestDeduction;
