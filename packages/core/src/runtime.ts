/**
 * BotForge Runtime — boots a bot from YAML config
 *
 * Lifecycle: loadConfig → createAdapter → initStorage → loadSkills → wireBrain → start
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadConfig, type LoadConfigOptions } from './config.js';
import { createLogger, type Logger, type Skill, type SkillContext, type DatabaseLike } from './skill.js';
import type { PlatformAdapter, IncomingMessage } from './adapter.js';
import type { BotConfig } from './schema.js';
import { askBrain, type BrainResponse } from './brain.js';
import { askGemini } from './brain-gemini.js';
import { ToolRegistry, loadToolsFromDir, type ToolContext } from './tool-registry.js';
import { withChatLock } from './chat-lock.js';
import { shouldAllow } from './rate-limiter.js';

export type AdapterFactory = (config: BotConfig, log: Logger) => PlatformAdapter;
export type SkillFactory = (name: string) => Promise<Skill>;
export type MessageProcessor = (message: IncomingMessage, context: BotInstance) => Promise<void>;

export interface BotInstance {
  config: BotConfig;
  adapter: PlatformAdapter;
  skills: Map<string, Skill>;
  log: Logger;
  db?: DatabaseLike;
  toolRegistry: ToolRegistry;
  /** Process an incoming message through the brain */
  processMessage?: MessageProcessor;
  /** Bot's Telegram username (auto-detected or from config) */
  botUsername?: string;
  /** Bot's platform user ID (auto-detected) */
  botId?: string;
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
  'token-tracker',
  'context-builder',
  'circuit-breaker',
  'passive-detection',
  'response-formatter',
  'reply-context',
  'pending-questions',
  'cron-scheduler',
  'daily-digest',
  'health-server',
] as const;

