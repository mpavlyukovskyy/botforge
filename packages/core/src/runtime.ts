/**
 * BotForge Runtime — boots a bot from YAML config
 *
 * Lifecycle: loadConfig → createAdapter → deriveBotDir → loadModules → initSkills → wireBrain → start
 */

import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { loadConfig, type LoadConfigOptions } from './config.js';
import { createLogger, type Logger, type Skill, type SkillContext, type DatabaseLike } from './skill.js';
import type { PlatformAdapter, IncomingMessage } from './adapter.js';
import type { BotConfig } from './schema.js';
import { ToolRegistry, loadToolsFromDir } from './tool-registry.js';
import { loadModulesFromDir } from './module-loader.js';
import { CommandRegistry, parseCommand, type ModuleContext, type CommandHandler } from './command-registry.js';
import { CallbackRegistry, type CallbackActionHandler, type CallbackContext } from './callback-registry.js';
import { withChatLock } from './chat-lock.js';
import { shouldAllow } from './rate-limiter.js';
import { STORE_KEYS, type BotStore } from './bot-store.js';
import { loadSkills, initSkills } from './skill-loader.js';
import { shouldProcessMessage } from './reception.js';
import { createBrainProcessor, createEchoProcessor, loadSystemPrompt, buildModuleContext } from './brain-processor.js';

export type AdapterFactory = (config: BotConfig, log: Logger) => PlatformAdapter;
export type SkillFactory = (name: string) => Promise<Skill>;
export type MessageProcessor = (message: IncomingMessage, context: BotInstance) => Promise<void>;

/** Lifecycle hook loaded from bot directory */
export interface LifecycleHook {
  event: 'start' | 'stop';
  execute: (ctx: ModuleContext) => Promise<void>;
}

/** Context builder loaded from bot directory */
export interface ContextBuilder {
  type: string;
  build: (ctx: ModuleContext) => Promise<string>;
}

/** Cron handler loaded from bot directory */
export interface CronHandler {
  name: string;
  execute: (ctx: ModuleContext) => Promise<void>;
}

export interface BotInstance {
  config: BotConfig;
  adapter: PlatformAdapter;
  skills: Map<string, Skill>;
  log: Logger;
  db?: DatabaseLike;
  toolRegistry: ToolRegistry;
  commandRegistry: CommandRegistry;
  callbackRegistry: CallbackRegistry;
  /** Shared key-value store for cross-module state */
  store: BotStore;
  /** Process an incoming message through the brain */
  processMessage?: MessageProcessor;
  /** Bot's Telegram username (auto-detected or from config) */
  botUsername?: string;
  /** Bot's platform user ID (auto-detected) */
  botId?: string;
  /** Bot directory path (derived from config path) */
  botDir?: string;
  /** Lifecycle hooks */
  lifecycleHooks: LifecycleHook[];
  /** Context builders */
  contextBuilders: ContextBuilder[];
  /** Cron handlers */
  cronHandlers: CronHandler[];
}

export interface BotForgeOptions {
  /** Factory to create platform adapter from config */
  createAdapter: AdapterFactory;
  /** Factory to load skills by name */
  loadSkill?: SkillFactory;
  /** Message processor override (bypasses built-in brain wiring) */
  messageProcessor?: MessageProcessor;
  /** Config loading options */
  configOptions?: LoadConfigOptions;
  /** SQLite storage instance (if provided, used for conversation history etc.) */
  db?: DatabaseLike;
  /** Directory containing bot tool files */
  toolsDir?: string;
  /** Force echo mode — don't use brain, just echo messages */
  echo?: boolean;
}

// ─── Bot directory derivation ───────────────────────────────────────────────

function deriveBotDir(configPath: string): string | undefined {
  const resolved = resolve(configPath);
  const dirPath = resolved.replace(/\.ya?ml$/, '');
  if (existsSync(dirPath)) return dirPath;
  return undefined;
}

// ─── Module validators ──────────────────────────────────────────────────────

