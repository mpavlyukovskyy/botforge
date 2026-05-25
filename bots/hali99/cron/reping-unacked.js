/**
 * Cron handler: reping_unacked
 *
 * Pings findlays-website's /api/cron/reping-unacked endpoint, which finds
 * any P&D orders that have been unacknowledged for >15 min and sends a
 * Telegram reminder to the Findlays ops group.
 *
 * Configured to fire every 5 minutes (see hali99.yaml schedule).
 *
 * Auth: HALI99_SHARED_SECRET as Bearer token.
 */
export default {
  name: 'reping_unacked',
  async execute(ctx) {
    const base = process.env.FINDLAYS_WEBSITE_URL;
    const secret = process.env.HALI99_SHARED_SECRET;
    if (!base || !secret) {
      ctx.log.warn('reping_unacked: FINDLAYS_WEBSITE_URL or HALI99_SHARED_SECRET not configured');
      return;
    }

    const url = `${base.replace(/\/$/, '')}/api/cron/reping-unacked`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        ctx.log.error(`reping_unacked: HTTP ${res.status} ${JSON.stringify(json)}`);
        return;
      }
      if (json.repinged > 0) {
        ctx.log.info(`reping_unacked: sent ${json.repinged} reminder(s)`);
      }
    } catch (err) {
      ctx.log.error(`reping_unacked: fetch failed: ${err?.message || err}`);
    }
  },
};
