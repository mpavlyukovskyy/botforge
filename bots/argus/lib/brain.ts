/**
 * Argus Trading System — Claude Code CLI Wrapper
 *
 * Calls `claude -p` for LLM intelligence (stock strategist, weekly reports).
 * Uses Claude Code Max ($200/mo flat rate) — no per-token cost.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

interface ClaudeResponse {
  result: string;
  cost_usd: number;
  duration_ms: number;
  is_error: boolean;
}

/**
 * Query Claude via the CLI.
 *
 * @param prompt - The user prompt
 * @param systemPrompt - Optional system prompt override
 * @param model - Model ID (default: claude-opus-4-6)
 * @param timeoutMs - Timeout in milliseconds (default: 120s)
 */
export async function queryClaude(
  prompt: string,
  options: {
    systemPrompt?: string;
    model?: string;
    timeoutMs?: number;
  } = {},
): Promise<ClaudeResponse> {
  const { model = 'claude-opus-4-6', timeoutMs = 120_000 } = options;
  const startTime = Date.now();

  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--model', model,
  ];

  if (options.systemPrompt) {
    args.push('--system-prompt', options.systemPrompt);
  }

  try {
    const { stdout } = await execFileAsync('claude', args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'argus-bot' },
    });

    const durationMs = Date.now() - startTime;

    try {
      const parsed = JSON.parse(stdout);
      return {
        result: parsed.result || parsed.text || stdout,
        cost_usd: parsed.cost_usd || 0,
        duration_ms: durationMs,
        is_error: false,
      };
    } catch {
      // If JSON parse fails, return raw stdout
      return {
        result: stdout.trim(),
        cost_usd: 0,
        duration_ms: durationMs,
        is_error: false,
      };
    }
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);

    return {
      result: `Claude query failed: ${message}`,
      cost_usd: 0,
      duration_ms: durationMs,
      is_error: true,
    };
  }
}
