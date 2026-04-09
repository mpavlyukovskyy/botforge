/**
 * Lifecycle hook: start
 *
 * Runs DB migrations, auto-registers admin chat, and pre-warms column cache.
 */
import { runMigrations, registerChat, getRegisteredChat } from '../lib/db.js';
import { getColumns } from '../lib/atlas-client.js';

export default {
  event: 'start',
  async execute(ctx) {
    // Run DB migrations
    runMigrations(ctx);
    ctx.log.info('DB migrations complete');

    // Auto-register admin chat
    const chatIds = ctx.config.platform?.chat_ids || [];
    const adminChatId = chatIds.length > 0
      ? chatIds[0]
      : ctx.config.behavior?.access?.admin_users?.[0];
    if (adminChatId) {
      const existing = getRegisteredChat(ctx, adminChatId);
      if (!existing) {
        registerChat(ctx, adminChatId, 'Mark', 'auto');
        ctx.log.info(`Auto-registered admin chat ${adminChatId} as Mark`);
      }
    }

    // Pre-warm column cache
    try {
      const columns = await getColumns(ctx);
      ctx.log.info(`Column cache warmed: ${columns.length} columns`);
    } catch (err) {
      ctx.log.warn(`Column cache warm-up failed: ${err}`);
    }
  },
};
