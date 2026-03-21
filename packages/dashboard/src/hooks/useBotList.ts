"use client";
import { useState, useEffect, useCallback } from "react";
import { fetchBots, type BotConfigData } from "@/lib/api";
import { useFleetStatus } from "./useFleetStatus";

export function useBotList() {
  const [bots, setBots] = useState<BotConfigData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const statuses = useFleetStatus();

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchBots();
      setBots(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load bots");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Merge fleet status with bot configs
  const botsWithStatus = bots.map(bot => {
    const status = statuses.find(s => s.name === bot.name);
    return { ...bot, status: status?.status ?? "unknown" as string, port: status?.port };
  });

  return { bots: botsWithStatus, loading, error, refresh: load };
}
