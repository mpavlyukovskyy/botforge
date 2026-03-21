"use client";
import { useRouter } from "next/navigation";
import { BotForm } from "@/components/bot-form/BotForm";
import { createBot } from "@/lib/api";

const DEFAULT_CONFIG = {
  name: "",
  version: "1.0",
  description: "",
  platform: { type: "telegram", token: "${TELEGRAM_BOT_TOKEN}", mode: "polling" },
  brain: { provider: "claude", model: "claude-sonnet-4-6", tools: [], temperature: 0, max_tokens: 4096 },
  memory: { conversation_history: { enabled: true, ttl_days: 14, max_messages: 100 }, context_blocks: [] },
  health: { port: 9003, path: "/api/health" },
  env_file: "../.env",
};

export default function NewBotPage() {
  const router = useRouter();

  const handleSave = async (config: Record<string, any>) => {
    if (!config.name) throw new Error("Bot name is required");
    await createBot(config.name, config);
    router.push(`/bots/${config.name}`);
  };

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Create New Bot</h2>
      <BotForm initialConfig={DEFAULT_CONFIG} isNew onSave={handleSave} />
    </div>
  );
}