function validateCommandHandler(mod: unknown, _filePath: string): CommandHandler | null {
  const m = mod as any;
  if (m && typeof m === 'object' && typeof m.command === 'string' && typeof m.execute === 'function') {
    return m as CommandHandler;
  }
  return null;
}

function validateCallbackHandler(mod: unknown, _filePath: string): CallbackActionHandler | null {
  const m = mod as any;
  if (m && typeof m === 'object' && typeof m.prefix === 'string' && typeof m.execute === 'function') {
    return m as CallbackActionHandler;
  }
  return null;
}

function validateLifecycleHook(mod: unknown, _filePath: string): LifecycleHook | null {
  const m = mod as any;
  if (m && typeof m === 'object' && typeof m.event === 'string' && typeof m.execute === 'function') {
    return m as LifecycleHook;
  }
  return null;
}

function validateContextBuilder(mod: unknown, _filePath: string): ContextBuilder | null {
  const m = mod as any;
  if (m && typeof m === 'object' && typeof m.type === 'string' && typeof m.build === 'function') {
    return m as ContextBuilder;
  }
  return null;
}

function validateCronHandler(mod: unknown, _filePath: string): CronHandler | null {
  const m = mod as any;
  if (m && typeof m === 'object' && typeof m.name === 'string' && typeof m.execute === 'function') {
    return m as CronHandler;
  }
  return null;
}


// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Start a bot from a YAML config file.
 */
