/**
 * Polling resilience: classify polling errors and decide what to do.
 *
 * node-telegram-bot-api emits 'polling_error' on every failed getUpdates poll.
 * Transient network errors (DNS, TCP timeouts) used to spam the logs and
 * effectively pin the bot down until systemd happened to restart it. The
 * resilience controller adds two behaviors:
 *
 *   1. **Exponential backoff** for transient classes — pause polling for
 *      5s → 15s → 60s → 5min on successive errors so the bot stops hammering
 *      a broken upstream.
 *   2. **Hard watchdog** — if 15 polling errors arrive within a 60s window,
 *      give up and exit so systemd can restart the process from a clean state.
 *
 * A successful poll (message or callback receipt) resets the backoff level.
 */

export const DEFAULT_BACKOFF_SCHEDULE_MS = [5_000, 15_000, 60_000, 300_000];
export const DEFAULT_WATCHDOG_WINDOW_MS = 60_000;
export const DEFAULT_WATCHDOG_MAX_ERRORS = 15;

const TRANSIENT_CODES = new Set([
  'EAI_AGAIN',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

const TRANSIENT_PATTERNS = [
  /eai_again/i,
  /econnreset/i,
  /etimedout/i,
  /enotfound/i,
  /econnrefused/i,
  /ehostunreach/i,
  /enetunreach/i,
  /epipe/i,
  /getaddrinfo/i,
  /socket hang up/i,
  /network/i,
];

/**
 * Errors we never want to retry: bad credentials, malformed requests. Surfacing
 * these via process exit means an operator (or systemd's restart with fresh
 * env) gets a chance to fix the underlying config.
 */
const FATAL_PATTERNS = [
  /401 unauthorized/i,
  /403 forbidden/i,
  /chat not found/i,
  /bot was blocked/i,
];

export type ErrorClass = 'transient' | 'fatal' | 'unknown';

export function classifyError(err: unknown): ErrorClass {
  if (!err) return 'unknown';
  const message = (err as Error).message ?? String(err);
  const code = (err as NodeJS.ErrnoException).code ?? '';

  if (code && TRANSIENT_CODES.has(code)) return 'transient';
  for (const p of TRANSIENT_PATTERNS) {
    if (p.test(message)) return 'transient';
  }
  for (const p of FATAL_PATTERNS) {
    if (p.test(message)) return 'fatal';
  }
  return 'unknown';
}

export type ResilienceDecision =
  | { action: 'noop' }
  | { action: 'log_only' }
  | { action: 'backoff'; ms: number; level: number }
  | { action: 'exit_watchdog'; recentErrorCount: number }
  | { action: 'exit_fatal' };

export interface ResilienceState {
  backoffLevel: number;
  errorTimestamps: number[];
  isPaused: boolean;
  schedule: number[];
  watchdogWindowMs: number;
  watchdogMax: number;
  /** Override-able clock so tests can use mock.timers / fake values. */
  now(): number;
}

export function createState(opts: {
  schedule?: number[];
  watchdogWindowMs?: number;
  watchdogMax?: number;
  now?: () => number;
} = {}): ResilienceState {
  return {
    backoffLevel: 0,
    errorTimestamps: [],
    isPaused: false,
    schedule: opts.schedule ?? DEFAULT_BACKOFF_SCHEDULE_MS,
    watchdogWindowMs: opts.watchdogWindowMs ?? DEFAULT_WATCHDOG_WINDOW_MS,
    watchdogMax: opts.watchdogMax ?? DEFAULT_WATCHDOG_MAX_ERRORS,
    now: opts.now ?? Date.now,
  };
}

/**
 * Decide what to do with a polling error. Mutates state (records the timestamp,
 * advances backoff level) so successive calls progress through the schedule.
 */
export function onPollingError(state: ResilienceState, err: unknown): ResilienceDecision {
  const now = state.now();

  state.errorTimestamps.push(now);
  state.errorTimestamps = state.errorTimestamps.filter((t) => t > now - state.watchdogWindowMs);

  if (state.errorTimestamps.length >= state.watchdogMax) {
    return { action: 'exit_watchdog', recentErrorCount: state.errorTimestamps.length };
  }

  const kind = classifyError(err);

  if (kind === 'fatal') {
    return { action: 'exit_fatal' };
  }

  if (kind !== 'transient') {
    return { action: 'log_only' };
  }

  if (state.isPaused) {
    // Already in a backoff window; the extra errors are just noise from the
    // queue draining. Don't re-trigger.
    return { action: 'noop' };
  }

  const level = state.backoffLevel;
  const ms = state.schedule[Math.min(level, state.schedule.length - 1)] ?? DEFAULT_BACKOFF_SCHEDULE_MS[DEFAULT_BACKOFF_SCHEDULE_MS.length - 1]!;
  state.backoffLevel = level + 1;
  return { action: 'backoff', ms, level: level + 1 };
}

/** Mark backoff paused/unpaused so concurrent errors don't double-trigger. */
export function setPaused(state: ResilienceState, paused: boolean): void {
  state.isPaused = paused;
}

/** Reset escalation after a successful poll cycle. */
export function onSuccessfulPoll(state: ResilienceState): void {
  state.backoffLevel = 0;
}
