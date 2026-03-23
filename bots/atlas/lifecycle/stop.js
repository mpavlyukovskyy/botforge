/**
 * Lifecycle hook: stop
 *
 * Flushes pending sync queue on graceful shutdown.
 */
import { retrySyncPending } from '../lib/spok-client.js';

export default {
  event: 'stop',
  async execute(ctx) {
    // Flush pending sync queue
    try {
      const count = await retrySyncPending(ctx);
      if (count > 0) ctx.log.info(`Flushed ${count} pending sync items`);
    } catch (err) {
      ctx.log.warn(`Shutdown sync flush failed: ${err}`);
    }
  },
};
