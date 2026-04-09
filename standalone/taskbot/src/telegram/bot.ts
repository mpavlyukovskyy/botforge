import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import { getConfig, getAllowedChatIds } from '../config.js';
import { getDb } from '../db/index.js';
import * as queries from '../db/queries.js';
import {
  parseMessage,
  shouldSkipMessage,
  canMakePassiveCall,
  recordPassiveCall,
  canMakePassiveSuggestion,
  recordPassiveSuggestion,
} from '../extraction/task-parser.js';
import { registerCommands, isPassiveEnabled } from './commands.js';
import { registerCallbackHandlers, getPendingEdit, clearPendingEdit } from './callbacks.js';
import { buildContextBlock } from './context-builder.js';
import {
  addTurn,
  buildMessagesArray,
  hasActiveHistory,
  loadConversationSummary,
} from './conversation.js';
import { askClaudeWithTools, buildSystemPrompt } from '../ai/claude.js';
import { ALL_TOOLS, createToolExecutor } from '../ai/tools.js';

let bot: TelegramBot;
let botUsername: string;

const pendingPhotos = new Map<string, { buffer: Buffer; filename: string; mimeType: string; telegramFileId: string }>();

export function getBot(): TelegramBot {
  if (!bot) throw new Error('Bot not initialized');
  return bot;
}

export async function initBot(): Promise<TelegramBot> {
  const config = getConfig();

  const opts: TelegramBot.ConstructorOptions = {
    polling: true,
  };

  if (config.TELEGRAM_API_URL) {
    (opts as Record<string, unknown>).baseApiUrl = config.TELEGRAM_API_URL;
  }

  bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, opts);

  const me = await bot.getMe();
  botUsername = me.username || config.BOT_NAME;
  console.log(`[bot] Logged in as @${botUsername}`);

  registerCommands(bot);
  registerCallbackHandlers(bot);

  bot.on('message', async (msg) => {
    try {
      if (msg.photo && msg.photo.length > 0) {
        await handlePhotoMessage(msg);
        return;
      }
      if (!msg.text || msg.text.startsWith('/')) return;
      await handleMessage(msg);
    } catch (err) {
      console.error('[bot] Unhandled message error:', err);
    }
  });

  return bot;
}

export function stopBot(): void {
  if (bot) {
    bot.stopPolling();
  }
}

export function storeMessageRefs(msgId: number, refs: Array<{ refNum: number; taskId: string; title: string }>): void {
  const db = getDb();
  const stmt = db.prepare('INSERT OR REPLACE INTO message_refs (msg_id, ref_num, task_id, title) VALUES (?, ?, ?, ?)');
  for (const ref of refs) {
    stmt.run(msgId, ref.refNum, ref.taskId, ref.title);
  }
}

export function loadMessageRefs(msgId: number): Array<{ refNum: number; taskId: string; title: string }> {
  const db = getDb();
  return db.prepare('SELECT ref_num as refNum, task_id as taskId, title FROM message_refs WHERE msg_id = ? ORDER BY ref_num')
    .all(msgId) as Array<{ refNum: number; taskId: string; title: string }>;
}

// Per-chat mutex
const chatLocks = new Map<string, Promise<void>>();

async function withChatLock(chatId: string, fn: () => Promise<void>): Promise<void> {
  const prev = chatLocks.get(chatId) || Promise.resolve();
  const next = prev.then(fn, fn);
  chatLocks.set(chatId, next);
  try {
    await next;
  } finally {
    if (chatLocks.get(chatId) === next) chatLocks.delete(chatId);
  }
}

function isAuthorized(msg: TelegramBot.Message): boolean {
  const allowed = getAllowedChatIds();
  const chatId = String(msg.chat.id);
  if (!allowed.includes(chatId)) {
    console.log(`[bot] Rejected chat ${chatId} (${msg.chat.title || msg.chat.type})`);
    return false;
  }
  return true;
}

function isExplicitPhotoMessage(msg: TelegramBot.Message): boolean {
  const caption = msg.caption || '';
  if (msg.reply_to_message?.from?.username === botUsername) return true;
  if (caption.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) return true;
  // In DMs, all photos are explicit
  if (msg.chat.type === 'private') return true;
  return false;
}

