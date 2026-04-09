/**
 * Cron handler: kb_compile
 *
 * Recompiles dirty knowledge base pages. Every 30 min (:15 and :45, staggered from profile_compile).
 * Phase 6: clears dirty flags only. Actual recompilation added in Phase 7.
 */
import { getDirtyPages, writePage, readPage } from '../lib/kb.js';
import { compile } from '../lib/claude.js';
import { ensureDb } from '../lib/db.js';

export default {
  name: 'kb_compile',
  async execute(ctx) {
    const dirtyPages = getDirtyPages();
    if (!dirtyPages || dirtyPages.length === 0) return;

    let cleared = 0;

    for (const page of dirtyPages) {
      try {
        // Phase 7 TODO: recompile using Sonnet
        // const existing = readPage(page.path);
        // const recompiled = await compile(
        //   'You are a knowledge base curator. Update this page with the latest data.',
        //   existing.content,
        //   'Recompile this KB page with any new information.',
        // );
        // writePage(page.path, { ...existing, content: recompiled.text });

        // For now, just clear the dirty flag
        const db = ensureDb(ctx.config);
        db.prepare(
          "UPDATE kb_pages SET dirty = 0, updated_at = datetime('now') WHERE path = ?"
        ).run(page.path);

        cleared++;
      } catch (err) {
        ctx.log.error(`KB compile failed for ${page.path}: ${err.message}`);
      }
    }

    if (cleared > 0) {
      ctx.log.info(`KB compile: ${cleared} dirty page${cleared > 1 ? 's' : ''} cleared`);
    }
  },
};
