import { z } from 'zod';
import { searchEmails, getRecentEmails, getRecentActivity, getStats } from '../lib/email-intel-db.js';

const searchEmailsTool = {
  name: 'search_emails',
  description:
    'Search the email database by keyword (FTS), contact, category, or direction. ' +
    'If a contact email is provided, returns recent emails for that contact. ' +
    'Otherwise performs a full-text search across all indexed emails. ' +
    'If no filters are provided, returns the most recent emails.',
  schema: {
    query: z.string().optional().describe('Full-text search query (FTS5 syntax)'),
    contact: z.string().optional().describe('Contact email address — switches to per-contact recent emails'),
    days: z.number().optional().describe('How many days back to search (default: 30 for contact, 7 for recent)'),
    category: z.string().optional().describe('Filter by contact category (e.g. customer, investor, legal)'),
    direction: z.string().optional().describe('Filter by direction: received or sent (aliases: inbound, outbound)'),
    limit: z.number().optional().describe('Max results to return (default: 20)'),
  },
  permissions: { db: 'read' },
  execute: async (args) => {
    console.log('[search_emails] called with:', JSON.stringify(args));

    const limit = args.limit ?? 20;

    let rows;

    if (args.contact) {
      // Per-contact mode
      const days = args.days ?? 30;
      rows = getRecentEmails(args.contact, days);
      if (rows.length === 0) {
        return `No emails found for ${args.contact} in the last ${days} days.`;
      }
      // Trim to requested limit
      rows = rows.slice(0, limit);
    } else if (args.query || args.category || args.direction) {
      // FTS / filter mode
      rows = searchEmails(args.query || null, {
        category: args.category,
        direction: args.direction,
        limit,
      });
      if (rows.length === 0) {
        return 'No emails matched the search criteria.';
      }
    } else {
      // Recent mode — no specific filters, show most recent emails
      const days = args.days ?? 7;
      const hours = days * 24;
      rows = getRecentActivity(hours);
      if (rows.length === 0) {
        // Fallback: try wider window
        rows = getRecentActivity(30 * 24);
      }
      if (rows.length === 0) {
        const stats = getStats();
        return `No recent emails found. DB has ${stats.totalEmails} total emails (last sync: ${stats.lastSync || 'unknown'}). Try a specific search query.`;
      }
      rows = rows.slice(0, limit);
    }

    const lines = rows.map((e, i) => {
      const date = e.date ? e.date.slice(0, 10) : 'unknown';
      const dir = e.direction === 'received' ? '←' : '→';
      const from = e.from_name || e.from_address || '?';
      const subject = e.subject || '(no subject)';
      let line = `${i + 1}. [${date}] ${dir} ${from} | ${subject}`;
      if (e.body_text) {
        const maxPreview = rows.length <= 5 ? 5000 : 2000;
        const preview = e.body_text.slice(0, maxPreview).replace(/\n+/g, ' ').trim();
        if (e.body_text.length > maxPreview) {
          line += `\n   ${preview} [TRUNCATED: ${e.body_text.length} chars total, showing ${maxPreview}]`;
        } else {
          line += `\n   ${preview}`;
        }
      }
      return line;
    });

    return `Found ${rows.length} email(s):\n${lines.join('\n')}`;
  },
};

export default searchEmailsTool;