async function handlePhotoMessage(msg: TelegramBot.Message): Promise<void> {
  if (!isAuthorized(msg)) return;
  if (!isExplicitPhotoMessage(msg)) return;

  const chatId = msg.chat.id;
  const userName = msg.from?.first_name || msg.from?.username || 'User';

  try {
    const photo = msg.photo![msg.photo!.length - 1];
    const fileId = photo.file_id;

    const fileObj = await bot.getFile(fileId);
    const filePath = fileObj.file_path;
    if (!filePath) throw new Error('getFile returned no file_path');

    let buffer: Buffer;
    if (filePath.startsWith('/')) {
      // Local Bot API server: file is on the filesystem
      console.log(`[bot] Reading file from local path: ${filePath}`);
      buffer = await fs.promises.readFile(filePath);
    } else {
      // Cloud API fallback: download via HTTP
      const config = getConfig();
      const baseUrl = config.TELEGRAM_API_URL || 'https://api.telegram.org';
      const fileUrl = `${baseUrl}/file/bot${config.TELEGRAM_BOT_TOKEN}/${filePath}`;
      const response = await fetch(fileUrl);
      if (!response.ok) throw new Error(`File download failed: HTTP ${response.status}`);
      buffer = Buffer.from(await response.arrayBuffer());
    }

    pendingPhotos.set(String(chatId), {
      buffer,
      filename: fileId + '.jpg',
      mimeType: 'image/jpeg',
      telegramFileId: fileId,
    });

    const text = msg.caption || 'New task with photo';
    await withChatLock(String(chatId), async () => {
      await handleExplicitNL(chatId, text, msg, userName);
    });
  } catch (err) {
    console.error('[bot] Photo handler error:', err);
  }
}

async function handleMessage(msg: TelegramBot.Message): Promise<void> {
  if (!isAuthorized(msg)) return;

  const text = msg.text || '';
  const chatId = msg.chat.id;
  const userName = msg.from?.first_name || msg.from?.username || 'User';

  // Check for pending edit response
  const pendingTaskId = getPendingEdit(chatId, msg.from?.id || 0);
  if (pendingTaskId) {
    clearPendingEdit(chatId);
    await handlePendingEditResponse(chatId, text, pendingTaskId, msg);
    return;
  }

  const isExplicit = isExplicitMessage(msg);

  if (!isExplicit) {
    // Passive detection path
    if (!isPassiveEnabled(String(chatId))) return;
    if (shouldSkipMessage(text)) return;
    if (!canMakePassiveCall()) return;

    try {
      recordPassiveCall();
      const parsed = await parseMessage(text, ['To Do', 'In Progress', 'Done'], [], false);

      if (
        parsed.intent === 'passive_detect' &&
        parsed.confidence > 0.7 &&
        parsed.title &&
        canMakePassiveSuggestion()
      ) {
        recordPassiveSuggestion();
        await handlePassiveSuggestion(chatId, parsed, msg);
      }
    } catch (err) {
      console.error('[bot] Passive detection error:', err);
    }

    return;
  }

  // Explicit message — NL agentic handler
  await withChatLock(String(chatId), async () => {
    await handleExplicitNL(chatId, text, msg, userName);
  });
}

function isExplicitMessage(msg: TelegramBot.Message): boolean {
  const text = msg.text || '';
  // DM is always explicit
  if (msg.chat.type === 'private') return true;

  // Reply to bot
  if (msg.reply_to_message?.from?.username === botUsername) return true;

  // @mention
  if (text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) return true;

  // Entities with mention type
  if (msg.entities) {
    for (const entity of msg.entities) {
      if (entity.type === 'mention') {
        const mention = text.slice(entity.offset, entity.offset + entity.length);
        if (mention.toLowerCase() === `@${botUsername.toLowerCase()}`) return true;
      }
    }
  }

  return false;
}

async function safeSendMessage(
  chatId: number,
  text: string,
  options?: TelegramBot.SendMessageOptions,
): Promise<TelegramBot.Message> {
  try {
    return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...options });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('400') || errMsg.includes("can't parse")) {
      const { parse_mode: _, ...rest } = options || {};
      return await bot.sendMessage(chatId, text, rest);
    }
    throw err;
  }
}

