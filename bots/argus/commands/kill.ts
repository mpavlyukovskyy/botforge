/**
 * /kill — Emergency close everything (requires double-tap confirmation)
 */

import { requestKillConfirmation } from '../safety/kill-switch.js';

export default {
  command: 'kill',
  description: 'Emergency kill switch — close all positions',
  async execute(_args: string, ctx: any) {
    // First tap: request confirmation
    requestKillConfirmation(ctx.chatId);

    await ctx.adapter.send({
      chatId: ctx.chatId,
      text: [
        '⚠️ *KILL SWITCH*',
        '',
        'This will:',
        '• Cancel ALL open orders',
        '• Close ALL perp positions (market orders)',
        '• Withdraw ALL Aave supply',
        '• HALT all strategies',
        '',
        'This action is IRREVERSIBLE.',
      ].join('\n'),
      inlineKeyboard: [
        [
          { text: '🔴 CONFIRM KILL', callback_data: 'kill:confirm' },
          { text: '❌ Cancel', callback_data: 'kill:cancel' },
        ],
      ],
    });
  },
};
