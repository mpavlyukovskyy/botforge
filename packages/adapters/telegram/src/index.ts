/**
 * Telegram Adapter — wraps node-telegram-bot-api behind PlatformAdapter interface
 */

import TelegramBot from 'node-telegram-bot-api';
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

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = 'telegram';
  private bot: TelegramBot;
  private messageHandlers: MessageHandler[] = [];
  private callbackHandlers: CallbackHandler[] = [];
  private connected = false;
  private config: TelegramPlatform;
  private log: Logger;

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

  async start(): Promise<void> {
    // Wire up message listener
    this.bot.on('message', (msg) => {
      const incoming = this.convertMessage(msg);
      if (!incoming) return;

      // Filter by allowed chat IDs
      if (this.config.chat_ids?.length) {
        if (!this.config.chat_ids.includes(String(msg.chat.id))) {
          this.log.debug(`Ignoring message from unauthorized chat ${msg.chat.id}`);
          return;
        }
      }

      for (const handler of this.messageHandlers) {
        handler(incoming).catch(err => {
          this.log.error(`Message handler error: ${err}`);
        });
      }
    });

    // Wire up callback query listener
    this.bot.on('callback_query', (query) => {
      const incoming = this.convertCallback(query);
      if (!incoming) return;

      // Auto-answer callback to remove loading state
      this.bot.answerCallbackQuery(query.id).catch(() => {});

      for (const handler of this.callbackHandlers) {
        handler(incoming).catch(err => {
          this.log.error(`Callback handler error: ${err}`);
        });
      }
    });

    this.bot.on('polling_error', (err) => {
      this.log.error(`Polling error: ${err.message}`);
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

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onCallback(handler: CallbackHandler): void {
    this.callbackHandlers.push(handler);
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
    const filePath = await this.bot.getFileLink(fileId);
    const response = await fetch(filePath);
    return Buffer.from(await response.arrayBuffer());
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendChatAction(chatId: string, action: string): Promise<void> {
    await this.bot.sendChatAction(chatId, action as TelegramBot.ChatAction);
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
