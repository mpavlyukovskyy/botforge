"use client";
import { HelpText } from "./HelpText";
import type { HelpEntry } from "./HelpText";

interface CheckboxFieldProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  help?: HelpEntry;
  helpKey?: string;
}

export function CheckboxField({ label, checked, onChange, help, helpKey }: CheckboxFieldProps) {
  return (
    <div>
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          onChange={e => onChange(e.target.checked)}
          className="accent-blue-500"
        />
        <span className="text-gray-300">{label}</span>
      </label>
      {help && helpKey && (
        <div className="ml-6">
          <HelpText {...help} helpKey={helpKey} />
        </div>
      )}
    </div>
  );
}
