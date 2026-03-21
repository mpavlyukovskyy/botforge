"use client";
import { Section } from "@/components/Section";
import { ArrayField } from "@/components/ArrayField";

interface Props { config: Record<string, any>; update: (path: string, value: any) => void; }

export function PassiveDetectionSection({ config, update }: Props) {
  const pd = config.passive_detection;

  return (
    <Section
      title="Passive Detection"
      enabled={!!pd}
      onToggle={enabled => update("passive_detection", enabled ? { keywords: [], case_sensitive: false } : undefined)}
    >
      {pd && (
        <>
          <ArrayField label="Keywords" values={pd.keywords || []} onChange={v => update("passive_detection.keywords", v)} placeholder="keyword" />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={pd.case_sensitive || false} onChange={e => update("passive_detection.case_sensitive", e.target.checked)} className="accent-blue-500" />
            <span className="text-gray-300">Case Sensitive</span>
          </label>
        </>
      )}
    </Section>
  );
}
