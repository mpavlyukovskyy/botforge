import TelegramBot from 'node-telegram-bot-api';
import { getDb } from '../db/index.js';
import * as queries from '../db/queries.js';

const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours
const COLUMNS = ['To Do', 'In Progress', 'Done'];
const PENDING_EDIT_TTL = 5 * 60 * 1000; // 5 minutes

const pendingEdits = new Map<number, { taskId: string; userId: number; timestamp: number }>();

export function getPendingEdit(chatId: number, userId: number): string | undefined {
  const entry = pendingEdits.get(chatId);
  if (!entry) return undefined;
  if (entry.userId !== userId) return undefined;
  if (Date.now() - entry.timestamp > PENDING_EDIT_TTL) {
    pendingEdits.delete(chatId);
    return undefined;
  }
  return entry.taskId;
}

export function clearPendingEdit(chatId: number): void {
  pendingEdits.delete(chatId);
}

export function registerCallbackHandlers(bot: TelegramBot): void {
  bot.on('callback_query', async (query) => {
    if (!query.data || !query.message) {
      await bot.answerCallbackQuery(query.id);
      return;
    }

    const data = query.data;
    const msgId = query.message.message_id;
    const chatId = query.message.chat.id;
    const db = getDb();

    // Check tracking
    const tracking = db
      .prepare('SELECT task_id, acted, created_at FROM callback_tracking WHERE msg_id = ?')
      .get(msgId) as { task_id: string; acted: number; created_at: string } | undefined;

    if (tracking?.acted) {
      await bot.answerCallbackQuery(query.id, { text: 'Already handled' });
      return;
    }

    if (tracking) {
      const age = Date.now() - new Date(tracking.created_at).getTime();
      if (age > STALE_THRESHOLD_MS) {
        await bot.answerCallbackQuery(query.id, { text: 'Expired' });
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: msgId }
        );
        return;
      }
    }

    const [action, ...rest] = data.split(':');
    const taskId8 = rest[0] || '';

    const task = queries.findTaskByIdPrefix(taskId8);
    if (!task) {
      await bot.answerCallbackQuery(query.id, { text: 'Task not found' });
      return;
    }

    try {
      switch (action) {
        case 'u':
          await handleUndo(bot, query, task, chatId, msgId);
          break;
        case 'e':
          await handleEdit(bot, query, task, chatId);
          break;
        case 'c':
          await handleColumnMove(bot, query, task, chatId, msgId);
          break;
        case 'd':
          await handleDone(bot, query, task, chatId, msgId);
          break;
        case 'y':
          await handleAccept(bot, query, task, chatId, msgId);
          break;
        case 'n':
          await handleReject(bot, query, task, chatId, msgId);
          break;
        case 'cs':
          await handleColumnSelect(bot, query, task, rest, chatId, msgId);
          break;
        default:
          await bot.answerCallbackQuery(query.id, { text: 'Unknown action' });
      }
    } catch (err) {
      console.error('[callbacks] Error handling callback:', err);
      await bot.answerCallbackQuery(query.id, { text: 'Error processing action' });
    }
  });
}

async function handleUndo(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  task: queries.Task,
  chatId: number,
  msgId: number,
): Promise<void> {
  queries.deleteTask(task.id);
  markActed(msgId, task.id, 'undo');

  await bot.answerCallbackQuery(query.id, { text: 'Removed' });
  await bot.editMessageText(`~${task.title}~ — removed`, {
    chat_id: chatId,
    message_id: msgId,
    parse_mode: 'Markdown',
  });
}

async function handleEdit(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  task: queries.Task,
  chatId: number,
): Promise<void> {
  await bot.answerCallbackQuery(query.id);
  await bot.sendMessage(
    chatId,
    `Reply with the updated title for:\n"${task.title}"`,
    { reply_markup: { force_reply: true, selective: true } }
  );

  pendingEdits.set(chatId, {
    taskId: task.id,
    userId: query.from!.id,
    timestamp: Date.now(),
  });
}

async function handleColumnMove(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  task: queries.Task,
  chatId: number,
  msgId: number,
): Promise<void> {
  const keyboard = COLUMNS.map((col) => [{
    text: col,
    callback_data: `cs:${task.id.slice(0, 8)}:${col}`,
  }]);

  await bot.answerCallbackQuery(query.id);
  await bot.editMessageReplyMarkup(
    { inline_keyboard: keyboard },
    { chat_id: chatId, message_id: msgId }
  );
}

async function handleColumnSelect(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  task: queries.Task,
  rest: string[],
  chatId: number,
  msgId: number,
): Promise<void> {
  const columnName = rest.slice(1).join(':') || '';

  if (!COLUMNS.includes(columnName)) {
    await bot.answerCallbackQuery(query.id, { text: 'Column not found' });
    return;
  }

  queries.updateTask(task.id, { column_name: columnName });

  markActed(msgId, task.id, 'column_move');
  await bot.answerCallbackQuery(query.id, { text: `Moved to ${columnName}` });
  await bot.editMessageText(`${task.title} → ${columnName}`, {
    chat_id: chatId,
    message_id: msgId,
    parse_mode: 'Markdown',
  });
}

async function handleDone(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  task: queries.Task,
  chatId: number,
  msgId: number,
): Promise<void> {
  queries.markDone([task.id]);

  markActed(msgId, task.id, 'done');
  await bot.answerCallbackQuery(query.id, { text: 'Done!' });
  await bot.editMessageText(`~${task.title}~ — done`, {
    chat_id: chatId,
    message_id: msgId,
    parse_mode: 'Markdown',
  });
}

async function handleAccept(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  task: queries.Task,
  chatId: number,
  msgId: number,
): Promise<void> {
  queries.updateTask(task.id, { status: 'OPEN' });

  markActed(msgId, task.id, 'accept');
  await bot.answerCallbackQuery(query.id, { text: 'Tracked' });

  let response = `Tracking: ${task.title}`;
  if (task.column_name) response += ` → ${task.column_name}`;

  await bot.editMessageText(response, {
    chat_id: chatId,
    message_id: msgId,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Undo', callback_data: `u:${task.id.slice(0, 8)}` },
          { text: 'Edit', callback_data: `e:${task.id.slice(0, 8)}` },
          { text: 'Column', callback_data: `c:${task.id.slice(0, 8)}` },
        ],
      ],
    },
  });
}

async function handleReject(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  task: queries.Task,
  chatId: number,
  msgId: number,
): Promise<void> {
  queries.deleteTask(task.id);

  markActed(msgId, task.id, 'reject');
  await bot.answerCallbackQuery(query.id, { text: 'Skipped' });
  await bot.editMessageReplyMarkup(
    { inline_keyboard: [] },
    { chat_id: chatId, message_id: msgId }
  );
}

function markActed(msgId: number, taskId: string, actionType: string): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO callback_tracking (msg_id, task_id, acted, action_type, created_at)
     VALUES (?, ?, 1, ?, datetime('now'))`
  ).run(msgId, taskId, actionType);
}
