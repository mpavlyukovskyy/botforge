/**
 * Skill Interface — composable capabilities loaded from YAML config
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import pino, { type Logger as PinoLogger } from 'pino';
import type { BotConfig } from './schema.js';
import type { PlatformAdapter } from './adapter.js';

/**
 * Database abstraction to avoid circular dependency between core↔storage-sqlite.
 * SqliteStorage's `.db` property satisfies this interface.
 */
export interface DatabaseLike {
  run(sql: string, ...params: unknown[]): unknown;
  prepare(sql: string): unknown;
  close(): void;
}

export interface SkillContext {
  config: BotConfig;
  adapter: PlatformAdapter;
  /** Log function scoped to the bot */
  log: Logger;
  /** SQLite database (if storage is enabled) */
  db?: DatabaseLike;
  /** Reference to other loaded skills */
  skills: Map<string, Skill>;
  /** Shared key-value store for cross-module state */
  store?: import('./bot-store.js').BotStore;
}

export interface Skill {
  /** Unique skill name */
  readonly name: string;

  /** Initialize the skill */
  init(context: SkillContext): Promise<void>;

  /** Cleanup on shutdown */
  destroy?(): Promise<void>;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Per-request context propagated via AsyncLocalStorage so nested log lines
 * automatically carry the request_id without callers threading it manually.
 */
export interface RequestContext {
  request_id: string;
  chat_id?: string;
  user_id?: string;
}

const requestContextStore = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with the given RequestContext active for the duration. Any logger
 * call inside the chain (sync or async) auto-attaches the request_id.
 */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContextStore.run(ctx, fn);
}

/** Read the active RequestContext if one is set. */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStore.getStore();
}

/**
 * Mint a stable request_id for a Telegram update. Format: tg:{chat_id}:{update_id}
 * so the id is reproducible across worker restarts when replaying from the inbox.
 */
export function mintTelegramRequestId(chatId: string | undefined, updateId: number | string | undefined): string {
  return `tg:${chatId ?? 'unknown'}:${updateId ?? Date.now()}`;
}

/**
 * Create a Pino logger for the bot. JSON to stdout by default; pino-pretty
 * is recommended via LOG_FORMAT=pretty in dev (pino auto-detects piped
 * `pino-pretty` from stdout, or callers can wire it).
 *
 * Redacts common secret-bearing paths so logs are safe to forward to
 * centralized aggregators.
 */
export function createLogger(botName: string): Logger {
  const useRaw = process.env.LOG_FORMAT === 'pretty';
  const pinoLogger: PinoLogger = pino({
    name: botName,
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: [
        'password', '*.password',
        'token', '*.token',
        'apiKey', 'api_key', '*.apiKey', '*.api_key',
        'secret', '*.secret',
        'authorization', '*.authorization',
      ],
      censor: '[REDACTED]',
    },
    formatters: {
      level: (label) => ({ level: label }),
      // Mixin appends request_id to every log line when an AsyncLocalStorage
      // RequestContext is active.
      bindings: () => ({ bot: botName }),
    },
    mixin() {
      const ctx = getRequestContext();
      return ctx ? { request_id: ctx.request_id, chat_id: ctx.chat_id, user_id: ctx.user_id } : {};
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Pretty output for dev — newline-delimited human-readable text.
    transport: useRaw
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        }
      : undefined,
  });

  /** Pino takes the args list as a single object; adapt to the existing Logger surface. */
  const adapt = (level: 'debug' | 'info' | 'warn' | 'error') =>
    (message: string, ...args: unknown[]) => {
      if (args.length === 0) {
        pinoLogger[level](message);
        return;
      }
      // If the first arg is an object, treat it as structured data.
      const [first, ...rest] = args;
      if (first && typeof first === 'object' && !Array.isArray(first)) {
        if (rest.length === 0) {
          pinoLogger[level](first as Record<string, unknown>, message);
        } else {
          pinoLogger[level]({ ...(first as Record<string, unknown>), extra: rest }, message);
        }
      } else {
        pinoLogger[level]({ extra: args }, message);
      }
    };

  return {
    debug: adapt('debug'),
    info: adapt('info'),
    warn: adapt('warn'),
    error: adapt('error'),
  };
}
