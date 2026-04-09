export interface BotConfigData {
  name: string;
  file: string;
  config: Record<string, any>;
}

export interface BotDetailData {
  name: string;
  config: Record<string, any>;
  raw: string;
}

export async function fetchBots(): Promise<BotConfigData[]> {
  const res = await fetch("/api/bots");
  if (!res.ok) throw new Error("Failed to fetch bots");
  return res.json();
}

export async function fetchBot(name: string): Promise<BotDetailData> {
  const res = await fetch(`/api/bots/${name}`);
  if (!res.ok) throw new Error("Failed to fetch bot");
  return res.json();
}

export async function saveBot(name: string, config: Record<string, any>): Promise<void> {
  const res = await fetch(`/api/bots/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.errors?.join(", ") || "Failed to save bot");
  }
}

export async function createBot(name: string, config: Record<string, any>): Promise<void> {
  const res = await fetch("/api/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, config }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to create bot");
  }
}

export async function deleteBot(name: string): Promise<void> {
  const res = await fetch(`/api/bots/${name}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete bot");
}

export async function startBot(name: string): Promise<void> {
  const res = await fetch(`/api/bots/${name}/start`, { method: "POST" });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to start bot");
  }
}

export async function stopBot(name: string): Promise<void> {
  const res = await fetch(`/api/bots/${name}/stop`, { method: "POST" });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to stop bot");
  }
}

export async function deployBot(name: string): Promise<{ deployId: string }> {
  const res = await fetch(`/api/bots/${name}/deploy`, { method: "POST" });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to start deploy");
  }
  return res.json();
}

export async function validateConfig(config: Record<string, any>): Promise<{ valid: boolean; errors?: string[] }> {
  const res = await fetch("/api/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  });
  return res.json();
}
