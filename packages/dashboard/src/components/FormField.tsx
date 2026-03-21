"use client";
import { HelpText } from "./HelpText";
import type { HelpEntry } from "./HelpText";

interface FormFieldProps {
  label: string;
  children: React.ReactNode;
  error?: string;
  description?: string;
  help?: HelpEntry;
  helpKey?: string;
}

export function FormField({ label, children, error, description, help, helpKey }: FormFieldProps) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-gray-300">{label}</label>
      {description && <p className="text-xs text-gray-500">{description}</p>}
      {help && helpKey && <HelpText {...help} helpKey={helpKey} />}
      {children}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}

// Input helper
export function Input({ className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none ${className}`}
      {...props}
    />
  );
}

// Select helper
export function Select({ className = "", children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 focus:border-blue-500 focus:outline-none ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

// Textarea helper
export function Textarea({ className = "", ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none ${className}`}
      rows={4}
      {...props}
    />
  );
}
