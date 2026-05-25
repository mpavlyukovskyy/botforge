// Honest, cause-specific error messages for brain failures.
//
// When the brain (Claude Code / Gemini) throws, we must tell the user WHAT
// went wrong in plain language — especially "I've hit my API budget" — instead
// of a generic "Sorry, I couldn't process that." Lives in core so every bot
// inherits it. Pure, dependency-light; safe to run when credits are exhausted.

import type { PlatformAdapter } from './adapter.js';
import type { Logger } from './skill.js';

export type ErrorClass =
  | 'rate_limited'
  | 'auth'
  | 'usage_limit'
  | 'brain_timeout'
  | 'tool_error'
  | 'unknown';

/**
 * Classify a thrown error into a stable category. Order matters — most
 * specific first. Matches the Anthropic spend-cap 400 body verbatim:
 * "You have reached your specified API usage limits. You will regain access
 *  on 2026-06-01 at 00:00 UTC."
 */
export function classifyError(err: unknown): ErrorClass {
  if (!err) return 'unknown';
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';

  if (/specified API usage limits/i.test(msg) || /usage limit/i.test(msg)) return 'usage_limit';
  if (/\b(429|529)\b/.test(msg) || /rate.?limit/i.test(msg)) return 'rate_limited';
  if (/\b401\b/.test(msg) || /authentication|invalid api key|unauthorized/i.test(msg)) return 'auth';
  if (name === 'AbortError' || /This operation was aborted/i.test(msg)) return 'brain_timeout';
  if (/timed out/i.test(msg) || /timeout/i.test(msg)) return 'brain_timeout';
  if (/\btool\b|MCP/i.test(msg)) return 'tool_error';
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
    case 'auth':
      return `⚠️ My API key isn't working (authentication failed) — an admin needs to check it. (ref ${ref})`;
    case 'rate_limited':
      return `⏳ I'm being rate-limited right now. Give me a minute and try again. (ref ${ref})`;
    case 'brain_timeout':
      return `⏳ That took too long to process. Please try again. (ref ${ref})`;
    case 'tool_error':
      return `⚠️ One of my tools failed. Logged for review. (ref ${ref})`;
    case 'unknown':
    default:
      return `⚠️ Failed to process (ref ${ref}). Logged for review.`;
  }
}

const ADMIN_NOTIFY_THROTTLE_MS = 30 * 60 * 1000;

/**
 * Best-effort, throttled admin alert for serious brain errors that need a
 * human (usage_limit, auth). Env-gated on ADMIN_USER_ID — no config flag, so
 * it stays out of the way for bots that don't set it. Throttled per error
 * class to one alert / 30 min via the shared store. Never throws.
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
  if (errorClass !== 'usage_limit' && errorClass !== 'auth') return;

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

  try {
    await adapter.send({
      chatId: adminId,
      text: `🚨 ${botName ?? 'Bot'} brain error: ${errorClass}. ${errMsg.slice(0, 200)}`,
    });
    store.set(throttleKey, now);
  } catch (err) {
    log.debug(`Admin alert send failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
