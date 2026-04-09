import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config.js';
import { DateTime } from 'luxon';

export interface ParsedTask {
  intent: 'add_task' | 'query_fund' | 'mark_done' | 'passive_detect' | 'other';
  confidence: number;
  title: string;
  assignee: string | null;
  column: string | null;
  category: string | null;
  deadline: string | null;
  rawDeadline: string | null;
}

const TASK_TOOL: Anthropic.Tool = {
  name: 'extract_task',
  description: 'Extract a task or action item from a message',
  input_schema: {
    type: 'object' as const,
    properties: {
      intent: {
        type: 'string',
        enum: ['add_task', 'query_fund', 'mark_done', 'passive_detect', 'other'],
        description: 'The detected intent of the message',
      },
      confidence: {
        type: 'number',
        description: 'Confidence score from 0.0 to 1.0',
      },
      title: {
        type: 'string',
        description: 'Clean task title (imperative form, no filler words)',
      },
      assignee: {
        type: 'string',
        description: 'Person assigned to the task, or null',
      },
      column: {
        type: 'string',
        description: 'Board column name, or null',
      },
      category: {
        type: 'string',
        enum: ['home', 'professional'],
        description: 'Task category: home or professional',
      },
      deadline: {
        type: 'string',
        description: 'Resolved ISO date (YYYY-MM-DD) for the deadline, or null',
      },
      rawDeadline: {
        type: 'string',
        description: 'Original deadline phrase from the message, or null',
      },
    },
    required: ['intent', 'confidence', 'title', 'column'],
  },
};

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: getConfig().ANTHROPIC_API_KEY });
  }
  return client;
}

export async function parseMessage(
  message: string,
  columnNames: string[],
  assignees: string[],
  isExplicit: boolean
): Promise<ParsedTask> {
  const config = getConfig();
  const now = DateTime.now().setZone(config.TIMEZONE);
  const todayStr = now.toFormat('cccc, yyyy-MM-dd');

  const systemPrompt = `You are ${config.BOT_NAME}, a task extraction assistant. Extract action items from messages.

Today is ${todayStr} (${config.TIMEZONE} timezone).
Available board columns: ${columnNames.length > 0 ? columnNames.join(', ') : 'To Do, In Progress, Done'}
Known assignees: ${assignees.length > 0 ? assignees.join(', ') : config.BOT_NAME}

Rules:
- For explicit requests: extract the task with high confidence
- For passive detection: only flag clear action items with deadlines or assignments
- Resolve relative dates: "tomorrow" = ${now.plus({ days: 1 }).toISODate()}, "Friday" = next Friday, "next week" = next Monday
- Task titles should be clean, imperative form: "Review Q3 financials" not "we need to review the Q3 financials"
- If no clear task is found, return intent "other" with confidence 0
- Classify category:
  * home: groceries, cooking, cleaning, appointments, errands, kids, pets, personal
  * professional: work, meetings, reports, invoices, clients, projects
  * Default to "home" if unclear
- Default column to "To Do"`;

  const userPrompt = isExplicit
    ? `[EXPLICIT REQUEST] Extract the task from this message:\n\n${message}`
    : `[PASSIVE DETECTION] Check if this message contains an action item worth tracking:\n\n${message}`;

  try {
    const response = await getClient().messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 512,
      system: systemPrompt,
      tools: [TASK_TOOL],
      tool_choice: { type: 'tool', name: 'extract_task' },
      messages: [{ role: 'user', content: userPrompt }],
    });

    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );

    if (toolBlock) {
      const input = toolBlock.input as Record<string, unknown>;
      return {
        intent: (input.intent as ParsedTask['intent']) || 'other',
        confidence: (input.confidence as number) || 0,
        title: (input.title as string) || '',
        assignee: (input.assignee as string) || null,
        column: (input.column as string) || null,
        category: (input.category as string) || null,
        deadline: (input.deadline as string) || null,
        rawDeadline: (input.rawDeadline as string) || null,
      };
    }

    return fallback();
  } catch (err) {
    console.error('[task-parser] Claude API error:', err);
    return fallback();
  }
}

function fallback(): ParsedTask {
  return {
    intent: 'other',
    confidence: 0,
    title: '',
    assignee: null,
    column: null,
    category: null,
    deadline: null,
    rawDeadline: null,
  };
}

// Rate limiting for passive detection
const passiveCallTimestamps: number[] = [];
const passiveSuggestionTimestamps: number[] = [];

const MAX_PASSIVE_CALLS_PER_HOUR = 30;
const MAX_PASSIVE_SUGGESTIONS_PER_HOUR = 3;

export function canMakePassiveCall(): boolean {
  const oneHourAgo = Date.now() - 3600_000;
  while (passiveCallTimestamps.length > 0 && passiveCallTimestamps[0]! < oneHourAgo) {
    passiveCallTimestamps.shift();
  }
  return passiveCallTimestamps.length < MAX_PASSIVE_CALLS_PER_HOUR;
}

export function recordPassiveCall(): void {
  passiveCallTimestamps.push(Date.now());
}

export function canMakePassiveSuggestion(): boolean {
  const oneHourAgo = Date.now() - 3600_000;
  while (passiveSuggestionTimestamps.length > 0 && passiveSuggestionTimestamps[0]! < oneHourAgo) {
    passiveSuggestionTimestamps.shift();
  }
  return passiveSuggestionTimestamps.length < MAX_PASSIVE_SUGGESTIONS_PER_HOUR;
}

export function recordPassiveSuggestion(): void {
  passiveSuggestionTimestamps.push(Date.now());
}

export function shouldSkipMessage(text: string): boolean {
  if (!text || text.length < 10) return true;
  if (/^https?:\/\/\S+$/i.test(text.trim())) return true;
  return false;
}
