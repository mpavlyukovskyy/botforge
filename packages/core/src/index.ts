// Core exports
export { loadConfig, validateConfig, type LoadConfigOptions } from './config.js';
export { startBot, type BotInstance, type BotForgeOptions, type AdapterFactory, type SkillFactory, type MessageProcessor } from './runtime.js';
export { createLogger, type Skill, type SkillContext, type Logger, type DatabaseLike } from './skill.js';

// Brain
export { askBrain, type BrainTool, type BrainConfig, type BrainInput, type BrainResponse } from './brain.js';
export { askGemini, type GeminiBrainConfig, type GeminiInput, type GeminiResponse } from './brain-gemini.js';

// Tool Registry
export { ToolRegistry, loadToolsFromDir, type ToolImplementation, type ToolContext } from './tool-registry.js';

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
