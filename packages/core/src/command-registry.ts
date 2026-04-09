/**
 * Command Registry — loads and dispatches slash-command handlers
 *
 * Commands are modules that export a CommandHandler with a command name,
 * description, and execute function.
 */

import type { BotConfig } from './schema.js';
import type { PlatformAdapter } from './adapter.js';
import type { Logger, DatabaseLike } from './skill.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Runtime context passed to every command handler */
export interface ModuleContext {
  chatId: string;
  userId: string;
  userName?: string;
  db?: DatabaseLike;
  config: BotConfig;
  adapter: PlatformAdapter;
  log: Logger;
  /** Shared key-value store for cross-module state */
  store: Map<string, unknown>;
  /** Attached files (e.g. photos, documents) */
  files?: Buffer[];
}

/** A single slash-command handler */
export interface CommandHandler {
  /** Command name without slash prefix, e.g. "status" */
  command: string;
  description: string;
  execute: (args: string, ctx: ModuleContext) => Promise<void>;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse raw message text into command + args.
 * Strips leading `/`, removes `@botname` suffix, splits on first space.
 */
export function parseCommand(text: string): { command: string; args: string } {
  let cleaned = text.trim();
  if (cleaned.startsWith('/')) cleaned = cleaned.slice(1);

  // Split on first space
  const spaceIdx = cleaned.indexOf(' ');
  const rawCommand = spaceIdx === -1 ? cleaned : cleaned.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : cleaned.slice(spaceIdx + 1).trim();

  // Strip @botname suffix from command
  const atIdx = rawCommand.indexOf('@');
  const command = atIdx === -1 ? rawCommand : rawCommand.slice(0, atIdx);

  return { command: command.toLowerCase(), args };
}

// ─── Registry ───────────────────────────────────────────────────────────────

export class CommandRegistry {
  private commands = new Map<string, CommandHandler>();

  register(handler: CommandHandler): void {
    if (this.commands.has(handler.command)) {
      throw new Error(`Duplicate command: "${handler.command}"`);
    }
    this.commands.set(handler.command, handler);
  }

  get(command: string): CommandHandler | undefined {
    return this.commands.get(command);
  }

  has(command: string): boolean {
    return this.commands.has(command);
  }

  /** Return all registered handlers (useful for /help generation) */
  getAll(): CommandHandler[] {
    return Array.from(this.commands.values());
  }
}
