"use client";
import { Section } from "@/components/Section";
import { FormField, Input } from "@/components/FormField";
import { HelpText } from "@/components/HelpText";
import { CONFIG_HELP, SECTION_DESCRIPTIONS } from "@/lib/config-help";

interface Props { config: Record<string, any>; update: (path: string, value: any) => void; }

export function MemorySection({ config, update }: Props) {
  const memory = config.memory || {};
  const ch = memory.conversation_history || {};
  const blocks = memory.context_blocks || [];

  const addBlock = () => {
    update("memory.context_blocks", [...blocks, { type: "", label: "" }]);
  };
  const removeBlock = (idx: number) => {
    update("memory.context_blocks", blocks.filter((_: any, i: number) => i !== idx));
  };
  const updateBlock = (idx: number, field: string, value: string) => {
    const next = [...blocks];
    next[idx] = { ...next[idx], [field]: value };
    update("memory.context_blocks", next);
  };

  return (
    <Section title="Memory">
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={ch.enabled !== false} onChange={e => update("memory.conversation_history.enabled", e.target.checked)} className="accent-blue-500" />
          <span className="text-gray-300">Conversation History</span>
        </label>
        <div className="ml-6">
          <HelpText {...CONFIG_HELP["memory.conversation_history"]} helpKey="memory.conversation_history" />
        </div>
        {ch.enabled !== false && (
          <div className="grid grid-cols-2 gap-4 pl-6">
            <FormField label="TTL (days)" help={CONFIG_HELP["memory.conversation_history.ttl_days"]} helpKey="memory.conversation_history.ttl_days">
              <Input type="number" min={1} value={ch.ttl_days || 14} onChange={e => update("memory.conversation_history.ttl_days", parseInt(e.target.value))} />
            </FormField>
            <FormField label="Max Messages" help={CONFIG_HELP["memory.conversation_history.max_messages"]} helpKey="memory.conversation_history.max_messages">
              <Input type="number" min={1} value={ch.max_messages || 100} onChange={e => update("memory.conversation_history.max_messages", parseInt(e.target.value))} />
            </FormField>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-gray-300">Context Blocks</label>
          <button type="button" onClick={addBlock} className="text-xs text-blue-400 hover:text-blue-300">+ Add</button>
        </div>
        <p className="text-xs text-gray-500">{SECTION_DESCRIPTIONS.context_blocks}</p>
        {blocks.map((block: any, idx: number) => (
          <div key={idx} className="flex gap-2">
            <Input value={block.type || ""} onChange={e => updateBlock(idx, "type", e.target.value)} placeholder="Type (e.g., recent_history)" />
            <Input value={block.label || ""} onChange={e => updateBlock(idx, "label", e.target.value)} placeholder="Label" />
            <button type="button" onClick={() => removeBlock(idx)} className="text-red-400 hover:text-red-300 text-sm px-2">&times;</button>
          </div>
        ))}
      </div>
    </Section>
  );
}
