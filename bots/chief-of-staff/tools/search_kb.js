import { z } from 'zod';
import { searchKb, readPage } from '../lib/kb.js';

const searchKbTool = {
  name: 'search_kb',
  description:
    'Search the knowledge base or read a specific page. ' +
    'If a path is provided, reads that page directly. ' +
    'Otherwise performs a full-text search across all KB pages.',
  schema: {
    query: z.string().optional().describe('Full-text search query'),
    path: z.string().optional().describe('Exact page path to read (e.g. customers/bmc.md)'),
    category: z.string().optional().describe('Filter search by category (e.g. customers, pipeline, facility)'),
  },
  permissions: { db: 'read' },
  execute: async (args) => {
    // Direct page read
    if (args.path) {
      const page = readPage(args.path);
      if (!page) {
        return `KB page not found: ${args.path}`;
      }

      const content = page.content
        ? page.content.slice(0, 3000) + (page.content.length > 3000 ? '\n\n[truncated]' : '')
        : '(empty page)';

      return `# ${page.title}\nCategory: ${page.category || 'none'} | Updated: ${page.lastUpdated || 'unknown'}\n\n${content}`;
    }

    // Search mode
    if (!args.query) {
      return 'Please provide a query to search or a path to read.';
    }

    const results = searchKb(args.query, {
      category: args.category,
      limit: 10,
    });

    if (results.length === 0) {
      return `No KB pages matched "${args.query}".`;
    }

    const lines = results.map((r, i) => {
      const snippet = r.snippet
        ? r.snippet.replace(/<\/?b>/g, '*').slice(0, 200)
        : '';
      return `${i + 1}. [${r.category || '?'}] ${r.title} (${r.path})\n   ${snippet}`;
    });

    return `Found ${results.length} KB page(s) for "${args.query}":\n\n${lines.join('\n\n')}`;
  },
};

export default searchKbTool;
