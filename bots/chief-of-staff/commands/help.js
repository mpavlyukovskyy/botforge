/**
 * Command: /help
 *
 * Lists available commands and capabilities.
 */
export default {
  command: 'help',
  description: 'Show available commands',
  async execute(args, ctx) {
    const text = [
      '*Chief of Staff Commands*',
      '',
      '/status \u2014 Operational status (KB, commitments, email, calendar)',
      '/dbstatus \u2014 Email-intel database diagnostics',
      '/help \u2014 This message',
      '',
      '*What I can do:*',
      '\u2022 Morning briefing with priorities, calendar, and commitments',
      '\u2022 Track commitments extracted from emails and conversations',
      '\u2022 Draft and review emails for your approval',
      '\u2022 Pre-meeting briefs with attendee context',
      '\u2022 Maintain a knowledge base about contacts and projects',
      '\u2022 Monitor email activity and flag items needing response',
      '',
      'Or just tell me what you need in natural language.',
    ].join('\n');

    await ctx.adapter.send({ chatId: ctx.chatId, text, parseMode: 'Markdown' });
  },
};
