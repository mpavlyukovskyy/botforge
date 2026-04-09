import TelegramBot from 'node-telegram-bot-api';
import { getConfig, getAllowedChatIds } from '../config.js';
import * as queries from '../db/queries.js';
import { getCurrentWeekOf, getMenuForWeek, getRecommendationsForWeek, dbMenuToAnalysisFormat, storeMenuItems, storeRecommendations, logScrape } from '../lunch/index.js';
import { scrapeMenu } from '../lunch/scraper.js';
import { analyzeMenu } from '../lunch/analysis.js';
import { formatRecommendations } from '../lunch/formatter.js';

// Passive detection toggle (per chat, in-memory)
const passiveEnabled = new Map<string, boolean>();

export function isPassiveEnabled(chatId: string): boolean {
  return passiveEnabled.get(chatId) === true;
}

function isAuthorized(msg: TelegramBot.Message): boolean {
  const allowed = getAllowedChatIds();
  const chatId = String(msg.chat.id);
  if (!allowed.includes(chatId)) {
    console.log(`[commands] Rejected chat ${chatId} (${msg.chat.title || msg.chat.type})`);
    return false;
  }
  return true;
}

export function registerCommands(bot: TelegramBot): void {
  bot.onText(/\/status/, async (msg) => {
    await handleStatus(bot, msg);
  });

  bot.onText(/\/filter(?:\s+(.+))?/, async (msg, match) => {
    await handleFilter(bot, msg, match?.[1]?.trim());
  });

  bot.onText(/\/done/, async (msg) => {
    await handleDone(bot, msg);
  });

  bot.onText(/\/help/, async (msg) => {
    await handleHelp(bot, msg);
  });

  bot.onText(/\/passive(?:\s+(on|off))?/, async (msg, match) => {
    await handlePassive(bot, msg, match?.[1]?.trim());
  });

  bot.onText(/\/home/, async (msg) => {
    await handleCategoryFilter(bot, msg, 'home');
  });

  bot.onText(/\/work/, async (msg) => {
    await handleCategoryFilter(bot, msg, 'professional');
  });

  bot.onText(/\/settings/, async (msg) => {
    await handleSettings(bot, msg);
  });

  bot.onText(/\/refresh(?:\s+(.+))?/, async (msg, match) => {
    await handleRefresh(bot, msg, match?.[1]?.trim());
  });
}

