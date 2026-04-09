import Anthropic from '@anthropic-ai/sdk';
import * as queries from '../db/queries.js';
import { getCurrentWeekOf, getMenuForWeek, getRecommendationsForWeek, dbMenuToAnalysisFormat, storeMenuItems, storeRecommendations, logScrape } from '../lunch/index.js';
import { scrapeMenu } from '../lunch/scraper.js';
import { analyzeMenu } from '../lunch/analysis.js';
import { formatRecommendations, formatMenu } from '../lunch/formatter.js';

export interface ToolContext {
  chatId: number;
  messageId: number;
  userName: string;
  replyMsgId?: number;
}

export interface CreatedTask {
  taskId: string;
  title: string;
  columnName: string | null;
}

export interface QueriedItem {
  refNum: number;
  taskId: string;
  title: string;
}

const queryBoardTool: Anthropic.Tool = {
  name: 'query_board',
  description: 'Query the task board with optional filters.',
  input_schema: {
    type: 'object' as const,
    properties: {
      status: { type: 'string', description: 'Filter by status: OPEN, DONE, ARCHIVED' },
      column: { type: 'string', description: 'Filter by column name (To Do, In Progress, Done)' },
      category: { type: 'string', description: 'Filter by category: home, professional' },
    },
    required: [],
  },
};

const createTaskTool: Anthropic.Tool = {
  name: 'create_task',
  description: 'Create a new task. Always provide a title. Column defaults to "To Do".',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Task title in imperative form' },
      column: { type: 'string', description: 'Column name: To Do, In Progress, Done' },
      category: { type: 'string', description: 'Category: home or professional. Default: home' },
      priority: { type: 'number', description: 'Priority: 1 (high), 2 (normal), 3 (low). Default: 2' },
      assignee: { type: 'string', description: 'Person to assign the task to' },
      deadline: { type: 'string', description: 'Deadline as ISO date (YYYY-MM-DD)' },
      deadline_time: { type: 'string', description: 'Time of deadline (HH:MM in 24h format)' },
      done: { type: 'boolean', description: 'If true, create and immediately mark as done' },
      subtasks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Checklist items / subtasks',
      },
    },
    required: ['title'],
  },
};

const updateTaskTool: Anthropic.Tool = {
  name: 'update_task',
  description: 'Update an existing task. Provide the item_id and fields to change.',
  input_schema: {
    type: 'object' as const,
    properties: {
      item_id: { type: 'string', description: 'Task ID (8-char prefix or full ID)' },
      title: { type: 'string', description: 'New title' },
      assignee: { type: 'string', description: 'New assignee' },
      deadline: { type: 'string', description: 'New deadline (YYYY-MM-DD)' },
      deadline_time: { type: 'string', description: 'New deadline time (HH:MM)' },
      column: { type: 'string', description: 'Column to move to' },
      category: { type: 'string', description: 'New category: home or professional' },
      priority: { type: 'number', description: 'New priority: 1, 2, or 3' },
    },
    required: ['item_id'],
  },
};

const markDoneTool: Anthropic.Tool = {
  name: 'mark_done',
  description: 'Mark one or more tasks as done.',
  input_schema: {
    type: 'object' as const,
    properties: {
      item_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of task IDs to mark done',
      },
    },
    required: ['item_ids'],
  },
};

const deleteTaskTool: Anthropic.Tool = {
  name: 'delete_task',
  description: 'Delete a task from the board entirely.',
  input_schema: {
    type: 'object' as const,
    properties: {
      item_id: { type: 'string', description: 'Task ID to delete' },
    },
    required: ['item_id'],
  },
};

const getMenuTool: Anthropic.Tool = {
  name: 'get_menu',
  description: 'Get the LunchDrop menu for the current week. Optionally filter by day.',
  input_schema: {
    type: 'object' as const,
    properties: {
      day: { type: 'string', description: 'Filter to a specific day (e.g. "Monday")' },
    },
    required: [],
  },
};

const getRecommendationsTool: Anthropic.Tool = {
  name: 'get_recommendations',
  description: 'Get AI-scored lunch recommendations for the current week. Shows top picks ranked by nutrition + longevity.',
  input_schema: {
    type: 'object' as const,
    properties: {
      day: { type: 'string', description: 'Filter to a specific day (e.g. "Monday")' },
    },
    required: [],
  },
};

const refreshMenuTool: Anthropic.Tool = {
  name: 'refresh_menu',
  description: 'Scrape fresh menu from LunchDrop and run AI analysis. Use force=true to re-scrape even if cached. Use reanalyze=true to re-run analysis on cached menu.',
  input_schema: {
    type: 'object' as const,
    properties: {
      force: { type: 'boolean', description: 'Force re-scrape even if menu is cached' },
      reanalyze: { type: 'boolean', description: 'Re-run analysis on existing cached menu' },
    },
    required: [],
  },
};

