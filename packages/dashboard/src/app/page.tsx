"use client";

import { useFleetStatus } from "@/hooks/useFleetStatus";

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    healthy: "bg-green-500",
    offline: "bg-red-500",
    error: "bg-yellow-500",
    deploying: "bg-blue-500",
  };
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${colors[status] ?? "bg-gray-500"}`} />
  );
}

function formatUptime(seconds?: number): string {
  if (!seconds) return "-";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function FleetPage() {
  const statuses = useFleetStatus();

  const healthy = statuses.filter(s => s.status === "healthy").length;
  const offline = statuses.filter(s => s.status === "offline").length;
  const total = statuses.length;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Fleet Overview</h2>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4 mb-8">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-sm text-gray-400">Total Bots</div>
          <div className="text-3xl font-bold">{total}</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-sm text-gray-400">Healthy</div>
          <div className="text-3xl font-bold text-green-400">{healthy}</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-sm text-gray-400">Offline</div>
          <div className="text-3xl font-bold text-red-400">{offline}</div>
        </div>
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <div className="text-sm text-gray-400">Active</div>
          <div className="text-3xl font-bold text-blue-400">{healthy}</div>
        </div>
      </div>

      {/* Bot table */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-800">
              <th className="text-left p-3 text-sm text-gray-400">Bot</th>
              <th className="text-left p-3 text-sm text-gray-400">Status</th>
              <th className="text-left p-3 text-sm text-gray-400">Uptime</th>
              <th className="text-left p-3 text-sm text-gray-400">Port</th>
              <th className="text-left p-3 text-sm text-gray-400">Platform</th>
              <th className="text-left p-3 text-sm text-gray-400">Brain</th>
            </tr>
          </thead>
          <tbody>
            {statuses.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-8 text-center text-gray-500">
                  Connecting to fleet...
                </td>
              </tr>
            ) : (
              statuses.map((bot) => (
                <tr key={bot.name} className="border-b border-gray-800/50 hover:bg-gray-800/50">
                  <td className="p-3 font-medium">{bot.name}</td>
                  <td className="p-3">
                    <span className="flex items-center gap-2">
                      <StatusBadge status={bot.status} />
                      {bot.status}
                    </span>
                  </td>
                  <td className="p-3 text-gray-400">{formatUptime(bot.uptime)}</td>
                  <td className="p-3 text-gray-400">{bot.port}</td>
                  <td className="p-3 text-gray-400">{bot.platform ?? "-"}</td>
                  <td className="p-3 text-gray-400">{bot.brain ?? "-"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-gray-600">Auto-updates every 10 seconds via WebSocket</p>
    </div>
  );
}
