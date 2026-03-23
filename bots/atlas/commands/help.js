export default {
  command: 'help',
  description: 'Show available commands',
  async execute(args, ctx) {
    const text = [
      '*Atlas Commands*',
      '',
      '/status — Board overview',
      '/done — Quick mark items done',
      '/filter <column> — View column items',
      '/passive on|off — Toggle passive detection',
      '/help — This message',
      '',
      'Shared tracker for Mark & Hendrik.',
      'Just tell me what you need in natural language!',
    ].join('\n');

    await ctx.adapter.send({ chatId: ctx.chatId, text, parseMode: 'Markdown' });
  },
};
