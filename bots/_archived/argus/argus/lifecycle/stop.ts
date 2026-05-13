/**
 * Lifecycle stop hook — runs on graceful shutdown
 *
 * 1. Close database
 * 2. Send shutdown notification
 */

import { closeDb } from '../lib/db.js';
import { ALERT_CONFIG } from '../lib/config.js';

export default {
  event: 'stop',
  async execute(ctx: any) {
    ctx.log.info('Argus shutting down...');

    // 1. Send shutdown notification
    try {
      await ctx.adapter.send({
        chatId: ALERT_CONFIG.telegramChatId,
        text: '🔴 *Argus Offline*\nGraceful shutdown.',
      });
    } catch {
      // Ignore send failure during shutdown
    }

    // 2. Close database
    closeDb();
    ctx.log.info('Database closed');

    ctx.log.info('Argus shutdown complete');
  },
};
