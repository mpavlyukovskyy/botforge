/**
 * /reconcile — Force reconciliation check
 */

export default {
  command: 'reconcile',
  description: 'Force reconciliation check',
  async execute(_args: string, ctx: any) {
    await ctx.adapter.send({
      chatId: ctx.chatId,
      text: '🔄 Running reconciliation...',
    });

    try {
      const { runReconciliation, formatReconciliationReport } = await import('../safety/reconciliation.js');

      // TODO: inject real adapter dependencies once execution adapters are wired
      const result = await runReconciliation({
        getHyperliquidPositions: async () => [],
        getHyperliquidOpenOrders: async () => [],
        getArbitrumBalances: async () => [],
        getAavePositions: async () => [],
        sendAlert: async () => {},
      });

      const report = formatReconciliationReport(result);
      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: report,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: `Reconciliation failed: ${msg}`,
      });
    }
  },
};
