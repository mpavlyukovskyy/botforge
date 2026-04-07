import { z } from 'zod';
import { readPage } from '../lib/kb.js';

const getConstructionStatusTool = {
  name: 'get_construction_status',
  description:
    'Get the current construction status from the knowledge base. Returns the latest ' +
    'facility/construction-status.md KB page with milestones, blockers, and updates.',
  schema: {},
  permissions: { db: 'read' },
  execute: async (_args, _ctx) => {
    const page = readPage('facility/construction-status.md');

    if (!page) {
      return (
        'Construction status page not found in the knowledge base. ' +
        'The construction sync may not have run yet, or the page path may differ. ' +
        'Try search_kb with query "construction" to find related pages.'
      );
    }

    const lines = [];
    lines.push(`=== CONSTRUCTION STATUS ===`);
    lines.push(`Last updated: ${page.lastUpdated || 'unknown'}`);
    lines.push('');
    lines.push(page.content);

    return lines.join('\n');
  },
};

export default getConstructionStatusTool;
