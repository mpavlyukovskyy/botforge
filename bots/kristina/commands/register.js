import { registerChat, getRegisteredChat } from '../lib/db.js';

export default {
  command: 'register',
  description: 'Register a chat with a requester name (admin only)',
  async execute(args, ctx) {
    // Admin check
    const adminUsers = ctx.config.behavior?.access?.admin_users || [];
    const chatIds = ctx.config.platform?.chat_ids || [];
    const isAdmin = adminUsers.includes(ctx.userId) || chatIds.includes(ctx.chatId);

    if (!isAdmin) {
      await ctx.adapter.send({ chatId: ctx.chatId, text: 'Admin only.' });
      return;
    }

    const name = args.trim();
    if (!name) {
      const existing = getRegisteredChat(ctx, ctx.chatId);
      if (existing) {
        await ctx.adapter.send({ chatId: ctx.chatId, text: `This chat is registered as: ${existing.requester_name}` });
      } else {
        await ctx.adapter.send({ chatId: ctx.chatId, text: 'Usage: /register <name>' });
      }
      return;
    }

    // Capitalize first letter of each word
    const normalized = name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    registerChat(ctx, ctx.chatId, normalized, ctx.userName);
    await ctx.adapter.send({ chatId: ctx.chatId, text: `Registered as: ${normalized}` });
  },
};
