"use client";
import { useState, useCallback } from "react";
import { startBot as apiStart, stopBot as apiStop } from "@/lib/api";

export function useBotLifecycle() {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async (name: string) => {
    try {
      setLoading(name);
      setError(null);
      await apiStart(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(null);
    }
  }, []);

  const stop = useCallback(async (name: string) => {
    try {
      setLoading(name);
      setError(null);
      await apiStop(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setLoading(null);
    }
  }, []);

  return { start, stop, loading, error };
}
