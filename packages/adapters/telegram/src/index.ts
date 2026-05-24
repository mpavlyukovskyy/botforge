/**
 * Telegram Adapter — wraps node-telegram-bot-api behind PlatformAdapter interface
 */

import TelegramBot from 'node-telegram-bot-api';
import { readFileSync } from 'fs';
import {
  mintTelegramRequestId,
  runWithRequestContext,
  type PlatformAdapter,
  type IncomingMessage,
  type OutgoingMessage,
  type MessageHandler,
  type CallbackHandler,
  type BotConfig,
  type TelegramPlatform,
  type Logger,
} from '@botforge/core';
import {
  createState,
  onPollingError,
  onSuccessfulPoll,
  setPaused,
  type ResilienceState,
} from './polling-resilience.js';

/**
 * Minimal interface implemented by the @botforge/skill-telegram-inbox skill.
 * Defined here (not imported) so the adapter doesn't depend on the skill.
 */
export interface InboxAPI {
  acquireForProcessing(
    updateId: number,
    kind: string,
    chatId: string | null,
    rawJson: string,
  ): { action: 'process' } | { action: 'skip'; reason: string };
  markDone(updateId: number): void;
  markFailed(updateId: number, error: string): void;
}

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
  private pollingResilience: ResilienceState = createState();
  private inbox?: InboxAPI;
  private origProcessUpdate?: (update: unknown) => void;

  constructor(botConfig: BotConfig, log: Logger) {
    const platform = botConfig.platform;
    if (platform.type !== 'telegram') {
      throw new Error(`TelegramAdapter requires platform.type === 'telegram', got '${platform.type}'`);
    }
    this.config = platform;
    this.log = log;

    const options: TelegramBot.ConstructorOptions = {
      polling: this.config.mode === 'polling',
    };

    // If using local Bot API server
    if (this.config.local_bot_api) {
      options.baseApiUrl = this.config.local_bot_api;
    }

    this.bot = new TelegramBot(this.config.token, options);
  }

  /**
   * Inject a durable inbox so polled updates survive a process crash mid-handler.
   * Called by the @botforge/skill-telegram-inbox skill during init.
   *
   * Patches node-telegram-bot-api's processUpdate to write each update to
   * SQLite BEFORE dispatching to user handlers. On restart the library
   * resumes from offset=0; Telegram replays the last 24h and the inbox's
   * acquireForProcessing skips already-done updates.
   */
  setInbox(inbox: InboxAPI): void {
    if (this.inbox) {
      this.log.warn('TelegramAdapter.setInbox called twice; ignoring second call');
      return;
    }
    this.inbox = inbox;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.origProcessUpdate = (this.bot as any).processUpdate.bind(this.bot);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.bot as any).processUpdate = (update: any) => {
      try {
        const updateId: number | undefined = update?.update_id;
        if (typeof updateId !== 'number') {
          return this.origProcessUpdate!(update);
        }
        const kind = update.message ? 'message'
          : update.callback_query ? 'callback_query'
          : update.edited_message ? 'edited_message'
          : 'other';
        const chatId: string | null =
          update.message?.chat?.id?.toString() ??
          update.callback_query?.message?.chat?.id?.toString() ??
          update.edited_message?.chat?.id?.toString() ??
          null;

        const result = inbox.acquireForProcessing(updateId, kind, chatId, JSON.stringify(update));
        if (result.action === 'skip') {
          this.log.debug(`inbox: skip update ${updateId} (${result.reason})`);
          return;
        }
        // Attach updateId so the handlers below can mark done/failed.
        if (update.message) update.message._updateId = updateId;
        if (update.callback_query) update.callback_query._updateId = updateId;
        if (update.edited_message) update.edited_message._updateId = updateId;
        return this.origProcessUpdate!(update);
      } catch (err) {
        this.log.error(`inbox processUpdate interceptor error: ${err}`);
        // Degrade to at-most-once rather than zero delivery.
        return this.origProcessUpdate!(update);
      }
    };
  }

  async start(): Promise<void> {
    // Wire up message listener
    this.bot.on('message', async (msg) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updateId: number | undefined = (msg as any)._updateId;
      const incoming = this.convertMessage(msg);
      if (!incoming) {
        if (updateId !== undefined) this.inbox?.markDone(updateId);
        return;
      }

      // Filter by allowed chat IDs
      if (this.config.chat_ids?.length) {
        const chatStr = String(msg.chat.id);
        if (!this.config.chat_ids.includes(chatStr) && !this.dynamicChatIds.has(chatStr)) {
          this.log.debug(`Ignoring message from unauthorized chat ${msg.chat.id}`);
          if (updateId !== undefined) this.inbox?.markDone(updateId);
          return;
        }
      }

      if (this.messageHandler) {
        const requestId = mintTelegramRequestId(incoming.chatId, updateId ?? msg.message_id);
        await runWithRequestContext(
          { request_id: requestId, chat_id: incoming.chatId, user_id: incoming.userId },
          async () => {
            try {
              await this.messageHandler!(incoming);
              if (updateId !== undefined) this.inbox?.markDone(updateId);
            } catch (err) {
              this.log.error(`Message handler error: ${err}`);
              if (updateId !== undefined) this.inbox?.markFailed(updateId, String(err));
            }
          },
        );
      } else if (updateId !== undefined) {
        // No handler — there's nothing more we can do; treat as done so the
        // inbox doesn't retry forever.
        this.inbox?.markDone(updateId);
      }
    });

    // Wire up callback query listener
    this.bot.on('callback_query', async (query) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updateId: number | undefined = (query as any)._updateId;
      const incoming = this.convertCallback(query);
      if (!incoming) {
        if (updateId !== undefined) this.inbox?.markDone(updateId);
        return;
      }

      // Filter by allowed chat IDs (same whitelist as messages)
      if (this.config.chat_ids?.length) {
        const chatStr = incoming.chatId;
        if (!this.config.chat_ids.includes(chatStr) && !this.dynamicChatIds.has(chatStr)) {
          this.log.debug(`Ignoring callback from unauthorized chat ${chatStr}`);
          this.bot.answerCallbackQuery(query.id).catch(() => {});
          if (updateId !== undefined) this.inbox?.markDone(updateId);
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

      let handlerError: unknown;
      if (this.callbackHandler) {
        const requestId = mintTelegramRequestId(incoming.chatId, updateId ?? query.id);
        await runWithRequestContext(
          { request_id: requestId, chat_id: incoming.chatId, user_id: incoming.userId },
          async () => {
            try {
              await this.callbackHandler!(incoming);
            } catch (err) {
              this.log.error(`Callback handler error: ${err}`);
              handlerError = err;
            }
          },
        );
      }

      clearTimeout(fallbackTimer);
      // If handler finished without answering, answer now
      if (!answered) {
        answered = true;
        this.bot.answerCallbackQuery(query.id).catch(() => {});
      }

      if (updateId !== undefined) {
        if (handlerError) this.inbox?.markFailed(updateId, String(handlerError));
        else this.inbox?.markDone(updateId);
      }
    });

    this.bot.on('polling_error', (err) => {
      this.log.error(`Polling error: ${err.message}`);
      this.handlePollingError(err);
    });

    // A successful update means polling is working — reset any escalation.
    this.bot.on('message', () => onSuccessfulPoll(this.pollingResilience));
    this.bot.on('callback_query', () => onSuccessfulPoll(this.pollingResilience));

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

  private async handlePollingError(err: unknown): Promise<void> {
    const decision = onPollingError(this.pollingResilience, err);
    switch (decision.action) {
      case 'noop':
      case 'log_only':
        return;
      case 'exit_fatal':
        this.log.error('Polling error is fatal (auth/permission) — exiting for operator intervention');
        process.exit(1);
        return;
      case 'exit_watchdog':
        this.log.error(
          `Polling-error watchdog tripped: ${decision.recentErrorCount} errors in ${this.pollingResilience.watchdogWindowMs}ms — exiting for systemd restart`,
        );
        process.exit(1);
        return;
      case 'backoff':
        await this.pausePolling(decision.ms, decision.level);
        return;
    }
  }

  private async pausePolling(ms: number, level: number): Promise<void> {
    setPaused(this.pollingResilience, true);
    this.log.warn(`Transient polling error; pausing polling for ${ms}ms (escalation level ${level})`);
    try {
      // node-telegram-bot-api keeps internal state for stop/start. Awaiting both
      // makes sure we don't race a second pause window against ourselves.
      await this.bot.stopPolling();
      await new Promise((r) => setTimeout(r, ms));
      await this.bot.startPolling();
      this.log.info(`Polling resumed after ${ms}ms pause`);
    } catch (err) {
      this.log.error(`Failed to restart polling after backoff: ${err}`);
      process.exit(1);
    } finally {
      setPaused(this.pollingResilience, false);
    }
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
