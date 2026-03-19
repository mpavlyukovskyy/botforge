/**
 * BotForge YAML Configuration Schema
 *
 * Every bot is defined by a single YAML file validated against this schema.
 * Uses Zod for runtime validation + TypeScript type inference.
 */

import { z } from 'zod';

// ─── Platform ────────────────────────────────────────────────────────────────

const TelegramPlatformSchema = z.object({
  type: z.literal('telegram'),
  token: z.string().describe('Bot token from BotFather, supports ${ENV_VAR} interpolation'),
  chat_ids: z.array(z.string()).optional().describe('Allowed chat IDs (empty = allow all)'),
  mode: z.enum(['polling', 'webhook']).default('polling'),
  webhook_url: z.string().url().optional(),
  local_bot_api: z.string().url().optional().describe('Local Bot API server URL for large files'),
});

const SlackPlatformSchema = z.object({
  type: z.literal('slack'),
  bot_token: z.string(),
  app_token: z.string().optional(),
  signing_secret: z.string(),
  channels: z.array(z.string()).optional(),
});

const EmailPlatformSchema = z.object({
  type: z.literal('email'),
  imap_host: z.string(),
  imap_port: z.number().default(993),
  imap_user: z.string(),
  imap_password: z.string(),
  smtp_host: z.string().optional(),
  smtp_port: z.number().optional(),
  smtp_user: z.string().optional(),
  smtp_password: z.string().optional(),
  folders: z.array(z.string()).default(['INBOX']),
  idle: z.boolean().default(true),
});

const WebPlatformSchema = z.object({
  type: z.literal('web'),
  port: z.number(),
  cors_origins: z.array(z.string()).optional(),
  websocket: z.boolean().default(false),
});

const HeadlessPlatformSchema = z.object({
  type: z.literal('headless'),
});

const PlatformSchema = z.discriminatedUnion('type', [
  TelegramPlatformSchema,
  SlackPlatformSchema,
  EmailPlatformSchema,
  WebPlatformSchema,
  HeadlessPlatformSchema,
]);

// ─── Brain (LLM Configuration) ──────────────────────────────────────────────

const ClaudeBrainSchema = z.object({
  provider: z.literal('claude').default('claude'),
  model: z.string().default('claude-sonnet-4-20250514'),
  system_prompt: z.string().optional(),
  system_prompt_file: z.string().optional().describe('Path to system prompt file'),
  tools: z.array(z.string()).default([]),
  temperature: z.number().min(0).max(1).default(0),
  max_tokens: z.number().positive().default(4096),
  max_iterations: z.number().positive().optional().describe('Max agentic turns (maps to SDK maxTurns)'),
  max_budget_usd: z.number().positive().optional().describe('Max cost per query in USD'),
});

const GeminiBrainSchema = z.object({
  provider: z.literal('gemini'),
  model: z.string().default('gemini-2.0-flash'),
  system_prompt: z.string().optional(),
  system_prompt_file: z.string().optional(),
  tools: z.array(z.string()).default([]),
  temperature: z.number().min(0).max(2).default(0),
  max_tokens: z.number().positive().default(4096),
});

const BrainSchema = z.discriminatedUnion('provider', [
  ClaudeBrainSchema,
  GeminiBrainSchema,
]);

// ─── Memory ──────────────────────────────────────────────────────────────────

const ConversationHistorySchema = z.object({
  enabled: z.boolean().default(true),
  ttl_days: z.number().positive().default(14),
  max_messages: z.number().positive().default(100),
  strip_action_lines: z.boolean().default(false).describe('Strip ACTION lines before storage'),
});

const ContextBlockSchema = z.object({
  type: z.string().describe('Context block type (e.g., board_state, recent_history, pipeline)'),
  label: z.string().optional().describe('XML tag name for the context block'),
  handler: z.string().optional().describe('Handler function name or module path'),
});

const MemorySchema = z.object({
  conversation_history: ConversationHistorySchema.optional(),
  context_blocks: z.array(ContextBlockSchema).default([]),
});

// ─── Resilience ──────────────────────────────────────────────────────────────

const CircuitBreakerSchema = z.object({
  threshold: z.number().positive().default(5),
  reset_timeout_ms: z.number().positive().default(30000),
  half_open_max: z.number().positive().default(1),
});

const RetrySchema = z.object({
  max_attempts: z.number().positive().default(3),
  backoff: z.enum(['exponential', 'linear', 'fixed']).default('exponential'),
  base_delay_ms: z.number().positive().default(1000),
  max_delay_ms: z.number().positive().default(30000),
  transient_codes: z.array(z.number()).default([429, 502, 503, 504]),
});

const ResilienceSchema = z.object({
  circuit_breaker: CircuitBreakerSchema.optional(),
  retry: RetrySchema.optional(),
});

// ─── Schedule ────────────────────────────────────────────────────────────────

const CronJobSchema = z.object({
  cron: z.string().describe('Cron expression (5 or 6 fields)'),
  timezone: z.string().default('UTC'),
  handler: z.string().optional().describe('Handler function name'),
});

