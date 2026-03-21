"use client";
import { Input } from "./FormField";
import { HelpText } from "./HelpText";
import type { HelpEntry } from "./HelpText";

interface ArrayFieldProps {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  help?: HelpEntry;
  helpKey?: string;
}

export function ArrayField({ label, values, onChange, placeholder, help, helpKey }: ArrayFieldProps) {
  const add = () => onChange([...values, ""]);
  const remove = (idx: number) => onChange(values.filter((_, i) => i !== idx));
  const update = (idx: number, val: string) => {
    const next = [...values];
    next[idx] = val;
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium text-gray-300">{label}</label>
        <button type="button" onClick={add} className="text-xs text-blue-400 hover:text-blue-300">+ Add</button>
      </div>
      {help && helpKey && <HelpText {...help} helpKey={helpKey} />}
      {values.map((val, idx) => (
        <div key={idx} className="flex gap-2">
          <Input value={val} onChange={e => update(idx, e.target.value)} placeholder={placeholder} />
          <button type="button" onClick={() => remove(idx)} className="text-red-400 hover:text-red-300 text-sm px-2">&times;</button>
        </div>
      ))}
      {values.length === 0 && <p className="text-xs text-gray-500">No items</p>}
    </div>
  );
}
