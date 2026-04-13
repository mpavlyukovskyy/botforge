/**
 * BotForge Brain — Claude Agent SDK wrapper
 *
 * Config-driven interface to the Claude Agent SDK's query() function.
 * Each call spawns a Claude Code child process with MCP tools.
 */

import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { ZodType } from 'zod';

/** MCP CallToolResult — defined locally to avoid @modelcontextprotocol/sdk dependency */
type CallToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BrainTool {
  name: string;
  description: string;
  schema: Record<string, ZodType>;  // AnyZodRawShape — plain object of Zod types, NOT z.object()
  execute: (args: unknown) => Promise<CallToolResult>;
}

export interface BrainConfig {
  /** Bot name — used as MCP server name */
  name: string;
  /** Claude model ID (e.g., 'claude-opus-4-6') */
  model: string;
  /** System prompt text */
  systemPrompt: string;
  /** Max agentic turns, default 5 */
  maxTurns?: number;
  /** Max cost per query in USD, default $1.00 */
  maxBudgetUsd?: number;
}

export interface BrainInput {
  /** The user's message text */
  userMessage: string;
  /** MCP tools available to the brain */
  tools: BrainTool[];
  /** Formatted conversation history block */
  conversationHistory?: string;
  /** Dynamic context blocks (XML-tagged) */
  contextBlocks?: string[];
}

export interface BrainResponse {
  /** The assistant's text response */
  text: string;
  /** Cost info — SDK only exposes total_cost_usd */
  usage: { costUsd: number };
  /** Number of agentic turns taken */
  turns: number;
}

// Built-in SDK tools that MUST be blocked for security
const DISALLOWED_BUILTIN_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'Agent', 'AskUserQuestion',
  'NotebookEdit', 'TodoWrite', 'ExitPlanMode', 'EnterWorktree',
  'Config', 'TaskOutput', 'TaskStop', 'ListMcpResources', 'ReadMcpResource',
  'EnterPlanMode', 'Task', 'Skill', 'EnterWorktree',
];

/**
 * Send a message to the Claude brain with MCP tools.
 *
 * Each call spawns a Claude Code child process (~60MB, 3-10s cold start).
 * Acceptable for chat bots where users expect thinking time.
 */
export async function askBrain(
  config: BrainConfig,
  input: BrainInput,
  log?: { info(msg: string, ...a: unknown[]): void; debug(msg: string, ...a: unknown[]): void; warn(msg: string, ...a: unknown[]): void },
): Promise<BrainResponse> {
  // 1. Build MCP server from registered tools
  const mcpServer = createSdkMcpServer({
    name: config.name,
    tools: input.tools.map(t =>
      tool(t.name, t.description, t.schema, async (args: unknown) => {
        return await t.execute(args);
      })
    ),
  });

  // 2. Build full system prompt with context blocks
  let fullSystemPrompt = config.systemPrompt;
  if (input.conversationHistory) {
    fullSystemPrompt += `\n\n${input.conversationHistory}`;
  }
  if (input.contextBlocks?.length) {
    fullSystemPrompt += '\n\n' + input.contextBlocks.join('\n\n');
  }

  // 3. Build allowed tools list (only our MCP tools)
  const allowedMcpTools = input.tools.map(t => `mcp__${config.name}__${t.name}`);

  // 4. Call SDK
  let resultText = '';
  let costUsd = 0;
  let turns = 0;

  try {
    for await (const message of query({
      prompt: input.userMessage,
      options: {
        systemPrompt: fullSystemPrompt,
        model: config.model,
        maxTurns: config.maxTurns ?? 5,
        maxBudgetUsd: config.maxBudgetUsd ?? 1.0,
        mcpServers: { [config.name]: mcpServer },
        // SECURITY: Block all built-in tools
        disallowedTools: DISALLOWED_BUILTIN_TOOLS,
        permissionMode: 'dontAsk',
        allowedTools: allowedMcpTools,
        // No session persistence for ephemeral bot queries
        persistSession: false,
        // Defense-in-depth: disable all built-in tools via tools option
        tools: [],
        // Don't use thinking for chat bot responses (saves cost)
        thinking: { type: 'disabled' },
      },
    })) {
      if (log) {
        const t = (message as any).type ?? 'unknown';
        if (t !== 'result') {
          log.debug(`Brain [${config.name}]: event=${t}`);
        }
      }
      if (message.type === 'result') {
        if (message.subtype === 'success') {
          resultText = message.result;
        } else {
          // Error result — extract what we can
          resultText = message.errors?.join('\n') ?? 'An error occurred during processing.';
        }
        costUsd = message.total_cost_usd ?? 0;
        turns = message.num_turns ?? 0;
      }
    }
  } catch (err) {
    throw new Error(`Brain query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { text: resultText, usage: { costUsd }, turns };
}
