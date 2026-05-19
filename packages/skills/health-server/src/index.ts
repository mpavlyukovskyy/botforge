import { createServer, type Server } from 'node:http';
import type { Skill, SkillContext } from '@botforge/core';

const LOG_BUFFER_SIZE = 1000;
// Health-server default bind. 127.0.0.1 keeps the management/log endpoints off
// the public network; the active probe runs on the same host (acemagic).
// Override with HEALTH_BIND_ADDR=0.0.0.0 to expose via Tailscale interface.
const DEFAULT_BIND = '127.0.0.1';

export class HealthServerSkill implements Skill {
  readonly name = 'health-server';
  private server?: Server;
  private startTime = Date.now();
  private logBuffer: Array<{ timestamp: string; level: string; message: string }> = [];
  private skills?: Map<string, Skill>;
  private store?: Map<string, unknown>;

  /** Called by runtime after BotInstance is created so /api/health can report liveness state */
  setStore(store: Map<string, unknown>): void {
    this.store = store;
  }

  async init(ctx: SkillContext): Promise<void> {
    if (!ctx.config.health) return;
    this.startTime = Date.now();
    this.skills = ctx.skills;

    const { port, path: healthPath, management_api } = ctx.config.health;

    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);

      res.setHeader('Content-Type', 'application/json');

      // Health endpoint
      if (req.method === 'GET' && url.pathname === healthPath) {
        const lastError = this.store?.get('_lastError') as { at: number; class: string; ref: string } | undefined;
        const lastMessageProcessedAt = this.store?.get('_lastMessageProcessedAt') as number | undefined;
        const atlasCircuit = this.store?.get('_atlasCircuitState') as 'closed' | 'open' | undefined;
        const health = {
          status: 'healthy',
          botName: ctx.config.name,
          uptime: Math.floor((Date.now() - this.startTime) / 1000),
          memory: process.memoryUsage(),
          version: ctx.config.version,
          platform: ctx.config.platform.type,
          brain: ctx.config.brain.provider,
          last_message_processed_at: lastMessageProcessedAt
            ? new Date(lastMessageProcessedAt).toISOString()
            : null,
          last_error_at: lastError ? new Date(lastError.at).toISOString() : null,
          last_error_class: lastError?.class ?? null,
          last_error_ref: lastError?.ref ?? null,
          atlas_circuit_state: atlasCircuit ?? null,
        };
        res.writeHead(200);
        res.end(JSON.stringify(health));
        return;
      }

      // Lightweight probe — no brain call, no auth. Used by external watchdog
      // to verify the HTTP server is reachable AND the bot reports recent
      // activity. Returns degraded if no message processed in `stale_threshold_s`
      // OR if last interaction errored with usage_limit / auth.
      if (req.method === 'GET' && url.pathname === '/api/probe') {
        const lastError = this.store?.get('_lastError') as { at: number; class: string; ref: string } | undefined;
        const lastMessageProcessedAt = this.store?.get('_lastMessageProcessedAt') as number | undefined;
        const staleThresholdMs = parseInt(url.searchParams.get('stale_threshold_s') ?? '7200', 10) * 1000;
        const now = Date.now();
        let ok = true;
        const failures: string[] = [];
        if (lastError && (lastError.class === 'usage_limit' || lastError.class === 'auth')) {
          // Hard block: a usage_limit/auth error means future brain calls will all fail
          // until human intervention. Surface even if it happened long ago.
          ok = false;
          failures.push(`last_error=${lastError.class}`);
        }
        if (lastMessageProcessedAt && now - lastMessageProcessedAt > staleThresholdMs) {
          ok = false;
          failures.push(`no_message_in=${Math.floor((now - lastMessageProcessedAt) / 1000)}s`);
        }
        res.writeHead(ok ? 200 : 503);
        res.end(JSON.stringify({
          ok,
          botName: ctx.config.name,
          checked_at: new Date(now).toISOString(),
          last_message_processed_at: lastMessageProcessedAt
            ? new Date(lastMessageProcessedAt).toISOString()
            : null,
          last_error: lastError
            ? { class: lastError.class, ref: lastError.ref, at: new Date(lastError.at).toISOString() }
            : null,
          failures,
        }));
        return;
      }

