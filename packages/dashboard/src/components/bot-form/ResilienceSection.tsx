"use client";
import { Section } from "@/components/Section";
import { FormField, Input, Select } from "@/components/FormField";
import { ArrayField } from "@/components/ArrayField";
import { HelpText } from "@/components/HelpText";
import { CONFIG_HELP } from "@/lib/config-help";

interface Props { config: Record<string, any>; update: (path: string, value: any) => void; }

export function ResilienceSection({ config, update }: Props) {
  const resilience = config.resilience || {};
  const cb = resilience.circuit_breaker;
  const retry = resilience.retry;

  return (
    <Section title="Resilience">
      <div className="space-y-4">
        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!cb} onChange={e => update("resilience.circuit_breaker", e.target.checked ? { threshold: 5, reset_timeout_ms: 30000 } : undefined)} className="accent-blue-500" />
            <span className="text-gray-300">Circuit Breaker</span>
          </label>
          <div className="ml-6">
            <HelpText {...CONFIG_HELP["resilience.circuit_breaker"]} helpKey="resilience.circuit_breaker" />
          </div>
          {cb && (
            <div className="grid grid-cols-2 gap-4 pl-6">
              <FormField label="Threshold" help={CONFIG_HELP["resilience.circuit_breaker.threshold"]} helpKey="resilience.circuit_breaker.threshold">
                <Input type="number" min={1} value={cb.threshold || 5} onChange={e => update("resilience.circuit_breaker.threshold", parseInt(e.target.value))} />
              </FormField>
              <FormField label="Reset Timeout (ms)" help={CONFIG_HELP["resilience.circuit_breaker.reset_timeout_ms"]} helpKey="resilience.circuit_breaker.reset_timeout_ms">
                <Input type="number" min={1000} value={cb.reset_timeout_ms || 30000} onChange={e => update("resilience.circuit_breaker.reset_timeout_ms", parseInt(e.target.value))} />
              </FormField>
            </div>
          )}
        </div>

        <div className="space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!retry} onChange={e => update("resilience.retry", e.target.checked ? { max_attempts: 3, backoff: "exponential", transient_codes: [429, 502, 503, 504] } : undefined)} className="accent-blue-500" />
            <span className="text-gray-300">Retry</span>
          </label>
          <div className="ml-6">
            <HelpText {...CONFIG_HELP["resilience.retry"]} helpKey="resilience.retry" />
          </div>
          {retry && (
            <div className="pl-6 space-y-3">
              <div className="grid grid-cols-2 gap-4">
                <FormField label="Max Attempts" help={CONFIG_HELP["resilience.retry.max_attempts"]} helpKey="resilience.retry.max_attempts">
                  <Input type="number" min={1} value={retry.max_attempts || 3} onChange={e => update("resilience.retry.max_attempts", parseInt(e.target.value))} />
                </FormField>
                <FormField label="Backoff" help={CONFIG_HELP["resilience.retry.backoff"]} helpKey="resilience.retry.backoff">
                  <Select value={retry.backoff || "exponential"} onChange={e => update("resilience.retry.backoff", e.target.value)}>
                    <option value="exponential">Exponential</option>
                    <option value="linear">Linear</option>
                    <option value="fixed">Fixed</option>
                  </Select>
                </FormField>
              </div>
              <ArrayField
                label="Transient Status Codes"
                values={(retry.transient_codes || []).map(String)}
                onChange={v => update("resilience.retry.transient_codes", v.map(Number).filter(n => !isNaN(n)))}
                placeholder="429"
                help={CONFIG_HELP["resilience.retry.transient_codes"]}
                helpKey="resilience.retry.transient_codes"
              />
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}
