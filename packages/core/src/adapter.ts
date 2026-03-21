/**
 * Platform Adapter Interface
 *
 * Every platform (Telegram, Slack, email, web) implements this interface.
 * Bot logic never touches platform-specific APIs directly.
 */

export interface IncomingMessage {
  id: string;
  chatId: string;
  userId: string;
  userName?: string;
  text?: string;
  /** Platform-specific message type */
  type: 'text' | 'audio' | 'photo' | 'document' | 'callback' | 'command' | 'voice' | 'video';
  /** Raw platform-specific data */
  raw?: unknown;
  /** File info for media messages */
  file?: {
    fileId: string;
    fileName?: string;
    mimeType?: string;
    fileSize?: number;
  };
  /** Callback data for inline keyboards */
  callbackData?: string;
  /** Is this a group message? */
  isGroup?: boolean;
  /** Timestamp */
  timestamp: Date;
  /** Reply context — message this is replying to */
  replyToMessageId?: string;
  replyToText?: string;
  replyToUserId?: string;
  replyToIsBot?: boolean;
  /** Whether this message was forwarded */
  isForwarded?: boolean;
  /** Thread/topic ID (for supergroup topics) */
  threadId?: string;
}

export interface OutgoingMessage {
  chatId: string;
  text?: string;
  parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
  photo?: Buffer | string;
  document?: Buffer | string;
  documentName?: string;
  /** Inline keyboard buttons */
  inlineKeyboard?: InlineButton[][];
  /** Reply to a specific message */
  replyToMessageId?: string;
  /** Disable link preview */
  disablePreview?: boolean;
}

export interface InlineButton {
  text: string;
  callbackData?: string;
  url?: string;
}

export type MessageHandler = (message: IncomingMessage) => Promise<void>;
export type CallbackHandler = (callback: IncomingMessage) => Promise<void>;

export interface PlatformAdapter {
  /** Platform name */
  readonly platform: string;

  /** Start listening for messages */
  start(): Promise<void>;

  /** Stop listening (graceful shutdown) */
  stop(): Promise<void>;

  /** Register message handler */
  onMessage(handler: MessageHandler): void;

  /** Register callback query handler (inline keyboards) */
  onCallback(handler: CallbackHandler): void;

  /** Send a message */
  send(message: OutgoingMessage): Promise<string | undefined>;

  /** Edit an existing message */
  edit?(messageId: string, chatId: string, message: Partial<OutgoingMessage>): Promise<void>;

  /** Delete a message */
  delete?(messageId: string, chatId: string): Promise<void>;

  /** Download a file by ID */
  downloadFile?(fileId: string): Promise<Buffer>;

  /** Send a chat action (e.g. 'typing') — optional, gracefully degrades */
  sendChatAction?(chatId: string, action: string): Promise<void>;

  /** Get bot identity info (id + username) — optional, used for @mention detection */
  getBotInfo?(): Promise<{ id: string; username?: string }>;

  /** Is the adapter currently connected? */
  isConnected(): boolean;
}