async function handleStatus(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;

  const tasks = queries.getOpenTasks();
  if (tasks.length === 0) {
    await bot.sendMessage(chatId, 'No open items. Clean slate.');
    return;
  }

  // Group by category then column
  const grouped = new Map<string, Map<string, typeof tasks>>();
  for (const task of tasks) {
    const cat = task.category || 'home';
    if (!grouped.has(cat)) grouped.set(cat, new Map());
    const catMap = grouped.get(cat)!;
    const col = task.column_name || 'To Do';
    if (!catMap.has(col)) catMap.set(col, []);
    catMap.get(col)!.push(task);
  }

  const stats = queries.getTaskStats();
  const lines = ['*Board Status*\n'];

  for (const [cat, columns] of grouped) {
    lines.push(`*${cat.charAt(0).toUpperCase() + cat.slice(1)}*`);
    for (const [colName, colTasks] of columns) {
      lines.push(`  *${colName}* (${colTasks.length}):`);
      const shown = colTasks.slice(0, 5);
      for (let i = 0; i < shown.length; i++) {
        const task = shown[i];
        const deadline = task.deadline ? ` (${task.deadline})` : '';
        const priority = task.priority === 1 ? ' !' : '';
        lines.push(`    ${i + 1}. ${task.title}${deadline}${priority}`);
      }
      if (colTasks.length > 5) {
        lines.push(`    ...and ${colTasks.length - 5} more`);
      }
    }
    lines.push('');
  }

  if (stats.overdue > 0) lines.push(`Overdue: ${stats.overdue}`);
  lines.push(`Total: ${stats.open} open`);

  let text = lines.join('\n');
  if (text.length > 3800) {
    text = text.slice(0, 3800) + '\n\n...truncated';
  }

  await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

async function handleFilter(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  columnQuery?: string,
): Promise<void> {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;

  if (!columnQuery) {
    await bot.sendMessage(chatId, 'Usage: /filter <column>\n\nAvailable:\n  To Do\n  In Progress\n  Done');
    return;
  }

  // Fuzzy match column names
  const columns = ['To Do', 'In Progress', 'Done'];
  const matched = columns.find(c => c.toLowerCase().includes(columnQuery.toLowerCase()));
  if (!matched) {
    await bot.sendMessage(chatId, `No column matching "${columnQuery}". Try: To Do, In Progress, Done`);
    return;
  }

  const tasks = queries.getTasksByColumn(matched);
  if (tasks.length === 0) {
    await bot.sendMessage(chatId, `No open items in ${matched}.`);
    return;
  }

  const lines = [`*${matched}*\n`];
  for (const task of tasks.slice(0, 20)) {
    const deadline = task.deadline ? ` (${task.deadline})` : '';
    const cat = task.category ? ` [${task.category}]` : '';
    lines.push(`- ${task.title}${deadline}${cat}`);
  }
  if (tasks.length > 20) {
    lines.push(`\n...and ${tasks.length - 20} more`);
  }

  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
}

async function handleDone(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;

  const tasks = queries.getOpenTasks();
  if (tasks.length === 0) {
    await bot.sendMessage(chatId, 'No open items to mark done.');
    return;
  }

  const keyboard = tasks.slice(0, 10).map((task) => [
    {
      text: `${task.title}${task.deadline ? ` (${task.deadline})` : ''}`,
      callback_data: `d:${task.id.slice(0, 8)}`,
    },
  ]);

  await bot.sendMessage(chatId, 'Tap to mark done:', {
    reply_markup: { inline_keyboard: keyboard },
  });
}

async function handleHelp(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const config = getConfig();
  const text = `*${config.BOT_NAME} — Personal Task Assistant*

Just talk to me naturally! Examples:
- "Buy groceries tomorrow"
- "Submit the report by Friday"
- "What's on my plate?"
- "Mark the groceries done"
- "Which tasks are overdue?"
- Reply to a numbered list → "mark 3 done"

Commands:
/status — Board overview
/home — Home tasks only
/work — Professional tasks only
/filter <column> — Items in a column
/done — Mark items complete
/passive on|off — Toggle passive detection
/settings — Bot settings
/help — This message`;

  await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
}

async function handlePassive(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  toggle?: string,
): Promise<void> {
  if (!isAuthorized(msg)) return;
  const chatId = String(msg.chat.id);

  if (!toggle) {
    const current = isPassiveEnabled(chatId);
    await bot.sendMessage(msg.chat.id, `Passive detection is ${current ? 'on' : 'off'}.`);
    return;
  }

  passiveEnabled.set(chatId, toggle === 'on');
  await bot.sendMessage(msg.chat.id, `Passive detection ${toggle}.`);
}

async function handleCategoryFilter(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  category: string,
): Promise<void> {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;

  const tasks = queries.getOpenTasks(category);
  if (tasks.length === 0) {
    await bot.sendMessage(chatId, `No open ${category} tasks.`);
    return;
  }

  const label = category.charAt(0).toUpperCase() + category.slice(1);
  const grouped = new Map<string, typeof tasks>();
  for (const task of tasks) {
    const col = task.column_name || 'To Do';
    if (!grouped.has(col)) grouped.set(col, []);
    grouped.get(col)!.push(task);
  }

  const lines = [`*${label} Tasks*\n`];
  for (const [colName, colTasks] of grouped) {
    lines.push(`*${colName}* (${colTasks.length}):`);
    for (const task of colTasks.slice(0, 10)) {
      const deadline = task.deadline ? ` (${task.deadline})` : '';
      const priority = task.priority === 1 ? ' !' : '';
      lines.push(`  - ${task.title}${deadline}${priority}`);
    }
  }

  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
}

async function handleSettings(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  if (!isAuthorized(msg)) return;
  const config = getConfig();
  const stats = queries.getTaskStats();

  const text = `*Settings*

Bot: ${config.BOT_NAME}
Timezone: ${config.TIMEZONE}
Passive detection: ${isPassiveEnabled(String(msg.chat.id)) ? 'on' : 'off'}

*Stats:*
Open: ${stats.open}
Done: ${stats.done}
Overdue: ${stats.overdue}
Home: ${stats.byCategory['home'] || 0}
Professional: ${stats.byCategory['professional'] || 0}

Dashboard: Port ${config.DASHBOARD_PORT}`;

  await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
}

async function handleRefresh(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  arg?: string,
): Promise<void> {
  if (!isAuthorized(msg)) return;
  const chatId = msg.chat.id;
  const force = arg === 'force';
  const budget = Number(process.env.DAILY_BUDGET) || 20;

  const log = {
    info: (m: string) => console.log(`[lunch] ${m}`),
    warn: (m: string) => console.warn(`[lunch] ${m}`),
  };

  await bot.sendMessage(chatId, force ? 'Force refreshing menu...' : 'Refreshing menu...');

  try {
    const weekOf = getCurrentWeekOf();
    const existingMenu = getMenuForWeek(weekOf);

    let items;
    let menuWeekOf = weekOf;

    if (existingMenu.length > 0 && !force) {
      items = dbMenuToAnalysisFormat(existingMenu);
    } else {
      const result = await scrapeMenu(log);
      if (!result || result.items.length === 0) {
        logScrape(weekOf, 'empty', 0);
        await bot.sendMessage(chatId, 'Menu scrape returned no items. The menu may not be posted yet.');
        return;
      }
      storeMenuItems(result.weekOf, result.items);
      logScrape(result.weekOf, 'success', result.items.length);
      items = result.items;
      menuWeekOf = result.weekOf;
      await bot.sendMessage(chatId, `Scraped ${items.length} items. Running analysis...`);
    }

    const recs = await analyzeMenu(items, budget);
    storeRecommendations(menuWeekOf, recs as unknown as Array<Record<string, unknown>>);

    if (recs.length === 0) {
      await bot.sendMessage(chatId, 'Analysis complete but no recommendations generated.');
      return;
    }

    // Import RecommendationRow-compatible data from DB for formatter
    const storedRecs = getRecommendationsForWeek(menuWeekOf);
    const messages = formatRecommendations(storedRecs, menuWeekOf);

    // Send to the requesting chat
    for (const message of messages) {
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    // Also send to lunch group if different from current chat
    const lunchGroupId = process.env.LUNCH_GROUP_CHAT_ID;
    if (lunchGroupId && String(chatId) !== lunchGroupId) {
      for (const message of messages) {
        await bot.sendMessage(lunchGroupId, message, { parse_mode: 'Markdown' });
      }
    }
  } catch (err) {
    console.error('[refresh] Error:', err);
    await bot.sendMessage(chatId, `Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
