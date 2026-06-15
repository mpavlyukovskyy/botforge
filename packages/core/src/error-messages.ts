// Honest, cause-specific error messages for brain failures.
//
// When the brain (Claude Code / Gemini) throws, we must tell the user WHAT
// went wrong in plain language — especially "I've hit my API budget" — instead
// of a generic "Sorry, I couldn't process that." Lives in core so every bot
// inherits it. Pure, dependency-light; safe to run when credits are exhausted.

import type { PlatformAdapter } from './adapter.js';
import type { Logger } from './skill.js';

export type ErrorClass =
  | 'credit_balance'
  | 'usage_limit'
  | 'payment_required'
  | 'auth'
  | 'permission'
  | 'overloaded'
  | 'rate_limited'
  | 'context_too_long'
  | 'server_error'
  | 'network'
  | 'brain_timeout'
  | 'db_error'
  | 'cli_failure'
  | 'tool_error'
  | 'unknown';

/**
 * Classify a thrown error into a stable category. ORDER MATTERS — most specific
 * first, because (a) several distinct billing failures all arrive as HTTP 400
 * and (b) the claude-cli path wraps the cause as "Claude CLI call failed: ...",
 * so a CLI-wrapped credit/auth error must still classify by its real cause, not
 * the generic cli_failure bucket.
 *
 * The signal is string-only: the Agent SDK collapses HTTP status / error.type /
 * the full API body into a generic Error string (and truncates it, e.g.
 * "Credit balance is too low") before this sees it, so we match on the deployed
 * (often truncated) strings.
 */
export function classifyError(err: unknown): ErrorClass {
  if (!err) return 'unknown';
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';

  // Billing (all surface as 400 invalid_request_error) — most specific first.
  if (/credit balance is too low/i.test(msg) || /Plans & Billing/i.test(msg)) return 'credit_balance';
  if (/specified API usage limits/i.test(msg) || /usage limit/i.test(msg)) return 'usage_limit';
  if (/\b402\b/.test(msg) || /payment.?required/i.test(msg)) return 'payment_required';

  // Auth / permission
  if (/\b401\b/.test(msg) || /authentication/i.test(msg) || /invalid (x-)?api.?key/i.test(msg) || /unauthorized/i.test(msg)) return 'auth';
  if (/\b403\b/.test(msg) || /permission_error/i.test(msg)) return 'permission';

  // Overload / rate limit
  if (/\b529\b/.test(msg) || /overloaded/i.test(msg)) return 'overloaded';
  if (/\b429\b/.test(msg) || /rate.?limit/i.test(msg)) return 'rate_limited';

  // Request too large for the context window
  if (/prompt is too long/i.test(msg) || /exceeds? the maximum/i.test(msg) || /context.{0,12}length/i.test(msg) || /too many tokens/i.test(msg)) return 'context_too_long';

  // Anthropic server errors
  if (/\b50[023]\b/.test(msg) || /\bapi_error\b/i.test(msg) || /service unavailable/i.test(msg) || /internal server error/i.test(msg)) return 'server_error';

  // Network / transport — before the generic timeout check so ETIMEDOUT etc. land here, not brain_timeout.
  if (/ECONNRESET/i.test(msg) || /ETIMEDOUT/i.test(msg) || /socket hang up/i.test(msg) || /fetch failed/i.test(msg) || /ENOTFOUND/i.test(msg)) return 'network';

  // Our own 120s brain timeout / aborts
  if (name === 'AbortError' || /operation was aborted/i.test(msg) || /timed out/i.test(msg) || /\btimeout\b/i.test(msg)) return 'brain_timeout';

  // Local database errors (e.g. the token-tracker PK divergence)
  if (/SqliteError/i.test(msg) || /SQLITE_/.test(msg) || /database is locked/i.test(msg) || /ON CONFLICT/i.test(msg)) return 'db_error';

  // claude-cli subprocess failure (Chief-of-Staff) — after the specific causes above.
  if (/Claude CLI call failed/i.test(msg) || /command failed/i.test(msg)) return 'cli_failure';

  if (/\btool\b/i.test(msg) || /MCP/i.test(msg)) return 'tool_error';
  return 'unknown';
}