async function handleExplicitNL(
  chatId: number,
  text: string,
  msg: TelegramBot.Message,
  userName: string,
): Promise<void> {
  try {
    const context = buildContextBlock();

    const historySummary = !hasActiveHistory(String(chatId))
      ? loadConversationSummary(String(chatId), 20)
      : '';

    let replyContext = '';
    const replyMsg = msg.reply_to_message;
    const isReplyToBot = replyMsg?.from?.username === botUsername;
    const replyMsgId = isReplyToBot ? replyMsg!.message_id : undefined;

    if (replyMsg) {
      const quotedText = (replyMsg.text || replyMsg.caption || '').slice(0, 1500);

      if (isReplyToBot && quotedText) {
        replyContext += `<replying_to>\nThe user is replying to this ${getConfig().BOT_NAME} message:\n${quotedText}\n</replying_to>\n`;

        const refs = loadMessageRefs(replyMsgId!);
        if (refs.length > 0) {
          replyContext += `<numbered_refs>\n`;
          for (const ref of refs) {
            replyContext += `  ${ref.refNum} → ID:${ref.taskId.slice(0, 8)} "${ref.title}"\n`;
          }
          replyContext += `When user says "task 3" or "#3", use the corresponding ID.\n</numbered_refs>\n`;
        }
      } else if (!isReplyToBot && quotedText) {
        const sender = replyMsg.from?.first_name || 'Someone';
        replyContext += `<quoted_message>\nThe user is replying to this message from ${sender}:\n${quotedText}\n</quoted_message>\n`;
      }
    }

    const fullContext = historySummary + context + replyContext;
    const messages = buildMessagesArray(String(chatId), fullContext, text, userName);
    const systemPrompt = buildSystemPrompt();

    const toolCtx = { chatId, messageId: msg.message_id, userName, replyMsgId };
    const { execute, createdTasks, queriedItems } = createToolExecutor(toolCtx);

    const result = await askClaudeWithTools(messages, ALL_TOOLS, execute, {
      system: systemPrompt,
      maxTokens: 1024,
      maxIterations: 5,
    });

    // Auto-attach pending photos and URLs to created tasks
    if (createdTasks.length > 0) {
      const chatIdStr = String(chatId);

      const pendingPhoto = pendingPhotos.get(chatIdStr);
      if (pendingPhoto) {
        const imageBase64 = pendingPhoto.buffer.toString('base64');
        const db0 = getDb();
        for (const task of createdTasks) {
          db0.prepare(
            `INSERT INTO task_attachments (task_id, type, filename, mime_type, telegram_file_id, image_base64) VALUES (?, 'IMAGE', ?, ?, ?, ?)`
          ).run(task.taskId, pendingPhoto.filename, pendingPhoto.mimeType, pendingPhoto.telegramFileId, imageBase64);
        }
        pendingPhotos.delete(chatIdStr);
      }

      const { extractUrls } = await import('../extraction/url-extractor.js');
      const urls = extractUrls(text);
      if (urls.length > 0) {
        const db0 = getDb();
        for (const url of urls) {
          for (const task of createdTasks) {
            db0.prepare(
              `INSERT INTO task_attachments (task_id, type, url) VALUES (?, 'LINK', ?)`
            ).run(task.taskId, url);
          }
        }
      }
    }

    let responseText = result.text || 'Done.';
    if (responseText.length > 3900) {
      responseText = responseText.slice(0, 3900) + '\n\n...truncated';
    }

    const db = getDb();
    let sentMsgId: number | undefined;

    if (createdTasks.length === 1) {
      const task = createdTasks[0];
      const sentMsg = await safeSendMessage(chatId, responseText, {
        reply_to_message_id: msg.message_id,
        reply_markup: {
          inline_keyboard: [[
            { text: 'Undo', callback_data: `u:${task.taskId.slice(0, 8)}` },
            { text: 'Edit', callback_data: `e:${task.taskId.slice(0, 8)}` },
            { text: 'Column', callback_data: `c:${task.taskId.slice(0, 8)}` },
          ]],
        },
      });
      sentMsgId = sentMsg.message_id;
      db.prepare(
        "INSERT INTO callback_tracking (msg_id, task_id, acted, created_at) VALUES (?, ?, 0, datetime('now'))"
      ).run(sentMsg.message_id, task.taskId);
    } else if (createdTasks.length > 1) {
      for (const task of createdTasks) {
        const sentMsg = await safeSendMessage(chatId, `Added: *${task.title}*`, {
          reply_markup: {
            inline_keyboard: [[
              { text: 'Undo', callback_data: `u:${task.taskId.slice(0, 8)}` },
              { text: 'Column', callback_data: `c:${task.taskId.slice(0, 8)}` },
            ]],
          },
        });
        db.prepare(
          "INSERT INTO callback_tracking (msg_id, task_id, acted, created_at) VALUES (?, ?, 0, datetime('now'))"
        ).run(sentMsg.message_id, task.taskId);
      }
      const finalMsg = await safeSendMessage(chatId, responseText, {
        reply_to_message_id: msg.message_id,
      });
      sentMsgId = finalMsg.message_id;
    } else {
      const sentMsg = await safeSendMessage(chatId, responseText, {
        reply_to_message_id: msg.message_id,
      });
      sentMsgId = sentMsg.message_id;
    }

    // Store numbered refs
    const allRefs: Array<{ refNum: number; taskId: string; title: string }> = [];
    createdTasks.forEach((task, idx) => {
      allRefs.push({ refNum: idx + 1, taskId: task.taskId, title: task.title });
    });
    for (const qi of queriedItems) {
      allRefs.push({ refNum: qi.refNum, taskId: qi.taskId, title: qi.title });
    }
    if (allRefs.length > 0 && sentMsgId) {
      storeMessageRefs(sentMsgId, allRefs);
    }

    addTurn(String(chatId), text, result.text);
  } catch (err) {
    console.error('[bot] NL handler error:', err);
    await safeSendMessage(chatId, 'Sorry, something went wrong. Try a slash command (/status, /done, /help).', {
      reply_to_message_id: msg.message_id,
    });
  }
}

