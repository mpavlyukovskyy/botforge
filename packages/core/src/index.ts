// Core exports
export { loadConfig, validateConfig, type LoadConfigOptions } from './config.js';
export { startBot, type BotInstance, type BotForgeOptions, type AdapterFactory, type SkillFactory, type MessageProcessor } from './runtime.js';
export { createLogger, type Skill, type SkillContext, type Logger } from './skill.js';

// Adapter types
export type {
  PlatformAdapter,
  IncomingMessage,
  OutgoingMessage,
  InlineButton,
  MessageHandler,
  CallbackHandler,
} from './adapter.js';

// Schema
export { BotConfigSchema } from './schema.js';
export type {
  BotConfig,
  Platform,
  TelegramPlatform,
  Brain,
  ClaudeBrain,
  GeminiBrain,
  Memory,
  ConversationHistory,
  ContextBlock,
  Resilience,
  CircuitBreaker,
  Retry,
  Schedule,
  CronJob,
  Health,
  Communication,
  Subscription,
  PassiveDetection,
  Pipeline,
  PipelineStep,
  ToolDefinition,
} from './schema.js';