export async function startBot(configPath: string, options: BotForgeOptions): Promise<BotInstance> {
  // 1. Load and validate config
  const config = loadConfig(configPath, options.configOptions);
  const log = createLogger(config.name);
  const configDir = dirname(resolve(configPath));

  log.info(`Starting bot "${config.name}" v${config.version}`);
  log.info(`Platform: ${config.platform.type}`);

  // 2. Create platform adapter
  const adapter = options.createAdapter(config, log);

  // 3. Derive bot directory from config path
  const botDir = deriveBotDir(configPath);
  if (botDir) {
    log.info(`Bot directory: ${botDir}`);
  }

  // 4. Create shared store
  const store: BotStore = new Map<string, unknown>();

  // 5. Load tool registry
  const toolRegistry = new ToolRegistry();
  const toolsDir = options.toolsDir || (botDir ? join(botDir, 'tools') : undefined);
  if (toolsDir) {
    const toolImpls = await loadToolsFromDir(toolsDir);
    for (const impl of toolImpls) {
      toolRegistry.register(impl);
      log.info(`Registered tool: ${impl.name}`);
    }
  }

  // 5a. Store toolRegistry in shared store (for tool-server and other skills)
  store.set(STORE_KEYS.TOOL_REGISTRY, toolRegistry);

  // 6. Load command handlers from bot directory
  const commandRegistry = new CommandRegistry();
  if (botDir) {
    const commandsDir = join(botDir, 'commands');
    const commands = await loadModulesFromDir<CommandHandler>(commandsDir, validateCommandHandler);
    for (const cmd of commands) {
      commandRegistry.register(cmd);
      log.info(`Registered command: /${cmd.command}`);
    }
  }

  // 7. Load callback handlers from bot directory
  const callbackRegistry = new CallbackRegistry();
  if (botDir) {
    const callbacksDir = join(botDir, 'callbacks');
    const callbacks = await loadModulesFromDir<CallbackActionHandler>(callbacksDir, validateCallbackHandler);
    for (const cb of callbacks) {
      callbackRegistry.register(cb);
      log.info(`Registered callback: ${cb.prefix}`);
    }
  }

  // 8. Load lifecycle hooks
  let lifecycleHooks: LifecycleHook[] = [];
  if (botDir) {
    const lifecycleDir = join(botDir, 'lifecycle');
    lifecycleHooks = await loadModulesFromDir<LifecycleHook>(lifecycleDir, validateLifecycleHook);
    for (const hook of lifecycleHooks) {
      log.info(`Registered lifecycle hook: ${hook.event}`);
    }
  }

  // 9. Load context builders
  let contextBuilders: ContextBuilder[] = [];
  if (botDir) {
    const contextDir = join(botDir, 'context');
    contextBuilders = await loadModulesFromDir<ContextBuilder>(contextDir, validateContextBuilder);
    for (const cb of contextBuilders) {
      log.info(`Registered context builder: ${cb.type}`);
    }
  }

  // 10. Load cron handlers
  let cronHandlers: CronHandler[] = [];
  if (botDir) {
    const cronDir = join(botDir, 'cron');
    cronHandlers = await loadModulesFromDir<CronHandler>(cronDir, validateCronHandler);
    for (const ch of cronHandlers) {
      log.info(`Registered cron handler: ${ch.name}`);
    }
  }

  // 11. Load skills (auto-detection + factory)
  const skills = await loadSkills(config, options.loadSkill, log);

  // 12. Register cron handlers with cron-scheduler skill BEFORE skill init
  const cronScheduler = skills.get('cron-scheduler');
  if (cronScheduler && 'registerHandler' in cronScheduler && cronHandlers.length > 0) {
    for (const ch of cronHandlers) {
      (cronScheduler as any).registerHandler(ch.name, async () => {
        const ctx: ModuleContext = {
          chatId: '', userId: '', db: options.db, config, adapter, log, store,
        };
        await ch.execute(ctx);
      });
      log.info(`Registered cron handler "${ch.name}" with scheduler`);
    }
  }

  // 13. Build instance
  const instance: BotInstance = {
    config,
    adapter,
    skills,
    log,
    db: options.db,
    toolRegistry,
    commandRegistry,
    callbackRegistry,
    store,
    botDir,
    lifecycleHooks,
    contextBuilders,
    cronHandlers,
  };

  // 13a. Auto-detect bot identity
  const reception = config.behavior?.reception;
  instance.botUsername = reception?.bot_username || undefined;
  instance.botId = undefined;
  if (adapter.getBotInfo) {
    try {
      const info = await adapter.getBotInfo();
      instance.botId = info.id;
      if (!instance.botUsername && info.username) {
        instance.botUsername = info.username;
      }
      log.info(`Bot identity: @${instance.botUsername} (ID: ${instance.botId})`);
    } catch (err) {
      log.warn(`Could not auto-detect bot identity: ${err}`);
    }
  }

  // 14. Initialize skills (in dependency order)
  const skillContext: SkillContext = {
    config,
    adapter,
    log,
    db: options.db,
    skills,
    store,
  };

  await initSkills(skills, skillContext, log);

  // Store event bus reference for cron handlers and other modules
  const eventBusSkill = skills.get('event-bus');
  if (eventBusSkill && 'getBus' in eventBusSkill) {
    const bus = (eventBusSkill as any).getBus();
    if (bus) {
      store.set(STORE_KEYS.EVENT_BUS, bus);
      log.info('Event bus stored in instance store');
    }
  }

  // 15. Run lifecycle 'start' hooks
  const startCtx: ModuleContext = {
    chatId: '', userId: '', db: options.db, config, adapter, log, store,
  };
  for (const hook of lifecycleHooks.filter(h => h.event === 'start')) {
    try {
      await hook.execute(startCtx);
      log.info(`Lifecycle start hook executed`);
    } catch (err) {
      log.error(`Lifecycle start hook failed: ${err}`);
    }
  }

  // 15a. Now that start hooks have run, replay any in_flight crons that
  //      opted in via YAML's replay_on_crash. Deferred until here so the
  //      handlers see fully-initialized lifecycle state.
  const cronSchedulerForReplay = skills.get('cron-scheduler');
  if (cronSchedulerForReplay && 'runDeferredReplays' in cronSchedulerForReplay) {
    try {
      await (cronSchedulerForReplay as unknown as { runDeferredReplays(): Promise<void> }).runDeferredReplays();
    } catch (err) {
      log.error(`Cron deferred replay failed: ${err}`);
    }
  }

  // 16. Determine message processor
  if (options.messageProcessor) {
    instance.processMessage = options.messageProcessor;
  } else if (options.echo) {
    instance.processMessage = createEchoProcessor();
  } else if (config.brain) {
    const systemPrompt = loadSystemPrompt(config, configDir);
    instance.processMessage = createBrainProcessor(config, systemPrompt, toolRegistry, instance);
  } else {
    instance.processMessage = createEchoProcessor();
  }

  // 17. Wire up message handling (behavior-aware routing)
  adapter.onMessage(async (message) => {
    log.debug(`Message from ${message.userId}: ${message.text?.slice(0, 100) ?? '[non-text]'}`);

    const behavior = config.behavior;
    const receptionCfg = behavior?.reception;
    const msgTypes = behavior?.message_types;

    // 17a. Message type filter
    if (msgTypes) {
      const typeKey = message.type as keyof typeof msgTypes;
      if (typeKey in msgTypes && !msgTypes[typeKey]) {
        log.debug(`Skipping disabled message type: ${message.type}`);
        return;
      }
    }

    // 17b. Access control
    const access = behavior?.access;
    if (access) {
      if (access.blocked_users.includes(message.userId)) {
        log.debug(`Blocked user ${message.userId} — ignoring`);
        return;
      }
      if (access.restrict_to_allowlist
          && !access.allowed_users.includes(message.userId)
          && !access.admin_users.includes(message.userId)) {
        log.debug(`User ${message.userId} not on allowlist — ignoring`);
        return;
      }
    }

    // 17c. Command dispatch — before reception rules (commands always work)
    if (message.type === 'command' && message.text) {
      const { command, args } = parseCommand(message.text);
      const handler = commandRegistry.get(command);
      if (handler) {
        const ctx = buildModuleContext(message, instance);
        const chatLockEnabled = config.behavior?.concurrency?.chat_lock;
        const runCmd = async () => {
          try {
            await handler.execute(args, ctx);
          } catch (err) {
            log.error(`Command /${command} error: ${err}`);
            try {
              await adapter.send({ chatId: message.chatId, text: `Error running /${command}.` });
            } catch { /* ignore send failure */ }
          }
        };
        if (chatLockEnabled) {
          await withChatLock(message.chatId, runCmd);
        } else {
          await runCmd();
        }
        return; // Command handled, skip brain
      }
      // Unknown command — fall through to brain
    }

    // 17d. Reception rules (pure decision via reception.ts)
    const decision = shouldProcessMessage(message, receptionCfg, {
      botId: instance.botId,
      botUsername: instance.botUsername,
    });
    if (!decision.process) {
      log.debug(`Reception dropped message: ${decision.reason}`);
      return;
    }

    // 17e. Rate limiter
    const rateLimit = config.behavior?.concurrency?.rate_limit_per_user;
    if (rateLimit && rateLimit > 0) {
      const isAdmin = access?.admin_users.includes(message.userId);
      if (!isAdmin) {
        const window = config.behavior?.concurrency?.rate_limit_window_seconds ?? 60;
        if (!shouldAllow(message.userId, rateLimit, window)) {
          log.debug(`Rate limited user ${message.userId}`);
          return;
        }
      }
    }

    // 17f. Typing indicator
    const respFormatter = skills.get('response-formatter');
    if (respFormatter && 'sendTyping' in respFormatter) {
      await (respFormatter as any).sendTyping(message.chatId);
    }

    // 17f-b. Thinking reaction on incoming message
    if (adapter.setMessageReaction) {
      try {
        await adapter.setMessageReaction(message.chatId, message.id, '🤔');
      } catch {
        // Best-effort — bot may lack reaction permissions
      }
    }

    // 17g. Process message (with optional chat lock)
    const chatLockEnabled = config.behavior?.concurrency?.chat_lock;
    const processMsg = async () => {
      if (instance.processMessage) {
        try {
          await instance.processMessage(message, instance);
        } catch (err) {
          log.error(`Error processing message: ${err}`);
          try {
            await adapter.send({
              chatId: message.chatId,
              text: "Sorry, I couldn't process that. Please try again.",
            });
          } catch {
            // Ignore send failure
          }
        }
      }
    };

    if (chatLockEnabled) {
      await withChatLock(message.chatId, processMsg);
    } else {
      await processMsg();
    }

    // 17g-b. Remove thinking reaction
    if (adapter.setMessageReaction) {
      try {
        await adapter.setMessageReaction(message.chatId, message.id);
      } catch {
        // Best-effort cleanup
      }
    }
  });

  // 18. Wire up callback handling
  adapter.onCallback(async (callback) => {
    log.debug(`Callback from ${callback.userId}: ${callback.callbackData}`);

    // Access control for callbacks
    const access = config.behavior?.access;
    if (access) {
      if (access.blocked_users.includes(callback.userId)) return;
      if (access.restrict_to_allowlist
          && !access.allowed_users.includes(callback.userId)
          && !access.admin_users.includes(callback.userId)) return;
    }

    // Try callback registry first
    if (callback.callbackData) {
      const handler = callbackRegistry.match(callback.callbackData);
      if (handler) {
        const ctx: CallbackContext = {
          ...buildModuleContext(callback, instance),
          messageId: callback.id,
          answerCallback: callback.answerCallback ?? (async () => {}),
        };
        try {
          await handler.execute(callback.callbackData, ctx);
        } catch (err) {
          log.error(`Callback handler "${handler.prefix}" error: ${err}`);
        }
        return;
      }
    }

    // Fall through to brain processor
    if (instance.processMessage) {
      try {
        await instance.processMessage(callback, instance);
      } catch (err) {
        log.error(`Error processing callback: ${err}`);
      }
    }
  });

  // 19. Log warnings for Phase D behavior groups (not yet enforced)
  const phaseDGroups = ['guardrails', 'escalation', 'availability', 'onboarding', 'webhooks', 'i18n', 'fallback'] as const;
  for (const group of phaseDGroups) {
    if ((config.behavior as any)?.[group]) {
      log.warn(`behavior.${group} is configured but not yet enforced by the runtime`);
    }
  }

  // 19a. Wire group join notification
  if (adapter.onGroupJoin) {
    adapter.onGroupJoin((chatId, title) => {
      const platformChatId = config.platform.type === 'telegram'
        ? config.platform.chat_ids?.[0] : undefined;
      const adminChat = platformChatId
        || config.behavior?.access?.admin_users?.[0];
      if (adminChat) {
        adapter.send({
          chatId: adminChat,
          text: `I've been added to group "${title}" (ID: ${chatId}). I'll respond to mentions there.`,
        }).catch(err => log.warn(`Failed to notify admin about group join: ${err}`));
      }
    });
  }

  // 20. Start adapter
  await adapter.start();
  log.info(`Bot "${config.name}" is running`);

  // 20a. Startup behavior — announce restart to recent chats
  if (config.behavior?.startup?.announce_restart && config.behavior.startup.recovery_message) {
    const histSkill = skills.get('conversation-history');
    if (histSkill && 'getRecentChatIds' in histSkill) {
      const recentChats = (histSkill as any).getRecentChatIds(24 * 60); // last 24h
      for (const chatId of recentChats) {
        try {
          await adapter.send({ chatId, text: config.behavior.startup.recovery_message });
        } catch (err) {
          log.warn(`Failed to send restart message to ${chatId}: ${err}`);
        }
      }
    }
  }

  // 21. Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);

    // Run lifecycle 'stop' hooks
    const stopCtx: ModuleContext = {
      chatId: '', userId: '', db: options.db, config, adapter, log, store,
    };
    for (const hook of lifecycleHooks.filter(h => h.event === 'stop')) {
      try {
        await hook.execute(stopCtx);
        log.info(`Lifecycle stop hook executed`);
      } catch (err) {
        log.error(`Lifecycle stop hook failed: ${err}`);
      }
    }

    await adapter.stop();
    for (const [name, skill] of skills) {
      if (skill.destroy) {
        try {
          await skill.destroy();
          log.info(`Destroyed skill: ${name}`);
        } catch (err) {
          log.error(`Error destroying skill "${name}": ${err}`);
        }
      }
    }
    if (options.db) {
      try {
        options.db.close();
        log.info('Database closed');
      } catch {
        // Ignore
      }
    }
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return instance;
}
