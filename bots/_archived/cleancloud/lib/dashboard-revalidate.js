/**
 * Dashboard price cache revalidation
 *
 * Fire-and-forget POST to Findlays dashboard to bust the 24h CleanCloud price cache
 * after any product/price mutation.
 */

export async function revalidateDashboardPrices(log) {
  const url = process.env.DASHBOARD_REVALIDATE_URL;
  const secret = process.env.DASHBOARD_REVALIDATE_SECRET;
  if (!url || !secret) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-revalidate-secret': secret },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) log?.warn?.(`Dashboard revalidation returned ${res.status}`);
  } catch (err) {
    log?.warn?.(`Dashboard revalidation failed: ${err.message}`);
  }
}
