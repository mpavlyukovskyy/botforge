/**
 * /report — On-demand weekly performance report
 */

export default {
  command: 'report',
  description: 'Generate on-demand performance report',
  async execute(_args: string, ctx: any) {
    await ctx.adapter.send({
      chatId: ctx.chatId,
      text: '📊 Generating report...',
    });

    try {
      // Dynamic import to avoid circular dependency issues
      const { generateWeeklyReport } = await import('../intelligence/reporter.js');
      const report = await generateWeeklyReport();

      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: report,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.adapter.send({
        chatId: ctx.chatId,
        text: `Failed to generate report: ${msg}`,
      });
    }
  },
};
