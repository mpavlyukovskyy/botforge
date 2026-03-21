"use client";
import { useState, useRef, useLayoutEffect } from "react";
import { createPortal } from "react-dom";

export interface HelpEntry {
  summary: string;
  detail?: string;
  example?: string;
  defaultValue?: string;
}

interface HelpTextProps extends HelpEntry {
  helpKey: string;
}

export function HelpText({ summary, detail, example, defaultValue, helpKey }: HelpTextProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hasMore = !!(detail || example);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const gap = 6;
    const popoverWidth = 280;
    let top = rect.bottom + gap;
    let left = rect.left;
    // Clamp horizontal
    if (left + popoverWidth > window.innerWidth - 8) left = window.innerWidth - popoverWidth - 8;
    if (left < 8) left = 8;
    // Flip above if near bottom — use actual height after render
    const actualHeight = popoverRef.current?.getBoundingClientRect().height ?? 160;
    if (top + actualHeight > window.innerHeight - 8) {
      top = rect.top - actualHeight - gap;
    }
    setPos({ top, left });
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current && !popoverRef.current.contains(target) &&
        buttonRef.current && !buttonRef.current.contains(target)
      ) dismiss();
    };
    const onEscape = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };

    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEscape);
    window.addEventListener("scroll", dismiss, { capture: true, passive: true });
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEscape);
      window.removeEventListener("scroll", dismiss, { capture: true });
    };
  }, [open]);

  return (
    <div className="mt-1">
      <div className="flex items-start gap-1.5">
        <p className="text-xs text-gray-400 leading-relaxed">{summary}</p>
        {hasMore && (
          <button
            ref={buttonRef}
            type="button"
            onClick={() => setOpen(!open)}
            className={`shrink-0 mt-0.5 transition-colors ${
              open ? "text-blue-400" : "text-gray-500 hover:text-gray-300"
            }`}
            aria-label={`More info about ${helpKey}`}
            aria-expanded={open}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5">
              <path fillRule="evenodd" d="M15 8A7 7 0 1 1 1 8a7 7 0 0 1 14 0ZM9 5a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM6.75 8a.75.75 0 0 0 0 1.5h.25v1.75a.75.75 0 0 0 1.5 0v-2.5A.75.75 0 0 0 7.75 8h-1Z" clipRule="evenodd" />
            </svg>
          </button>
        )}
      </div>
      {open && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={`Details for ${helpKey}`}
          className="fixed z-50 w-[280px] bg-gray-800 border border-gray-700 rounded-lg shadow-lg shadow-black/40 p-3 space-y-2 text-xs leading-relaxed"
          style={{ top: pos.top, left: pos.left }}
        >
          {detail && <p className="text-gray-300">{detail}</p>}
          {example && (
            <div className="bg-gray-900/60 border border-gray-700 rounded px-2 py-1.5 text-gray-400">
              <span className="text-gray-500 font-medium">Example: </span>{example}
            </div>
          )}
          {defaultValue && (
            <span className="inline-block bg-gray-900 text-gray-500 rounded px-1.5 py-0.5 text-[10px] font-mono">
              Default: {defaultValue}
            </span>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
