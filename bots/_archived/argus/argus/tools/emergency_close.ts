/**
 * LLM Tool: emergency_close — kill switch (requires user confirmation via Telegram)
 *
 * This tool does NOT directly execute the kill switch.
 * It sends a confirmation request via Telegram callback buttons.
 */

import { z } from 'zod';
import { requestKillConfirmation } from '../safety/kill-switch.js';

export default {
  name: 'emergency_close',
  description: 'Request emergency close of all positions. Sends a confirmation prompt to the user — does NOT execute immediately.',
  schema: {
    reason: z.string().describe('Reason for emergency close'),
  },
  async execute(args: { reason: string }, ctx: any): Promise<string> {
    requestKillConfirmation(ctx.chatId);

    await ctx.adapter.send({
      chatId: ctx.chatId,
      text: `⚠️ *Emergency Close Requested*\nReason: ${args.reason}\n\nConfirm below:`,
      inlineKeyboard: [
        [
          { text: '🔴 CONFIRM KILL', callback_data: 'kill:confirm' },
          { text: '❌ Cancel', callback_data: 'kill:cancel' },
        ],
      ],
    });

    return 'Kill switch confirmation sent. Awaiting user response via inline keyboard.';
  },
};
