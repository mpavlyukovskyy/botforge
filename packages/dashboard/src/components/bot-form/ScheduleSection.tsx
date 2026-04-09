"use client";
import { Section } from "@/components/Section";
import { FormField, Input } from "@/components/FormField";
import { SECTION_DESCRIPTIONS } from "@/lib/config-help";

interface Props { config: Record<string, any>; update: (path: string, value: any) => void; }

export function ScheduleSection({ config, update }: Props) {
  const schedule = config.schedule || {};
  const entries = Object.entries(schedule) as [string, any][];

  const addEntry = () => {
    const name = `job_${Date.now()}`;
    update("schedule", { ...schedule, [name]: { cron: "0 * * * *", timezone: "UTC" } });
  };
  const removeEntry = (name: string) => {
    const next = { ...schedule };
    delete next[name];
    update("schedule", next);
  };
  const updateEntry = (oldName: string, field: string, value: string) => {
    if (field === "_name") {
      const next: Record<string, any> = {};
      for (const [k, v] of Object.entries(schedule)) {
        next[k === oldName ? value : k] = v;
      }
      update("schedule", next);
    } else {
      update(`schedule.${oldName}.${field}`, value);
    }
  };

  return (
    <Section title="Schedule">
      <p className="text-xs text-gray-500">{SECTION_DESCRIPTIONS.schedule}</p>
      {entries.map(([name, job]) => (
        <div key={name} className="flex gap-2 items-end">
          <FormField label="Name">
            <Input value={name} onChange={e => updateEntry(name, "_name", e.target.value)} />
          </FormField>
          <FormField label="Cron">
            <Input value={job.cron || ""} onChange={e => updateEntry(name, "cron", e.target.value)} placeholder="0 * * * *" />
          </FormField>
          <FormField label="Timezone">
            <Input value={job.timezone || "UTC"} onChange={e => updateEntry(name, "timezone", e.target.value)} />
          </FormField>
          <button type="button" onClick={() => removeEntry(name)} className="text-red-400 hover:text-red-300 text-sm px-2 pb-2">&times;</button>
        </div>
      ))}
      <button type="button" onClick={addEntry} className="text-xs text-blue-400 hover:text-blue-300">+ Add Schedule</button>
    </Section>
  );
}
