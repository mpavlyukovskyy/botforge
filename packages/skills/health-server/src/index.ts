import { createServer, type Server } from 'node:http';
import type { Skill, SkillContext } from '@botforge/core';

const LOG_BUFFER_SIZE = 1000;

export class HealthServerSkill implements Skill {
  readonly name = 'health-server';
  private server?: Server;
  private startTime = Date.now();
  private logBuffer: Array<{ timestamp: string; level: string; message: string }> = [];

  async init(ctx: SkillContext): Promise<void> {
    if (!ctx.config.health) return;
    this.startTime = Date.now();

    const { port, path: healthPath, management_api } = ctx.config.health;

    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);

      res.setHeader('Content-Type', 'application/json');

      // Health endpoint
      if (req.method === 'GET' && url.pathname === healthPath) {
        const health = {
          status: 'healthy',
          botName: ctx.config.name,
          uptime: Math.floor((Date.now() - this.startTime) / 1000),
          memory: process.memoryUsage(),
          version: ctx.config.version,
          platform: ctx.config.platform.type,
          brain: ctx.config.brain.provider,
        };
        res.writeHead(200);
        res.end(JSON.stringify(health));
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

    // Bind to localhost only
    this.server.listen(port, '127.0.0.1', () => {
      ctx.log.info(`Health server listening on http://127.0.0.1:${port}${healthPath}`);
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
