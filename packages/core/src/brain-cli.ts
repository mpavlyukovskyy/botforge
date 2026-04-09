/**
 * BotForge Brain CLI — wraps `claude -p` for flat-rate subscription billing.
 *
 * Instead of using the Agent SDK (which requires ANTHROPIC_API_KEY and
 * per-token billing), this provider shells out to `claude -p` and implements
 * a manual tool-calling loop:
 *
 *   1. System prompt includes tool definitions as structured text
 *   2. Claude responds with <tool_use> blocks when it needs a tool
 *   3. We parse, execute, and feed results back as <tool_result>
 *   4. Loop until Claude gives a final text answer or max turns reached
 *
 * Each "turn" is a separate `claude -p` call. For most queries (1-2 tool calls),
 * this means 2-3 CLI calls per user message — acceptable latency for a Telegram bot.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrainConfig, BrainInput, BrainResponse, BrainTool } from './brain.js';

const execFileAsync = promisify(execFile);

// ─── Tool definition serialization ──────────────────────────────────────────

/**
 * Convert a Zod schema record to a human-readable parameter description.
 */
function describeZodSchema(schema: Record<string, any>): string {
  const params: Record<string, { type: string; description?: string; required: boolean }> = {};

  for (const [key, zodType] of Object.entries(schema)) {
    const def = zodType?._def;
    if (!def) {
      params[key] = { type: 'unknown', required: true };
      continue;
    }

    let typeName = 'string';
    let required = true;
    let description = def.description;
    let innerDef = def;

    // Unwrap ZodOptional
    if (def.typeName === 'ZodOptional') {
      required = false;
      innerDef = def.innerType?._def ?? def;
      if (!description) description = innerDef.description;
    }

    // Map Zod type names to simple types
    switch (innerDef.typeName) {
      case 'ZodString': typeName = 'string'; break;
      case 'ZodNumber': typeName = 'number'; break;
      case 'ZodBoolean': typeName = 'boolean'; break;
      case 'ZodArray': typeName = 'array'; break;
      case 'ZodEnum': typeName = `enum(${innerDef.values?.join('|') ?? ''})`; break;
      default: typeName = innerDef.typeName?.replace('Zod', '').toLowerCase() || 'string';
    }

    params[key] = { type: typeName, description, required };
  }

  return JSON.stringify(params, null, 2);
}

/**
 * Build the tool definitions block for the system prompt.
 */
function buildToolDefinitions(tools: BrainTool[]): string {
  if (tools.length === 0) return '';

  const toolDefs = tools.map(t => {
    return `<tool name="${t.name}" description="${t.description.replace(/"/g, '&quot;')}">\n<parameters>\n${describeZodSchema(t.schema)}\n</parameters>\n</tool>`;
  }).join('\n\n');

  return `<available_tools>
${toolDefs}
</available_tools>

TOOL CALLING INSTRUCTIONS:
When you need information that a tool can provide, use a tool by responding with a <tool_use> block.
Format: <tool_use name="tool_name">{"param": "value"}</tool_use>
You may call multiple tools in a single response — use one <tool_use> block per tool call.
After calling tools, wait for the results before providing your final answer.
If you do NOT need any tools, just respond with your answer directly — no <tool_use> blocks needed.`;
}

// ─── Tool call parsing ──────────────────────────────────────────────────────

interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Extract <tool_use name="...">...</tool_use> blocks from Claude's response.
 */
function parseToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const regex = /<tool_use\s+name="([^"]+)">([\s\S]*?)<\/tool_use>/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const name = match[1]!;
    const rawArgs = (match[2] ?? '').trim();

    try {
      const args = rawArgs ? JSON.parse(rawArgs) : {};
      calls.push({ name, args: args as Record<string, unknown> });
    } catch {
      // If JSON parse fails, try to extract anyway
      calls.push({ name, args: {} });
    }
  }

  return calls;
}

// ─── Main brain function ────────────────────────────────────────────────────

/**
 * Send a message to Claude via CLI with manual tool-calling loop.
 */
