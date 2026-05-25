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

// T3.1: Slack/Email/Web/Headless platform schemas were vaporware (no runtime).
// Removed after confirming no bot YAML used them. Reintroduce per-platform
// when there's a real adapter implementation.

const PlatformSchema = TelegramPlatformSchema;

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
  budget_usd_per_day: z.number().positive().optional().describe('Per-day cumulative spend cap; refuse new calls when exceeded'),
});

const ClaudeCliBrainSchema = z.object({
  provider: z.literal('claude-cli'),
  model: z.string().default('claude-sonnet-4-6'),
  system_prompt: z.string().optional(),
  system_prompt_file: z.string().optional().describe('Path to system prompt file'),
  tools: z.array(z.string()).default([]),
  temperature: z.number().min(0).max(1).default(0),
  max_tokens: z.number().positive().default(4096),
  max_iterations: z.number().positive().optional().describe('Max tool-calling turns (default 5)'),
  budget_usd_per_day: z.number().positive().optional().describe('Per-day cumulative spend cap'),
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
  ClaudeCliBrainSchema,
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
  /** HTTP codes that should immediately alert (no retry). Auth failures = operator action needed. */
  alert_immediately_codes: z.array(z.number()).default([401, 403]),
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
  /**
   * When true, if the process crashed mid-handler the cron-scheduler skill
   * will re-invoke the handler on next startup. Default false — most cron
   * handlers send user-visible messages and a replay would duplicate them.
   * Opt in per job only for handlers known to be idempotent.
   */
  replay_on_crash: z.boolean().default(false),
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

const HeartbeatSchema = z.object({
  poll_url: z.string().optional().describe('Uptime Kuma push URL fired every poll_interval_ms'),
  poll_interval_ms: z.number().positive().default(60_000),
  cron_urls: z.record(z.string()).optional().describe('Per-cron push URLs keyed on cron job name'),
});

const HealthSchema = z.object({
  port: z.number(),
  path: z.string().default('/api/health'),
  management_api: z.boolean().default(true).describe('Enable /api/config, /api/logs, /api/restart'),
  heartbeat: HeartbeatSchema.optional(),
});

const InboxSchema = z.object({
  enabled: z.boolean().default(true),
  processing_timeout_ms: z.number().positive().default(30_000),
});

const OutboxSchema = z.object({
  enabled: z.boolean().default(true),
  poll_interval_ms: z.number().positive().default(250),
});

const DlqSchema = z.object({
  enabled: z.boolean().default(true),
});

const BackupSchema = z.object({
  enabled: z.boolean().default(false),
  target_host: z.string().optional(),
  target_dir: z.string().optional(),
  local_retention_days: z.number().positive().default(7),
});

const WorkspaceMonitorSchema = z.object({
  enabled: z.boolean().default(false),
  cap_usd: z.number().positive().optional().describe('Daily workspace cap; falls back to ANTHROPIC_WORKSPACE_CAP_USD env'),
  assumed_workspace_share: z.number().positive().max(1).default(1),
  admin_chat_id: z.string().optional(),
});

// ─── Tool Server ────────────────────────────────────────────────────────

const ToolServerSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number(),
  auth_token: z.string().optional().describe('Bearer token for auth, supports ${ENV_VAR} interpolation'),
});

// T3.1: CommunicationSchema + SubscriptionSchema removed — no inter-bot
// webhook runtime ever existed. Bots that need to coordinate use the
// Atlas/Spok API (Tier 4 ack).

// ─── Behavior ────────────────────────────────────────────────────────────────

const ReceptionSchema = z.object({
  dm_mode: z.enum(['always', 'ignore', 'keyword_only']).default('always'),
  group_mode: z.enum(['passive', 'always', 'ignore']).default('passive'),
  respond_to_replies: z.boolean().default(true),
  respond_to_mentions: z.boolean().default(true),
  bot_username: z.string().optional().describe('Auto-detected if empty'),
  ignore_own_messages: z.boolean().default(true),
  conversation_timeout_min: z.number().nonnegative().default(0),
  keywords: z.array(z.string()).default([]),
  patterns: z.array(z.string()).default([]),
  case_sensitive: z.boolean().default(false),
});

