import { createServer, type Server } from 'node:http';
import type { Skill, SkillContext } from '@botforge/core';
import type { ToolRegistry, ToolContext } from '@botforge/core';

export class ToolServerSkill implements Skill {
  readonly name = 'tool-server';
  private server?: Server;
  private startTime = Date.now();

  async init(ctx: SkillContext): Promise<void> {
    const tsConfig = ctx.config.tool_server;
    if (!tsConfig) return;

    this.startTime = Date.now();
    const { port, auth_token } = tsConfig;

    const toolRegistry = ctx.store?.get('toolRegistry') as ToolRegistry | undefined;
    if (!toolRegistry) {
      ctx.log.warn('Tool server: no toolRegistry in store, tool execution unavailable');
    }

    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      res.setHeader('Content-Type', 'application/json');

      // Health endpoint (unauthenticated)
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200);
        res.end(JSON.stringify({
          status: 'healthy',
          botName: ctx.config.name,
          uptime: Math.floor((Date.now() - this.startTime) / 1000),
          toolCount: toolRegistry?.getAll().length ?? 0,
        }));
        return;
      }

      // Auth check for all other endpoints
      if (auth_token) {
        const authHeader = req.headers.authorization;
        if (authHeader !== `Bearer ${auth_token}`) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      // GET /tools — list available tools
      if (req.method === 'GET' && url.pathname === '/tools') {
        if (!toolRegistry) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: 'Tool registry not available' }));
          return;
        }
        const tools = toolRegistry.getAll().map(t => ({
          name: t.name,
          description: t.description,
          permissions: t.permissions,
        }));
        res.writeHead(200);
        res.end(JSON.stringify({ tools }));
        return;
      }

      // POST /tools/:name — execute a tool
      const toolMatch = url.pathname.match(/^\/tools\/([a-zA-Z0-9_-]+)$/);
      if (req.method === 'POST' && toolMatch) {
        if (!toolRegistry) {
          res.writeHead(503);
          res.end(JSON.stringify({ error: 'Tool registry not available' }));
          return;
        }

        const toolName = toolMatch[1]!;
        const tool = toolRegistry.get(toolName);
        if (!tool) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Tool "${toolName}" not found` }));
          return;
        }

        // Parse request body
        let body = '';
        for await (const chunk of req) {
          body += chunk;
        }

        let args: unknown;
        try {
          args = body ? JSON.parse(body) : {};
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }

        // Synthetic ToolContext — permissions enforced via toBrainTools
        const toolCtx: ToolContext = {
          chatId: '',
          userId: 'tool-server',
          userName: 'tool-server',
          db: ctx.db,
          config: ctx.config,
          adapter: ctx.adapter,
          log: ctx.log,
          store: ctx.store ?? new Map(),
        };

        // Use toBrainTools to get permission-sandboxed executors
        const brainTools = toolRegistry.toBrainTools(toolCtx);
        const brainTool = brainTools.find(t => t.name === toolName);
        if (!brainTool) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Tool "${toolName}" not available` }));
          return;
        }

        try {
          const result = await brainTool.execute(args);
          const isError = result.isError ?? false;
          const text = result.content.map((c: { text: string }) => c.text).join('\n');
          res.writeHead(isError ? 500 : 200);
          res.end(JSON.stringify({ result: text, isError }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          res.writeHead(500);
          res.end(JSON.stringify({ error: message }));
        }
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    });

    this.server.listen(port, '127.0.0.1', () => {
      ctx.log.info(`Tool server listening on http://127.0.0.1:${port}`);
    });
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

export function createSkill(): ToolServerSkill {
  return new ToolServerSkill();
}

export default new ToolServerSkill();
