/**
 * Feature flags — single source of truth is the Atlas `Config` table (so the
 * bot and dashboard can't drift). The bot caches the values in memory and
 * refreshes them on each reconcile; reads are synchronous (computeDecayValue /
 * computeBalance are sync). DEFAULT IS OFF for every flag until proven on.
 *
 * INCENTIVE_V2 gates the whole v2 money model (the $0 floor, pool, tier
 * multipliers, quality gate). With it OFF the system behaves byte-identically
 * to today — that invariant is the whole point of the flag.
 */
let _cache = {}; // key -> string value

/** Synchronous flag read. Missing/"false"/"0" => false. */
export function getFlag(name) {
  const v = _cache[name];
  if (v == null) return false;
  const s = String(v).toLowerCase();
  return s === 'true' || s === '1' || s === 'on' || s === 'yes';
}

/** Test/explicit override of the cache (used by refreshFlags + tests). */
export function setFlagsCache(obj) { _cache = obj || {}; }

/**
 * Refresh the cache from Atlas /config. Best-effort: on any failure the cache
 * is LEFT UNCHANGED (we never flip a flag off due to a transient fetch error,
 * nor on, since default is off and we only adopt a successfully-fetched value).
 */
export async function refreshFlags(ctx, getAtlasConfig) {
  try {
    const { url, token } = getAtlasConfig(ctx);
    const resp = await fetch(`${url}/api/sync/kristina-bot/config`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data && data.config && typeof data.config === 'object') _cache = data.config;
  } catch (err) {
    ctx.log?.debug?.(`[flags] refresh failed (keeping cache): ${err}`);
  }
}
