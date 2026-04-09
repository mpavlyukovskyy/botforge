import { createServer } from "node:http";
import {
  readFileSync,
  existsSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { spawn } from "node:child_process";
import next from "next";
import { Server } from "socket.io";
import { BotConfigSchema } from "@botforge/core";

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handler = app.getRequestHandler();

const BOTS_DIR = resolve("../../bots");
const FLEET_CONFIG = resolve("../../botforge.yaml");
const CLI_PATH = resolve("../../packages/cli/dist/index.js");

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

// Parse request body
function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
  });
}

// JSON response helper
function jsonResponse(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// Extract route params: /api/bots/:name/action
function matchRoute(url, method) {
  const u = new URL(url, "http://localhost");
  const path = u.pathname;

  if (method === "GET" && path === "/api/bots") return { handler: "listBots" };
  if (method === "POST" && path === "/api/bots")
    return { handler: "createBot" };
  if (method === "POST" && path === "/api/validate")
    return { handler: "validateConfig" };

  const botMatch = path.match(/^\/api\/bots\/([^/]+)$/);
  if (botMatch) {
    const name = botMatch[1];
    if (method === "GET") return { handler: "getBot", name };
    if (method === "PUT") return { handler: "updateBot", name };
    if (method === "DELETE") return { handler: "deleteBot", name };
  }

  const actionMatch = path.match(
    /^\/api\/bots\/([^/]+)\/(start|stop|restart|deploy)$/,
  );
  if (actionMatch) {
    return { handler: actionMatch[2], name: actionMatch[1] };
  }

  return null;
}

// Dummy env vars for validation (mirrors CLI validate-all pattern)
const DUMMY_ENV = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_CHAT_ID: "12345",
  TEST_BOT_TOKEN: "test-token",
  IMAP_HOST: "localhost",
  IMAP_USER: "test",
  IMAP_PASSWORD: "test",
  ATLAS_SYNC_KEY: "test",
  SPOK_SYNC_KEY: "test",
  SPOK_DEFAULT_FUND_ID: "test",
  SPOK_READ_FUND_IDS: "test",
  SPOK_API_TOKEN: "test",
  INSTANTLY_API_URL: "https://example.com",
  INSTANTLY_API_KEY: "test",
  BUTTONDOWN_API_KEY: "test",
  GOOGLE_CALENDAR_TOKEN: "test",
  TELEGRAM_API_URL: "http://localhost:8081",
};

// Substitute env vars in config object for validation
function substituteEnvVars(obj) {
  if (typeof obj === "string") {
    return obj.replace(/\$\{([^}]+)\}/g, (_, varName) => {
      const [name, ...defParts] = varName.split(":-");
      return DUMMY_ENV[name.trim()] ?? defParts.join(":-") ?? "dummy";
    });
  }
  if (Array.isArray(obj)) return obj.map(substituteEnvVars);
  if (obj && typeof obj === "object") {
    const result = {};
    for (const [k, v] of Object.entries(obj)) result[k] = substituteEnvVars(v);
    return result;
  }
  return obj;
}

// Strip empty defaults to keep YAML files clean
// Removes: undefined, null, empty arrays, empty objects
// Does NOT strip false or 0 — those could be intentional user choices
function stripDefaults(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj;
  const cleaned = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      const nested = stripDefaults(v);
      if (Object.keys(nested).length > 0) cleaned[k] = nested;
    } else {
      cleaned[k] = v;
    }
  }
  return cleaned;
}

// Managed child processes for bot lifecycle
const managedProcesses = new Map();
const deployingBots = new Set();

