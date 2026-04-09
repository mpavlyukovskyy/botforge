"use client";
import { Section } from "@/components/Section";
import { FormField, Input } from "@/components/FormField";
import { CONFIG_HELP } from "@/lib/config-help";

interface Props { config: Record<string, any>; update: (path: string, value: any) => void; }

export function HealthSection({ config, update }: Props) {
  const health = config.health;

  return (
    <Section
      title="Health Endpoint"
      enabled={!!health}
      onToggle={enabled => update("health", enabled ? { port: 9003, path: "/api/health" } : undefined)}
    >
      {health && (
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Port" help={CONFIG_HELP["health.port"]} helpKey="health.port">
            <Input type="number" value={health.port || 9003} onChange={e => update("health.port", parseInt(e.target.value))} />
          </FormField>
          <FormField label="Path" help={CONFIG_HELP["health.path"]} helpKey="health.path">
            <Input value={health.path || "/api/health"} onChange={e => update("health.path", e.target.value)} />
          </FormField>
        </div>
      )}
    </Section>
  );
}
