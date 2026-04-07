/**
 * Tool Registry — loads and manages bot tools, bridges to BrainTool format
 *
 * Tools are TypeScript/JavaScript modules that export a ToolImplementation.
 * The registry converts them to BrainTool[] with bound context for askBrain().
 */

import type { ZodType } from 'zod';
import type { BrainTool } from './brain.js';
import type { BotConfig } from './schema.js';
import type { PlatformAdapter } from './adapter.js';
import type { Logger, DatabaseLike } from './skill.js';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ToolPermissions {
  db?: 'read' | 'write' | 'none';
  adapter?: 'send' | 'none';
}

/**
 * Named "ToolImplementation" to avoid collision with schema.ts's "ToolDefinition" type.
 */
export interface ToolImplementation {
  name: string;
  description: string;
  /** AnyZodRawShape — plain object of Zod types, NOT z.object() */
  schema: Record<string, ZodType>;
  /** Execute the tool and return a result string */
  execute: (args: any, ctx: ToolContext) => Promise<string>;
  /** Optional permission restrictions */
  permissions?: ToolPermissions;
}

export interface ToolContext {
  chatId: string;
  userId: string;
  userName?: string;
  db?: DatabaseLike;
  config: BotConfig;
  adapter: PlatformAdapter;
  log: Logger;
  /** Shared key-value store persisted across messages on the BotInstance */
  store: Map<string, unknown>;
  /** Attached files (e.g. downloaded photos) */
  files?: Buffer[];
}

// ─── Permission Sandbox ─────────────────────────────────────────────────────

function sandboxContext(ctx: ToolContext, permissions: ToolPermissions): ToolContext {
  const sandboxed = { ...ctx };

  if (permissions.db === 'none') {
    sandboxed.db = undefined;
  } else if (permissions.db === 'read' && ctx.db) {
    sandboxed.db = new Proxy(ctx.db, {
      get(target, prop, receiver) {
        if (prop === 'run') {
          return (sql: string, ...params: unknown[]) => {
            const trimmed = sql.trim().toUpperCase();
            if (trimmed.startsWith('INSERT') || trimmed.startsWith('UPDATE') ||
                trimmed.startsWith('DELETE') || trimmed.startsWith('DROP') ||
                trimmed.startsWith('ALTER') || trimmed.startsWith('CREATE')) {
              throw new Error('Permission denied: tool has read-only database access');
            }
            return (target as any).run(sql, ...params);
          };
        }
        if (prop === 'prepare') {
          return (sql: string) => {
            const stmt = (target as any).prepare(sql);
            const trimmed = sql.trim().toUpperCase();
            const isWrite = trimmed.startsWith('INSERT') || trimmed.startsWith('UPDATE') ||
                           trimmed.startsWith('DELETE') || trimmed.startsWith('DROP') ||
                           trimmed.startsWith('ALTER') || trimmed.startsWith('CREATE');
            if (isWrite) {
              return new Proxy(stmt, {
                get(stmtTarget: any, stmtProp: string) {
                  if (stmtProp === 'run') {
                    return () => { throw new Error('Permission denied: tool has read-only database access'); };
                  }
                  return Reflect.get(stmtTarget, stmtProp);
                }
              });
            }
            return stmt;
          };
        }
        return Reflect.get(target, prop, receiver);
      }
    }) as any;
  }

  if (permissions.adapter === 'none') {
    sandboxed.adapter = new Proxy(ctx.adapter, {
      get(target, prop) {
        if (prop === 'send' || prop === 'sendMessage') {
          return () => { throw new Error('Permission denied: tool has no send access'); };
        }
        return Reflect.get(target, prop);
      }
    }) as any;
  }

  return sandboxed;
}

// ─── Registry ───────────────────────────────────────────────────────────────

export class ToolRegistry {
  private tools = new Map<string, ToolImplementation>();

  register(tool: ToolImplementation): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolImplementation | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolImplementation[] {
    return Array.from(this.tools.values());
  }

  /** Convert to BrainTool[] with bound ToolContext */
  toBrainTools(ctx: ToolContext): BrainTool[] {
    return this.getAll().map(impl => ({
      name: impl.name,
      description: impl.description,
      schema: impl.schema,
      execute: async (args: unknown) => {
        try {
          const effectiveCtx = impl.permissions ? sandboxContext(ctx, impl.permissions) : ctx;
          const result = await impl.execute(args, effectiveCtx);
          return { content: [{ type: 'text', text: result }] };
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: 'text', text: `Error: ${errorMsg}` }], isError: true };
        }
      },
    }));
  }
}

// ─── Dynamic Tool Loader ────────────────────────────────────────────────────

/**
 * Load tool modules from a directory.
 * Tries .js first (production), falls back to .ts (development with tsx).
 */
export async function loadToolsFromDir(dir: string): Promise<ToolImplementation[]> {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }

  const toolFiles = files.filter(f =>
    (f.endsWith('.js') || f.endsWith('.ts')) && !f.endsWith('.d.ts') && !f.endsWith('.test.ts')
  );

  const tools: ToolImplementation[] = [];

  for (const file of toolFiles) {
    try {
      const mod = await import(join(dir, file));
      const impl = mod.default ?? mod;

      if (impl && typeof impl === 'object' && 'name' in impl && 'execute' in impl) {
        tools.push(impl as ToolImplementation);
      }
    } catch (err) {
      // Skip files that fail to import (e.g., missing dependencies)
      console.warn(`Failed to load tool from ${file}: ${err}`);
    }
  }

  return tools;
}
