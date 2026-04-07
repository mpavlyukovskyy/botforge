// Core exports
export { loadConfig, validateConfig, type LoadConfigOptions } from './config.js';
export { startBot, type BotInstance, type BotForgeOptions, type AdapterFactory, type SkillFactory, type MessageProcessor, type LifecycleHook, type ContextBuilder, type CronHandler } from './runtime.js';
export { createLogger, type Skill, type SkillContext, type Logger, type DatabaseLike } from './skill.js';

// Brain
export { askBrain, type BrainTool, type BrainConfig, type BrainInput, type BrainResponse } from './brain.js';
export { askBrainCli } from './brain-cli.js';
export { askGemini, type GeminiBrainConfig, type GeminiInput, type GeminiResponse } from './brain-gemini.js';

// Tool Registry
export { ToolRegistry, loadToolsFromDir, type ToolImplementation, type ToolContext, type ToolPermissions } from './tool-registry.js';

// Module System
export { loadModulesFromDir } from './module-loader.js';
export { CommandRegistry, parseCommand, type ModuleContext, type CommandHandler } from './command-registry.js';
export { CallbackRegistry, type CallbackActionHandler, type CallbackContext } from './callback-registry.js';

// Utilities
export { withChatLock } from './chat-lock.js';
export { shouldAllow } from './rate-limiter.js';
export { setRef, getRef, extractRefs, expandRefs, clearRefs } from './numbered-refs.js';

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
  ClaudeCliBrain,
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
  ToolServer,
  Communication,
  Subscription,
  Behavior,
  Reception,
  MessageTypes,
  Pipeline,
  PipelineStep,
  ToolDefinition,
} from './schema.js';
