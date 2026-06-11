/**
 * Findlays dashboard API client for hali99 commands.
 *
 * Same auth pattern as cron/reping-unacked.js: Bearer HALI99_SHARED_SECRET
 * against FINDLAYS_WEBSITE_URL (both already in /opt/botforge/.env).
 *
 * callDashboard NEVER throws on HTTP status — it returns {status, body} so
 * commands can render body.text (the dashboard puts a usage/diagnostic line
 * in EVERY response, including 400s). It throws only on transport failures
 * (timeout/DNS), which commands catch and turn into a generic line.
 */

export function parseOrderId(args) {
  const id = String(args || '').trim().replace(/^#/, '');
  return /^\d+$/.test(id) ? id : null;
}

export async function callDashboard(path) {
  const base = process.env.FINDLAYS_WEBSITE_URL;
  const secret = process.env.HALI99_SHARED_SECRET;
  if (!base || !secret) {
    throw new Error('FINDLAYS_WEBSITE_URL or HALI99_SHARED_SECRET not configured');
  }
  const url = `${base.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(25_000),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    // non-JSON body — leave empty
  }
  return { status: res.status, body };
}

const GENERIC_FAIL = "Couldn't fetch order status — try again in a minute.";

/**
 * Shared command body: typing indicator → dashboard call → send text.
 */
export async function runStatusCommand(ctx, path) {
  try {
    await ctx.adapter.sendChatAction?.(ctx.chatId, 'typing');
  } catch {
    /* cosmetic only */
  }
  let text = GENERIC_FAIL;
  try {
    const { status, body } = await callDashboard(path);
    if (body && typeof body.text === 'string' && body.text.length > 0) {
      text = body.text;
    }
    if (body && body.meta) {
      ctx.log?.info?.(
        `[hali99/status] ${path} -> ${status} source=${body.meta.source} cc=${body.meta.ccCount} online=${body.meta.onlineCount} pos=${body.meta.posCount}`
      );
    }
  } catch (err) {
    ctx.log?.error?.(`[hali99/status] ${path} failed: ${err?.message || err}`);
  }
  await ctx.adapter.send({ chatId: ctx.chatId, text });
}
