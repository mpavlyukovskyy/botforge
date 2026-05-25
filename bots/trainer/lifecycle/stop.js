/**
 * Lifecycle hook: stop
 *
 * Persists the Telegram polling offset to SQLite on graceful shutdown.
 * Prevents duplicate message processing after restart.
 */
import { ensureDb, setState } from '../lib/db.js';

export default {
  event: 'stop',
  async execute(ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return; // DB not ready
    }

    if (ctx.adapter.getPollingOffset) {
      const offset = ctx.adapter.getPollingOffset();
      if (offset > 0) {
        try {
          setState(ctx.config, 'telegram_polling_offset', String(offset));
          ctx.log.info(`Telegram polling offset saved: ${offset}`);
        } catch (err) {
          ctx.log.error(`Failed to save polling offset: ${err.message}`);
        }
      }
    }
  },
};
