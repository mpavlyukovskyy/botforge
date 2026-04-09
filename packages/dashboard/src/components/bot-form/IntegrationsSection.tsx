"use client";
import { Section } from "@/components/Section";
import { FormField, Input } from "@/components/FormField";
import { SECTION_DESCRIPTIONS } from "@/lib/config-help";

interface Props { config: Record<string, any>; update: (path: string, value: any) => void; }

export function IntegrationsSection({ config, update }: Props) {
  const integrations = config.integrations || {};
  const entries = Object.entries(integrations) as [string, any][];

  const addEntry = () => {
    const name = `integration_${Date.now()}`;
    update("integrations", { ...integrations, [name]: { url: "", sync_endpoint: "", token: "" } });
  };
  const removeEntry = (name: string) => {
    const next = { ...integrations };
    delete next[name];
    update("integrations", Object.keys(next).length ? next : undefined);
  };

  return (
    <Section title="Integrations">
      <p className="text-xs text-gray-500">{SECTION_DESCRIPTIONS.integrations}</p>
      {entries.map(([name, int]) => (
        <div key={name} className="border border-gray-800 rounded p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-300">{name}</span>
            <button type="button" onClick={() => removeEntry(name)} className="text-red-400 hover:text-red-300 text-xs">Remove</button>
          </div>
          <FormField label="URL">
            <Input value={int.url || ""} onChange={e => update(`integrations.${name}.url`, e.target.value)} placeholder="https://api.example.com" />
          </FormField>
          <FormField label="Sync Endpoint">
            <Input value={int.sync_endpoint || ""} onChange={e => update(`integrations.${name}.sync_endpoint`, e.target.value)} placeholder="/api/sync" />
          </FormField>
          <FormField label="Token">
            <Input value={int.token || ""} onChange={e => update(`integrations.${name}.token`, e.target.value)} placeholder="${API_TOKEN}" />
          </FormField>
        </div>
      ))}
      <button type="button" onClick={addEntry} className="text-xs text-blue-400 hover:text-blue-300">+ Add Integration</button>
    </Section>
  );
}
