"use client";

import { useState, useEffect, useCallback } from "react";
import { useFleetStatus } from "@/hooks/useFleetStatus";

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export default function LogsPage() {
  const statuses = useFleetStatus();
  const [selectedBot, setSelectedBot] = useState<string>("");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchLogs = useCallback(async (botName: string) => {
    if (!botName) return;
    setLoading(true);

    const bot = statuses.find(s => s.name === botName);
    if (!bot || bot.status === "offline") {
      setLogs([]);
      setLoading(false);
      return;
    }

    try {
      const res = await fetch(`http://localhost:${bot.port}/api/logs?tail=100`);
      const data = await res.json();
      setLogs(data);
    } catch {
      setLogs([]);
    }
    setLoading(false);
  }, [statuses]);

  useEffect(() => {
    if (selectedBot) {
      fetchLogs(selectedBot);
      const interval = setInterval(() => fetchLogs(selectedBot), 5000);
      return () => clearInterval(interval);
    }
  }, [selectedBot, fetchLogs]);

  const levelColor: Record<string, string> = {
    error: "text-red-400",
    warn: "text-yellow-400",
    info: "text-blue-400",
    debug: "text-gray-500",
  };

  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Fleet Logs</h2>

      <div className="mb-4">
        <select
          value={selectedBot}
          onChange={(e) => setSelectedBot(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm"
        >
          <option value="">Select a bot...</option>
          {statuses.map(s => (
            <option key={s.name} value={s.name}>
              {s.name} ({s.status})
            </option>
          ))}
        </select>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 font-mono text-xs max-h-[70vh] overflow-y-auto">
        {loading && <div className="text-gray-500">Loading...</div>}
        {!loading && logs.length === 0 && selectedBot && (
          <div className="text-gray-500">No logs available</div>
        )}
        {logs.map((log, i) => (
          <div key={i} className="py-0.5">
            <span className="text-gray-600">{log.timestamp}</span>{" "}
            <span className={levelColor[log.level] ?? "text-gray-400"}>
              [{log.level.toUpperCase()}]
            </span>{" "}
            <span>{log.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
