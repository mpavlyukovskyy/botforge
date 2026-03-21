"use client";
import { useRouter } from "next/navigation";
import { useBotList } from "@/hooks/useBotList";
import { useBotLifecycle } from "@/hooks/useBotLifecycle";
import { BotCard } from "@/components/BotCard";

export default function BotsPage() {
  const router = useRouter();
  const { bots, loading, error, refresh } = useBotList();
  const lifecycle = useBotLifecycle();

  if (loading) return <p className="text-gray-400">Loading bots...</p>;
  if (error) return <p className="text-red-400">Error: {error}</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Bots</h2>
        <button
          onClick={() => router.push("/bots/new")}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium"
        >
          Create New Bot
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {bots.map(bot => (
          <BotCard
            key={bot.name}
            name={bot.name}
            description={bot.config.description}
            platform={bot.config.platform?.type}
            brain={bot.config.brain?.model}
            status={bot.status}
            onEdit={() => router.push(`/bots/${bot.name}`)}
            onStart={async () => { await lifecycle.start(bot.name); refresh(); }}
            onStop={async () => { await lifecycle.stop(bot.name); refresh(); }}
            isLoading={lifecycle.loading === bot.name}
          />
        ))}
      </div>

      {bots.length === 0 && (
        <p className="text-gray-500 text-center py-12">No bots configured yet.</p>
      )}
    </div>
  );
}
