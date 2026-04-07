import { z } from 'zod';
import { listCommitments, getOverdue, getByCustomer, getByPerson } from '../lib/commitments-db.js';

const listCommitmentsTool = {
  name: 'list_commitments',
  description:
    'List tracked commitments with optional filters. Commitment types: ' +
    'P1 (deliverable promise), P3 (response owed), W2 (waiting for response), W3 (delegated task). ' +
    'Can filter by status, type, customer, person, or show only overdue items.',
  schema: {
    status: z.string().optional().describe('Filter by status: active, fulfilled, cancelled'),
    type: z.string().optional().describe('Filter by type: P1, P3, W2, W3'),
    customer: z.string().optional().describe('Filter by customer name'),
    person: z.string().optional().describe('Filter by person (bearer or counterparty)'),
    overdue_only: z.boolean().optional().describe('If true, show only overdue active commitments'),
  },
  permissions: { db: 'read' },
  execute: async (args, ctx) => {
    let rows;
    let label;

    if (args.overdue_only) {
      rows = getOverdue(ctx);
      label = 'Overdue commitments';
    } else if (args.customer) {
      rows = getByCustomer(ctx, args.customer);
      label = `Commitments for customer "${args.customer}"`;
    } else if (args.person) {
      rows = getByPerson(ctx, args.person);
      label = `Commitments involving "${args.person}"`;
    } else {
      rows = listCommitments(ctx, {
        status: args.status,
        type: args.type,
      });
      const filters = [];
      if (args.status) filters.push(`status=${args.status}`);
      if (args.type) filters.push(`type=${args.type}`);
      label = filters.length > 0
        ? `Commitments (${filters.join(', ')})`
        : 'All commitments';
    }

    if (!rows || rows.length === 0) {
      return `${label}: none found.`;
    }

    const lines = rows.map((c, i) => {
      const parts = [`${i + 1}. [${c.type}]`];
      parts.push(c.description || '(no description)');

      if (c.bearer) parts.push(`Bearer: ${c.bearer}`);
      if (c.counterparty) parts.push(`Counterparty: ${c.counterparty}`);
      if (c.due_date) parts.push(`Due: ${c.due_date}`);
      if (c.customer) parts.push(`Customer: ${c.customer}`);
      parts.push(`Status: ${c.status}`);

      if (c.priority && c.priority !== 'normal') parts.push(`Priority: ${c.priority}`);

      return parts.join(' | ');
    });

    return `${label} (${rows.length}):\n${lines.join('\n')}`;
  },
};

export default listCommitmentsTool;
