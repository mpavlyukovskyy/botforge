/**
 * Brain tool: search_exercises
 *
 * Fuzzy search exercise templates cached from Hevy.
 * Uses fuse.js for fuzzy matching.
 */
import { z } from 'zod';
import { ensureDb, getAllExerciseTemplates } from '../lib/db.js';
import Fuse from 'fuse.js';

export default {
  name: 'search_exercises',
  description: 'Search exercise templates by name or muscle group. Returns matching exercises from the user\'s Hevy library.',
  schema: {
    query: z.string().describe('Search query (exercise name or muscle group)'),
    limit: z.number().optional().describe('Max results (default 10)'),
  },
  async execute(args, ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return 'Database not available.';
    }

    const templates = getAllExerciseTemplates(ctx.config);
    if (templates.length === 0) {
      return 'No exercise templates cached yet. The daily sync needs to run first.';
    }

    const fuse = new Fuse(templates, {
      keys: ['title', 'muscle_group', 'equipment'],
      threshold: 0.4,
      includeScore: true,
    });

    const results = fuse.search(args.query, { limit: args.limit || 10 });

    if (results.length === 0) {
      return `No exercises matching "${args.query}". Try a broader search term.`;
    }

    const lines = results.map(r => {
      const t = r.item;
      const confidence = Math.round((1 - r.score) * 100);
      return `- ${t.title} (${t.muscle_group || 'unknown'}, ${t.equipment || 'n/a'}) [${confidence}% match] ID: ${t.id}`;
    });

    return `Found ${results.length} exercises matching "${args.query}":\n${lines.join('\n')}`;
  },
};
