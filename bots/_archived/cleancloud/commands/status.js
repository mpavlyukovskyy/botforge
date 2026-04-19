/**
 * Command: /status
 *
 * Show bot status: browser state, last sync, product/section counts, recent operations.
 */
import { ensureDb, getTotalProductCount, getTotalSectionCount, getLastSync, getRecentOperations } from '../lib/db.js';
import { isBrowserRunning } from '../lib/browser.js';

export default {
  command: 'status',
  description: 'Bot status — browser, cache, recent operations',
  async execute(args, ctx) {
    const chatId = ctx.chatId;

    try {
      ensureDb(ctx.config);
    } catch {
      await ctx.adapter.send({ chatId, text: 'Database not available.' });
      return;
    }

    const lines = [];
    lines.push('*CleanCloud Bot Status*');
    lines.push('');

    // Browser status
    const running = isBrowserRunning();
    lines.push(`Browser: ${running ? 'running' : 'stopped'}`);

    // Cache stats
    const products = getTotalProductCount(ctx.config);
    const sections = getTotalSectionCount(ctx.config);
    lines.push(`Cache: ${sections} sections, ${products} products`);

    // Last sync
    const lastSync = getLastSync(ctx.config);
    if (lastSync) {
      lines.push(`Last sync: ${lastSync.synced_at}`);
    } else {
      lines.push('Last sync: never');
    }

    // Recent operations
    lines.push('');
    const ops = getRecentOperations(ctx.config, 5);
    if (ops.length > 0) {
      lines.push('Recent operations:');
      for (const op of ops) {
        const status = op.status === 'completed' ? '\u2705' : op.status === 'failed' ? '\u274c' : '\u23f3';
        lines.push(`  ${status} ${op.action} — ${op.description || 'no description'} (${op.created_at})`);
      }
    } else {
      lines.push('No operations yet.');
    }

    await ctx.adapter.send({
      chatId,
      text: lines.join('\n'),
      parseMode: 'Markdown',
    });
  },
};