const MessageTypesSchema = z.object({
  text: z.boolean().default(true),
  voice: z.boolean().default(false),
  audio: z.boolean().default(false),
  photo: z.boolean().default(false),
  document: z.boolean().default(false),
  video: z.boolean().default(false),
  command: z.boolean().default(true),
});

const ResponseBehaviorSchema = z.object({
  typing_indicator: z.boolean().default(true),
  markdown: z.boolean().default(true),
  markdown_fallback: z.boolean().default(true).describe('Retry as plain text on Markdown parse error'),
  max_message_length: z.number().positive().default(4096).describe('Chunk at sentence boundaries'),
  disable_link_preview: z.boolean().default(false),
});

const ConcurrencySchema = z.object({
  chat_lock: z.boolean().default(false).describe('Per-chat mutex'),
  rate_limit_per_user: z.number().nonnegative().default(0).describe('msg/min (0 = unlimited)'),
  rate_limit_window_seconds: z.number().positive().default(60),
});

const ContinuitySchema = z.object({
  pending_questions: z.boolean().default(false).describe('In-memory tracking, lost on restart'),
  reply_context: z.boolean().default(false).describe('Inject replied-to message text into brain context'),
  numbered_refs: z.boolean().default(false).describe('[1],[2] shorthand → entity ID mapping'),
});

const StartupSchema = z.object({
  announce_restart: z.boolean().default(false),
  recovery_message: z.string().default(''),
});

// ── Phase D schemas (validate in YAML, runtime warns "not enforced") ──

const AccessSchema = z.object({
  admin_users: z.array(z.string()).default([]),
  blocked_users: z.array(z.string()).default([]),
  restrict_to_allowlist: z.boolean().default(false),
  allowed_users: z.array(z.string()).default([]),
});

// T3.1: GuardrailsSchema, EscalationSchema, AvailabilitySchema,
// OnboardingSchema, WebhooksSchema, I18nSchema, FallbackSchema were
// 'Phase D' fields with no runtime enforcement. Removed.

const BehaviorSchema = z.object({
  reception: ReceptionSchema.optional(),
  message_types: MessageTypesSchema.optional(),
  response: ResponseBehaviorSchema.optional(),
  concurrency: ConcurrencySchema.optional(),
  continuity: ContinuitySchema.optional(),
  startup: StartupSchema.optional(),
  access: AccessSchema.optional(),
});

// T3.1: PipelineSchema / PipelineStepSchema removed — the runtime never
// implemented pipelines; babushka's standalone codebase manages its own
// audio pipeline outside the framework.

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
  tool_server: ToolServerSchema.optional(),
  behavior: BehaviorSchema.optional(),

  // Tier 2 skills — opt-in / opt-out via these blocks.
  inbox: InboxSchema.optional(),
  outbox: OutboxSchema.optional(),
  dlq: DlqSchema.optional(),
  backup: BackupSchema.optional(),
  workspace_monitor: WorkspaceMonitorSchema.optional(),

  tool_definitions: z.array(ToolDefinitionSchema).optional(),

  env_file: z.string().optional().describe('Path to .env file to load'),
});

// ─── Type Exports ────────────────────────────────────────────────────────────

export type BotConfig = z.infer<typeof BotConfigSchema>;
export type Platform = z.infer<typeof PlatformSchema>;
export type TelegramPlatform = z.infer<typeof TelegramPlatformSchema>;
export type Brain = z.infer<typeof BrainSchema>;
export type ClaudeBrain = z.infer<typeof ClaudeBrainSchema>;
export type ClaudeCliBrain = z.infer<typeof ClaudeCliBrainSchema>;
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
export type ToolServer = z.infer<typeof ToolServerSchema>;
export type Behavior = z.infer<typeof BehaviorSchema>;
export type Reception = z.infer<typeof ReceptionSchema>;
export type MessageTypes = z.infer<typeof MessageTypesSchema>;
export type ResponseBehavior = z.infer<typeof ResponseBehaviorSchema>;
export type Concurrency = z.infer<typeof ConcurrencySchema>;
export type Continuity = z.infer<typeof ContinuitySchema>;
export type Startup = z.infer<typeof StartupSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