async function handleApiRoute(req, res, io) {
  const route = matchRoute(req.url, req.method);
  if (!route) {
    return jsonResponse(res, { error: "Not found" }, 404);
  }

  try {
    switch (route.handler) {
      case "listBots": {
        const files = readdirSync(BOTS_DIR).filter(
          (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
        );
        const bots = files.map((f) => {
          const raw = readFileSync(join(BOTS_DIR, f), "utf-8");
          const config = parseYaml(raw);
          return {
            name: config.name || f.replace(/\.ya?ml$/, ""),
            file: f,
            config,
          };
        });
        return jsonResponse(res, bots);
      }

      case "getBot": {
        const file = `${route.name}.yaml`;
        const filePath = join(BOTS_DIR, file);
        if (!existsSync(filePath))
          return jsonResponse(res, { error: "Bot not found" }, 404);
        const raw = readFileSync(filePath, "utf-8");
        const config = parseYaml(raw);
        return jsonResponse(res, { name: route.name, config, raw });
      }

      case "updateBot": {
        const body = await parseBody(req);
        if (!body?.config)
          return jsonResponse(res, { error: "Missing config" }, 400);

        // Validate with dummy env vars
        const substituted = substituteEnvVars(body.config);
        const result = BotConfigSchema.safeParse(substituted);
        if (!result.success) {
          const errors = result.error.issues.map(
            (i) => `${i.path.join(".")}: ${i.message}`,
          );
          return jsonResponse(
            res,
            { error: "Validation failed", errors },
            400,
          );
        }

        const yaml = stringifyYaml(stripDefaults(body.config));
        const filePath = join(BOTS_DIR, `${route.name}.yaml`);
        writeFileSync(filePath, yaml);
        return jsonResponse(res, { ok: true });
      }

      case "createBot": {
        const body = await parseBody(req);
        if (!body?.name || !body?.config)
          return jsonResponse(
            res,
            { error: "Missing name or config" },
            400,
          );

        const file = `${body.name}.yaml`;
        const filePath = join(BOTS_DIR, file);
        if (existsSync(filePath))
          return jsonResponse(res, { error: "Bot already exists" }, 409);

        // Create tools directory
        mkdirSync(join(BOTS_DIR, body.name, "tools"), { recursive: true });

        // Write config
        const yaml = stringifyYaml(stripDefaults(body.config));
        writeFileSync(filePath, yaml);

        // Add to botforge.yaml
        const fleet = loadFleetConfig() || { fleet: {}, bots: {} };
        if (!fleet.bots) fleet.bots = {};
        fleet.bots[body.name] = {
          config: `bots/${file}`,
          port: body.config.health?.port || 9099,
        };
        writeFileSync(FLEET_CONFIG, stringifyYaml(fleet));

        return jsonResponse(res, { ok: true }, 201);
      }

      case "deleteBot": {
        const file = `${route.name}.yaml`;
        const filePath = join(BOTS_DIR, file);
        if (!existsSync(filePath))
          return jsonResponse(res, { error: "Bot not found" }, 404);

        unlinkSync(filePath);

        // Remove from botforge.yaml
        const fleet = loadFleetConfig();
        if (fleet?.bots?.[route.name]) {
          delete fleet.bots[route.name];
          writeFileSync(FLEET_CONFIG, stringifyYaml(fleet));
        }

        return jsonResponse(res, { ok: true });
      }

      case "validateConfig": {
        const body = await parseBody(req);
        if (!body?.config)
          return jsonResponse(res, { error: "Missing config" }, 400);

        const substituted = substituteEnvVars(body.config);
        const result = BotConfigSchema.safeParse(substituted);
        if (!result.success) {
          const errors = result.error.issues.map(
            (i) => `${i.path.join(".")}: ${i.message}`,
          );
          return jsonResponse(res, { valid: false, errors });
        }
        return jsonResponse(res, { valid: true });
      }

      case "start": {
        if (managedProcesses.has(route.name)) {
          return jsonResponse(res, { error: "Bot already running" }, 409);
        }
        const configPath = resolve(`../../bots/${route.name}.yaml`);
        if (!existsSync(configPath))
          return jsonResponse(res, { error: "Bot not found" }, 404);

        const child = spawn("node", [CLI_PATH, "dev", configPath], {
          cwd: resolve("../../"),
          stdio: "pipe",
          env: { ...process.env },
        });

        managedProcesses.set(route.name, child);

        child.on("exit", (code) => {
          managedProcesses.delete(route.name);
          io?.emit("bot:stopped", { name: route.name, code });
        });

        io?.emit("bot:started", { name: route.name });
        return jsonResponse(res, { ok: true, pid: child.pid });
      }

      case "stop": {
        const proc = managedProcesses.get(route.name);
        if (!proc)
          return jsonResponse(res, { error: "Bot not running" }, 404);

        proc.kill("SIGTERM");
        return jsonResponse(res, { ok: true });
      }

      case "restart": {
        const existing = managedProcesses.get(route.name);
        if (existing) {
          existing.kill("SIGTERM");
          await new Promise((r) => existing.on("exit", r));
        }

        const configPath = resolve(`../../bots/${route.name}.yaml`);
        if (!existsSync(configPath))
          return jsonResponse(res, { error: "Bot not found" }, 404);

        const child = spawn("node", [CLI_PATH, "dev", configPath], {
          cwd: resolve("../../"),
          stdio: "pipe",
          env: { ...process.env },
        });

        managedProcesses.set(route.name, child);
        child.on("exit", (code) => {
          managedProcesses.delete(route.name);
          io?.emit("bot:stopped", { name: route.name, code });
        });

        io?.emit("bot:started", { name: route.name });
        return jsonResponse(res, { ok: true, pid: child.pid });
      }

      case "deploy": {
        if (deployingBots.has(route.name)) {
          return jsonResponse(res, { error: "Deploy already in progress" }, 409);
        }

        const fleet = loadFleetConfig();
        const bot = fleet?.bots?.[route.name];
        if (!bot?.service) {
          return jsonResponse(
            res,
            { error: "Bot has no service configured for deploy" },
            400,
          );
        }

        deployingBots.add(route.name);
        const deployId = crypto.randomUUID();
        jsonResponse(res, { deployId, status: "started" });

        const deployChild = spawn("node", [CLI_PATH, "deploy", route.name], {
          cwd: resolve("../../"),
          stdio: "pipe",
          env: { ...process.env },
        });

        let deployOutput = "";
        deployChild.stdout.on("data", (data) => {
          const line = data.toString().trim();
          deployOutput += line + "\n";
          io?.emit("bot:deploy:progress", {
            botName: route.name,
            deployId,
            line,
          });
        });

        deployChild.stderr.on("data", (data) => {
          const line = data.toString().trim();
          deployOutput += line + "\n";
          io?.emit("bot:deploy:progress", {
            botName: route.name,
            deployId,
            line,
            error: true,
          });
        });

        deployChild.on("exit", (code) => {
          deployingBots.delete(route.name);
          io?.emit("bot:deploy:complete", {
            botName: route.name,
            deployId,
            success: code === 0,
            output: deployOutput,
          });
        });

        return; // Response already sent
      }

      default:
        return jsonResponse(res, { error: "Not found" }, 404);
    }
  } catch (err) {
    console.error("API error:", err);
    return jsonResponse(res, { error: err.message || "Internal error" }, 500);
  }
}

app.prepare().then(() => {
  let io;

  const httpServer = createServer(async (req, res) => {
    if (req.url?.startsWith("/api/")) {
      return handleApiRoute(req, res, io);
    }
    handler(req, res);
  });

  io = new Server(httpServer, {
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

  process.on("SIGINT", () => {
    for (const [name, proc] of managedProcesses) {
      proc.kill("SIGTERM");
    }
    process.exit(0);
  });

  const port = parseInt(process.env.PORT ?? "9000");
  httpServer.listen(port, () => {
    console.log(`> Dashboard ready on http://localhost:${port}`);
  });
});
