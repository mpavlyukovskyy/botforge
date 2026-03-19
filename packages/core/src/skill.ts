/**
 * Skill Interface — composable capabilities loaded from YAML config
 */

import type { BotConfig } from './schema.js';
import type { PlatformAdapter } from './adapter.js';

export interface SkillContext {
  config: BotConfig;
  adapter: PlatformAdapter;
  /** Log function scoped to the bot */
  log: Logger;
  /** SQLite database (if storage is enabled) */
  db?: unknown;
  /** Reference to other loaded skills */
  skills: Map<string, Skill>;
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
 * Create a simple console logger with bot name prefix.
 */
export function createLogger(botName: string): Logger {
  const prefix = `[${botName}]`;
  const timestamp = () => new Date().toISOString();

  return {
    debug(message, ...args) {
      console.debug(`${timestamp()} ${prefix} DEBUG: ${message}`, ...args);
    },
    info(message, ...args) {
      console.info(`${timestamp()} ${prefix} INFO: ${message}`, ...args);
    },
    warn(message, ...args) {
      console.warn(`${timestamp()} ${prefix} WARN: ${message}`, ...args);
    },
    error(message, ...args) {
      console.error(`${timestamp()} ${prefix} ERROR: ${message}`, ...args);
    },
  };
}