export async function askBrainCli(config: BrainConfig, input: BrainInput): Promise<BrainResponse> {
  const maxTurns = config.maxTurns ?? 5;
  console.log(`[brain-cli] Starting: model=${config.model}, maxTurns=${maxTurns}, tools=${input.tools.length}, contextBlocks=${input.contextBlocks?.length ?? 0}, historyLen=${input.conversationHistory?.length ?? 0}`);

  // Build full system prompt with tool definitions and context
  let fullSystemPrompt = config.systemPrompt;
  if (input.conversationHistory) {
    fullSystemPrompt += `\n\n${input.conversationHistory}`;
  }
  if (input.contextBlocks?.length) {
    fullSystemPrompt += '\n\n' + input.contextBlocks.join('\n\n');
  }

  const toolDefs = buildToolDefinitions(input.tools);
  if (toolDefs) {
    fullSystemPrompt += '\n\n' + toolDefs;
  }

  // Build tool lookup map
  const toolMap = new Map<string, BrainTool>();
  for (const t of input.tools) {
    toolMap.set(t.name, t);
  }

  // Conversation accumulator for multi-turn
  let conversation = input.userMessage;
  let turns = 0;

  while (turns < maxTurns) {
    turns++;
    const MAX_CONVERSATION = 100_000;
    if (conversation.length > MAX_CONVERSATION) {
      console.warn(`[brain-cli] Conversation too large (${conversation.length} chars), truncating to ${MAX_CONVERSATION}`);
      conversation = conversation.slice(0, MAX_CONVERSATION) + '\n[...conversation truncated due to size]';
    }
    console.log(`[brain-cli] Turn ${turns}/${maxTurns}, prompt size: system=${fullSystemPrompt.length} user=${conversation.length}`);

    // Call claude -p
    const responseText = await callClaude(config.model, fullSystemPrompt, conversation);

    // Check for tool calls
    const toolCalls = parseToolCalls(responseText);

    if (toolCalls.length === 0) {
      // No tool calls — this is the final response
      console.log(`[brain-cli] Turn ${turns}: no tool calls, final response (${responseText.length} chars)`);
      return {
        text: responseText,
        usage: { costUsd: 0 }, // Flat-rate, no per-token cost
        turns,
      };
    }

    console.log(`[brain-cli] Turn ${turns}: ${toolCalls.length} tool call(s): ${toolCalls.map(tc => tc.name).join(', ')}`);

    // Execute all tool calls
    const toolResults: string[] = [];
    for (const tc of toolCalls) {
      const tool = toolMap.get(tc.name);
      if (!tool) {
        toolResults.push(
          `<tool_result name="${tc.name}">\nError: Unknown tool "${tc.name}"\n</tool_result>`
        );
        continue;
      }

      try {
        const result = await tool.execute(tc.args);
        // Extract text from CallToolResult
        let resultText = result.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text)
          .join('\n');
        const MAX_TOOL_RESULT = 20_000;
        if (resultText.length > MAX_TOOL_RESULT) {
          console.warn(`[brain-cli] Tool ${tc.name} result truncated: ${resultText.length} → ${MAX_TOOL_RESULT} chars`);
          resultText = resultText.slice(0, MAX_TOOL_RESULT) + `\n[...truncated from ${resultText.length} chars]`;
        }
        console.log(`[brain-cli] Tool ${tc.name}: ${resultText.length} chars`);
        toolResults.push(
          `<tool_result name="${tc.name}">\n${resultText}\n</tool_result>`
        );
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`[brain-cli] Tool ${tc.name} ERROR: ${errorMsg}`);
        toolResults.push(
          `<tool_result name="${tc.name}">\nError: ${errorMsg}\n</tool_result>`
        );
      }
    }

    // Build next turn with assistant response + tool results
    conversation += `\n\n<assistant_response>\n${responseText}\n</assistant_response>\n\n${toolResults.join('\n\n')}\n\nThe tool results above are now available. Continue your response to the user, incorporating the tool results. Do NOT use <tool_use> again for the same tools unless you need different information.`;
  }

  // Max turns exceeded — return whatever we have
  return {
    text: 'I was unable to complete the request within the allowed number of steps. Please try rephrasing or breaking your question into smaller parts.',
    usage: { costUsd: 0 },
    turns,
  };
}

// ─── Claude CLI wrapper ─────────────────────────────────────────────────────

async function callClaude(model: string, systemPrompt: string, userMessage: string): Promise<string> {
  const TIMEOUT_MS = 120_000;

  const args = [
    '-p', userMessage,
    '--output-format', 'json',
    '--model', model,
    '--system-prompt', systemPrompt,
  ];

  // Build env: inherit process.env but remove CLAUDECODE to allow nested sessions
  const env = { ...process.env };
  delete env.CLAUDECODE;
  // Set entrypoint for analytics
  env.CLAUDE_CODE_ENTRYPOINT = 'botforge-brain-cli';

  try {
    const { stdout } = await execFileAsync('claude', args, {
      timeout: TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env,
    });

    try {
      const parsed = JSON.parse(stdout);
      return parsed.result || parsed.text || stdout.trim();
    } catch {
      // JSON parse fails — return raw stdout
      return stdout.trim();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[brain-cli] Claude CLI call failed: ${message}`);
    throw new Error(`Claude CLI call failed: ${message}`);
  }
}
