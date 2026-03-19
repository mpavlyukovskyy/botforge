import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import next from "next";
import { Server } from "socket.io";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handler = app.getRequestHandler();

// Load fleet config
function loadFleetConfig() {
  const configPath = resolve("../../botforge.yaml");
  if (!existsSync(configPath)) return null;
  const raw = readFileSync(configPath, "utf-8");
  return parseYaml(raw);
}

// Poll bot health endpoints
async function pollFleetHealth() {
  const fleet = loadFleetConfig();
  if (!fleet?.bots) return [];

  const statuses = [];
  for (const [name, bot] of Object.entries(fleet.bots)) {
    try {
      const res = await fetch(`http://localhost:${bot.port}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const health = await res.json();
      statuses.push({ name, ...health, port: bot.port });
    } catch {
      statuses.push({ name, status: "offline", port: bot.port });
    }
  }
  return statuses;
}

app.prepare().then(() => {
  const httpServer = createServer(handler);
  const io = new Server(httpServer, {
    cors: { origin: "*" },
  });

  // Poll every 10s and push to clients
  setInterval(async () => {
    const statuses = await pollFleetHealth();
    io.emit("fleet:status", statuses);
  }, 10_000);

  io.on("connection", async (socket) => {
    // Send initial state on connect
    const statuses = await pollFleetHealth();
    socket.emit("fleet:status", statuses);
  });

  const port = parseInt(process.env.PORT ?? "9000");
  httpServer.listen(port, () => {
    console.log(`> Dashboard ready on http://localhost:${port}`);
  });
});
