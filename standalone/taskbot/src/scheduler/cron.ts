import cron from 'node-cron';
import { DateTime } from 'luxon';
import { getDb } from '../db/index.js';
import { getConfig, getAllowedChatIds } from '../config.js';
import * as queries from '../db/queries.js';
import { getBot, storeMessageRefs } from '../telegram/bot.js';
import { cleanupOldConversations } from '../telegram/conversation.js';
import { getCurrentWeekOf, getMenuForWeek, dbMenuToAnalysisFormat, storeMenuItems, storeRecommendations, getRecommendationsForWeek, logScrape } from '../lunch/index.js';
import { scrapeMenu } from '../lunch/scraper.js';
import { analyzeMenu } from '../lunch/analysis.js';
import { formatRecommendations } from '../lunch/formatter.js';

let lastOverdueCheck = DateTime.now().toISO();

export function startCronJobs(): void {
  const config = getConfig();
  const tz = config.TIMEZONE;

  // Daily digest — 8:30 AM in partner's timezone
  cron.schedule('30 8 * * *', () => {
    sendDailyDigest().catch((err) => console.error('[cron] Digest error:', err));
  }, { timezone: tz });

  // Auto-archive — 8:00 AM in partner's timezone
  cron.schedule('0 8 * * *', () => {
    autoArchive().catch((err) => console.error('[cron] Archive error:', err));
  }, { timezone: tz });

  // Overdue check — every hour
  cron.schedule('0 * * * *', () => {
    checkOverdue().catch((err) => console.error('[cron] Overdue check error:', err));
  });

  // Data cleanup — 4:00 AM in partner's timezone
  cron.schedule('0 4 * * *', () => {
    cleanupOldData().catch((err) => console.error('[cron] Cleanup error:', err));
  }, { timezone: tz });

  // Lunch scrape — Sunday 6 PM Eastern (independent of partner timezone)
  cron.schedule('0 18 * * 0', () => {
    runLunchScrape().catch((err) => console.error('[cron] Lunch scrape error:', err));
  }, { timezone: 'America/New_York' });

  console.log('[cron] All jobs scheduled');
}

async function sendDailyDigest(): Promise<void> {
  const config = getConfig();
  const bot = getBot();
  const chatId = getAllowedChatIds()[0];

  const tasks = queries.getOpenTasks();
  if (tasks.length === 0) {
    await bot.sendMessage(chatId, 'No open items. Clean slate.');
    return;
  }

  const now = DateTime.now().setZone(config.TIMEZONE);
  const endOfWeek = now.endOf('week');

  const overdue: queries.Task[] = [];
  const dueThisWeek: queries.Task[] = [];
  const byCategory = new Map<string, Map<string, queries.Task[]>>();

  for (const task of tasks) {
    if (task.deadline) {
      const dl = DateTime.fromISO(task.deadline);
      if (dl < now.startOf('day')) {
        overdue.push(task);
        continue;
      }
      if (dl <= endOfWeek) {
        dueThisWeek.push(task);
        continue;
      }
    }
    const cat = task.category || 'home';
    if (!byCategory.has(cat)) byCategory.set(cat, new Map());
    const catMap = byCategory.get(cat)!;
    const col = task.column_name || 'To Do';
    if (!catMap.has(col)) catMap.set(col, []);
    catMap.get(col)!.push(task);
  }

  const lines: string[] = ['*Daily Digest*\n'];
  let refNum = 1;
  const refMap = new Map<number, string>();

  if (overdue.length > 0) {
    lines.push('*Overdue:*');
    for (const task of overdue) {
      lines.push(`  ${refNum}. ${task.title} (${task.deadline}) [${task.category}]`);
      refMap.set(refNum, task.id);
      refNum++;
    }
    lines.push('');
  }

  if (dueThisWeek.length > 0) {
    lines.push('*Due this week:*');
    for (const task of dueThisWeek) {
      lines.push(`  ${refNum}. ${task.title} (${task.deadline}) [${task.category}]`);
      refMap.set(refNum, task.id);
      refNum++;
    }
    lines.push('');
  }

  for (const [cat, columns] of byCategory) {
    const label = cat.charAt(0).toUpperCase() + cat.slice(1);
    lines.push(`*${label}:*`);
    for (const [colName, colTasks] of columns) {
      if (columns.size > 1) lines.push(`  _${colName}:_`);
      for (const task of colTasks) {
        const dl = task.deadline ? ` (${task.deadline})` : '';
        lines.push(`  ${refNum}. ${task.title}${dl}`);
        refMap.set(refNum, task.id);
        refNum++;
      }
    }
    lines.push('');
  }

  let text = lines.join('\n');
  if (text.length > 3800) {
    text = text.slice(0, 3800) + '\n\n...truncated. Use /status for full view.';
  }

  const sentMsg = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });

  // Store refs for reply resolution
  const digestRefs: Array<{ refNum: number; taskId: string; title: string }> = [];
  for (const [num, taskId] of refMap) {
    const task = tasks.find(t => t.id === taskId);
    digestRefs.push({ refNum: num, taskId, title: task?.title || 'Unknown' });
  }
  if (digestRefs.length > 0) {
    storeMessageRefs(sentMsg.message_id, digestRefs);
  }
}

