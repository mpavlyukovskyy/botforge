/**
 * Lifecycle hook: stop
 *
 * Cleanup resources on shutdown.
 */
export default {
  event: 'stop',
  async execute(ctx) {
    ctx.log.info('Chief of Staff shutting down');
  },
};
