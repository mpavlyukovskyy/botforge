/**
 * /help — list the hali99 query commands.
 */
export default {
  command: 'help',
  description: 'List available commands',
  async execute(args, ctx) {
    await ctx.adapter.send({
      chatId: ctx.chatId,
      text:
        'Findlays bot commands:\n' +
        '/orders — today’s orders with paid/ack state\n' +
        '/orders yesterday — a previous day (or /orders 2026-06-10)\n' +
        '/unpaid — unpaid online orders (last 7 days)\n' +
        '/order <id> — full status of one order\n' +
        '\n' +
        'New-order and payment alerts post here automatically.',
    });
  },
};
