/**
 * MockAdapter — full PlatformAdapter implementation backed by in-memory state.
 *
 * Tests drive the bot by calling `mock.inject(...)` to deliver a message
 * to the registered handler, then read `mock.sent`, `mock.edits`, etc. to
 * assert what the bot sent back.
 *
 * Tests for skills that touch the framework can use this without spinning
 * up real Telegram + Anthropic. Brain calls inside the runtime still need
 * Anthropic mocking separately (vi.mock or fixture responses).
 */

import type {
  CallbackHandler,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  PlatformAdapter,
} from '../adapter.js';

interface SentMessage extends OutgoingMessage {
  /** Synthesized message ID; deterministic across runs for snapshot tests. */
  messageId: string;
}

interface EditRecord {
  messageId: string;
  chatId: string;
  patch: Partial<OutgoingMessage>;
}

interface ReactionRecord {
  chatId: string;
  messageId: string;
  emoji?: string;
}

interface DeleteRecord {
  chatId: string;
  messageId: string;
}

interface ChatActionRecord {
  chatId: string;
  action: string;
}

export interface MockAdapterOptions {
  /** Synthesized bot info returned by getBotInfo(). */
  botInfo?: { id: string; username?: string };
  /** Pre-seeded file-id → Buffer mapping for downloadFile(). */
  files?: Record<string, Buffer>;
}

export class MockAdapter implements PlatformAdapter {
  readonly platform = 'mock';
  readonly sent: SentMessage[] = [];
  readonly edits: EditRecord[] = [];
  readonly reactions: ReactionRecord[] = [];
  readonly deletes: DeleteRecord[] = [];
  readonly chatActions: ChatActionRecord[] = [];

  private messageHandler?: MessageHandler;
  private callbackHandler?: CallbackHandler;
  private groupJoinHandler?: (chatId: string, title: string) => void;
  private started = false;
  private msgCounter = 0;
  private files: Record<string, Buffer>;
  private botInfo: { id: string; username?: string };

  constructor(opts: MockAdapterOptions = {}) {
    this.botInfo = opts.botInfo ?? { id: '1', username: 'mockbot' };
    this.files = opts.files ?? {};
  }

  // ─── PlatformAdapter surface ──────────────────────────────────────────────

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  isConnected(): boolean {
    return this.started;
  }

  onMessage(handler: MessageHandler): void {
    if (this.messageHandler) throw new Error('MockAdapter.onMessage already registered');
    this.messageHandler = handler;
  }

  onCallback(handler: CallbackHandler): void {
    if (this.callbackHandler) throw new Error('MockAdapter.onCallback already registered');
    this.callbackHandler = handler;
  }

  onGroupJoin(handler: (chatId: string, title: string) => void): void {
    this.groupJoinHandler = handler;
  }

  async send(message: OutgoingMessage): Promise<string | undefined> {
    this.msgCounter += 1;
    const messageId = `mock-msg-${this.msgCounter}`;
    this.sent.push({ ...message, messageId });
    return messageId;
  }

  async edit(messageId: string, chatId: string, message: Partial<OutgoingMessage>): Promise<void> {
    this.edits.push({ messageId, chatId, patch: message });
  }

  async delete(messageId: string, chatId: string): Promise<void> {
    this.deletes.push({ chatId, messageId });
  }

  async setMessageReaction(chatId: string, messageId: string, emoji?: string): Promise<void> {
    this.reactions.push({ chatId, messageId, emoji });
  }

  async sendChatAction(chatId: string, action: string): Promise<void> {
    this.chatActions.push({ chatId, action });
  }

  async downloadFile(fileId: string): Promise<Buffer> {
    const buf = this.files[fileId];
    if (!buf) throw new Error(`MockAdapter: no fixture for fileId=${fileId}`);
    return buf;
  }

  async getBotInfo(): Promise<{ id: string; username?: string }> {
    return this.botInfo;
  }

  // ─── Test helpers ─────────────────────────────────────────────────────────

  /**
   * Synthesize a complete IncomingMessage from a partial and route it to the
   * registered message handler. Returns the resolved message so tests can
   * assert on it after dispatch.
   */
  async inject(partial: Partial<IncomingMessage>): Promise<IncomingMessage> {
    const msg: IncomingMessage = {
      id: partial.id ?? `inject-${++this.msgCounter}`,
      chatId: partial.chatId ?? 'chat-1',
      userId: partial.userId ?? 'user-1',
      userName: partial.userName,
      text: partial.text,
      type: partial.type ?? 'text',
      raw: partial.raw,
      file: partial.file,
      callbackData: partial.callbackData,
      isGroup: partial.isGroup,
      timestamp: partial.timestamp ?? new Date(),
      replyToMessageId: partial.replyToMessageId,
      replyToText: partial.replyToText,
      replyToUserId: partial.replyToUserId,
      replyToIsBot: partial.replyToIsBot,
      isForwarded: partial.isForwarded,
      threadId: partial.threadId,
    };
    if (!this.messageHandler) throw new Error('MockAdapter.inject: no onMessage handler registered yet');
    await this.messageHandler(msg);
    return msg;
  }

  /** Route an inline-keyboard callback to the registered callback handler. */
  async injectCallback(partial: Partial<IncomingMessage> & { callbackData: string }): Promise<IncomingMessage> {
    const cb: IncomingMessage = {
      id: partial.id ?? `cb-${++this.msgCounter}`,
      chatId: partial.chatId ?? 'chat-1',
      userId: partial.userId ?? 'user-1',
      userName: partial.userName,
      type: 'callback',
      callbackData: partial.callbackData,
      timestamp: partial.timestamp ?? new Date(),
      isGroup: partial.isGroup,
    };
    if (!this.callbackHandler) throw new Error('MockAdapter.injectCallback: no onCallback handler registered yet');
    await this.callbackHandler(cb);
    return cb;
  }

  /** Synthesize a bot-added-to-group event. */
  fireGroupJoin(chatId: string, title: string): void {
    if (!this.groupJoinHandler) return;
    this.groupJoinHandler(chatId, title);
  }

  /** Reset all captured logs without disposing handlers. */
  clear(): void {
    this.sent.length = 0;
    this.edits.length = 0;
    this.reactions.length = 0;
    this.deletes.length = 0;
    this.chatActions.length = 0;
    this.msgCounter = 0;
  }
}