      if (!management_api) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      // Authenticate ALL management endpoints (not just /api/restart)
      const expectedToken = process.env.HEALTH_API_TOKEN;
      if (expectedToken) {
        const authHeader = req.headers.authorization;
        if (authHeader !== `Bearer ${expectedToken}`) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      // Config endpoint (secrets redacted)
      if (req.method === 'GET' && url.pathname === '/api/config') {
        const config = JSON.parse(JSON.stringify(ctx.config));
        // Redact secrets by key name (not by value pattern — resolved env vars don't contain '${')
        const SENSITIVE_KEYS = /token|password|key|secret|api_key|apikey|credential/i;
        const redact = (obj: any) => {
          for (const key in obj) {
            if (typeof obj[key] === 'string' && SENSITIVE_KEYS.test(key)) {
              obj[key] = '***';
            } else if (typeof obj[key] === 'object' && obj[key] !== null) {
              redact(obj[key]);
            }
          }
        };
        redact(config);
        res.writeHead(200);
        res.end(JSON.stringify(config));
        return;
      }

      // Logs endpoint
      if (req.method === 'GET' && url.pathname === '/api/logs') {
        const tail = parseInt(url.searchParams.get('tail') ?? '50');
        const level = url.searchParams.get('level');
        let logs = this.logBuffer.slice(-tail);
        if (level) {
          logs = logs.filter(l => l.level === level);
        }
        res.writeHead(200);
        res.end(JSON.stringify(logs));
        return;
      }

      // Interactions endpoint — query recent interactions from interaction-log skill
      if (req.method === 'GET' && url.pathname === '/api/interactions') {
        const iLog = this.skills?.get('interaction-log');
        if (!iLog || !('getRecent' in iLog)) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'interaction-log skill not available' }));
          return;
        }
        const limit = parseInt(url.searchParams.get('limit') ?? '50');
        const bot = url.searchParams.get('bot') ?? undefined;
        const rows = (iLog as any).getRecent(limit, bot);
        res.writeHead(200);
        res.end(JSON.stringify(rows));
        return;
      }

      // Interaction stats endpoint
      if (req.method === 'GET' && url.pathname === '/api/interactions/stats') {
        const iLog = this.skills?.get('interaction-log');
        if (!iLog || !('getStats' in iLog)) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'interaction-log skill not available' }));
          return;
        }
        const days = parseInt(url.searchParams.get('days') ?? '7');
        const stats = (iLog as any).getStats(days);
        res.writeHead(200);
        res.end(JSON.stringify(stats));
        return;
      }

      // Cost-by-bot endpoint
      if (req.method === 'GET' && url.pathname === '/api/costs') {
        const tracker = this.skills?.get('token-tracker');
        if (!tracker || !('getCostByBot' in tracker)) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'token-tracker skill not available' }));
          return;
        }
        const days = parseInt(url.searchParams.get('days') ?? '30');
        const costs = (tracker as any).getCostByBot(days);
        res.writeHead(200);
        res.end(JSON.stringify(costs));
        return;
      }

      // Restart endpoint
      if (req.method === 'POST' && url.pathname === '/api/restart') {
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'restarting' }));
        setTimeout(() => process.exit(0), 100);
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    // Bind. Default localhost; set HEALTH_BIND_ADDR=0.0.0.0 to expose on
    // Tailscale interface for cross-host probes.
    const bindAddr = process.env.HEALTH_BIND_ADDR || DEFAULT_BIND;
    this.server.listen(port, bindAddr, () => {
      ctx.log.info(`Health server listening on http://${bindAddr}:${port}${healthPath}`);
    });
  }

  /** Add a log line to the ring buffer (called by runtime) */
  addLog(level: string, message: string): void {
    this.logBuffer.push({ timestamp: new Date().toISOString(), level, message });
    if (this.logBuffer.length > LOG_BUFFER_SIZE) {
      this.logBuffer.shift();
    }
  }

  async destroy(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

export function createSkill(): HealthServerSkill {
  return new HealthServerSkill();
}

export default new HealthServerSkill();
