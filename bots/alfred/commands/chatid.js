/**
 * Command: /chatid
 *
 * Reveals the current chat ID — used to discover group chat IDs.
 */
export default {
  command: 'chatid',
  description: 'Show the current chat ID',
  async execute(args, ctx) {
    await ctx.adapter.send({
      chatId: ctx.chatId,
      text: `Chat ID: \`${ctx.chatId}\``,
      parseMode: 'Markdown',
    });
  },
};
