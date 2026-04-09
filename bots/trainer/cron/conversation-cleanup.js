/**
 * Cron handler: conversation_cleanup
 *
 * Purges expired conversation history entries.
 * Runs daily at 4am UTC.
 */

export default {
  name: 'conversation_cleanup',
  async execute(ctx) {
    const skill = ctx.skills?.['conversation-history'];
    if (skill?.cleanup) {
      const removed = await skill.cleanup();
      if (removed > 0) {
        ctx.log.info(`Conversation cleanup: removed ${removed} expired entries`);
      }
    }
  },
};
