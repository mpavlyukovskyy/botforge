/**
 * BotForge Runtime — boots a bot from YAML config
 *
 * Lifecycle: loadConfig → createAdapter → loadSkills → start
 */

import { loadConfig, type LoadConfigOptions } from './config.js';
import { createLogger, type Logger, type Skill, type SkillContext } from './skill.js';
import type { PlatformAdapter, IncomingMessage } from './adapter.js';
import type { BotConfig } from './schema.js';

export type AdapterFactory = (config: BotConfig, log: Logger) => PlatformAdapter;
export type SkillFactory = (name: string) => Promise<Skill>;
export type MessageProcessor = (message: IncomingMessage, context: BotInstance) => Promise<void>;

export interface BotInstance {
  config: BotConfig;
  adapter: PlatformAdapter;
  skills: Map<string, Skill>;
  log: Logger;
  /** Process an incoming message through the brain */
  processMessage?: MessageProcessor;
}

export interface BotForgeOptions {
  /** Factory to create platform adapter from config */
  createAdapter: AdapterFactory;
  /** Factory to load skills by name */
  loadSkill?: SkillFactory;
  /** Message processor (e.g., Claude Agent SDK handler) */
  messageProcessor?: MessageProcessor;
  /** Config loading options */
  configOptions?: LoadConfigOptions;
}

/**
 * Start a bot from a YAML config file.
 */
export async function startBot(configPath: string, options: BotForgeOptions): Promise<BotInstance> {
  // 1. Load and validate config
  const config = loadConfig(configPath, options.configOptions);
  const log = createLogger(config.name);

  log.info(`Starting bot "${config.name}" v${config.version}`);
  log.info(`Platform: ${config.platform.type}`);

  // 2. Create platform adapter
  const adapter = options.createAdapter(config, log);

  // 3. Load skills
  const skills = new Map<string, Skill>();

  if (options.loadSkill) {
    // Load skills declared in brain.tools (these are tool names, not skill names)
    // Skills are loaded from dedicated skill packages
    const skillNames = new Set<string>();

    // Auto-detect skills from config
    if (config.memory?.conversation_history?.enabled) skillNames.add('conversation-history');
    if (config.resilience?.circuit_breaker) skillNames.add('circuit-breaker');
    if (config.health) skillNames.add('health-server');
    if (config.schedule) skillNames.add('cron-scheduler');
    if (config.passive_detection) skillNames.add('passive-detection');

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

  // 4. Build instance
  const instance: BotInstance = {
    config,
    adapter,
    skills,
    log,
    processMessage: options.messageProcessor,
  };

  // 5. Initialize skills
  const skillContext: SkillContext = {
    config,
    adapter,
    log,
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

  // 6. Wire up message handling
  adapter.onMessage(async (message) => {
    log.debug(`Message from ${message.userId}: ${message.text?.slice(0, 100) ?? '[non-text]'}`);
    if (instance.processMessage) {
      try {
        await instance.processMessage(message, instance);
      } catch (err) {
        log.error(`Error processing message: ${err}`);
      }
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

  // 7. Start adapter
  await adapter.start();
  log.info(`Bot "${config.name}" is running`);

  // 8. Graceful shutdown
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
    log.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return instance;
}
