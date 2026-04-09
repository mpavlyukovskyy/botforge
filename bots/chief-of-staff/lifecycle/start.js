/**
 * Lifecycle hook: start
 *
 * Runs DB migrations, auto-registers admin chat, initializes integrations.
 */
import { runMigrations, registerChat, getRegisteredChat } from '../lib/db.js';
import { initKb } from '../lib/kb.js';
import { initGmail } from '../lib/gmail-client.js';

export default {
  event: 'start',
  async execute(ctx) {
    // Run DB migrations
    runMigrations(ctx);
    ctx.log.info('DB migrations complete');

    // Auto-register admin chat (Mark)
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

    // Store integration config in shared store for tools/cron (from env vars)
    ctx.store.set('email_intel_db_path', process.env.EMAIL_INTEL_DB_PATH || null);
    ctx.store.set('science_gmail_email', process.env.SCIENCE_GMAIL_EMAIL || null);
    ctx.store.set('kb_base_dir', process.env.COS_KB_DIR || '~/.chief-of-staff/science/kb');

    // Initialize KB manager
    const kbDir = process.env.COS_KB_DIR || '~/.chief-of-staff/science/kb';
    initKb(ctx.config, kbDir);
    ctx.log.info(`KB initialized (${kbDir})`);

    // Initialize Gmail client (SMTP via app password + local DB for drafts)
    try {
      await initGmail(
        process.env.SCIENCE_GMAIL_EMAIL || null,
        process.env.SCIENCE_GMAIL_APP_PASSWORD || null,
        ctx.config
      );
      ctx.log.info('Gmail client initialized');
    } catch (err) {
      ctx.log.warn(`Gmail init failed (drafts will be text-only): ${err.message}`);
    }

    ctx.log.info('Chief of Staff started');
  },
};
