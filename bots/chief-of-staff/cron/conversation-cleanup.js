/**
 * Cron handler: conversation_cleanup
 *
 * Purges expired conversation history entries.
 * Runs daily at 4am ET.
 */

export default {
  name: 'conversation_cleanup',
  async execute(ctx) {
    // The conversation-history skill handles its own TTL cleanup on access,
    // but this cron ensures stale rows get purged even if no messages come in.
    const skill = ctx.skills?.['conversation-history'];
    if (skill?.cleanup) {
      const removed = await skill.cleanup();
      if (removed > 0) {
        ctx.log.info(`Conversation cleanup: removed ${removed} expired entries`);
      }
    } else {
      ctx.log.debug('Conversation cleanup: skill not available, skipping');
    }
  },
};
