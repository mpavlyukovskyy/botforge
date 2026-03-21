import type { HelpEntry } from "@/components/HelpText";

// Help content for BehaviorSection settings.
// Keyed by config dot-path (same strings used in update() calls).
// NOTE: Covers UI-rendered fields only. Schema fields not in UI
// (bot_username, ignore_own_messages, patterns) are not included.

export const BEHAVIOR_HELP: Record<string, HelpEntry> = {
  // ── Reception ──
  "behavior.reception.dm_mode": {
    summary: "How the bot handles direct messages.",
    detail: "\"Always\" responds to every DM. \"Keyword only\" requires a trigger word. \"Ignore\" silently drops all DMs.",
    defaultValue: "always",
  },
  "behavior.reception.group_mode": {
    summary: "How the bot handles group chat messages.",
    detail: "\"Passive\" only responds to keywords, replies, and @mentions. \"Always\" responds to every message. \"Ignore\" disables group chats entirely.",
    defaultValue: "passive",
  },
  "behavior.reception.respond_to_replies": {
    summary: "Reply when someone responds to one of the bot's messages.",
    example: "User replies to the bot's answer — bot continues the thread.",
    defaultValue: "true",
  },
  "behavior.reception.respond_to_mentions": {
    summary: "Reply when someone @mentions the bot.",
    example: "\"@MyBot what's the status?\" triggers a response.",
    defaultValue: "true",
  },
  "behavior.reception.conversation_timeout_min": {
    summary: "Reset chat history after N minutes of inactivity.",
    detail: "Set to 0 to keep history indefinitely within a session. Useful to avoid stale context in long-running chats.",
    defaultValue: "0",
  },
  "behavior.reception.keywords": {
    summary: "Trigger words that activate the bot in keyword mode.",
    detail: "Only used when DM or group mode is set to \"keyword_only\" or \"passive\". The bot checks each incoming message for these words.",
    example: "\"help\", \"support\", \"order\" — bot responds when any appear.",
  },
  "behavior.reception.case_sensitive": {
    summary: "Match keywords with exact upper/lowercase.",
    detail: "Off by default — \"Help\" and \"help\" both trigger. Turn on if you need precise matching.",
    defaultValue: "false",
  },

  // ── Response ──
  "behavior.response.typing_indicator": {
    summary: "Show \"typing...\" while the bot generates a reply.",
    detail: "Makes the bot feel more human. Disable if your bot serves rapid-fire automated responses.",
    defaultValue: "true",
  },
  "behavior.response.markdown": {
    summary: "Send replies with Markdown formatting.",
    detail: "Enables bold, italic, code blocks, and lists in Telegram. Some clients render Markdown poorly — disable if users report garbled text.",
    defaultValue: "true",
  },
  "behavior.response.markdown_fallback": {
    summary: "Retry as plain text if Markdown fails to send.",
    detail: "Telegram rejects malformed Markdown. This retries the same message without formatting so the user still gets a reply.",
    defaultValue: "true",
  },
  "behavior.response.max_message_length": {
    summary: "Split long replies at sentence boundaries.",
    detail: "Telegram caps messages at 4096 chars. The bot chunks longer replies into multiple messages, splitting at sentence ends for readability.",
    defaultValue: "4096",
  },
  "behavior.response.disable_link_preview": {
    summary: "Suppress URL preview cards in bot messages.",
    detail: "Telegram auto-generates preview cards for links. Disable to keep messages compact when the bot frequently shares URLs.",
    defaultValue: "false",
  },

  // ── Concurrency ──
  "behavior.concurrency.chat_lock": {
    summary: "Process one message at a time per chat.",
    detail: "Queues incoming messages so the bot finishes replying before handling the next. Prevents race conditions but adds latency under load.",
    defaultValue: "false",
  },
  "behavior.concurrency.rate_limit_per_user": {
    summary: "Max messages per user in the rate window (0 = off).",
    detail: "Protects against spam. Excess messages are silently dropped until the window resets.",
    defaultValue: "0",
  },
  "behavior.concurrency.rate_limit_window_seconds": {
    summary: "Time window for the per-user rate limit.",
    detail: "Combined with rate limit above. E.g., 5 messages per 60 seconds.",
    defaultValue: "60",
  },

  // ── Continuity ──
  "behavior.continuity.pending_questions": {
    summary: "Track unanswered questions across messages.",
    detail: "The bot remembers questions it asked and re-prompts if the user changes topic. Stored in memory — lost on restart.",
    defaultValue: "false",
  },
  "behavior.continuity.reply_context": {
    summary: "Include quoted message text in the bot's context.",
    detail: "When a user replies to an older message, the bot sees both the reply and the original. Helps maintain coherent threads.",
    defaultValue: "false",
  },
  "behavior.continuity.numbered_refs": {
    summary: "Let users reference items by number ([1], #1).",
    detail: "The bot assigns numbers to entities (links, files, results) and maps shorthand references back to the original item.",
    defaultValue: "false",
  },

  // ── Startup ──
  "behavior.startup.announce_restart": {
    summary: "Notify recent chats when the bot restarts.",
    detail: "Sends the recovery message (below) to all chats active before the restart. Useful so users know to re-ask if a reply was lost.",
    defaultValue: "false",
  },
  "behavior.startup.recovery_message": {
    summary: "Message sent to recent chats on restart.",
    detail: "Only sent when \"Announce restart\" is enabled. Leave blank to use a generic default.",
    example: "\"I'm back online! What were we discussing?\"",
  },
};

export const SUBSECTION_HELP: Record<string, string> = {
  reception: "Controls when and how your bot responds to messages.",
  message_types: "Choose which message types your bot processes. Disabled types are silently ignored.",
  response: "How the bot formats and delivers its responses.",
  concurrency: "Handle multiple messages arriving at once.",
  continuity: "Help the bot maintain context across a conversation.",
  startup: "What happens when the bot restarts.",
};
