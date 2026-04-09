/**
 * Claude Code CLI wrapper — calls `claude -p` for LLM intelligence.
 *
 * Pattern: chief-of-staff/lib/claude.js
 *
 * Model routing:
 *   callSonnet() → Sonnet (daily messages, workout wrappers)
 *   callOpus()   → Opus (program design, monthly reviews)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const MODELS = {
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
 * @returns {{ text: string, duration_ms: number, is_error: boolean }}
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
      maxBuffer: 10 * 1024 * 1024,
      env: (() => {
        const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'trainer' };
        delete env.CLAUDECODE;
        return env;
      })(),
    });

    const durationMs = Date.now() - startTime;

    try {
      const parsed = JSON.parse(stdout);
      return {
        text: parsed.result || parsed.text || stdout,
        duration_ms: durationMs,
        is_error: false,
      };
    } catch {
      return {
        text: stdout.trim(),
        duration_ms: durationMs,
        is_error: false,
      };
    }
  } catch (err) {
    const durationMs = Date.now() - startTime;
    return {
      text: `Claude query failed: ${err.message}`,
      duration_ms: durationMs,
      is_error: true,
    };
  }
}

// ─── Convenience wrappers ─────────────────────────────────────────────────

export async function callSonnet(systemPrompt, userMessage, options = {}) {
  return complete(MODELS.SONNET, systemPrompt, userMessage, {
    timeoutMs: options.timeoutMs || 60_000,
  });
}

export async function callOpus(systemPrompt, userMessage, options = {}) {
  return complete(MODELS.OPUS, systemPrompt, userMessage, {
    timeoutMs: options.timeoutMs || 180_000,
  });
}