async function handlePendingEditResponse(
  chatId: number,
  newTitle: string,
  taskId: string,
  msg: TelegramBot.Message
): Promise<void> {
  const task = queries.findTaskByIdPrefix(taskId.slice(0, 8));

  if (!task) {
    await safeSendMessage(chatId, 'Task not found.');
    return;
  }

  queries.updateTask(taskId, { title: newTitle });

  const db = getDb();
  const sentMsg = await safeSendMessage(chatId, `Updated: *${newTitle}*`, {
    reply_to_message_id: msg.message_id,
    reply_markup: {
      inline_keyboard: [[
        { text: 'Undo', callback_data: `u:${taskId.slice(0, 8)}` },
        { text: 'Edit', callback_data: `e:${taskId.slice(0, 8)}` },
        { text: 'Column', callback_data: `c:${taskId.slice(0, 8)}` },
      ]],
    },
  });

  db.prepare(
    "INSERT INTO callback_tracking (msg_id, task_id, acted, created_at) VALUES (?, ?, 0, datetime('now'))"
  ).run(sentMsg.message_id, taskId);
}

async function handlePassiveSuggestion(
  chatId: number,
  parsed: Awaited<ReturnType<typeof parseMessage>>,
  msg: TelegramBot.Message,
): Promise<void> {
  const db = getDb();

  const taskId = queries.createTask({
    title: parsed.title,
    column_name: parsed.column || 'To Do',
    category: parsed.category || 'home',
    assignee: parsed.assignee || undefined,
    deadline: parsed.deadline || undefined,
    status: 'PENDING',
    source: 'passive',
    telegram_msg_id: String(msg.message_id),
  });

  const sentMsg = await bot.sendMessage(
    chatId,
    `Track this? *${parsed.title}*`,
    {
      parse_mode: 'Markdown',
      reply_to_message_id: msg.message_id,
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Yes', callback_data: `y:${taskId.slice(0, 8)}` },
            { text: 'No', callback_data: `n:${taskId.slice(0, 8)}` },
          ],
        ],
      },
    }
  );

  db.prepare(
    "INSERT INTO callback_tracking (msg_id, task_id, acted, created_at) VALUES (?, ?, 0, datetime('now'))"
  ).run(sentMsg.message_id, taskId);
}
