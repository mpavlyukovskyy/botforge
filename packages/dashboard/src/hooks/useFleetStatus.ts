"use client";

import { useEffect, useState } from "react";
import { getSocket } from "@/lib/socket";
import type { BotStatus } from "@/types/fleet";

export function useFleetStatus() {
  const [statuses, setStatuses] = useState<BotStatus[]>([]);

  useEffect(() => {
    const socket = getSocket();

    const handler = (data: BotStatus[]) => {
      setStatuses(data);
    };

    socket.on("fleet:status", handler);

    return () => {
      socket.off("fleet:status", handler);
    };
  }, []);

  return statuses;
}
