"use client";
import { Input } from "./FormField";

interface KeyValueFieldProps {
  label: string;
  entries: Record<string, string>;
  onChange: (entries: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

export function KeyValueField({ label, entries, onChange, keyPlaceholder = "key", valuePlaceholder = "value" }: KeyValueFieldProps) {
  const pairs = Object.entries(entries);

  const add = () => onChange({ ...entries, "": "" });
  const remove = (key: string) => {
    const next = { ...entries };
    delete next[key];
    onChange(next);
  };
  const updateKey = (oldKey: string, newKey: string) => {
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) {
      next[k === oldKey ? newKey : k] = v;
    }
    onChange(next);
  };
  const updateValue = (key: string, val: string) => {
    onChange({ ...entries, [key]: val });
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-gray-300">{label}</label>
        <button type="button" onClick={add} className="text-xs text-blue-400 hover:text-blue-300">+ Add</button>
      </div>
      {pairs.map(([key, val], idx) => (
        <div key={idx} className="flex gap-2">
          <Input value={key} onChange={e => updateKey(key, e.target.value)} placeholder={keyPlaceholder} className="w-1/3" />
          <Input value={val} onChange={e => updateValue(key, e.target.value)} placeholder={valuePlaceholder} />
          <button type="button" onClick={() => remove(key)} className="text-red-400 hover:text-red-300 text-sm px-2">&times;</button>
        </div>
      ))}
      {pairs.length === 0 && <p className="text-xs text-gray-500">No entries</p>}
    </div>
  );
}
