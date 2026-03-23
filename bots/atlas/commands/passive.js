export default {
  command: 'passive',
  description: 'Toggle passive task detection',
  async execute(args, ctx) {
    const passiveKey = `passive:${ctx.chatId}`;
    const current = ctx.store.get(passiveKey) ?? true; // Default ON for Atlas

    if (args.trim().toLowerCase() === 'on') {
      ctx.store.set(passiveKey, true);
      await ctx.adapter.send({ chatId: ctx.chatId, text: 'Passive detection enabled.' });
    } else if (args.trim().toLowerCase() === 'off') {
      ctx.store.set(passiveKey, false);
      await ctx.adapter.send({ chatId: ctx.chatId, text: 'Passive detection disabled.' });
    } else {
      const state = current ? 'on' : 'off';
      await ctx.adapter.send({ chatId: ctx.chatId, text: `Passive detection is ${state}. Use /passive on or /passive off.` });
    }
  },
};
