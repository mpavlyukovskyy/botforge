/**
 * Cron handler: token_refresh
 *
 * Every 5 minutes — checks Whoop token expiry and refreshes if needed.
 * Sends Telegram alert on failure.
 */
import { getOAuthToken, ensureDb } from '../lib/db.js';
import { refreshAccessToken } from '../lib/whoop-client.js';

export default {
  name: 'token_refresh',
  async execute(ctx) {
    try {
      ensureDb(ctx.config);
    } catch {
      return; // DB not ready
    }

    const token = getOAuthToken(ctx.config, 'whoop');
    if (!token) return; // No token yet — auth not done

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = token.expires_at || 0;

    // Refresh if expiring within 10 minutes
    if (expiresAt > now + 600) return;

    if (!token.refresh_token) {
      ctx.log.error('Whoop token expiring and no refresh token available');
      await alertUser(ctx, 'Whoop token expiring with no refresh token. Re-run whoop-auth.js.');
      return;
    }

    try {
      await refreshAccessToken(ctx.config, token.refresh_token);
      ctx.log.info('Whoop token refreshed');
    } catch (err) {
      ctx.log.error(`Whoop token refresh failed: ${err.message}`);
      await alertUser(ctx, `Whoop token refresh failed: ${err.message}`);
    }
  },
};

async function alertUser(ctx, message) {
  const chatId = ctx.store?.get('chat_id')
    || ctx.config.platform?.chat_ids?.[0]
    || process.env.TRAINER_CHAT_ID;

  if (!chatId) return;

  try {
    await ctx.adapter.send({
      chatId,
      text: `\u26a0\ufe0f Trainer alert: ${message}`,
    });
  } catch {
    // Can't alert — just log
  }
}
