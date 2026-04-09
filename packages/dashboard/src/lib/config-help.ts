import type { HelpEntry } from "@/components/HelpText";

// Help content for all config sections except Behavior (which has its own behavior-help.ts).
// Keyed by config dot-path (same strings used in update() calls).

export const CONFIG_HELP: Record<string, HelpEntry> = {
  // ── General ──
  "general.name": {
    summary: "Unique bot identifier used in logs, health endpoint, and dashboard.",
    detail: "Cannot be changed after creation. Must be unique across all bots in the fleet.",
  },
  "general.version": {
    summary: "Semantic version shown in health endpoint and dashboard.",
  },
  "general.description": {
    summary: "Short description shown on the fleet dashboard card.",
  },
  "general.env_file": {
    summary: "Path to .env file relative to this config.",
    detail: "Variables are available via ${VAR} interpolation in any string field (tokens, chat IDs, etc.).",
    example: "../.env",
  },

  // ── Platform ──
  "platform.type": {
    summary: "Messaging platform. Each type has its own adapter and config options.",
  },
  "platform.token": {
    summary: "Bot API token from your platform provider.",
    detail: "Use ${ENV_VAR} to read from .env instead of hardcoding secrets.",
    example: "${TELEGRAM_BOT_TOKEN}",
  },
  "platform.mode": {
    summary: "How the bot receives messages from Telegram.",
    detail: "Polling checks periodically — simple but adds latency. Webhook requires a public URL for Telegram to push updates in real time.",
    defaultValue: "polling",
  },
  "platform.chat_ids": {
    summary: "Restrict to specific chats. Leave empty to accept all chats the bot is added to.",
    detail: "When set, messages from unlisted chats are silently ignored. The bot auto-detects new groups and notifies admin. Supports ${VAR} syntax.",
  },

  // ── Brain ──
  "brain.provider": {
    summary: "LLM provider for the bot's intelligence.",
    detail: "Claude uses the Agent SDK with MCP tools. Gemini uses REST API (no tool support yet).",
  },
  "brain.model": {
    summary: "Which model to use. Larger models are more capable but slower and costlier.",
  },
  "brain.system_prompt": {
    summary: "Instructions defining personality, rules, and capabilities.",
    detail: "Injected before every user message. Use Inline for short prompts or File for complex ones versioned in git.",
  },
  "brain.tools": {
    summary: "Tools loaded from the bot's tools/ directory.",
    detail: "Listed here for documentation. The runtime loads all files in the tools dir regardless of this list.",
  },
  "brain.temperature": {
    summary: "Controls randomness. 0 = deterministic, 1 = creative.",
    detail: "Ignored for Claude — the Agent SDK controls temperature internally.",
    defaultValue: "0",
  },
  "brain.max_tokens": {
    summary: "Max tokens per response. Higher = longer replies but more cost.",
    defaultValue: "4096",
  },
  "brain.max_iterations": {
    summary: "Max tool-use loops per message. Prevents runaway chains.",
    defaultValue: "5",
  },
  "brain.max_budget_usd": {
    summary: "Cost cap per user message in USD.",
    detail: "The SDK stops mid-response if this budget is exceeded. Set to 0 or leave empty for no limit.",
    defaultValue: "1.00",
  },

  // ── Memory ──
  "memory.conversation_history": {
    summary: "Store and replay recent messages for conversational context.",
    detail: "When enabled, the bot remembers previous messages in each chat and includes them in LLM calls.",
  },
  "memory.conversation_history.ttl_days": {
    summary: "Delete entries older than this. Keeps the database small.",
    defaultValue: "14",
  },
  "memory.conversation_history.max_messages": {
    summary: "Max messages injected per chat. Older messages are trimmed.",
    defaultValue: "100",
  },

  // ── Resilience ──
  "resilience.circuit_breaker": {
    summary: "Stop calling the LLM after repeated failures.",
    detail: "Prevents cascading errors and wasted API spend when the provider is down.",
  },
  "resilience.circuit_breaker.threshold": {
    summary: "Consecutive failures before the circuit opens.",
    defaultValue: "5",
  },
  "resilience.circuit_breaker.reset_timeout_ms": {
    summary: "How long the circuit stays open before retrying.",
    defaultValue: "30000",
  },
  "resilience.retry": {
    summary: "Auto-retry failed API calls with backoff.",
    detail: "Only retries on transient HTTP codes (below). Permanent failures are not retried.",
  },
  "resilience.retry.max_attempts": {
    summary: "Total attempts including the initial call. 3 = 1 try + 2 retries.",
    defaultValue: "3",
  },
  "resilience.retry.backoff": {
    summary: "Delay strategy between retries.",
    detail: "Exponential doubles each time. Linear adds a fixed delay. Fixed waits the same amount.",
    defaultValue: "exponential",
  },
  "resilience.retry.transient_codes": {
    summary: "HTTP status codes that trigger a retry. Others are treated as permanent failures.",
    example: "429, 502, 503",
  },

  // ── Health ──
  "health.port": {
    summary: "Port for the HTTP health endpoint. Each bot needs a unique port.",
    defaultValue: "9003",
  },
  "health.path": {
    summary: "URL path the dashboard polls for bot status.",
    defaultValue: "/api/health",
  },

};

// Static descriptions for dynamic-entry sections (not per-field help).
export const SECTION_DESCRIPTIONS: Record<string, string> = {
  schedule: "Cron jobs execute registered skill handlers. Job names must match a handler (e.g., daily_digest, auto_archive).",
  integrations: "External service connections. The bot's tools use these for API calls. Token supports ${VAR} interpolation.",
  context_blocks: "Custom XML blocks injected into every LLM call. Each block requires a registered handler in a skill to populate it.",
};
