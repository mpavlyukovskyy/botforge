"use client";
import { useState, useCallback } from "react";
import { GeneralSection } from "./GeneralSection";
import { PlatformSection } from "./PlatformSection";
import { BrainSection } from "./BrainSection";
import { MemorySection } from "./MemorySection";
import { ResilienceSection } from "./ResilienceSection";
import { ScheduleSection } from "./ScheduleSection";
import { IntegrationsSection } from "./IntegrationsSection";
import { HealthSection } from "./HealthSection";
import { PassiveDetectionSection } from "./PassiveDetectionSection";
import { BehaviorSection } from "./BehaviorSection";
import { validateConfig } from "@/lib/api";

interface BotFormProps {
  initialConfig: Record<string, any>;
  isNew: boolean;
  onSave: (config: Record<string, any>) => Promise<void>;
}

export function BotForm({ initialConfig, isNew, onSave }: BotFormProps) {
  const [config, setConfig] = useState<Record<string, any>>(initialConfig);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const update = useCallback((path: string, value: any) => {
    setConfig(prev => {
      const next = { ...prev };
      const keys = path.split(".");
      let obj: any = next;
      for (let i = 0; i < keys.length - 1; i++) {
        if (obj[keys[i]] === undefined || obj[keys[i]] === null) obj[keys[i]] = {};
        obj[keys[i]] = { ...obj[keys[i]] };
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = value;
      return next;
    });
  }, []);

  const handleValidate = async () => {
    setErrors([]);
    setMessage(null);
    const result = await validateConfig(config);
    if (result.valid) {
      setMessage("Config is valid");
    } else {
      setErrors(result.errors || ["Unknown validation error"]);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setErrors([]);
      setMessage(null);
      await onSave(config);
      setMessage("Saved successfully");
    } catch (err) {
      setErrors([err instanceof Error ? err.message : "Save failed"]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 max-w-4xl">
      {errors.length > 0 && (
        <div className="bg-red-900/30 border border-red-800 rounded-lg p-3">
          {errors.map((e, i) => <p key={i} className="text-sm text-red-300">{e}</p>)}
        </div>
      )}
      {message && (
        <div className="bg-green-900/30 border border-green-800 rounded-lg p-3">
          <p className="text-sm text-green-300">{message}</p>
        </div>
      )}

      <GeneralSection config={config} update={update} isNew={isNew} />
      <PlatformSection config={config} update={update} />
      <BrainSection config={config} update={update} />
      <MemorySection config={config} update={update} />
      <ResilienceSection config={config} update={update} />
      <ScheduleSection config={config} update={update} />
      <IntegrationsSection config={config} update={update} />
      <HealthSection config={config} update={update} />
      <BehaviorSection config={config} update={update} />
      <PassiveDetectionSection config={config} update={update} />

      <div className="flex gap-3 pt-4">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
        <button
          onClick={handleValidate}
          className="px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded text-sm"
        >
          Validate
        </button>
      </div>
    </div>
  );
}
