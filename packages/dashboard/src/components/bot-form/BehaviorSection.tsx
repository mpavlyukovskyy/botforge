"use client";
import { Section } from "@/components/Section";
import { FormField, Input, Select } from "@/components/FormField";
import { ArrayField } from "@/components/ArrayField";
import { CheckboxField } from "@/components/CheckboxField";
import { BEHAVIOR_HELP, SUBSECTION_HELP } from "@/lib/behavior-help";

interface Props {
  config: Record<string, any>;
  update: (path: string, value: any) => void;
}

export function BehaviorSection({ config, update }: Props) {
  const behavior = config.behavior;

  return (
    <Section
      title="Behavior"
      enabled={!!behavior}
      onToggle={enabled => update("behavior", enabled ? {} : undefined)}
    >
      {behavior && (
        <div className="space-y-6">
          {/* ── Reception ── */}
          <div className="border border-gray-800 rounded p-3 space-y-3">
            <h4 className="text-sm font-medium text-gray-300">Reception</h4>
            <p className="text-xs text-gray-500">{SUBSECTION_HELP.reception}</p>

            <FormField label="DM Mode" help={BEHAVIOR_HELP["behavior.reception.dm_mode"]} helpKey="behavior.reception.dm_mode">
              <Select
                value={behavior.reception?.dm_mode ?? "always"}
                onChange={e => update("behavior.reception.dm_mode", e.target.value)}
              >
                <option value="always">Always respond</option>
                <option value="ignore">Ignore DMs</option>
                <option value="keyword_only">Keyword only</option>
              </Select>
            </FormField>

            <FormField label="Group Mode" help={BEHAVIOR_HELP["behavior.reception.group_mode"]} helpKey="behavior.reception.group_mode">
              <Select
                value={behavior.reception?.group_mode ?? "passive"}
                onChange={e => update("behavior.reception.group_mode", e.target.value)}
              >
                <option value="passive">Passive (keywords, replies, mentions)</option>
                <option value="always">Always respond</option>
                <option value="ignore">Ignore groups</option>
              </Select>
            </FormField>

            <CheckboxField
              label="Respond to replies to this bot"
              checked={behavior.reception?.respond_to_replies ?? true}
              onChange={v => update("behavior.reception.respond_to_replies", v)}
              help={BEHAVIOR_HELP["behavior.reception.respond_to_replies"]}
              helpKey="behavior.reception.respond_to_replies"
            />

            <CheckboxField
              label="Respond to @mentions"
              checked={behavior.reception?.respond_to_mentions ?? true}
              onChange={v => update("behavior.reception.respond_to_mentions", v)}
              help={BEHAVIOR_HELP["behavior.reception.respond_to_mentions"]}
              helpKey="behavior.reception.respond_to_mentions"
            />

            <FormField label="Conversation Timeout (min)" help={BEHAVIOR_HELP["behavior.reception.conversation_timeout_min"]} helpKey="behavior.reception.conversation_timeout_min">
              <Input
                type="number"
                min={0}
                value={behavior.reception?.conversation_timeout_min ?? 0}
                onChange={e => update("behavior.reception.conversation_timeout_min", parseInt(e.target.value) || 0)}
              />
            </FormField>

            <ArrayField
              label="Keywords"
              values={behavior.reception?.keywords ?? []}
              onChange={v => update("behavior.reception.keywords", v)}
              placeholder="keyword"
              help={BEHAVIOR_HELP["behavior.reception.keywords"]}
              helpKey="behavior.reception.keywords"
            />

            <CheckboxField
              label="Case Sensitive"
              checked={behavior.reception?.case_sensitive ?? false}
              onChange={v => update("behavior.reception.case_sensitive", v)}
              help={BEHAVIOR_HELP["behavior.reception.case_sensitive"]}
              helpKey="behavior.reception.case_sensitive"
            />
          </div>

          {/* ── Message Types ── */}
          <div className="border border-gray-800 rounded p-3 space-y-2">
            <h4 className="text-sm font-medium text-gray-300">Message Types</h4>
            <p className="text-xs text-gray-500">{SUBSECTION_HELP.message_types}</p>
            {(["text", "voice", "audio", "photo", "document", "video", "command"] as const).map(type => (
              <CheckboxField
                key={type}
                label={type.charAt(0).toUpperCase() + type.slice(1)}
                checked={behavior.message_types?.[type] ?? (type === "text" || type === "command")}
                onChange={v => update(`behavior.message_types.${type}`, v)}
              />
            ))}
          </div>

          {/* ── Response ── */}
          <div className="border border-gray-800 rounded p-3 space-y-3">
            <h4 className="text-sm font-medium text-gray-300">Response</h4>
            <p className="text-xs text-gray-500">{SUBSECTION_HELP.response}</p>

            <CheckboxField
              label="Typing indicator"
              checked={behavior.response?.typing_indicator ?? true}
              onChange={v => update("behavior.response.typing_indicator", v)}
              help={BEHAVIOR_HELP["behavior.response.typing_indicator"]}
              helpKey="behavior.response.typing_indicator"
            />

            <CheckboxField
              label="Markdown formatting"
              checked={behavior.response?.markdown ?? true}
              onChange={v => update("behavior.response.markdown", v)}
              help={BEHAVIOR_HELP["behavior.response.markdown"]}
              helpKey="behavior.response.markdown"
            />

            <CheckboxField
              label="Markdown fallback (retry as plain text)"
              checked={behavior.response?.markdown_fallback ?? true}
              onChange={v => update("behavior.response.markdown_fallback", v)}
              help={BEHAVIOR_HELP["behavior.response.markdown_fallback"]}
              helpKey="behavior.response.markdown_fallback"
            />

            <FormField label="Max Message Length" help={BEHAVIOR_HELP["behavior.response.max_message_length"]} helpKey="behavior.response.max_message_length">
              <Input
                type="number"
                min={100}
                value={behavior.response?.max_message_length ?? 4096}
                onChange={e => update("behavior.response.max_message_length", parseInt(e.target.value) || 4096)}
              />
            </FormField>

            <CheckboxField
              label="Disable link preview"
              checked={behavior.response?.disable_link_preview ?? false}
              onChange={v => update("behavior.response.disable_link_preview", v)}
              help={BEHAVIOR_HELP["behavior.response.disable_link_preview"]}
              helpKey="behavior.response.disable_link_preview"
            />
          </div>

          {/* ── Concurrency ── */}
          <div className="border border-gray-800 rounded p-3 space-y-3">
            <h4 className="text-sm font-medium text-gray-300">Concurrency</h4>
            <p className="text-xs text-gray-500">{SUBSECTION_HELP.concurrency}</p>

            <CheckboxField
              label="Per-chat lock (serialize messages)"
              checked={behavior.concurrency?.chat_lock ?? false}
              onChange={v => update("behavior.concurrency.chat_lock", v)}
              help={BEHAVIOR_HELP["behavior.concurrency.chat_lock"]}
              helpKey="behavior.concurrency.chat_lock"
            />

            <FormField label="Rate Limit (per user, msg/min)" help={BEHAVIOR_HELP["behavior.concurrency.rate_limit_per_user"]} helpKey="behavior.concurrency.rate_limit_per_user">
              <Input
                type="number"
                min={0}
                value={behavior.concurrency?.rate_limit_per_user ?? 0}
                onChange={e => update("behavior.concurrency.rate_limit_per_user", parseInt(e.target.value) || 0)}
              />
            </FormField>

            <FormField label="Rate Limit Window (seconds)" help={BEHAVIOR_HELP["behavior.concurrency.rate_limit_window_seconds"]} helpKey="behavior.concurrency.rate_limit_window_seconds">
              <Input
                type="number"
                min={1}
                value={behavior.concurrency?.rate_limit_window_seconds ?? 60}
                onChange={e => update("behavior.concurrency.rate_limit_window_seconds", parseInt(e.target.value) || 60)}
              />
            </FormField>
          </div>

          {/* ── Continuity ── */}
          <div className="border border-gray-800 rounded p-3 space-y-2">
            <h4 className="text-sm font-medium text-gray-300">Continuity</h4>
            <p className="text-xs text-gray-500">{SUBSECTION_HELP.continuity}</p>

            <CheckboxField
              label="Pending questions tracking"
              checked={behavior.continuity?.pending_questions ?? false}
              onChange={v => update("behavior.continuity.pending_questions", v)}
              help={BEHAVIOR_HELP["behavior.continuity.pending_questions"]}
              helpKey="behavior.continuity.pending_questions"
            />

            <CheckboxField
              label="Reply context injection"
              checked={behavior.continuity?.reply_context ?? false}
              onChange={v => update("behavior.continuity.reply_context", v)}
              help={BEHAVIOR_HELP["behavior.continuity.reply_context"]}
              helpKey="behavior.continuity.reply_context"
            />

            <CheckboxField
              label="Numbered references ([1], #1)"
              checked={behavior.continuity?.numbered_refs ?? false}
              onChange={v => update("behavior.continuity.numbered_refs", v)}
              help={BEHAVIOR_HELP["behavior.continuity.numbered_refs"]}
              helpKey="behavior.continuity.numbered_refs"
            />
          </div>

          {/* ── Startup ── */}
          <div className="border border-gray-800 rounded p-3 space-y-3">
            <h4 className="text-sm font-medium text-gray-300">Startup</h4>
            <p className="text-xs text-gray-500">{SUBSECTION_HELP.startup}</p>

            <CheckboxField
              label="Announce restart to recent chats"
              checked={behavior.startup?.announce_restart ?? false}
              onChange={v => update("behavior.startup.announce_restart", v)}
              help={BEHAVIOR_HELP["behavior.startup.announce_restart"]}
              helpKey="behavior.startup.announce_restart"
            />

            <FormField label="Recovery Message" help={BEHAVIOR_HELP["behavior.startup.recovery_message"]} helpKey="behavior.startup.recovery_message">
              <Input
                value={behavior.startup?.recovery_message ?? ""}
                onChange={e => update("behavior.startup.recovery_message", e.target.value)}
                placeholder="I'm back online! What were we discussing?"
              />
            </FormField>
          </div>
        </div>
      )}
    </Section>
  );
}
