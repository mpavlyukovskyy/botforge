"use client";
import { useState, useEffect, useCallback } from "react";
import { fetchBot, saveBot as apiSaveBot, type BotDetailData } from "@/lib/api";

export function useBotConfig(name: string | null) {
  const [data, setData] = useState<BotDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!name) return;
    try {
      setLoading(true);
      const d = await fetchBot(name);
      setData(d);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (config: Record<string, any>) => {
    if (!name) return;
    try {
      setSaving(true);
      await apiSaveBot(name, config);
      setError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save";
      setError(msg);
      throw err;
    } finally {
      setSaving(false);
    }
  }, [name]);

  return { data, loading, saving, error, save, reload: load };
}
