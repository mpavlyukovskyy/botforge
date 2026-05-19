/**
 * Cron handler: healthcheck_ping
 *
 * Every 5 min. If HEALTHCHECK_PING_URL is set (e.g. healthchecks.io endpoint),
 * GET it as a liveness signal so an external monitor can detect when this
 * cron stops firing.
 *
 * Silently noop if the env var is unset — keeps deployment overhead zero
 * for users who don't have an external monitor configured.
 */

export default {
  name: 'healthcheck_ping',
  async execute(ctx) {
    const url = process.env.HEALTHCHECK_PING_URL;
    if (!url) return; // No external monitor configured

    try {
      await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      // Don't fail the cron — the external monitor will detect the absence
      ctx.log.debug(`healthcheck_ping: ${err}`);
    }
  },
};
