/**
 * Claude Code CLI wrapper — calls `claude -p` for LLM intelligence.
 *
 * Uses Claude Code (flat-rate subscription) instead of per-token API calls.
 * Pattern borrowed from bots/argus/lib/brain.ts.
 *
 * Model routing:
 *   classify() → Haiku  (fast, cheap classification)
 *   extract()  → Sonnet (structured extraction)
 *   compile()  → Sonnet (briefing/meeting prep synthesis)
 *   draft()    → Opus   (high-quality email drafts)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const MODELS = {
  HAIKU: 'claude-haiku-4-5-20251001',
  SONNET: 'claude-sonnet-4-6',
  OPUS: 'claude-opus-4-6',
};

// ─── Core: claude -p ──────────────────────────────────────────────────────

/**
 * Call Claude via the CLI (`claude -p`).
 *
 * @param {string} model - Model ID
 * @param {string} systemPrompt - System prompt
 * @param {string} userMessage - User message / prompt
 * @param {object} [options]
 * @param {number} [options.timeoutMs=120000] - Timeout in ms
 * @returns {{ text: string, cost_usd: number, duration_ms: number, is_error: boolean }}
 */
export async function complete(model, systemPrompt, userMessage, options = {}) {
  const { timeoutMs = 120_000 } = options;
  const startTime = Date.now();

  const args = [
    '-p', userMessage,
    '--output-format', 'json',
    '--model', model,
  ];

  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt);
  }

  try {
    const { stdout } = await execFileAsync('claude', args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'chief-of-staff' },
    });

    const durationMs = Date.now() - startTime;

    try {
      const parsed = JSON.parse(stdout);
      return {
        text: parsed.result || parsed.text || stdout,
        usage: { costUsd: parsed.cost_usd || 0 },
        duration_ms: durationMs,
        is_error: false,
      };
    } catch {
      // JSON parse fails → return raw stdout
      return {
        text: stdout.trim(),
        usage: { costUsd: 0 },
        duration_ms: durationMs,
        is_error: false,
      };
    }
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    return {
      text: `Claude query failed: ${message}`,
      usage: { costUsd: 0 },
      duration_ms: durationMs,
      is_error: true,
    };
  }
}

// ─── Convenience wrappers ─────────────────────────────────────────────────

/**
 * Classify text into one of the given categories. Uses Haiku.
 */
export async function classify(text, categories, options = {}) {
  const systemPrompt = options.systemPrompt || [
    'You are a classifier. Categorize the following text into exactly one of these categories:',
    categories.join(', '),
    '',
    'Respond with ONLY valid JSON: {"category": "...", "confidence": 0.0-1.0, "summary": "one sentence"}',
  ].join('\n');

  const model = options.model || MODELS.HAIKU;

  const result = await complete(model, systemPrompt, text, {
    timeoutMs: options.timeoutMs || 30_000,
  });

  try {
    // Strip markdown code fences if present (e.g. ```json\n...\n```)
    const cleaned = result.text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    return { ...parsed, usage: result.usage };
  } catch {
    return { category: null, confidence: 0, summary: result.text, usage: result.usage };
  }
}

/**
 * Extract structured data from text. Uses Sonnet.
 */
export async function extract(systemPrompt, text, options = {}) {
  const result = await complete(MODELS.SONNET, systemPrompt, text, {
    timeoutMs: options.timeoutMs || 60_000,
  });

  try {
    const parsed = JSON.parse(result.text);
    return { ...parsed, usage: result.usage };
  } catch {
    return { text: result.text, usage: result.usage };
  }
}

/**
 * Compile/synthesize context into a briefing or summary. Uses Sonnet.
 */
export async function compile(systemPrompt, context, instruction, options = {}) {
  const userMessage = `<context>\n${context}\n</context>\n\n${instruction}`;
  return complete(MODELS.SONNET, systemPrompt, userMessage, {
    timeoutMs: options.timeoutMs || 120_000,
  });
}

/**
 * Draft an email or document. Uses Opus for quality.
 */
export async function draft(systemPrompt, context, instruction, options = {}) {
  const userMessage = `<context>\n${context}\n</context>\n\n${instruction}`;
  return complete(MODELS.OPUS, systemPrompt, userMessage, {
    timeoutMs: options.timeoutMs || 120_000,
  });
}