function detectSkills(config: BotConfig): string[] {
  const detected = new Set<string>();

  if (config.memory?.conversation_history?.enabled) detected.add('conversation-history');
  if (config.brain?.provider === 'claude') detected.add('token-tracker');
  if (config.memory?.context_blocks?.length) detected.add('context-builder');
  if (config.resilience?.circuit_breaker) detected.add('circuit-breaker');
  // passive-detection: load if either old or new config has keywords/patterns
  if (config.passive_detection
      || config.behavior?.reception?.keywords?.length
      || config.behavior?.reception?.patterns?.length) {
    detected.add('passive-detection');
  }
  if (config.behavior?.response) detected.add('response-formatter');
  if (config.behavior?.continuity?.reply_context) detected.add('reply-context');
  if (config.behavior?.continuity?.pending_questions) detected.add('pending-questions');
  if (config.schedule) detected.add('cron-scheduler');
  if (config.schedule?.daily_digest) detected.add('daily-digest');
  if (config.health) detected.add('health-server');

  // Return in init order
  return SKILL_INIT_ORDER.filter(name => detected.has(name));
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

// ─── Default brain message processor ────────────────────────────────────────

function createBrainProcessor(
  config: BotConfig,
  systemPrompt: string,
  toolRegistry: ToolRegistry,
  db: DatabaseLike | undefined,
  log: Logger,
): MessageProcessor {
  return async (message: IncomingMessage, instance: BotInstance) => {
    if (!message.text) {
      log.debug(`Non-text message type "${message.type}" passed type filter; media handling not yet implemented`);
      return;
    }

    // Build tool context for this message
    const toolCtx: ToolContext = {
      chatId: message.chatId,
      userId: message.userId,
      userName: message.userName,
      db,
      config: instance.config,
      adapter: instance.adapter,
      log,
    };

    const brainTools = toolRegistry.toBrainTools(toolCtx);

    // Collect context blocks from context-builder skill if available
    const contextBlocks: string[] = [];
    const contextBuilder = instance.skills.get('context-builder');
    if (contextBuilder && 'getContextBlocks' in contextBuilder) {
      const blocks = await (contextBuilder as any).getContextBlocks(message.chatId);
      if (Array.isArray(blocks)) {
        contextBlocks.push(...blocks);
      }
    }

    // Reply context injection
    const replyCtxSkill = instance.skills.get('reply-context');
    if (replyCtxSkill && 'getContextBlock' in replyCtxSkill) {
      const replyBlock = (replyCtxSkill as any).getContextBlock(message);
      if (replyBlock) contextBlocks.push(replyBlock);
    }

    // Pending questions context injection
    const pendingQSkill = instance.skills.get('pending-questions');
    if (pendingQSkill && 'getContextBlock' in pendingQSkill) {
      const pendingBlock = (pendingQSkill as any).getContextBlock(message.chatId);
      if (pendingBlock) contextBlocks.push(pendingBlock);
    }

    // Get conversation history from conversation-history skill
    let conversationHistory: string | undefined;
    const historySkill = instance.skills.get('conversation-history');
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

    try {
      if (config.brain.provider === 'claude') {
        brainResponse = await askBrain(
          {
            name: config.name,
            model: config.brain.model,
            systemPrompt,
            maxTurns: config.brain.max_iterations ?? 5,
            maxBudgetUsd: config.brain.max_budget_usd ?? 1.0,
          },
          {
            userMessage: message.text,
            tools: brainTools,
            conversationHistory,
            contextBlocks,
          },
        );
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
            userMessage: message.text,
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
    if (responseText) {
      const respFormatter = instance.skills.get('response-formatter');
      if (respFormatter && 'formatAndSend' in respFormatter) {
        await (respFormatter as any).formatAndSend(message.chatId, responseText);
      } else {
        await instance.adapter.send({
          chatId: message.chatId,
          text: responseText,
        });
      }
    }

    // Store conversation in history (if skill available)
    if (historySkill && 'addMessage' in historySkill) {
      await (historySkill as any).addMessage(message.chatId, 'user', message.text);
      if (responseText) {
        await (historySkill as any).addMessage(message.chatId, 'assistant', responseText);
      }
    }

    // Record pending questions from bot response
    if (pendingQSkill && 'recordQuestion' in pendingQSkill && responseText) {
      (pendingQSkill as any).recordQuestion(message.chatId, responseText);
    }

    // Record token usage (if skill available)
    const tokenTracker = instance.skills.get('token-tracker');
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

  // 3. Load tool registry
  const toolRegistry = new ToolRegistry();
  if (options.toolsDir) {
    const toolImpls = await loadToolsFromDir(options.toolsDir);
    for (const impl of toolImpls) {
      toolRegistry.register(impl);
      log.info(`Registered tool: ${impl.name}`);
    }
  }

  // 4. Load skills
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

  // 5. Build instance
  const instance: BotInstance = {
    config,
    adapter,
    skills,
    log,
    db: options.db,
    toolRegistry,
  };

  // 5a. Auto-detect bot identity
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

  // 6. Determine message processor
  if (options.messageProcessor) {
    instance.processMessage = options.messageProcessor;
  } else if (options.echo) {
    instance.processMessage = createEchoProcessor();
  } else if (config.brain) {
    const systemPrompt = loadSystemPrompt(config, configDir);
    instance.processMessage = createBrainProcessor(config, systemPrompt, toolRegistry, options.db, log);
  } else {
    instance.processMessage = createEchoProcessor();
  }

  // 7. Initialize skills (in dependency order)
  const skillContext: SkillContext = {
    config,
    adapter,
    log,
    db: options.db,
    skills,
  };

  for (const [name, skill] of skills) {
    try {
      await skill.init(skillContext);
      log.info(`Initialized skill: ${name}`);
    } catch (err) {
      log.error(`Failed to initialize skill "${name}": ${err}`);
    }
  }

  // 8. Wire up message handling (behavior-aware routing)
  adapter.onMessage(async (message) => {
    log.debug(`Message from ${message.userId}: ${message.text?.slice(0, 100) ?? '[non-text]'}`);

    const behavior = config.behavior;
    const receptionCfg = behavior?.reception;
    const msgTypes = behavior?.message_types;

    // 8a. Message type filter
    if (msgTypes) {
      const typeKey = message.type as keyof typeof msgTypes;
      if (typeKey in msgTypes && !msgTypes[typeKey]) {
        log.debug(`Skipping disabled message type: ${message.type}`);
        return;
      }
    }

    // 8b. Reception rules
    if (message.isGroup) {
      const groupMode = receptionCfg?.group_mode ?? (config.passive_detection ? 'passive' : 'always');

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
          const keywords = receptionCfg?.keywords ?? config.passive_detection?.keywords ?? [];
          const patterns = receptionCfg?.patterns ?? config.passive_detection?.patterns ?? [];
          const caseSensitive = receptionCfg?.case_sensitive ?? config.passive_detection?.case_sensitive ?? false;
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

        // Legacy passive-detection skill fallback (for bots without behavior config)
        if (!shouldProcess && !receptionCfg && config.passive_detection) {
          const passiveSkill = skills.get('passive-detection');
          if (passiveSkill && 'shouldProcess' in passiveSkill) {
            shouldProcess = await (passiveSkill as any).shouldProcess(message);
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

    // 8c. Rate limiter
    const rateLimit = config.behavior?.concurrency?.rate_limit_per_user;
    if (rateLimit && rateLimit > 0) {
      const window = config.behavior?.concurrency?.rate_limit_window_seconds ?? 60;
      if (!shouldAllow(message.userId, rateLimit, window)) {
        log.debug(`Rate limited user ${message.userId}`);
        return;
      }
    }

    // 8d. Typing indicator
    const respFormatter = skills.get('response-formatter');
    if (respFormatter && 'sendTyping' in respFormatter) {
      await (respFormatter as any).sendTyping(message.chatId);
    }

    // 8e. Process message (with optional chat lock)
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
  });

  adapter.onCallback(async (callback) => {
    log.debug(`Callback from ${callback.userId}: ${callback.callbackData}`);
    if (instance.processMessage) {
      try {
        await instance.processMessage(callback, instance);
      } catch (err) {
        log.error(`Error processing callback: ${err}`);
      }
    }
  });

  // 9. Log warnings for Phase D behavior groups (not yet enforced)
  const phaseDGroups = ['access', 'guardrails', 'escalation', 'availability', 'onboarding', 'webhooks', 'i18n', 'fallback'] as const;
  for (const group of phaseDGroups) {
    if ((config.behavior as any)?.[group]) {
      log.warn(`behavior.${group} is configured but not yet enforced by the runtime`);
    }
  }

  // 10. Start adapter
  await adapter.start();
  log.info(`Bot "${config.name}" is running`);

  // 10a. Startup behavior — announce restart to recent chats
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

  // 11. Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down...`);
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
