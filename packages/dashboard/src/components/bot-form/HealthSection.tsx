"use client";
import { Section } from "@/components/Section";
import { FormField, Input } from "@/components/FormField";

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
          <FormField label="Port">
            <Input type="number" value={health.port || 9003} onChange={e => update("health.port", parseInt(e.target.value))} />
          </FormField>
          <FormField label="Path">
            <Input value={health.path || "/api/health"} onChange={e => update("health.path", e.target.value)} />
          </FormField>
        </div>
      )}
    </Section>
  );
}
