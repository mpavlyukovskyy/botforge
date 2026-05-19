/**
 * Telegram Adapter — wraps node-telegram-bot-api behind PlatformAdapter interface
 */

import TelegramBot from 'node-telegram-bot-api';
import { readFileSync } from 'fs';
import type {
  PlatformAdapter,
  IncomingMessage,
  OutgoingMessage,
  MessageHandler,
  CallbackHandler,
  BotConfig,
  TelegramPlatform,
  Logger,
} from '@botforge/core';

// Polling-error watchdog tuning. If we see >= MAX_ERRORS_PER_WINDOW polling
// errors within ERROR_WINDOW_MS, we exit(1) so systemd restarts the process
// with a fresh polling session. Counter resets on any successful message or
// callback. Ported from standalone kristina-bot (resilience.test.ts covers).
const ERROR_WINDOW_MS = 60_000;
const MAX_ERRORS_PER_WINDOW = 15;

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = 'telegram';
  private bot: TelegramBot;
  private messageHandler?: MessageHandler;
  private callbackHandler?: CallbackHandler;
  private connected = false;
  private config: TelegramPlatform;
  private log: Logger;
  private dynamicChatIds = new Set<string>();
  private groupJoinHandler?: (chatId: string, title: string) => void;
  private _pollingOffset = 0;
  private pollingErrors: number[] = [];
  private pollingHealthy = true;

  /** Public getter used by health-server skill to report polling state */
  isPollingHealthy(): boolean {
    return this.pollingHealthy;
  }

  constructor(botConfig: BotConfig, log: Logger) {
    const platform = botConfig.platform;
    if (platform.type !== 'telegram') {
      throw new Error(`TelegramAdapter requires platform.type === 'telegram', got '${platform.type}'`);
    }
    this.config = platform;
    this.log = log;

    const options: TelegramBot.ConstructorOptions = {
      polling: false,
    };

    // If using local Bot API server
    if (this.config.local_bot_api) {
      options.baseApiUrl = this.config.local_bot_api;
    }

    this.bot = new TelegramBot(this.config.token, options);
  }

  async start(): Promise<void> {
    // Wire up message listener
    this.bot.on('message', async (msg) => {
      const incoming = this.convertMessage(msg);
      if (!incoming) return;

      // Filter by allowed chat IDs
      if (this.config.chat_ids?.length) {
        const chatStr = String(msg.chat.id);
        if (!this.config.chat_ids.includes(chatStr) && !this.dynamicChatIds.has(chatStr)) {
          this.log.debug(`Ignoring message from unauthorized chat ${msg.chat.id}`);
          return;
        }
      }

      // Successful receive resets the polling-error sliding window
      this.pollingErrors = [];
      this.pollingHealthy = true;

      if (this.messageHandler) {
        try {
          await this.messageHandler(incoming);
        } catch (err) {
          this.log.error(`Message handler error: ${err}`);
        }
      }
    });

    // Wire up callback query listener
    this.bot.on('callback_query', async (query) => {
      const incoming = this.convertCallback(query);
      if (!incoming) return;

      // Filter by allowed chat IDs (same whitelist as messages)
      if (this.config.chat_ids?.length) {
        const chatStr = incoming.chatId;
        if (!this.config.chat_ids.includes(chatStr) && !this.dynamicChatIds.has(chatStr)) {
          this.log.debug(`Ignoring callback from unauthorized chat ${chatStr}`);
          this.bot.answerCallbackQuery(query.id).catch(() => {});
          return;
        }
      }

      // Track whether callback has been answered
      let answered = false;
      incoming.answerCallback = async (text?: string) => {
        if (answered) return;
        answered = true;
        await this.bot.answerCallbackQuery(query.id, { text }).catch(() => {});
      };

      // Fallback: auto-answer after 5s if handler hasn't answered
      const fallbackTimer = setTimeout(() => {
        if (!answered) {
          answered = true;
          this.bot.answerCallbackQuery(query.id).catch(() => {});
        }
      }, 5000);

      if (this.callbackHandler) {
        try {
          await this.callbackHandler(incoming);
        } catch (err) {
          this.log.error(`Callback handler error: ${err}`);
        }
      }

      clearTimeout(fallbackTimer);
      // If handler finished without answering, answer now
      if (!answered) {
        answered = true;
        this.bot.answerCallbackQuery(query.id).catch(() => {});
      }
    });

    this.bot.on('polling_error', (err) => {
      const now = Date.now();
      this.pollingErrors.push(now);
      // Trim entries outside the sliding window
      this.pollingErrors = this.pollingErrors.filter(t => now - t < ERROR_WINDOW_MS);
      this.log.error(`Polling error (${this.pollingErrors.length} in last ${ERROR_WINDOW_MS / 1000}s): ${err.message}`);
      if (this.pollingErrors.length >= MAX_ERRORS_PER_WINDOW) {
        this.pollingHealthy = false;
        this.log.error(`[FATAL] ${MAX_ERRORS_PER_WINDOW} polling errors in ${ERROR_WINDOW_MS / 1000}s — exiting for systemd restart`);
        process.exit(1);
      }
    });

    // Reset polling-error counter on successful callback receive too
    this.bot.on('callback_query', () => {
      this.pollingErrors = [];
      this.pollingHealthy = true;
    });

    // Auto-detect group joins/removals
    this.bot.on('my_chat_member', async (update: any) => {
      const chat = update.chat;
      const newStatus = update.new_chat_member?.status;
      if (newStatus === 'member' || newStatus === 'administrator') {
        this.log.info(`Bot added to ${chat.type} "${chat.title}" (ID: ${chat.id})`);
        this.dynamicChatIds.add(String(chat.id));
        if (this.groupJoinHandler) {
          this.groupJoinHandler(String(chat.id), chat.title || 'Unknown');
        }
      } else if (newStatus === 'left' || newStatus === 'kicked') {
        this.log.info(`Bot removed from "${chat.title}" (ID: ${chat.id})`);
        this.dynamicChatIds.delete(String(chat.id));
      }
    });

    // Track polling offset from every incoming update
    const origProcess = this.bot.processUpdate.bind(this.bot);
    this.bot.processUpdate = (update: TelegramBot.Update) => {
      this._pollingOffset = update.update_id + 1;
      origProcess(update);
    };

    // Start polling (moved from constructor to allow offset restoration)
    if (this.config.mode === 'polling') {
      // CRITICAL: TelegramBotPolling reads from bot.options.polling, NOT from
      // startPolling() args. We must set bot.options.polling directly.
      (this.bot as any).options.polling = {
        params: {
          offset: this._pollingOffset > 0 ? this._pollingOffset : 0,
          allowed_updates: ['message', 'callback_query', 'my_chat_member', 'edited_message'],
        },
      };
      if (this._pollingOffset > 0) {
        this.log.info(`Polling from saved offset ${this._pollingOffset}`);
      }
      this.bot.startPolling();
    }

    this.connected = true;
    this.log.info('Telegram adapter started (polling)');
  }

  async stop(): Promise<void> {
    if (this.config.mode === 'polling') {
      await this.bot.stopPolling();
    }
    this.connected = false;
    this.log.info('Telegram adapter stopped');
  }

  onMessage(handler: MessageHandler): void {
    if (this.messageHandler) {
      throw new Error('TelegramAdapter: onMessage handler already registered');
    }
    this.messageHandler = handler;
  }

  onGroupJoin(handler: (chatId: string, title: string) => void): void {
    this.groupJoinHandler = handler;
  }

  onCallback(handler: CallbackHandler): void {
    if (this.callbackHandler) {
      throw new Error('TelegramAdapter: onCallback handler already registered');
    }
    this.callbackHandler = handler;
  }

  async send(message: OutgoingMessage): Promise<string | undefined> {
    const chatId = message.chatId;

    if (message.photo) {
      const sent = await this.bot.sendPhoto(chatId, message.photo as string, {
        caption: message.text,
        parse_mode: message.parseMode,
        reply_markup: message.inlineKeyboard ? {
          inline_keyboard: message.inlineKeyboard.map(row =>
            row.map(btn => ({
              text: btn.text,
              callback_data: btn.callbackData,
              url: btn.url,
            }))
          ),
        } : undefined,
      });
      return String(sent.message_id);
    }

    if (message.document) {
      const sent = await this.bot.sendDocument(chatId, message.document as string, {
        caption: message.text,
        parse_mode: message.parseMode,
      }, {
        filename: message.documentName,
      });
      return String(sent.message_id);
    }

    if (message.text) {
      const opts: TelegramBot.SendMessageOptions = {
        parse_mode: message.parseMode,
        disable_web_page_preview: message.disablePreview,
      };

      if (message.replyToMessageId) {
        opts.reply_to_message_id = Number(message.replyToMessageId);
      }

      if (message.inlineKeyboard) {
        opts.reply_markup = {
          inline_keyboard: message.inlineKeyboard.map(row =>
            row.map(btn => ({
              text: btn.text,
              callback_data: btn.callbackData,
              url: btn.url,
            }))
          ),
        };
      }

      const sent = await this.bot.sendMessage(chatId, message.text, opts);
      return String(sent.message_id);
    }

    return undefined;
  }

  async edit(messageId: string, chatId: string, message: Partial<OutgoingMessage>): Promise<void> {
    if (message.text) {
      await this.bot.editMessageText(message.text, {
        chat_id: chatId,
        message_id: Number(messageId),
        parse_mode: message.parseMode,
        reply_markup: message.inlineKeyboard ? {
          inline_keyboard: message.inlineKeyboard.map(row =>
            row.map(btn => ({
              text: btn.text,
              callback_data: btn.callbackData,
              url: btn.url,
            }))
          ),
        } : undefined,
      });
    }
  }

  async delete(messageId: string, chatId: string): Promise<void> {
    await this.bot.deleteMessage(chatId, Number(messageId));
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    const fileLink = await this.bot.getFileLink(fileId);
    // Local Bot API server returns filesystem paths starting with /
    if (fileLink.startsWith('/')) {
      return readFileSync(fileLink);
    }
    const response = await fetch(fileLink);
    return Buffer.from(await response.arrayBuffer());
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendChatAction(chatId: string, action: string): Promise<void> {
    await this.bot.sendChatAction(chatId, action as TelegramBot.ChatAction);
  }

  async setMessageReaction(chatId: string, messageId: string, emoji?: string): Promise<void> {
    const reaction = emoji
      ? [{ type: 'emoji' as const, emoji }]
      : [];
    await this.bot.setMessageReaction(chatId, Number(messageId), { reaction: reaction as any });
  }

  async getBotInfo(): Promise<{ id: string; username?: string }> {
    const me = await this.bot.getMe();
    return { id: String(me.id), username: me.username };
  }

  /** Get the underlying bot instance (for platform-specific operations) */
  getRawBot(): TelegramBot {
    return this.bot;
  }

  setPollingOffset(offset: number): void {
    this._pollingOffset = offset;
  }

  getPollingOffset(): number {
    return this._pollingOffset;
  }

  private convertMessage(msg: TelegramBot.Message): IncomingMessage | null {
    let type: IncomingMessage['type'] = 'text';
    let file: IncomingMessage['file'] | undefined;

    if (msg.voice) {
      type = 'voice';
      file = {
        fileId: msg.voice.file_id,
        mimeType: msg.voice.mime_type,
        fileSize: msg.voice.file_size,
      };
    } else if (msg.audio) {
      type = 'audio';
      file = {
        fileId: msg.audio.file_id,
        fileName: (msg.audio as unknown as { file_name?: string }).file_name,
        mimeType: msg.audio.mime_type,
        fileSize: msg.audio.file_size,
      };
    } else if (msg.photo) {
      type = 'photo';
      const largest = msg.photo[msg.photo.length - 1];
      if (largest) {
        file = {
          fileId: largest.file_id,
          fileSize: largest.file_size,
        };
      }
    } else if (msg.document) {
      type = 'document';
      file = {
        fileId: msg.document.file_id,
        fileName: msg.document.file_name,
        mimeType: msg.document.mime_type,
        fileSize: msg.document.file_size,
      };
    } else if (msg.video) {
      type = 'video';
      file = {
        fileId: msg.video.file_id,
        fileName: (msg.video as unknown as { file_name?: string }).file_name,
        mimeType: msg.video.mime_type,
        fileSize: msg.video.file_size,
      };
    } else if (msg.text?.startsWith('/')) {
      type = 'command';
    }

    return {
      id: String(msg.message_id),
      chatId: String(msg.chat.id),
      userId: String(msg.from?.id ?? msg.chat.id),
      userName: msg.from?.first_name ?? msg.from?.username,
      text: msg.text ?? msg.caption,
      type,
      file,
      isGroup: msg.chat.type === 'group' || msg.chat.type === 'supergroup',
      timestamp: new Date(msg.date * 1000),
      raw: msg,
      replyToMessageId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
      replyToText: msg.reply_to_message?.text ?? msg.reply_to_message?.caption,
      replyToUserId: msg.reply_to_message?.from ? String(msg.reply_to_message.from.id) : undefined,
      replyToIsBot: msg.reply_to_message?.from?.is_bot,
      isForwarded: !!msg.forward_date,
      threadId: (msg as any).message_thread_id ? String((msg as any).message_thread_id) : undefined,
    };
  }

  private convertCallback(query: TelegramBot.CallbackQuery): IncomingMessage | null {
    if (!query.message) return null;

    return {
      id: query.id,
      chatId: String(query.message.chat.id),
      userId: String(query.from.id),
      userName: query.from.first_name ?? query.from.username,
      text: query.data,
      type: 'callback',
      callbackData: query.data,
      isGroup: query.message.chat.type === 'group' || query.message.chat.type === 'supergroup',
      timestamp: new Date(query.message.date * 1000),
      raw: query,
    };
  }
}

export function createTelegramAdapter(config: BotConfig, log: Logger): PlatformAdapter {
  return new TelegramAdapter(config, log);
}
