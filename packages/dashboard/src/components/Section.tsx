"use client";
import { useState } from "react";

interface SectionProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  enabled?: boolean;
  onToggle?: (enabled: boolean) => void;
}

export function Section({ title, children, defaultOpen = false, enabled, onToggle }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-900 hover:bg-gray-800/70 text-left"
      >
        <span className="font-medium text-sm">{title}</span>
        <div className="flex items-center gap-3">
          {onToggle !== undefined && (
            <label className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={e => onToggle(e.target.checked)}
                className="accent-blue-500"
              />
              <span className="text-xs text-gray-400">Enabled</span>
            </label>
          )}
          <span className="text-gray-500 text-xs">{open ? "\u25B2" : "\u25BC"}</span>
        </div>
      </button>
      {open && <div className="p-4 space-y-4 bg-gray-950">{children}</div>}
    </div>
  );
}
