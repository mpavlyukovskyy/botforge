"use client";
import { use, useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BotForm } from "@/components/bot-form/BotForm";
import { useBotConfig } from "@/hooks/useBotConfig";
import { useBotLifecycle } from "@/hooks/useBotLifecycle";
import { useBotDeploy } from "@/hooks/useBotDeploy";
import { useFleetStatus } from "@/hooks/useFleetStatus";
import { deleteBot } from "@/lib/api";

const statusColors: Record<string, string> = {
  healthy: "bg-green-500",
  online: "bg-green-500",
  offline: "bg-red-500",
  error: "bg-yellow-500",
  deploying: "bg-blue-500",
  unknown: "bg-gray-500",
};

const statusLabels: Record<string, string> = {
  healthy: "Healthy",
  online: "Online",
  offline: "Offline",
  error: "Error",
  deploying: "Deploying",
  unknown: "Unknown",
};

function formatUptime(seconds?: number): string {
  if (!seconds) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatBytes(bytes?: number): string {
  if (!bytes) return "—";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function EditBotPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = use(params);
  const router = useRouter();
  const { data, loading, save, error } = useBotConfig(name);
  const lifecycle = useBotLifecycle();
  const deployer = useBotDeploy();
  const statuses = useFleetStatus();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const botStatus = statuses.find(s => s.name === name);
  const status: string = botStatus?.status ?? "unknown";
  const isOnline = status === "healthy" || status === "online";
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [deployer.logs]);

  if (loading) return <p className="text-gray-400">Loading...</p>;
  if (error) return <p className="text-red-400">Error: {error}</p>;
  if (!data) return <p className="text-gray-400">Bot not found</p>;

  const handleDelete = async () => {
    await deleteBot(name);
    router.push("/bots");
  };

  return (
    <div>
      {/* Back link */}
      <Link href="/bots" className="text-sm text-gray-500 hover:text-gray-300 mb-4 inline-block">
        &larr; Back to bots
      </Link>

      {/* Header with status */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold">{name}</h2>
          <span className="flex items-center gap-2 text-sm text-gray-400 bg-gray-900 border border-gray-800 rounded-full px-3 py-1">
            <span className={`inline-block w-2 h-2 rounded-full ${statusColors[status] ?? statusColors.unknown}`} />
            {statusLabels[status] ?? "Unknown"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isOnline ? (
            <button
              onClick={() => lifecycle.stop(name)}
              disabled={lifecycle.loading === name}
              className="px-3 py-1.5 text-sm bg-red-900/50 hover:bg-red-900 text-red-300 rounded disabled:opacity-50"
            >
              {lifecycle.loading === name ? "Stopping..." : "Stop"}
            </button>
          ) : (
            <button
              onClick={() => lifecycle.start(name)}
              disabled={lifecycle.loading === name}
              className="px-3 py-1.5 text-sm bg-green-900/50 hover:bg-green-900 text-green-300 rounded disabled:opacity-50"
            >
              {lifecycle.loading === name ? "Starting..." : "Start"}
            </button>
          )}
          <button
            onClick={() => deployer.deploy(name)}
            disabled={deployer.status === "deploying"}
            className="px-3 py-1.5 text-sm bg-blue-900/50 hover:bg-blue-900 text-blue-300 rounded disabled:opacity-50"
          >
            {deployer.status === "deploying" ? "Deploying..." : "Deploy"}
          </button>
          {!confirmDelete ? (
            <button onClick={() => setConfirmDelete(true)} className="px-3 py-1.5 text-sm bg-red-900/50 hover:bg-red-900 text-red-300 rounded">
              Delete
            </button>
          ) : (
            <div className="flex gap-2">
              <button onClick={handleDelete} className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-500 rounded">
                Confirm
              </button>
              <button onClick={() => setConfirmDelete(false)} className="px-3 py-1.5 text-sm bg-gray-800 hover:bg-gray-700 rounded">
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Health panel — only shown when bot has status data */}
      {botStatus && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-6 grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <span className="text-gray-500 block">Port</span>
            <span className="text-gray-200 font-mono">{botStatus.port}</span>
          </div>
          <div>
            <span className="text-gray-500 block">Uptime</span>
            <span className="text-gray-200">{formatUptime(botStatus.uptime)}</span>
          </div>
          <div>
            <span className="text-gray-500 block">Memory (RSS)</span>
            <span className="text-gray-200 font-mono">{formatBytes(botStatus.memory?.rss)}</span>
          </div>
          <div>
            <span className="text-gray-500 block">Heap Used</span>
            <span className="text-gray-200 font-mono">{formatBytes(botStatus.memory?.heapUsed)}</span>
          </div>
        </div>
      )}

      {/* Deploy progress panel */}
      {deployer.status !== "idle" && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 mb-6">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              {deployer.status === "deploying" && (
                <>
                  <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                  <span className="text-blue-300">Deploying...</span>
                </>
              )}
              {deployer.status === "success" && (
                <>
                  <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
                  <span className="text-green-300">Deploy succeeded</span>
                </>
              )}
              {deployer.status === "failed" && (
                <>
                  <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
                  <span className="text-red-300">Deploy failed</span>
                </>
              )}
            </div>
            {deployer.status !== "deploying" && (
              <button
                onClick={deployer.dismiss}
                className="text-xs text-gray-500 hover:text-gray-300"
              >
                Dismiss
              </button>
            )}
          </div>
          {deployer.logs.length > 0 && (
            <div className="bg-black/50 rounded p-2 max-h-48 overflow-y-auto font-mono text-xs">
              {deployer.logs.map((log, i) => (
                <div key={i} className={log.error ? "text-red-400" : "text-gray-400"}>
                  {log.line}
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          )}
          {deployer.error && (
            <p className="text-red-400 text-xs mt-2">{deployer.error}</p>
          )}
        </div>
      )}

      {lifecycle.error && (
        <p className="text-red-400 text-sm mb-4">{lifecycle.error}</p>
      )}

      <BotForm initialConfig={data.config} isNew={false} onSave={config => save(config)} />
    </div>
  );
}
