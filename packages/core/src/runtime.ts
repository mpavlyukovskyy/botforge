/**
 * BotForge Runtime — boots a bot from YAML config
 *
 * Lifecycle: loadConfig → createAdapter → deriveBotDir → loadModules → initSkills → wireBrain → start
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { loadConfig, type LoadConfigOptions } from './config.js';
import { createLogger, type Logger, type Skill, type SkillContext, type DatabaseLike } from './skill.js';
import type { PlatformAdapter, IncomingMessage } from './adapter.js';
import type { BotConfig } from './schema.js';
import { askBrain, type BrainResponse } from './brain.js';
import { askBrainCli } from './brain-cli.js';
import { askGemini } from './brain-gemini.js';
import { ToolRegistry, loadToolsFromDir, type ToolContext } from './tool-registry.js';
import { loadModulesFromDir } from './module-loader.js';
import { CommandRegistry, parseCommand, type ModuleContext, type CommandHandler } from './command-registry.js';
import { CallbackRegistry, type CallbackActionHandler, type CallbackContext } from './callback-registry.js';
import { withChatLock } from './chat-lock.js';
import { shouldAllow } from './rate-limiter.js';

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
  store: Map<string, unknown>;
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

// ─── Skill auto-detection ───────────────────────────────────────────────────

const SKILL_INIT_ORDER = [
  'conversation-history',
  'event-bus',
  'token-tracker',
  'context-builder',
  'circuit-breaker',
  'response-formatter',
  'reply-context',
  'pending-questions',
  'cron-scheduler',
  'daily-digest',
  'health-server',
  'tool-server',
] as const;

function detectSkills(config: BotConfig): string[] {
  const detected = new Set<string>();

  if (config.memory?.conversation_history?.enabled) detected.add('conversation-history');
  if (config.brain?.provider === 'claude' || config.brain?.provider === 'claude-cli') detected.add('token-tracker');
  if (config.memory?.context_blocks?.length) detected.add('context-builder');
  if (config.resilience?.circuit_breaker) detected.add('circuit-breaker');
  if (config.behavior?.reception?.keywords?.length
      || config.behavior?.reception?.patterns?.length) {
    detected.add('passive-detection');
  }
  if (config.behavior?.response) detected.add('response-formatter');
  if (config.behavior?.continuity?.reply_context) detected.add('reply-context');
  if (config.behavior?.continuity?.pending_questions) detected.add('pending-questions');
  if (config.schedule) detected.add('cron-scheduler');
  if (config.schedule) detected.add('event-bus');
  if (config.schedule?.daily_digest) detected.add('daily-digest');
  if (config.health) detected.add('health-server');
  if (config.tool_server) detected.add('tool-server');

  // Return in init order
  return SKILL_INIT_ORDER.filter(name => detected.has(name));
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

// ─── System prompt loader ───────────────────────────────────────────────────

function loadSystemPrompt(config: BotConfig, configDir: string): string {
  if (config.brain.system_prompt) {
    return config.brain.system_prompt;
  }

  if (config.brain.system_prompt_file) {
    const promptPath = resolve(configDir, config.brain.system_prompt_file);
    if (existsSync(promptPath)) {
      return readFileSync(promptPath, 'utf-8');
    }
    throw new Error(`System prompt file not found: ${promptPath}`);
  }

  return `You are ${config.name}, an AI assistant. Be helpful and concise.`;
}

// ─── Build ModuleContext helper ──────────────────────────────────────────────

function buildModuleContext(
  message: IncomingMessage,
  instance: BotInstance,
): ModuleContext {
  return {
    chatId: message.chatId,
    userId: message.userId,
    userName: message.userName,
    db: instance.db,
    config: instance.config,
    adapter: instance.adapter,
    log: instance.log,
    store: instance.store,
  };
}

// ─── Default brain message processor ────────────────────────────────────────

function createBrainProcessor(
  config: BotConfig,
  systemPrompt: string,
  toolRegistry: ToolRegistry,
  instance: BotInstance,
): MessageProcessor {
  const { log, db } = instance;

  return async (message: IncomingMessage, inst: BotInstance) => {
    // Allow media messages with captions through (text is the caption)
    if (!message.text && !message.file) {
      log.debug(`Non-text message type "${message.type}" passed type filter; media handling not yet implemented`);
      return;
    }

    // Pre-brain media download
    let files: Buffer[] | undefined;
    let fileMetadata: ToolContext['fileMetadata'];
    if (message.file?.fileId && inst.adapter.downloadFile) {
      try {
        const buffer = await inst.adapter.downloadFile(message.file.fileId);
        files = [buffer];
        fileMetadata = [{
          fileName: message.file.fileName,
          mimeType: message.file.mimeType,
          fileSize: message.file.fileSize,
        }];
      } catch (err) {
        log.warn(`Failed to download file ${message.file.fileId}: ${err}`);
      }
    }

    // Build tool context for this message
    const toolCtx: ToolContext = {
      chatId: message.chatId,
      userId: message.userId,
      userName: message.userName,
      db,
      config: inst.config,
      adapter: inst.adapter,
      log,
      store: inst.store,
      files,
      fileMetadata,
    };

    const brainTools = toolRegistry.toBrainTools(toolCtx);

    // Collect context blocks from context-builder skill if available
    const contextBlocks: string[] = [];
    const contextBuilder = inst.skills.get('context-builder');
    if (contextBuilder && 'getContextBlocks' in contextBuilder) {
      const blocks = await (contextBuilder as any).getContextBlocks(message.chatId);
      if (Array.isArray(blocks)) {
        contextBlocks.push(...blocks);
      }
    }

    // Inject bot-directory context builders
    if (inst.contextBuilders.length > 0) {
      const moduleCtx = buildModuleContext(message, inst);
      for (const cb of inst.contextBuilders) {
        try {
          const block = await cb.build(moduleCtx);
          if (block) contextBlocks.push(block);
        } catch (err) {
          log.warn(`Context builder "${cb.type}" failed: ${err}`);
        }
      }
    }

    // Reply context injection
    const replyCtxSkill = inst.skills.get('reply-context');
    if (replyCtxSkill && 'getContextBlock' in replyCtxSkill) {
      const replyBlock = (replyCtxSkill as any).getContextBlock(message);
      if (replyBlock) contextBlocks.push(replyBlock);
    }

    // Pending questions context injection
    const pendingQSkill = inst.skills.get('pending-questions');
    if (pendingQSkill && 'getContextBlock' in pendingQSkill) {
      const pendingBlock = (pendingQSkill as any).getContextBlock(message.chatId);
      if (pendingBlock) contextBlocks.push(pendingBlock);
    }

    // Get conversation history from conversation-history skill
    let conversationHistory: string | undefined;
    const historySkill = inst.skills.get('conversation-history');
    if (historySkill && 'formatHistory' in historySkill) {
      // Check conversation timeout
      const timeout = config.behavior?.reception?.conversation_timeout_min;
      if (timeout && timeout > 0 && 'getLastMessageTime' in historySkill) {
        const lastTime = (historySkill as any).getLastMessageTime(message.chatId);
        if (lastTime && (Date.now() - lastTime.getTime()) > timeout * 60 * 1000) {
          log.info(`Conversation timeout: ${timeout}min idle, starting fresh for ${message.chatId}`);
          // Skip history injection
        } else {
          conversationHistory = await (historySkill as any).formatHistory(message.chatId);
        }
      } else {
        conversationHistory = await (historySkill as any).formatHistory(message.chatId);
      }
    }

    let responseText: string;
    let brainResponse: BrainResponse | undefined;

    // Clear any previous post-response actions
    inst.store.delete('postResponse');

    // Build userMessage with file metadata for document attachments
    let userMessage = message.text ?? '';
    if (message.type === 'document' && files?.length) {
      const fn = message.file?.fileName || 'unnamed file';
      const mt = message.file?.mimeType || 'unknown type';
      const sz = message.file?.fileSize ? `${Math.round(message.file.fileSize / 1024)} KB` : 'unknown size';
      const fileLine = `\n\n[Attached document: "${fn}" (${mt}, ${sz}). Use the read_document tool to extract its contents.]`;
      userMessage = (userMessage || '') + fileLine;
    }
    if (!userMessage) userMessage = '[media message]';

    try {
      if (config.brain.provider === 'claude') {
        const brainPromise = askBrain(
          {
            name: config.name,
            model: config.brain.model,
            systemPrompt,
            maxTurns: config.brain.max_iterations ?? 5,
            maxBudgetUsd: config.brain.max_budget_usd ?? 1.0,
          },
          {
            userMessage,
            tools: brainTools,
            conversationHistory,
            contextBlocks,
          },
        );
        const BRAIN_TIMEOUT_MS = 120_000; // 2 minutes
        brainResponse = await Promise.race([
          brainPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Brain query timed out after ${BRAIN_TIMEOUT_MS / 1000}s`)), BRAIN_TIMEOUT_MS)
          ),
        ]);
        responseText = brainResponse.text;
      } else if (config.brain.provider === 'claude-cli') {
        const cliPromise = askBrainCli(
          {
            name: config.name,
            model: config.brain.model,
            systemPrompt,
            maxTurns: config.brain.max_iterations ?? 5,
          },
          {
            userMessage,
            tools: brainTools,
            conversationHistory,
            contextBlocks,
          },
        );
        const BRAIN_TIMEOUT_MS = 120_000; // 2 minutes
        brainResponse = await Promise.race([
          cliPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Brain CLI query timed out after ${BRAIN_TIMEOUT_MS / 1000}s`)), BRAIN_TIMEOUT_MS)
          ),
        ]);
        responseText = brainResponse.text;
      } else if (config.brain.provider === 'gemini') {
        // Gemini API key from env
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          throw new Error('GEMINI_API_KEY environment variable not set');
        }

        const geminiResponse = await askGemini(
          {
            model: config.brain.model,
            apiKey,
            systemPrompt,
            temperature: config.brain.temperature,
            maxTokens: config.brain.max_tokens,
          },
          {
            userMessage,
            contextBlocks,
          },
        );
        responseText = geminiResponse.text;
      } else {
        responseText = 'Unsupported brain provider.';
      }
    } catch (err) {
      log.error(`Brain error: ${err}`);
      responseText = "Sorry, I couldn't process that. Please try again.";
    }

    // Send response (via response-formatter if available)
    let sentMessageId: string | undefined;
    if (responseText) {
      const respFormatter = inst.skills.get('response-formatter');
      if (respFormatter && 'formatAndSend' in respFormatter) {
        sentMessageId = await (respFormatter as any).formatAndSend(message.chatId, responseText);
      } else {
        sentMessageId = await inst.adapter.send({
          chatId: message.chatId,
          text: responseText,
        });
      }
    }

    // Post-response hook: attach inline keyboards from tool results
    const postResponse = inst.store.get('postResponse') as { buttons?: any[][] } | undefined;
    if (postResponse?.buttons && sentMessageId && inst.adapter.edit) {
      try {
        await inst.adapter.edit(sentMessageId, message.chatId, {
          text: responseText,
          inlineKeyboard: postResponse.buttons,
        });
      } catch (err) {
        log.warn(`Post-response edit failed: ${err}`);
      }
      inst.store.delete('postResponse');
    }

    // Store conversation in history (if skill available)
    if (historySkill && 'addMessage' in historySkill) {
      await (historySkill as any).addMessage(message.chatId, 'user', message.text ?? '[media]');
      if (responseText) {
        await (historySkill as any).addMessage(message.chatId, 'assistant', responseText);
      }
    }

    // Record pending questions from bot response
    if (pendingQSkill && 'recordQuestion' in pendingQSkill && responseText) {
      (pendingQSkill as any).recordQuestion(message.chatId, responseText);
    }

    // Record token usage (if skill available)
    const tokenTracker = inst.skills.get('token-tracker');
    if (tokenTracker && 'recordUsage' in tokenTracker && brainResponse) {
      await (tokenTracker as any).recordUsage(
        config.brain.model,
        brainResponse.usage.costUsd,
      );
    }
  };
}

// ─── Default echo processor ─────────────────────────────────────────────────

function createEchoProcessor(): MessageProcessor {
  return async (message: IncomingMessage, instance: BotInstance) => {
    const responseText = `[${instance.config.name}] Received: ${message.text ?? '[non-text message]'}`;
    await instance.adapter.send({
      chatId: message.chatId,
      text: responseText,
    });
  };
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
  const store = new Map<string, unknown>();

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
  store.set('toolRegistry', toolRegistry);

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

  // 11. Load skills
  const skills = new Map<string, Skill>();

  if (options.loadSkill) {
    const skillNames = detectSkills(config);

    for (const name of skillNames) {
      try {
        const skill = await options.loadSkill(name);
        skills.set(name, skill);
        log.info(`Loaded skill: ${name}`);
      } catch (err) {
        log.warn(`Failed to load skill "${name}": ${err}`);
      }
    }
  }

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

  for (const [name, skill] of skills) {
    try {
      await skill.init(skillContext);
      log.info(`Initialized skill: ${name}`);
    } catch (err) {
      log.error(`Failed to initialize skill "${name}": ${err}`);
    }
  }

  // Store event bus reference for cron handlers and other modules
  const eventBusSkill = skills.get('event-bus');
  if (eventBusSkill && 'getBus' in eventBusSkill) {
    const bus = (eventBusSkill as any).getBus();
    if (bus) {
      store.set('eventBus', bus);
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

    // 17d. Reception rules
    if (message.isGroup) {
      const groupMode = receptionCfg?.group_mode ?? 'always';

      if (groupMode === 'ignore') return;

      if (groupMode === 'passive') {
        let shouldProcess = false;

        // Reply to THIS bot (not any bot)
        if (receptionCfg?.respond_to_replies !== false
            && message.replyToUserId
            && instance.botId
            && message.replyToUserId === instance.botId) {
          shouldProcess = true;
        }

        // @mention with word boundary
        if (!shouldProcess && receptionCfg?.respond_to_mentions !== false && instance.botUsername) {
          const mentionRegex = new RegExp(`@${instance.botUsername}\\b`, 'i');
          if (message.text && mentionRegex.test(message.text)) shouldProcess = true;
        }

        // Keyword/pattern matching (inline for new config, skill for legacy)
        if (!shouldProcess && message.text) {
          const keywords = receptionCfg?.keywords ?? [];
          const patterns = receptionCfg?.patterns ?? [];
          const caseSensitive = receptionCfg?.case_sensitive ?? false;
          const compareText = caseSensitive ? message.text : message.text.toLowerCase();

          for (const kw of keywords) {
            if (compareText.includes(caseSensitive ? kw : kw.toLowerCase())) {
              shouldProcess = true;
              break;
            }
          }
          if (!shouldProcess) {
            for (const p of patterns) {
              if (new RegExp(p, caseSensitive ? '' : 'i').test(message.text)) {
                shouldProcess = true;
                break;
              }
            }
          }
        }

        if (!shouldProcess) return;
      }
      // groupMode === 'always' → fall through
    } else {
      // DM reception rules
      const dmMode = receptionCfg?.dm_mode ?? 'always';
      if (dmMode === 'ignore') return;
      if (dmMode === 'keyword_only' && message.text) {
        const keywords = receptionCfg?.keywords ?? [];
        const caseSensitive = receptionCfg?.case_sensitive ?? false;
        const compareText = caseSensitive ? message.text : message.text.toLowerCase();
        let matched = false;
        for (const kw of keywords) {
          if (compareText.includes(caseSensitive ? kw : kw.toLowerCase())) { matched = true; break; }
        }
        if (!matched) return;
      }
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
