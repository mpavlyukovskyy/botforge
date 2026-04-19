/**
 * Cron handler: browser_keepalive
 *
 * Every 30 minutes, checks if browser is alive and logged in.
 * Uses mutex to serialize with tool operations.
 * If login code is needed, notifies via Telegram (with 20-min cooldown).
 */
import { isBrowserRunning, withBrowserMutex, LoginCodeRequiredError } from '../lib/browser.js';

export default {
  name: 'browser_keepalive',
  async execute(ctx) {
    if (!isBrowserRunning()) {
      // Don't launch browser proactively — lazy-launch on first mutation
      return;
    }

    try {
      // Use mutex to serialize with tool operations
      await withBrowserMutex(async (page) => {
        // If we get here, we're logged in (mutex verified via login check)
        return true;
      });
    } catch (err) {
      if (err instanceof LoginCodeRequiredError) {
        // Cooldown: don't spam (20 min between notifications)
        const lastNotified = ctx.store?.loginCodeNotifiedAt || 0;
        if (Date.now() - lastNotified < 20 * 60 * 1000) return;

        const chatId = process.env.CLEANCLOUD_CHAT_ID;
        if (chatId && ctx.adapter) {
          try {
            await ctx.adapter.send({
              chatId,
              text: '🔐 CleanCloud session expired. A login code was sent to findlaysnz@icloud.com.\n\nReply with the 6-digit code to restore the session.',
            });
          } catch (sendErr) {
            ctx.log.warn(`Failed to send login code notification: ${sendErr.message}`);
          }
          if (ctx.store) ctx.store.loginCodeNotifiedAt = Date.now();
        }
      } else {
        ctx.log.warn(`Browser keepalive failed: ${err.message}`);
      }
    }
  },
};
