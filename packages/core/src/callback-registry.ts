/**
 * Callback Registry — loads and dispatches inline-keyboard callback handlers
 *
 * Callback data is split on `:` and the first segment is matched
 * against registered prefixes (e.g. "u", "d", "cs").
 */

import type { ModuleContext } from './command-registry.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** Extends ModuleContext with callback-specific fields */
export interface CallbackContext extends ModuleContext {
  messageId: string;
  answerCallback: (text?: string) => Promise<void>;
}

/** A single callback action handler */
export interface CallbackActionHandler {
  /** Prefix matched against `data.split(':')[0]`, e.g. "u", "d", "cs" */
  prefix: string;
  execute: (data: string, ctx: CallbackContext) => Promise<void>;
}

// ─── Registry ───────────────────────────────────────────────────────────────

export class CallbackRegistry {
  private handlers = new Map<string, CallbackActionHandler>();

  register(handler: CallbackActionHandler): void {
    if (this.handlers.has(handler.prefix)) {
      throw new Error(`Duplicate callback prefix: "${handler.prefix}"`);
    }
    this.handlers.set(handler.prefix, handler);
  }

  /** Match callback data against registered prefixes */
  match(data: string): CallbackActionHandler | undefined {
    const prefix = data.split(':')[0] ?? '';
    return this.handlers.get(prefix);
  }

  has(prefix: string): boolean {
    return this.handlers.has(prefix);
  }
}
