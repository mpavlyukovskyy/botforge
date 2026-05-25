/**
 * Bedtime helpers — pure functions + wind-down phase orchestrator.
 *
 * Used by:
 *   - cron/bedtime-prompt.js (T-15m shower signal)
 *   - cron/caffeine-cutoff-prompt.js (T-180m caffeine signal)
 *   - cron/winddown-prompt.js (T-90m screens signal)
 *   - commands/snooze.js, /sleep, /late (override writers)
 *
 * Anchor: Mark's 1:15am ET base bedtime = his empirical best cluster (n=6
 * nights @ rec 73.7 in 142-day Whoop dataset). CBT-I literature (Spielman 1987,
 * Bootzin stimulus control) favors fixed bedtimes for breaking chronic late-bed
 * habits. We honor "smarter" only via negative-only modifiers — bedtime can
 * pull earlier when last night was bad, NEVER later because today felt good.
 *
 * Anti-patterns explicitly rejected (do NOT re-add):
 *   - whoop_strain as a bedtime predictor: r=+0.018 confound in Mark's data.
 *   - Daily HRV (noise; only 7d-vs-30d trend allowed).
 *   - Streak length (regression confound — already documented in deload-detector).
 *   - Positive modifiers (rewarding green recovery with later target).
 */
import { ensureDb, getState, setState, getRecoveryForDate } from './db.js';
import { fetchAndStoreTodayRecovery } from './recovery-fetch.js';

// ─── Tunables ────────────────────────────────────────────────────────────────

export const BASE_BED_TIME_ET = '1:15';       // 24h-style, no AM/PM
// FLOOR raised 2026-05-25 from 12:30am → 1:00am. The shower cron fires at
// 1:00am ET; a target earlier than that would render as "be in bed by
// 12:45am" at 1:00am ET (15 min in the past — broken UX). Adaptive still
// pulls 15 min earlier on bad nights (1:15am → 1:00am), just not 30.
export const FLOOR_BED_TIME_ET = '1:00';
export const CEILING_BED_TIME_ET = '1:45';     // 1:45am ET — keep credibility
export const MAX_NEGATIVE_MODIFIER_MIN = 30;   // cap stacked pull-earlier
export const ALREADY_ASLEEP_LOOKBACK_MS = 2 * 3600_000; // 2h
export const SHOWER_LEAD_MIN = 15;             // Mark showers 15 min then bed

// ─── Wake-date resolver ──────────────────────────────────────────────────────

/**
 * "Tonight's bedtime" is keyed on TOMORROW's wake date when fired before midnight,
 * and on TODAY's date when fired after midnight (e.g. the 1am shower cron).
 * The +6h trick: shift "now" forward 6h, take the local date — this resolves
 * any time between 6pm and 6am to the wake date of that sleep.
 */