async function autoArchive(): Promise<void> {
  const config = getConfig();
  const db = getDb();
  const now = DateTime.now().setZone(config.TIMEZONE);

  // DONE tasks older than 24h → ARCHIVED
  const doneTasks = queries.getAllTasks('DONE');
  let archived = 0;
  for (const task of doneTasks) {
    const updated = DateTime.fromISO(task.updated_at);
    if (now.diff(updated, 'hours').hours > 24) {
      queries.updateTask(task.id, { status: 'ARCHIVED' });
      archived++;
    }
  }

  if (archived > 0) {
    console.log(`[cron] Auto-archived ${archived} items`);
  }
}

async function checkOverdue(): Promise<void> {
  const config = getConfig();
  const bot = getBot();

  const newlyOverdue = queries.getNewlyOverdue(lastOverdueCheck);
  lastOverdueCheck = DateTime.now().toISODate()!;

  if (newlyOverdue.length === 0) return;

  const lines = ['*Overdue Alert*\n'];
  for (const task of newlyOverdue) {
    lines.push(`- ${task.title} (was due ${task.deadline}) [${task.category}]`);
  }

  try {
    await bot.sendMessage(getAllowedChatIds()[0], lines.join('\n'), { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('[cron] Failed to send overdue alert:', err);
  }
}

async function cleanupOldData(): Promise<void> {
  const db = getDb();

  cleanupOldConversations();

  const cbResult = db
    .prepare("DELETE FROM callback_tracking WHERE created_at < datetime('now', '-2 days')")
    .run();
  if (cbResult.changes > 0) {
    console.log(`[cron] Cleaned ${cbResult.changes} stale callbacks`);
  }

  const pendResult = db
    .prepare("DELETE FROM tasks WHERE status = 'PENDING' AND created_at < datetime('now', '-2 days')")
    .run();
  if (pendResult.changes > 0) {
    console.log(`[cron] Cleaned ${pendResult.changes} unconfirmed suggestions`);
  }

  const refsResult = db
    .prepare("DELETE FROM message_refs WHERE created_at < datetime('now', '-7 days')")
    .run();
  if (refsResult.changes > 0) {
    console.log(`[cron] Cleaned ${refsResult.changes} stale message refs`);
  }
}

async function runLunchScrape(): Promise<void> {
  const bot = getBot();
  const lunchGroupId = process.env.LUNCH_GROUP_CHAT_ID;
  const budget = Number(process.env.DAILY_BUDGET) || 20;

  const log = {
    info: (msg: string) => console.log(`[lunch-cron] ${msg}`),
    warn: (msg: string) => console.warn(`[lunch-cron] ${msg}`),
  };

  try {
    console.log('[lunch-cron] Starting weekly scrape...');
    const result = await scrapeMenu(log);

    if (!result || result.items.length === 0) {
      logScrape(getCurrentWeekOf(), 'empty', 0);
      if (lunchGroupId) {
        await bot.sendMessage(lunchGroupId, 'Menu not posted yet for next week. Will retry on /refresh.');
      }
      return;
    }

    storeMenuItems(result.weekOf, result.items);
    logScrape(result.weekOf, 'success', result.items.length);
    console.log(`[lunch-cron] Scraped ${result.items.length} items for week of ${result.weekOf}`);

    const recs = await analyzeMenu(result.items, budget);
    storeRecommendations(result.weekOf, recs as unknown as Array<Record<string, unknown>>);
    console.log(`[lunch-cron] Generated ${recs.length} recommendations`);

    if (recs.length > 0 && lunchGroupId) {
      const storedRecs = getRecommendationsForWeek(result.weekOf);
      const messages = formatRecommendations(storedRecs, result.weekOf);
      for (const message of messages) {
        await bot.sendMessage(lunchGroupId, message, { parse_mode: 'Markdown' });
      }
    }
  } catch (err) {
    console.error('[lunch-cron] Error:', err);
    logScrape(getCurrentWeekOf(), 'error', 0, (err as Error).message);
    if (lunchGroupId) {
      try {
        await bot.sendMessage(lunchGroupId, `Lunch scrape failed: ${(err as Error).message}. Try /refresh later.`);
      } catch { /* ignore send failure */ }
    }
  }
}
