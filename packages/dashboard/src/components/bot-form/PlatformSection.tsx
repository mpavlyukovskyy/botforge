"use client";
import { Section } from "@/components/Section";
import { FormField, Input, Select } from "@/components/FormField";
import { ArrayField } from "@/components/ArrayField";
import { CONFIG_HELP } from "@/lib/config-help";

interface Props { config: Record<string, any>; update: (path: string, value: any) => void; }

export function PlatformSection({ config, update }: Props) {
  const platform = config.platform || {};
  return (
    <Section title="Platform" defaultOpen>
      <FormField label="Type" help={CONFIG_HELP["platform.type"]} helpKey="platform.type">
        <Select value={platform.type || "telegram"} onChange={e => update("platform.type", e.target.value)}>
          <option value="telegram">Telegram</option>
          <option value="slack">Slack</option>
          <option value="email">Email</option>
          <option value="web">Web</option>
          <option value="headless">Headless</option>
        </Select>
      </FormField>
      {platform.type === "telegram" && (
        <>
          <FormField label="Token" help={CONFIG_HELP["platform.token"]} helpKey="platform.token">
            <Input value={platform.token || ""} onChange={e => update("platform.token", e.target.value)} placeholder="${TELEGRAM_BOT_TOKEN}" />
          </FormField>
          <FormField label="Mode" help={CONFIG_HELP["platform.mode"]} helpKey="platform.mode">
            <Select value={platform.mode || "polling"} onChange={e => update("platform.mode", e.target.value)}>
              <option value="polling">Polling</option>
              <option value="webhook">Webhook</option>
            </Select>
          </FormField>
          <ArrayField label="Chat IDs" values={platform.chat_ids || []} onChange={v => update("platform.chat_ids", v)} placeholder="${CHAT_ID}" help={CONFIG_HELP["platform.chat_ids"]} helpKey="platform.chat_ids" />
        </>
      )}
    </Section>
  );
}
