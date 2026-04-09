"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { deployBot as apiDeploy } from "@/lib/api";
import { getSocket } from "@/lib/socket";

type DeployStatus = "idle" | "deploying" | "success" | "failed";

interface DeployLog {
  line: string;
  error?: boolean;
}

export function useBotDeploy() {
  const [status, setStatus] = useState<DeployStatus>("idle");
  const [logs, setLogs] = useState<DeployLog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const activeDeployRef = useRef<{ botName: string; deployId: string } | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const socket = getSocket();

    const onProgress = (data: { botName: string; deployId: string; line: string; error?: boolean }) => {
      if (activeDeployRef.current?.deployId !== data.deployId) return;
      setLogs(prev => [...prev, { line: data.line, error: data.error }]);
    };

    const onComplete = (data: { botName: string; deployId: string; success: boolean; output: string }) => {
      if (activeDeployRef.current?.deployId !== data.deployId) return;
      setStatus(data.success ? "success" : "failed");
      if (!data.success) {
        setError("Deploy failed");
      }
      if (data.success) {
        dismissTimerRef.current = setTimeout(() => {
          setStatus("idle");
          setLogs([]);
          setError(null);
          activeDeployRef.current = null;
        }, 5000);
      }
    };

    socket.on("bot:deploy:progress", onProgress);
    socket.on("bot:deploy:complete", onComplete);

    return () => {
      socket.off("bot:deploy:progress", onProgress);
      socket.off("bot:deploy:complete", onComplete);
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, []);

  const deploy = useCallback(async (name: string) => {
    try {
      setStatus("deploying");
      setLogs([]);
      setError(null);
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      const { deployId } = await apiDeploy(name);
      activeDeployRef.current = { botName: name, deployId };
    } catch (err) {
      setStatus("failed");
      setError(err instanceof Error ? err.message : "Deploy failed");
    }
  }, []);

  const dismiss = useCallback(() => {
    setStatus("idle");
    setLogs([]);
    setError(null);
    activeDeployRef.current = null;
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
  }, []);

  return { deploy, status, logs, error, dismiss };
}