const ScheduleSchema = z.object({
  daily_digest: CronJobSchema.optional(),
  auto_archive: CronJobSchema.optional(),
  cleanup: CronJobSchema.optional(),
}).catchall(CronJobSchema);

// ─── Integrations ────────────────────────────────────────────────────────────

const IntegrationSchema = z.object({
  url: z.string(),
  sync_endpoint: z.string().optional(),
  token: z.string().optional(),
  headers: z.record(z.string()).optional(),
}).catchall(z.unknown());

// ─── Health ──────────────────────────────────────────────────────────────────

const HealthSchema = z.object({
  port: z.number(),
  path: z.string().default('/api/health'),
  management_api: z.boolean().default(true).describe('Enable /api/config, /api/logs, /api/restart'),
});

// ─── Communication ───────────────────────────────────────────────────────────

const SubscriptionSchema = z.object({
  source: z.string().describe('Source bot name'),
  event: z.string().describe('Event type to subscribe to'),
  handler: z.string().optional().describe('Handler function name'),
});

const CommunicationSchema = z.object({
  team: z.string().nullable().default(null).describe('Team name for grouping'),
  subscriptions: z.array(SubscriptionSchema).default([]),
  webhook_port: z.number().optional().describe('Port for receiving inter-bot webhooks'),
});

// ─── Passive Detection ───────────────────────────────────────────────────────

const PassiveDetectionSchema = z.object({
  keywords: z.array(z.string()).default([]),
  patterns: z.array(z.string()).default([]).describe('Regex patterns'),
  case_sensitive: z.boolean().default(false),
});

// ─── Pipeline ────────────────────────────────────────────────────────────────

const PipelineStepSchema = z.object({
  name: z.string(),
  type: z.enum(['llm', 'transform', 'external']),
  provider: z.string().optional(),
  model: z.string().optional(),
  handler: z.string().optional(),
  input: z.string().optional().describe('Input mapping'),
  output: z.string().optional().describe('Output mapping'),
});

const PipelineSchema = z.object({
  name: z.string(),
  trigger: z.string().describe('What triggers this pipeline'),
  steps: z.array(PipelineStepSchema),
});

// ─── Tools ───────────────────────────────────────────────────────────────────

const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  module: z.string().optional().describe('Module path for tool implementation'),
  parameters: z.record(z.object({
    type: z.string(),
    description: z.string().optional(),
    required: z.boolean().optional(),
    enum: z.array(z.string()).optional(),
  })).optional(),
});

// ─── Full Bot Config ─────────────────────────────────────────────────────────

export const BotConfigSchema = z.object({
  name: z.string().min(1),
  version: z.string().default('1.0'),
  description: z.string().optional(),
  enabled: z.boolean().default(true),

  platform: PlatformSchema,
  brain: BrainSchema,

  memory: MemorySchema.optional(),
  resilience: ResilienceSchema.optional(),
  schedule: ScheduleSchema.optional(),
  integrations: z.record(IntegrationSchema).optional(),
  health: HealthSchema.optional(),
  communication: CommunicationSchema.optional(),
  passive_detection: PassiveDetectionSchema.optional(),
  pipelines: z.array(PipelineSchema).optional(),

  tool_definitions: z.array(ToolDefinitionSchema).optional(),

  env_file: z.string().optional().describe('Path to .env file to load'),
});

// ─── Type Exports ────────────────────────────────────────────────────────────

export type BotConfig = z.infer<typeof BotConfigSchema>;
export type Platform = z.infer<typeof PlatformSchema>;
export type TelegramPlatform = z.infer<typeof TelegramPlatformSchema>;
export type SlackPlatform = z.infer<typeof SlackPlatformSchema>;
export type EmailPlatform = z.infer<typeof EmailPlatformSchema>;
export type WebPlatform = z.infer<typeof WebPlatformSchema>;
export type HeadlessPlatform = z.infer<typeof HeadlessPlatformSchema>;
export type Brain = z.infer<typeof BrainSchema>;
export type ClaudeBrain = z.infer<typeof ClaudeBrainSchema>;
export type GeminiBrain = z.infer<typeof GeminiBrainSchema>;
export type Memory = z.infer<typeof MemorySchema>;
export type ConversationHistory = z.infer<typeof ConversationHistorySchema>;
export type ContextBlock = z.infer<typeof ContextBlockSchema>;
export type Resilience = z.infer<typeof ResilienceSchema>;
export type CircuitBreaker = z.infer<typeof CircuitBreakerSchema>;
export type Retry = z.infer<typeof RetrySchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type CronJob = z.infer<typeof CronJobSchema>;
export type Integration = z.infer<typeof IntegrationSchema>;
export type Health = z.infer<typeof HealthSchema>;
export type Communication = z.infer<typeof CommunicationSchema>;
export type Subscription = z.infer<typeof SubscriptionSchema>;
export type PassiveDetection = z.infer<typeof PassiveDetectionSchema>;
export type Pipeline = z.infer<typeof PipelineSchema>;
export type PipelineStep = z.infer<typeof PipelineStepSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
