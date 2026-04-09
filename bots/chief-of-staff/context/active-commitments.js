/**
 * Context builder: active_commitments
 *
 * Injects top 10 active commitments into LLM context,
 * sorted with overdue first, then by priority and due date.
 */
import { ensureDb } from '../lib/db.js';

export default {
  type: 'active_commitments',
  async build(ctx) {
    const db = ensureDb(ctx.config);
    const today = new Date().toISOString().slice(0, 10);

    let commitments;
    try {
      commitments = db.prepare(`
        SELECT * FROM commitments
        WHERE status = 'active'
        ORDER BY
          CASE WHEN due_date < ? THEN 0 ELSE 1 END,
          CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
          due_date ASC NULLS LAST,
          created_at DESC
        LIMIT 10
      `).all(today);
    } catch (err) {
      return '<active_commitments>Failed to load commitments.</active_commitments>';
    }

    if (!commitments || commitments.length === 0) {
      return '<active_commitments>No active commitments.</active_commitments>';
    }

    const lines = commitments.map((c) => {
      const overdue = c.due_date && c.due_date < today ? ' [OVERDUE]' : '';
      const due = c.due_date ? ` | due:${c.due_date}` : '';
      const prio = c.priority && c.priority !== 'normal' ? ` | ${c.priority}` : '';
      return `- [${c.type}] ${c.description} | ${c.bearer} -> ${c.counterparty}${due}${prio}${overdue}`;
    });

    const text = lines.join('\n');
    return `<active_commitments>\n${text}\n</active_commitments>`;
  },
};
