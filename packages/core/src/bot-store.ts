/**
 * BotStore is the cross-skill key-value store passed to skills and bot code
 * via `ctx.store`. It's a plain Map<string, unknown> so bot code can stash
 * arbitrary per-conversation state (`store.set('mode', 'goal-setting')`),
 * while framework code uses the named constants below for stronger typing.
 *
 * Naming framework keys as constants prevents typos in
 * `store.get('toolregistry')` (lowercase) from silently returning undefined
 * — the constant export makes the typo a compile error.
 */

import type { ToolRegistry } from './tool-registry.js';

export type BotStore = Map<string, unknown>;

/** Framework-owned store keys. Bot code may also use other string keys freely. */
export const STORE_KEYS = {
  /** ToolRegistry instance built during bot init. Set once, never overwritten. */
  TOOL_REGISTRY: 'toolRegistry',
  /** EventBus reference, populated after event-bus skill init. */
  EVENT_BUS: 'eventBus',
  /**
   * Per-message handler state — buttons to add to the bot's next outgoing
   * message. Set by callback/command handlers, consumed by the brain processor
   * after the LLM response renders.
   */
  POST_RESPONSE: 'postResponse',
} as const;

/** Shape of the postResponse store value when set. */
export interface PostResponseHint {
  buttons?: Array<Array<{ text: string; callbackData?: string; url?: string }>>;
}

/**
 * Typed convenience for framework code. Bot code keeps using `store.get(key)`
 * directly.
 */
export const storeAccess = {
  toolRegistry(store: BotStore): ToolRegistry | undefined {
    return store.get(STORE_KEYS.TOOL_REGISTRY) as ToolRegistry | undefined;
  },
  postResponse(store: BotStore): PostResponseHint | undefined {
    return store.get(STORE_KEYS.POST_RESPONSE) as PostResponseHint | undefined;
  },
  clearPostResponse(store: BotStore): void {
    store.delete(STORE_KEYS.POST_RESPONSE);
  },
};
