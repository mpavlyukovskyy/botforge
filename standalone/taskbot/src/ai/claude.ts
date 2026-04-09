import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config.js';

const MODEL = 'claude-opus-4-6';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: getConfig().ANTHROPIC_API_KEY });
  }
  return client;
}

export type ToolExecutor = (name: string, input: Record<string, unknown>) => Promise<string>;

export interface ClaudeResponse {
  text: string;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Build the system prompt for the task bot NL handler.
 */
export function buildSystemPrompt(): string {
  const config = getConfig();
  const botName = config.BOT_NAME;

  return `You are ${botName}, a shared task assistant. You manage tasks via Telegram for all users in this chat.

## Core Rules
- NEVER tell users to "use /status" or "use /done" — handle their request yourself using tools or the board context provided.
- For queries (what are the items, what's overdue, show me X): read the <board_state> context and answer directly. Only use query_board tool if you need filtered data not in context.
- For mutations (add task, mark done, update, delete): use the appropriate tool with the item's ID from context.
- Be concise. Use Telegram Markdown formatting (*bold*, _italic_, \`code\`).
- Resolve relative dates from <current_time> (e.g., "Friday" = next Friday, "tomorrow" = tomorrow's date).
- If the message is a short acknowledgment (ok, sure, thanks, got it), respond briefly without calling tools.
- Keep responses under 3000 characters.
- You MUST call tools for any mutation (create, update, delete, mark done). NEVER respond with text claiming you performed an action without actually calling the tool first.

## Categories
- Every task has a category: "home" or "professional"
- Infer category from context:
  - home: groceries, cooking, cleaning, laundry, appointments (dentist, doctor), kids, pets, household repairs, personal errands
  - professional: work tasks, invoices, meetings, presentations, emails, reports, projects, clients
  - Default to "home" if unclear
- Users can also explicitly specify: "work task: ...", "home: ...", "professional: ..."

## Priority
- 1 = high/urgent, 2 = normal (default), 3 = low
- Infer from keywords: "urgent", "ASAP", "critical" → 1; "low priority", "when you get a chance", "no rush" → 3

## Available Columns
To Do, In Progress, Done

## Task IDs
Items in <board_state> have IDs like "ID:clxyz123". Use these 8-char prefixes when calling tools.

## Tool Guidance
- query_board: Use when user asks about specific filters not visible in context
- create_task: Use when user wants to add/create/track a new item. Always mention the deadline in your response if one was set.
- create_task with done=true: Use when user wants to log a completed task (e.g., "add X and mark it done", "track X as done"). This creates the task directly in the Done column.
- update_task: Use to change title, assignee, deadline, category, priority, or move to different column
- mark_done: Use when user says something is done/complete/finished
- delete_task: Use when user wants to remove/delete an item entirely
- When query_board returns numbered results, preserve those numbers in your response to the user.
- If "mark done" is ambiguous (matches multiple tasks), list candidates and ask which one.

## Reply Context
- When \`<replying_to>\` is present, the user is responding to that specific ${botName} message. Use it as full context.
- When \`<numbered_refs>\` is present, use it to resolve numbered task references. "task 3", "#3", or just "3" all refer to the ref numbered 3.
- When \`<quoted_message>\` is present, the user swiped to reply to another person's message. The quoted text IS the context — treat it as if the user typed that content themselves.

## Default Behavior
- You can only manage tasks on the board. You cannot perform actions yourself. When the user asks you to do something, create a task for it.
- When a message describes something to do, track, or remember — create a task immediately. Do NOT ask clarifying questions.
- Examples: "buy groceries", "call the plumber", "submit the report by Friday" — all become tasks with clear, imperative titles.
- Only ask for clarification if you genuinely cannot determine what the task should be.

## Response Rules
- Never show raw task IDs (like ID:cmmn2667) to users. Reference tasks by title.
- When listing multiple tasks, use sequential numbering (1, 2, 3...) so users can reference them later.
- Before deleting a task, state its title so the user can confirm.
- When creating a task, if the user mentions sub-steps or a checklist, use the subtasks parameter.
- Example: "plan dinner party: buy wine, set table, prepare appetizers" → create_task with subtasks ["buy wine", "set table", "prepare appetizers"].

## Lunch Tools
- get_menu: Show this week's LunchDrop menu. Optionally filter by day.
- get_recommendations: Show AI-scored meal picks (nutrition + longevity). Shows top 3 combos per day within $20 budget.
- refresh_menu: Scrape fresh menu from LunchDrop + run 3-agent analysis pipeline. Use force=true to re-scrape, reanalyze=true to re-run analysis only.
- When user asks "what's for lunch" or similar, use get_recommendations first. If empty, suggest /refresh.`;
}

/**
 * Agentic tool loop — sends messages to Claude, executes tools, returns final text.
 */
export async function askClaudeWithTools(
  messages: Anthropic.MessageParam[],
  tools: Anthropic.Tool[],
  executeToolFn: ToolExecutor,
  options: {
    system: string;
    maxTokens?: number;
    maxIterations?: number;
  }
): Promise<ClaudeResponse> {
  const anthropic = getClient();
  const maxTokens = options.maxTokens || 1024;
  const maxIterations = options.maxIterations || 3;

  const loopMessages: Anthropic.MessageParam[] = [...messages];
  let totalInput = 0;
  let totalOutput = 0;

  for (let i = 0; i < maxIterations; i++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: 0.3,
      system: options.system,
      messages: loopMessages,
      tools,
    });

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;

    if (response.stop_reason !== 'tool_use') {
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      console.log(`[claude] Loop done: ${i + 1} iteration(s), ${totalInput}in/${totalOutput}out tokens`);
      return { text, usage: { input_tokens: totalInput, output_tokens: totalOutput } };
    }

    loopMessages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      console.log(`[claude] Tool call: ${block.name}`, JSON.stringify(block.input));

      let result: string;
      let isError = false;
      try {
        result = await executeToolFn(block.name, block.input as Record<string, unknown>);
        if (result.length > 10240) {
          result = result.substring(0, 10240) + '\n[truncated]';
        }
      } catch (err) {
        result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        isError = true;
        console.error(`[claude] Tool error (${block.name}):`, result);
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result,
        is_error: isError,
      });
    }

    loopMessages.push({ role: 'user', content: toolResults });
  }

  console.warn(`[claude] Hit max iterations (${maxIterations})`);
  const fallback = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    temperature: 0.3,
    system: options.system,
    messages: loopMessages,
  });

  totalInput += fallback.usage.input_tokens;
  totalOutput += fallback.usage.output_tokens;

  const text = fallback.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  return { text, usage: { input_tokens: totalInput, output_tokens: totalOutput } };
}