export const ALL_TOOLS: Anthropic.Tool[] = [
  queryBoardTool,
  createTaskTool,
  updateTaskTool,
  markDoneTool,
  deleteTaskTool,
  getMenuTool,
  getRecommendationsTool,
  refreshMenuTool,
];

export function createToolExecutor(ctx: ToolContext): {
  execute: (name: string, input: Record<string, unknown>) => Promise<string>;
  createdTasks: CreatedTask[];
  queriedItems: QueriedItem[];
} {
  const createdTasks: CreatedTask[] = [];
  const queriedItems: QueriedItem[] = [];

  async function execute(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'query_board':
        return executeQueryBoard(input, ctx, queriedItems);
      case 'create_task':
        return executeCreateTask(input, ctx, createdTasks);
      case 'update_task':
        return executeUpdateTask(input, ctx);
      case 'mark_done':
        return executeMarkDone(input, ctx);
      case 'delete_task':
        return executeDeleteTask(input, ctx);
      case 'get_menu':
        return executeGetMenu(input);
      case 'get_recommendations':
        return executeGetRecommendations(input);
      case 'refresh_menu':
        return executeRefreshMenu(input);
      default:
        return `Unknown tool: ${name}`;
    }
  }

  return { execute, createdTasks, queriedItems };
}