export function resolveWakeDate(now = new Date()) {
  return new Date(now.getTime() + 6 * 3600 * 1000)
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ─── Time parsing / formatting ──────────────────────────────────────────────

/**
 * Parse "1:15", "12:30", "1:45am", "01:00am", "3am", "11pm" into 24h
 * { hour, minute } in ET. Returns null on parse failure.
 */
export function parseEtTime(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mins = m[2] ? parseInt(m[2], 10) : 0;
  const meridiem = m[3];
  if (!Number.isFinite(h) || !Number.isFinite(mins) || mins < 0 || mins > 59) return null;
  if (h < 0 || h > 23) return null;
  if (meridiem === 'pm' && h < 12) h += 12;
  if (meridiem === 'am' && h === 12) h = 0;
  return { hour: h, minute: mins };
}

/** Format a {hour, minute} into "1:15am", "12:30am", "1:45am". */
export function formatEtTime({ hour, minute }) {
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const mm = String(minute).padStart(2, '0');
  const ampm = hour < 12 ? 'am' : 'pm';
  return `${h12}:${mm}${ampm}`;
}

/** Minutes past midnight from {hour, minute}. */
export function toMinutes({ hour, minute }) { return hour * 60 + minute; }
/** Inverse of toMinutes. Result is normalized to [0, 1440). */
export function fromMinutes(m) {
  const n = ((m % 1440) + 1440) % 1440;
  return { hour: Math.floor(n / 60), minute: n % 60 };
}

// ─── Adaptive target formula ────────────────────────────────────────────────

/**
 * Compute tonight's ideal bedtime given last-night context.
 *
 * @param {object} input
 * @param {number|null} input.lastNightSleepMin  — whoop_total_sleep_min (null if missing)
 * @param {number|null} input.lastNightRecovery  — whoop_recovery_score (null if missing)
 * @param {number|null} input.hrvDeltaPct        — from computeHrvDrift(); negative = drift down
 * @returns {{hour, minute, modifierMin, isFallback}}
 *
 * Rules:
 *   - Default base = 1:15am.
 *   - last_sleep < 360min → −15. last_recovery < 40 → −15. hrv ≤ −10% → −15.
 *   - Total negative capped at −30.
 *   - Clamp to [12:30am, 1:45am].
 *   - If sleep is 0 or null → return base (likely tracker fault, don't aggressively pull).
 */
export function computeIdealBedtime(input = {}) {
  const { lastNightSleepMin, lastNightRecovery, hrvDeltaPct } = input;
  const base = parseEtTime(BASE_BED_TIME_ET);
  const baseMin = toMinutes(base);

  // Fallback: missing or 0-sleep data → just return base
  if (lastNightSleepMin == null || lastNightSleepMin === 0) {
    return { ...base, modifierMin: 0, isFallback: true };
  }

  let modifier = 0;
  if (lastNightSleepMin < 360) modifier -= 15;
  if (typeof lastNightRecovery === 'number' && lastNightRecovery < 40) modifier -= 15;
  if (typeof hrvDeltaPct === 'number' && hrvDeltaPct <= -10) modifier -= 15;

  // Cap total negative modifier
  if (modifier < -MAX_NEGATIVE_MODIFIER_MIN) modifier = -MAX_NEGATIVE_MODIFIER_MIN;

  const rawMin = baseMin + modifier;
  const floor = toMinutes(parseEtTime(FLOOR_BED_TIME_ET));
  const ceiling = toMinutes(parseEtTime(CEILING_BED_TIME_ET));
  const clamped = Math.max(floor, Math.min(ceiling, rawMin));

  return { ...fromMinutes(clamped), modifierMin: modifier, isFallback: false };
}

// ─── Override read/write (snooze, /sleep, /late) ────────────────────────────

/**
 * Read effective target for tonight: override > cached compute > fresh compute.
 *
 * @param {object} config
 * @param {string} wakeDate     — from resolveWakeDate()
 * @param {object} computeArgs  — passed to computeIdealBedtime() if no cache
 * @returns {{hour, minute, source: 'override'|'cached'|'computed'|'skipped', overrideMeta?}}
 */
export function getEffectiveTarget(config, wakeDate, computeArgs = {}) {
  ensureDb(config);

  const overrideRaw = getState(config, `bedtime_override_${wakeDate}`);
  if (overrideRaw) {
    try {
      const parsed = JSON.parse(overrideRaw);
      if (parsed.source === 'skipped') {
        return { hour: 0, minute: 0, source: 'skipped', overrideMeta: parsed };
      }
      if (parsed.target_h != null && parsed.target_m != null) {
        return {
          hour: parsed.target_h,
          minute: parsed.target_m,
          source: 'override',
          overrideMeta: parsed,
        };
      }
    } catch { /* fall through to compute */ }
  }

  const cachedRaw = getState(config, `bedtime_target_${wakeDate}`);
  if (cachedRaw) {
    try {
      const parsed = JSON.parse(cachedRaw);
      if (parsed.target_h != null && parsed.target_m != null) {
        return { hour: parsed.target_h, minute: parsed.target_m, source: 'cached' };
      }
    } catch { /* fall through */ }
  }

  const computed = computeIdealBedtime(computeArgs);
  // Cache for subsequent signals tonight
  setState(config, `bedtime_target_${wakeDate}`, JSON.stringify({
    target_h: computed.hour,
    target_m: computed.minute,
    modifierMin: computed.modifierMin,
    isFallback: computed.isFallback,
    computed_at: Date.now(),
  }));
  return { hour: computed.hour, minute: computed.minute, source: 'computed' };
}

/** Write an override for tonight. */
export function setBedtimeOverride(config, wakeDate, payload) {
  ensureDb(config);
  setState(config, `bedtime_override_${wakeDate}`, JSON.stringify({
    ...payload,
    set_at: Date.now(),
  }));
}

// ─── alreadyAsleep helper (factored from v1) ────────────────────────────────

export function alreadyAsleep(config, log = console) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const todayRec = getRecoveryForDate(config, today);
    if (!todayRec?.raw_json) return false;
    let raw;
    try {
      raw = typeof todayRec.raw_json === 'string'
        ? JSON.parse(todayRec.raw_json)
        : todayRec.raw_json;
    } catch { return false; }
    if (!raw?.whoop_sleep_start) return false;
    const sleepStart = new Date(raw.whoop_sleep_start);
    if (Number.isNaN(sleepStart.getTime())) return false;
    return sleepStart.getTime() > Date.now() - ALREADY_ASLEEP_LOOKBACK_MS;
  } catch (err) {
    log.debug?.(`alreadyAsleep: check failed (returning false): ${err.message}`);
    return false;
  }
}

