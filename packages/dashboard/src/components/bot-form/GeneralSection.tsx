"use client";
import { Section } from "@/components/Section";
import { FormField, Input } from "@/components/FormField";

interface Props { config: Record<string, any>; update: (path: string, value: any) => void; isNew: boolean; }

export function GeneralSection({ config, update, isNew }: Props) {
  return (
    <Section title="General" defaultOpen>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Name">
          <Input value={config.name || ""} onChange={e => update("name", e.target.value)} disabled={!isNew} placeholder="my-bot" />
        </FormField>
        <FormField label="Version">
          <Input value={config.version || "1.0"} onChange={e => update("version", e.target.value)} />
        </FormField>
      </div>
      <FormField label="Description">
        <Input value={config.description || ""} onChange={e => update("description", e.target.value)} placeholder="What does this bot do?" />
      </FormField>
      <FormField label="Env File" description="Relative path to .env file">
        <Input value={config.env_file || ""} onChange={e => update("env_file", e.target.value)} placeholder="../.env" />
      </FormField>
    </Section>
  );
}
