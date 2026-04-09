export default {
  prefix: 'e',
  async execute(data, ctx) {
    const idPrefix = data.split(':')[1];
    if (!idPrefix) { await ctx.answerCallback('Error'); return; }

    // Send force reply prompt
    await ctx.adapter.send({
      chatId: ctx.chatId,
      text: `What should the new title be?`,
      replyToMessageId: ctx.messageId,
    });

    // Store pending edit in store for when user replies
    ctx.store.set(`pendingEdit:${ctx.chatId}`, idPrefix);
    await ctx.answerCallback();
  },
};