// ─── Lead-time formatter for wind-down messages ─────────────────────────────

/**
 * Render a "Bed in 3h15" style string given target time and "now".
 * Always positive; if target is in the past, returns "now".
 */
export function formatLeadTime(targetHour, targetMinute, now = new Date()) {
  // Convert "now" to ET clock time
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(now);
  const nowH = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const nowM = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);
  const nowMin = nowH * 60 + nowM;
  const targetMin = targetHour * 60 + targetMinute;
  let diff = targetMin - nowMin;
  // If target is on the next calendar day (e.g. target 1:15am, now 10:00pm),
  // diff is negative — add 24h.
  if (diff < 0) diff += 1440;
  if (diff === 0) return 'now';
  const h = Math.floor(diff / 60);
  const m = diff % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h${String(m).padStart(2, '0')}`;
}

// ─── Phase orchestrator (shared by all 3 wind-down crons) ───────────────────

const PHASE_CONFIG = {
  caffeine: {
    idempotencyKey: 'wind_down_caffeine_last_run_date',
    copy: (leadStr) => `Last coffee now. Bed in ${leadStr}.`,
  },
  screens: {
    idempotencyKey: 'wind_down_screens_last_run_date',
    copy: (leadStr) => `Wind down — dim screens. Bed in ${leadStr}.`,
  },
  shower: {
    idempotencyKey: 'bedtime_prompt_last_run_date', // preserve v1 key
    copy: (_lead, targetEt) => `Shower time. In bed by ${targetEt} for 7.5h sleep.`,
  },
};

/**
 * Send a wind-down phase. Used by all three cron handlers.
 *
 * @param {object} ctx     — runtime context (.config, .adapter, .log)
 * @param {string} phase   — 'caffeine' | 'screens' | 'shower'
 * @param {object} options — { lastNightSleepMin, lastNightRecovery, hrvDeltaPct }
 */
export async function sendWindDownPhase(ctx, phase, options = {}) {
  const cfg = PHASE_CONFIG[phase];
  if (!cfg) throw new Error(`Unknown wind-down phase: ${phase}`);

  const chatId = ctx.store?.get('chat_id')
    || ctx.config.platform?.chat_ids?.[0]
    || process.env.TRAINER_CHAT_ID;
  if (!chatId) {
    ctx.log?.warn?.(`${phase}_prompt: no chat ID configured`);
    return { sent: false, reason: 'no_chat_id' };
  }

  ensureDb(ctx.config);
  const wakeDate = resolveWakeDate();

  // Idempotency: already fired this phase tonight?
  if (getState(ctx.config, cfg.idempotencyKey) === wakeDate) {
    ctx.log?.info?.(`${phase}_prompt: already fired for ${wakeDate}`);
    return { sent: false, reason: 'idempotent' };
  }

  // Edge case: Whoop already shows sleep started → skip without writing idempotency
  if (alreadyAsleep(ctx.config, ctx.log)) {
    ctx.log?.info?.(`${phase}_prompt: Whoop shows recent sleep start — skip`);
    return { sent: false, reason: 'already_asleep' };
  }

  // Effective target (reads override > cached > computes)
  const target = getEffectiveTarget(ctx.config, wakeDate, options);

  if (target.source === 'skipped') {
    ctx.log?.info?.(`${phase}_prompt: /sleep override present — skip`);
    return { sent: false, reason: 'skipped_by_user' };
  }

  const targetEt = formatEtTime({ hour: target.hour, minute: target.minute });
  const leadStr = formatLeadTime(target.hour, target.minute);
  const text = cfg.copy(leadStr, targetEt);

  try {
    await ctx.adapter.send({ chatId, text });
    setState(ctx.config, cfg.idempotencyKey, wakeDate);
    ctx.log?.info?.(`${phase}_prompt: sent (target ${targetEt}, lead ${leadStr})`);
    return { sent: true, target: targetEt };
  } catch (err) {
    ctx.log?.error?.(`${phase}_prompt: send failed: ${err.message}`);
    return { sent: false, reason: 'send_error', error: err.message };
  }
}

// ─── Helper: pull last-night context from DB for the formula ────────────────

/**
 * ET calendar date for now. Mark wakes after 11am ET, so the recovery for
 * "this morning's wake-up" is stored under recovery_daily.date = today_et.
 */
export function todayEt(now = new Date()) {
  return new Date(now.getTime()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
export function yesterdayEt(now = new Date()) {
  return new Date(now.getTime() - 86400_000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function readContextFromRow(row) {
  if (!row || row.whoop_recovery_score == null) return null;
  let sleepMin = null;
  if (row.raw_json) {
    try {
      const raw = typeof row.raw_json === 'string' ? JSON.parse(row.raw_json) : row.raw_json;
      sleepMin = raw?.whoop_total_sleep_min ?? null;
    } catch { /* leave null */ }
  }
  return {
    lastNightSleepMin: sleepMin,
    lastNightRecovery: row.whoop_recovery_score,
  };
}

/**
 * Return {lastNightSleepMin, lastNightRecovery, source} for the bedtime formula.
 *
 * Lookup hierarchy (post-2026-05-25 fix):
 *   1. recovery_daily WHERE date = today_et — the recovery from Mark's sleep
 *      that ended THIS MORNING. Whoop indexes recovery by wake date, ET-aligned.
 *   2. If today's row is missing or has null recovery_score, fire a JIT Whoop
 *      fetch + upsert (Mark wakes after 11am, daily_sync at 5am may be stale).
 *   3. If JIT fails, fall back to yesterday's row — still better than nothing,
 *      Mark's pattern is regular enough that yesterday's data is informative.
 *   4. If both missing, return nulls (formula uses base 1:15am).
 *
 * Async because the JIT path makes an HTTP call to Whoop.
 *
 * @returns {Promise<{lastNightSleepMin, lastNightRecovery, source}>}
 */
export async function getLastNightContext(config, log = console) {
  ensureDb(config);
  const today = todayEt();

  // 1. Try today's row first
  let ctx = readContextFromRow(getRecoveryForDate(config, today));
  if (ctx) return { ...ctx, source: 'today' };

  // 2. JIT fetch
  try {
    log.info?.(`getLastNightContext: today (${today}) missing/stale — attempting JIT fetch`);
    await fetchAndStoreTodayRecovery(config, today, log);
    ctx = readContextFromRow(getRecoveryForDate(config, today));
    if (ctx) return { ...ctx, source: 'today_jit' };
  } catch (err) {
    log.warn?.(`getLastNightContext: JIT fetch failed: ${err.message}`);
  }

  // 3. Fallback to yesterday
  const yesterday = yesterdayEt();
  ctx = readContextFromRow(getRecoveryForDate(config, yesterday));
  if (ctx) {
    log.info?.(`getLastNightContext: today empty even after JIT — falling back to yesterday (${yesterday})`);
    return { ...ctx, source: 'yesterday_fallback' };
  }

  // 4. No data
  return { lastNightSleepMin: null, lastNightRecovery: null, source: 'none' };
}
