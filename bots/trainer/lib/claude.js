/**
 * Anthropic SDK wrapper for the Trainer bot.
 *
 * Error-class taxonomy returned to callers (so they can route intelligently):
 *   - 'cap_hit'      → workspace spending cap hit. No retry; raise cap or wait for reset.
 *   - 'rate_limited' → 429. Retry with backoff or fall back to a cheaper model.
 *   - 'server'       → 5xx or transient. Worth a retry.
 *   - 'timeout'      → request timed out. Worth a retry with smaller payload.
 *   - 'auth'         → 401/403. Misconfigured key; fix-it-now class.
 *   - 'bad_request'  → other 4xx that isn't the cap. Likely a prompt/schema bug.
 *   - 'unknown'      → anything else (network, JSON-parse, etc.)
 *
 * Single source of truth: every Anthropic SDK call lives in this file. No other
 * file in bots/trainer/ should import @anthropic-ai/sdk directly.
 */

import Anthropic from '@anthropic-ai/sdk';

export const MODELS = {
  HAIKU: 'claude-haiku-4-5-20251001',
  SONNET: 'claude-sonnet-4-6',
  OPUS: 'claude-opus-4-7',
};

export const ERROR_CLASSES = {
  CAP_HIT: 'cap_hit',
  RATE_LIMITED: 'rate_limited',
  SERVER: 'server',
  TIMEOUT: 'timeout',
  AUTH: 'auth',
  BAD_REQUEST: 'bad_request',
  UNKNOWN: 'unknown',
};

const CAP_HIT_PATTERN = /(usage limit|spending limit|credit balance|monthly limit)/i;

let _client;
function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is not set');
    }
    _client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: 2,
    });
  }
  return _client;
}

/**
 * Classify an Anthropic SDK error into one of the ERROR_CLASSES values.
 * Defensive — handles SDK error shape, raw HTTP shape, and unknown errors.
 */
export function classifyAnthropicError(err) {
  const status = err?.status ?? err?.response?.status;
  const rawMsg = err?.message ?? '';
  const body = err?.error?.error?.message ?? err?.error?.message ?? rawMsg;

  if (status === 400 && CAP_HIT_PATTERN.test(body)) return ERROR_CLASSES.CAP_HIT;
  if (status === 429) return ERROR_CLASSES.RATE_LIMITED;
  if (status === 401 || status === 403) return ERROR_CLASSES.AUTH;
  if (status >= 500 && status < 600) return ERROR_CLASSES.SERVER;
  if (status >= 400 && status < 500) return ERROR_CLASSES.BAD_REQUEST;
  if (/timeout|timed out|ETIMEDOUT/i.test(rawMsg)) return ERROR_CLASSES.TIMEOUT;
  return ERROR_CLASSES.UNKNOWN;
}

/**
 * Call Claude via the Anthropic Messages API.
 *
 * @param {string} model         - Model ID (see MODELS)
 * @param {string} systemPrompt  - System prompt (may be empty)
 * @param {string} userMessage   - User message / prompt
 * @param {object} [options]
 * @param {number} [options.timeoutMs=120000]
 * @param {number} [options.maxTokens=4096]
 * @returns {{ text: string, duration_ms: number, is_error: boolean, error_class?: string, model: string }}
 */
export async function complete(model, systemPrompt, userMessage, options = {}) {
  const { timeoutMs = 120_000, maxTokens = 4096 } = options;
  const startTime = Date.now();

  try {
    const client = getClient();
    const response = await client.messages.create(
      {
        model,
        max_tokens: maxTokens,
        system: systemPrompt || undefined,
        messages: [{ role: 'user', content: userMessage }],
      },
      { timeout: timeoutMs },
    );

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    return {
      text,
      duration_ms: Date.now() - startTime,
      is_error: false,
      model,
    };
  } catch (err) {
    const error_class = classifyAnthropicError(err);
    return {
      text: `Claude query failed: ${err.message ?? String(err)}`,
      duration_ms: Date.now() - startTime,
      is_error: true,
      error_class,
      model,
    };
  }
}

export async function callHaiku(systemPrompt, userMessage, options = {}) {
  return complete(MODELS.HAIKU, systemPrompt, userMessage, {
    timeoutMs: options.timeoutMs || 45_000,
    maxTokens: options.maxTokens,
  });
}

export async function callSonnet(systemPrompt, userMessage, options = {}) {
  return complete(MODELS.SONNET, systemPrompt, userMessage, {
    timeoutMs: options.timeoutMs || 60_000,
    maxTokens: options.maxTokens,
  });
}

export async function callOpus(systemPrompt, userMessage, options = {}) {
  return complete(MODELS.OPUS, systemPrompt, userMessage, {
    timeoutMs: options.timeoutMs || 180_000,
    maxTokens: options.maxTokens,
  });
}

/**
 * Cascade: try `tier` first, fall through to cheaper models on transient errors.
 * Skips fallback on CAP_HIT (workspace-wide; no model would work) and AUTH.
 *
 * @param {'opus'|'sonnet'|'haiku'} tier
 * @returns {Promise<{...completeResult, models_tried: string[]}>}
 */
export async function callWithCascade(tier, systemPrompt, userMessage, options = {}) {
  const chain = {
    opus: [MODELS.OPUS, MODELS.SONNET, MODELS.HAIKU],
    sonnet: [MODELS.SONNET, MODELS.HAIKU],
    haiku: [MODELS.HAIKU],
  }[tier] || [MODELS.SONNET, MODELS.HAIKU];

  const tried = [];
  let lastResult = null;
  for (const model of chain) {
    const result = await complete(model, systemPrompt, userMessage, options);
    tried.push(model);
    if (!result.is_error) {
      return { ...result, models_tried: tried };
    }
    lastResult = result;
    // Don't cascade on permanent errors — they affect every model.
    if (result.error_class === ERROR_CLASSES.CAP_HIT) break;
    if (result.error_class === ERROR_CLASSES.AUTH) break;
    if (result.error_class === ERROR_CLASSES.BAD_REQUEST) break;
  }
  return { ...lastResult, models_tried: tried };
}

/**
 * Send Mark a one-time admin alert when the workspace cap is hit.
 * Debounced via bot_state so we don't spam — at most once per 4 hours.
 *
 * @param {object} ctx        - Bot Forge tool context (has ctx.adapter + ctx.config)
 * @param {string} chatId     - Mark's Telegram chat ID
 * @param {string} reasonText - The 400 message body for context
 */
export async function notifyCapHit(ctx, chatId, reasonText) {
  const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
  try {
    const { getState, setState } = await import('./db.js');
    const lastAlertStr = getState(ctx.config, 'cap_hit_last_alert_at');
    const now = Date.now();
    if (lastAlertStr) {
      const last = parseInt(lastAlertStr, 10);
      if (Number.isFinite(last) && now - last < FOUR_HOURS_MS) return;
    }
    setState(ctx.config, 'cap_hit_last_alert_at', String(now));
    await ctx.adapter.send({
      chatId,
      text: `[ADMIN] Anthropic spending cap hit. Raise it at console.anthropic.com/settings/limits. Reason: ${reasonText.slice(0, 200)}`,
    });
  } catch (err) {
    ctx.log?.warn?.(`notifyCapHit failed: ${err.message ?? err}`);
  }
}