/** Short, human-shareable incident ref (8 hex-ish chars). */
export function shortRef(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Render a user-facing, cause-specific message. Written for a Telegram group
 * of non-engineers: plain, honest, friendly. Carries a ref so it can be
 * grepped in journals. For usage_limit it parses the regain date out of the
 * raw error body when present.
 */
export function renderError(
  errorClass: ErrorClass,
  opts: { errorMessage?: string; ref?: string } = {},
): string {
  const ref = opts.ref ?? shortRef();
  switch (errorClass) {
    case 'credit_balance':
      return `⚠️ I'm out of Anthropic API credits, so I can't run right now — an admin's been notified to top it up. (ref ${ref})`;
    case 'usage_limit': {
      const m = opts.errorMessage?.match(
        /regain access on ([0-9]{4}-[0-9]{2}-[0-9]{2})(?: at ([0-9:]+ ?UTC))?/i,
      );
      if (m) {
        const when = m[2] ? `${m[1]} at ${m[2]}` : m[1];
        return `⚠️ I've hit my monthly API budget, so I'm paused until ${when}. (ref ${ref})`;
      }
      return `⚠️ I've hit my monthly API budget and I'm paused until it resets. (ref ${ref})`;
    }
    case 'payment_required':
      return `⚠️ There's an Anthropic billing problem, so I can't run right now — an admin's been notified. (ref ${ref})`;
    case 'auth':
      return `⚠️ My API key isn't working (authentication failed) — an admin's been notified. (ref ${ref})`;
    case 'permission':
      return `⚠️ I'm not allowed to use that model or region — an admin's been notified. (ref ${ref})`;
    case 'overloaded':
      return `⏳ Anthropic is overloaded right now. Give me a moment and try again. (ref ${ref})`;
    case 'rate_limited':
      return `⏳ I'm being rate-limited right now. Give me a minute and try again. (ref ${ref})`;
    case 'context_too_long':
      return `⚠️ That was too large for me to process — try again with a shorter message. (ref ${ref})`;
    case 'server_error':
      return `⏳ Anthropic had a server error. Give me a moment and try again. (ref ${ref})`;
    case 'network':
      return `⏳ I had a network hiccup reaching Anthropic. Please try again. (ref ${ref})`;
    case 'brain_timeout':
      return `⏳ That took too long to process. Please try again. (ref ${ref})`;
    case 'db_error':
      return `⚠️ I hit a database error. Logged for review. (ref ${ref})`;
    case 'cli_failure':
      return `⚠️ My Claude CLI failed to run. Logged for review. (ref ${ref})`;
    case 'tool_error':
      return `⚠️ One of my tools failed. Logged for review. (ref ${ref})`;
    case 'unknown':
    default:
      return `⚠️ Failed to process (ref ${ref}). Logged for review.`;
  }
}

/**
 * Classes that mean "the LLM is unavailable" (vs. a local/tool/oversized-input
 * problem). Only these warrant deterministic fallback capture — db_error /
 * tool_error / context_too_long / cli_failure / unknown do NOT (a local insert
 * may also fail, a tool may have partially run, or we'd be guessing).
 */
export const LLM_UNAVAILABLE_CLASSES = new Set<ErrorClass>([
  'credit_balance', 'usage_limit', 'payment_required', 'auth', 'permission',
  'overloaded', 'rate_limited', 'server_error', 'network', 'brain_timeout',
]);

const ADMIN_NOTIFY_THROTTLE_MS = 30 * 60 * 1000;

/** Error classes only an admin can fix — these alert; transient classes don't. */
const ADMIN_ALERT_CLASSES = new Set<ErrorClass>([
  'credit_balance', 'usage_limit', 'payment_required', 'auth', 'permission', 'cli_failure',
]);

/** Per-class actionable hint for the admin alert (never shown to the group). */
function adminFixHint(errorClass: ErrorClass): string {
  switch (errorClass) {
    case 'credit_balance': return 'Top up at console.anthropic.com → Plans & Billing (and enable auto-reload).';
    case 'usage_limit': return 'Raise the spend cap in the Anthropic Console, or wait for the reset.';
    case 'payment_required': return 'Check billing/payment at console.anthropic.com → Plans & Billing.';
    case 'auth': return 'Check ANTHROPIC_API_KEY — it may be invalid or revoked.';
    case 'permission': return 'Check model/region access for the API key in the Console.';
    case 'cli_failure': return 'Check the claude CLI on the server (login / credentials / exit code).';
    default: return '';
  }
}

/**
 * Best-effort, throttled admin alert for brain errors only an admin can fix
 * (billing, auth, permission, CLI). Env-gated on ADMIN_USER_ID — no config
 * flag, so it stays out of the way for bots that don't set it. Throttled per
 * error class to one alert / 30 min via the shared store. Never throws.
 */
export async function maybeNotifyAdmin(args: {
  errorClass: ErrorClass;
  errMsg: string;
  botName?: string;
  adapter: PlatformAdapter;
  store: Map<string, unknown>;
  log: Logger;
}): Promise<void> {
  const { errorClass, errMsg, botName, adapter, store, log } = args;
  if (!ADMIN_ALERT_CLASSES.has(errorClass)) return;

  const adminId = process.env.ADMIN_USER_ID;
  if (!adminId) {
    log.debug('Serious brain error but ADMIN_USER_ID unset — skipping admin alert');
    return;
  }

  const throttleKey = `_adminNotified:${errorClass}`;
  const last = store.get(throttleKey) as number | undefined;
  const now = Date.now();
  if (typeof last === 'number' && now - last < ADMIN_NOTIFY_THROTTLE_MS) {
    log.debug(`Admin alert for ${errorClass} throttled (last ${Math.round((now - last) / 1000)}s ago)`);
    return;
  }

  const hint = adminFixHint(errorClass);
  try {
    await adapter.send({
      chatId: adminId,
      text: `🚨 ${botName ?? 'Bot'} brain error: ${errorClass}.${hint ? ' ' + hint : ''}\n${errMsg.slice(0, 200)}`,
    });
    store.set(throttleKey, now);
  } catch (err) {
    log.debug(`Admin alert send failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
