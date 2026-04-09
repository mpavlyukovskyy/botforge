"use client";
import { useState } from "react";
import { Section } from "@/components/Section";
import { FormField, Input, Select, Textarea } from "@/components/FormField";
import { ArrayField } from "@/components/ArrayField";
import { CONFIG_HELP } from "@/lib/config-help";

interface Props { config: Record<string, any>; update: (path: string, value: any) => void; }

const CLAUDE_MODELS = ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"];
const GEMINI_MODELS = ["gemini-2.0-flash", "gemini-2.0-flash-exp"];

export function BrainSection({ config, update }: Props) {
  const brain = config.brain || {};
  const provider = brain.provider || "claude";
  const models = provider === "claude" ? CLAUDE_MODELS : GEMINI_MODELS;
  const [promptMode, setPromptMode] = useState<"inline" | "file">(brain.system_prompt_file ? "file" : "inline");

  return (
    <Section title="Brain (LLM)" defaultOpen>
      <div className="grid grid-cols-2 gap-4">
        <FormField label="Provider" help={CONFIG_HELP["brain.provider"]} helpKey="brain.provider">
          <Select value={provider} onChange={e => update("brain.provider", e.target.value)}>
            <option value="claude">Claude</option>
            <option value="gemini">Gemini</option>
          </Select>
        </FormField>
        <FormField label="Model" help={CONFIG_HELP["brain.model"]} helpKey="brain.model">
          <Select value={brain.model || models[0]} onChange={e => update("brain.model", e.target.value)}>
            {models.map(m => <option key={m} value={m}>{m}</option>)}
          </Select>
        </FormField>
      </div>

      <div className="space-y-2">
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={promptMode === "inline"} onChange={() => { setPromptMode("inline"); update("brain.system_prompt_file", undefined); }} className="accent-blue-500" />
            <span className="text-gray-300">Inline Prompt</span>
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={promptMode === "file"} onChange={() => { setPromptMode("file"); update("brain.system_prompt", undefined); }} className="accent-blue-500" />
            <span className="text-gray-300">Prompt File</span>
          </label>
        </div>
        <p className="text-xs text-gray-400">{CONFIG_HELP["brain.system_prompt"]?.summary}</p>
        {promptMode === "inline" ? (
          <Textarea value={brain.system_prompt || ""} onChange={e => update("brain.system_prompt", e.target.value)} placeholder="You are a helpful assistant..." rows={6} />
        ) : (
          <Input value={brain.system_prompt_file || ""} onChange={e => update("brain.system_prompt_file", e.target.value)} placeholder="prompts/my-bot.md" />
        )}
      </div>

      <ArrayField label="Tools" values={brain.tools || []} onChange={v => update("brain.tools", v)} placeholder="tool_name" help={CONFIG_HELP["brain.tools"]} helpKey="brain.tools" />

      <div className="grid grid-cols-3 gap-4">
        <FormField label="Temperature" help={CONFIG_HELP["brain.temperature"]} helpKey="brain.temperature">
          <Input type="number" min={0} max={provider === "gemini" ? 2 : 1} step={0.1} value={brain.temperature ?? 0} onChange={e => update("brain.temperature", parseFloat(e.target.value))} />
        </FormField>
        <FormField label="Max Tokens" help={CONFIG_HELP["brain.max_tokens"]} helpKey="brain.max_tokens">
          <Input type="number" min={1} value={brain.max_tokens || 4096} onChange={e => update("brain.max_tokens", parseInt(e.target.value))} />
        </FormField>
        {provider === "claude" && (
          <FormField label="Max Iterations" help={CONFIG_HELP["brain.max_iterations"]} helpKey="brain.max_iterations">
            <Input type="number" min={1} value={brain.max_iterations || ""} onChange={e => update("brain.max_iterations", e.target.value ? parseInt(e.target.value) : undefined)} placeholder="Optional" />
          </FormField>
        )}
      </div>
      {provider === "claude" && (
        <FormField label="Max Budget (USD)" help={CONFIG_HELP["brain.max_budget_usd"]} helpKey="brain.max_budget_usd">
          <Input type="number" min={0} step={0.1} value={brain.max_budget_usd || ""} onChange={e => update("brain.max_budget_usd", e.target.value ? parseFloat(e.target.value) : undefined)} placeholder="Optional" />
        </FormField>
      )}
    </Section>
  );
}