async function executeQueryBoard(
  input: Record<string, unknown>,
  ctx: ToolContext,
  queriedItems: QueriedItem[],
): Promise<string> {
  try {
    const status = input.status ? String(input.status) : 'OPEN';
    const category = input.category ? String(input.category) : undefined;

    let tasks: queries.Task[];
    if (input.column) {
      tasks = queries.getTasksByColumn(String(input.column), category);
    } else if (status === 'OPEN') {
      tasks = queries.getOpenTasks(category);
    } else {
      tasks = queries.getAllTasks(status);
      if (category) {
        tasks = tasks.filter(t => t.category === category);
      }
    }

    if (tasks.length === 0) return 'No matching items found.';

    const lines = tasks.map((task, idx) => {
      const num = idx + 1;
      queriedItems.push({
        refNum: num,
        taskId: task.id,
        title: task.title,
      });
      let line = `${num}. ID:${task.id.slice(0, 8)} | ${task.title} | ${task.column_name}`;
      if (task.category) line += ` | ${task.category}`;
      if (task.assignee) line += ` | @${task.assignee}`;
      if (task.deadline) line += ` | due:${task.deadline}`;
      if (task.priority === 1) line += ' | HIGH';
      if (task.priority === 3) line += ' | low';
      line += ` | status:${task.status}`;
      return line;
    });

    return `Found ${tasks.length} items:\n${lines.join('\n')}`;
  } catch (err) {
    return `Error querying board: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function executeCreateTask(
  input: Record<string, unknown>,
  ctx: ToolContext,
  createdTasks: CreatedTask[],
): Promise<string> {
  try {
    const title = String(input.title);
    const columnName = input.done ? 'Done' : (input.column ? String(input.column) : 'To Do');
    const status = input.done ? 'DONE' : 'OPEN';

    const taskId = queries.createTask({
      title,
      column_name: columnName,
      category: input.category ? String(input.category) : 'home',
      priority: input.priority ? Number(input.priority) : 2,
      assignee: input.assignee ? String(input.assignee) : undefined,
      deadline: input.deadline ? String(input.deadline) : undefined,
      deadline_time: input.deadline_time ? String(input.deadline_time) : undefined,
      status,
      source: 'telegram',
      telegram_msg_id: String(ctx.messageId),
      subtasks: input.subtasks as string[] | undefined,
    });

    createdTasks.push({ taskId, title, columnName });

    let result = `Created: "${title}" (ID:${taskId.slice(0, 8)})`;
    if (columnName) result += ` in ${columnName}`;
    if (input.category) result += ` [${input.category}]`;
    if (input.assignee) result += `, assigned to ${input.assignee}`;
    if (input.deadline) result += `, due ${input.deadline}`;
    if (input.done) result += ' (marked done)';
    return result;
  } catch (err) {
    return `Error creating task: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function executeUpdateTask(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  try {
    const idPrefix = String(input.item_id);
    const task = queries.findTaskByIdPrefix(idPrefix, ctx.replyMsgId);
    if (!task) return `No task found matching ID "${idPrefix}".`;

    const updates: Record<string, unknown> = {};

    if (input.title) updates.title = String(input.title);
    if (input.assignee) updates.assignee = String(input.assignee);
    if (input.deadline) updates.deadline = String(input.deadline);
    if (input.deadline_time) updates.deadline_time = String(input.deadline_time);
    if (input.column) updates.column_name = String(input.column);
    if (input.category) updates.category = String(input.category);
    if (input.priority) updates.priority = Number(input.priority);

    queries.updateTask(task.id, updates);

    return `Updated "${task.title}": ${Object.keys(updates).join(', ')} changed.`;
  } catch (err) {
    return `Error updating task: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function executeMarkDone(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  try {
    const ids = (input.item_ids as string[]) || [];
    const results: string[] = [];

    for (const idPrefix of ids) {
      const task = queries.findTaskByIdPrefix(idPrefix, ctx.replyMsgId);
      if (!task) {
        results.push(`ID "${idPrefix}": not found`);
        continue;
      }
      queries.markDone([task.id]);
      results.push(`"${task.title}": marked done`);
    }

    return results.join('\n');
  } catch (err) {
    return `Error marking done: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function executeDeleteTask(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  try {
    const idPrefix = String(input.item_id);
    const task = queries.findTaskByIdPrefix(idPrefix, ctx.replyMsgId);
    if (!task) return `No task found matching ID "${idPrefix}".`;

    queries.deleteTask(task.id);
    return `Deleted: "${task.title}"`;
  } catch (err) {
    return `Error deleting task: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Lunch tools ─────────────────────────────────────────────────────────────

async function executeGetMenu(input: Record<string, unknown>): Promise<string> {
  try {
    const weekOf = getCurrentWeekOf();
    const day = input.day ? String(input.day) : undefined;
    const rows = getMenuForWeek(weekOf, day);

    if (rows.length === 0) {
      return day
        ? `No menu items found for ${day} (week of ${weekOf}). Try /refresh to scrape.`
        : `No menu data for this week (${weekOf}). Try /refresh to scrape.`;
    }

    return formatMenu(rows, day);
  } catch (err) {
    return `Error fetching menu: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function executeGetRecommendations(input: Record<string, unknown>): Promise<string> {
  try {
    const weekOf = getCurrentWeekOf();
    const day = input.day ? String(input.day) : undefined;
    const recs = getRecommendationsForWeek(weekOf, day);

    if (recs.length === 0) {
      return day
        ? `No recommendations for ${day} (week of ${weekOf}). Try /refresh to analyze.`
        : `No recommendations for this week (${weekOf}). Try /refresh to scrape and analyze.`;
    }

    const messages = formatRecommendations(recs, weekOf);
    return messages.join('\n\n');
  } catch (err) {
    return `Error fetching recommendations: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function executeRefreshMenu(input: Record<string, unknown>): Promise<string> {
  try {
    const force = input.force === true;
    const reanalyze = input.reanalyze === true;
    const weekOf = getCurrentWeekOf();
    const budget = Number(process.env.DAILY_BUDGET) || 20;

    const log = {
      info: (msg: string) => console.log(`[lunch] ${msg}`),
      warn: (msg: string) => console.warn(`[lunch] ${msg}`),
    };

    // Check cache
    const existingMenu = getMenuForWeek(weekOf);

    if (existingMenu.length > 0 && !force) {
      if (reanalyze) {
        // Re-analyze cached menu
        const items = dbMenuToAnalysisFormat(existingMenu);
        const recs = await analyzeMenu(items, budget);
        storeRecommendations(weekOf, recs as unknown as Array<Record<string, unknown>>);
        return `Re-analyzed ${existingMenu.length} cached menu items. Generated ${recs.length} recommendations.`;
      }

      // Check if recommendations already exist
      const existingRecs = getRecommendationsForWeek(weekOf);
      if (existingRecs.length > 0) {
        return `Menu already scraped (${existingMenu.length} items) and analyzed (${existingRecs.length} recommendations) for week of ${weekOf}. Use force=true to re-scrape or reanalyze=true to re-run analysis.`;
      }

      // Menu cached but not analyzed -- run analysis
      const items = dbMenuToAnalysisFormat(existingMenu);
      const recs = await analyzeMenu(items, budget);
      storeRecommendations(weekOf, recs as unknown as Array<Record<string, unknown>>);
      return `Analyzed ${existingMenu.length} cached menu items. Generated ${recs.length} recommendations.`;
    }

    // Full scrape + analyze
    const result = await scrapeMenu(log);
    if (!result || result.items.length === 0) {
      logScrape(weekOf, 'empty', 0);
      return 'Menu scrape returned no items. The menu may not be posted yet.';
    }

    storeMenuItems(result.weekOf, result.items);
    logScrape(result.weekOf, 'success', result.items.length);

    const recs = await analyzeMenu(result.items, budget);
    storeRecommendations(result.weekOf, recs as unknown as Array<Record<string, unknown>>);

    return `Scraped ${result.items.length} menu items and generated ${recs.length} recommendations for week of ${result.weekOf}.`;
  } catch (err) {
    const weekOf = getCurrentWeekOf();
    logScrape(weekOf, 'error', 0, (err as Error).message);
    return `Error refreshing menu: ${err instanceof Error ? err.message : String(err)}`;
  }
}
