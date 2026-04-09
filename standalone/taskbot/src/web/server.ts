import http from 'http';
import { getConfig } from '../config.js';
import {
  boardPage,
  taskDetailPage,
  createTaskPage,
  settingsPage,
} from './templates.js';
import * as queries from '../db/queries.js';
import { getDb } from '../db/index.js';

let server: http.Server;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function parseFormBody(body: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of body.split('&')) {
    const [k, v] = pair.split('=');
    if (k) result[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return result;
}

export function startWebServer(port: number): void {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    try {
      // Health — no auth
      if (pathname === '/api/health') {
        const stats = queries.getTaskStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), ...stats }));
      }

      // Auth disabled — dashboard is public (read-only board view)
      if (pathname === '/login') {
        res.writeHead(302, { Location: '/board' });
        return res.end();
      }

      // Board
      if ((pathname === '/' || pathname === '/board') && method === 'GET') {
        const category = url.searchParams.get('category') || undefined;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(boardPage(category));
      }

      // Create task page
      if (pathname === '/task/new' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(createTaskPage());
      }

      // Task detail
      const taskDetailMatch = pathname.match(/^\/task\/([a-f0-9-]+)$/);
      if (taskDetailMatch && method === 'GET') {
        const task = queries.getTaskById(taskDetailMatch[1]);
        if (!task) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('Task not found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(taskDetailPage(task));
      }

      // Settings
      if (pathname === '/settings' && method === 'GET') {
        const db = getDb();
        const auth = db.prepare('SELECT id FROM google_auth WHERE id = 1').get();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(settingsPage(!!auth));
      }

      // === API routes ===

      // Create task
      if (pathname === '/api/tasks' && method === 'POST') {
        const body = await readBody(req);
        const contentType = req.headers['content-type'] || '';
        let data: Record<string, string>;
        if (contentType.includes('application/json')) {
          data = JSON.parse(body);
        } else {
          data = parseFormBody(body);
        }

        if (!data.title) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Title required' }));
        }

        queries.createTask({
          title: data.title,
          category: data.category || 'home',
          priority: data.priority ? Number(data.priority) : 2,
          deadline: data.deadline || undefined,
          deadline_time: data.deadline_time || undefined,
          source: 'dashboard',
        });

        // Redirect for form submissions, JSON for API
        if (contentType.includes('application/json')) {
          res.writeHead(201, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true }));
        }
        res.writeHead(302, { Location: '/board' });
        return res.end();
      }

      // Update task
      const taskUpdateMatch = pathname.match(/^\/api\/tasks\/([a-f0-9-]+)$/);

      // Get task detail (JSON)
      if (taskUpdateMatch && method === 'GET') {
        const task = queries.getTaskById(taskUpdateMatch[1]);
        if (!task) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Not found' }));
        }
        const subtasks = queries.getSubtasks(task.id);
        const attachments = queries.getAttachments(task.id).map(a => ({
          ...a,
          image_base64: a.image_base64 ? a.image_base64.substring(0, 200) + '...' : null
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ task, subtasks, attachments }));
      }

      if (taskUpdateMatch && method === 'PATCH') {
        const body = JSON.parse(await readBody(req));
        queries.updateTask(taskUpdateMatch[1], body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      // Delete task
      if (taskUpdateMatch && method === 'DELETE') {
        queries.deleteTask(taskUpdateMatch[1]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      // Mark done
      const doneMatch = pathname.match(/^\/api\/tasks\/([a-f0-9-]+)\/done$/);
      if (doneMatch && method === 'POST') {
        queries.markDone([doneMatch[1]]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      // Move task
      const moveMatch = pathname.match(/^\/api\/tasks\/([a-f0-9-]+)\/move$/);
      if (moveMatch && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        queries.updateTask(moveMatch[1], { column_name: body.column_name });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      // Add subtask
      const addSubtaskMatch = pathname.match(/^\/api\/tasks\/([a-f0-9-]+)\/subtasks$/);
      if (addSubtaskMatch && method === 'POST') {
        const body = JSON.parse(await readBody(req));
        if (!body.title) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Title required' }));
        }
        queries.addSubtask(addSubtaskMatch[1], body.title);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      // Toggle subtask
      const subtaskMatch = pathname.match(/^\/api\/tasks\/([a-f0-9-]+)\/subtasks\/(\d+)\/toggle$/);
      if (subtaskMatch && method === 'POST') {
        queries.toggleSubtask(parseInt(subtaskMatch[2]));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }

      // Google Calendar OAuth (Phase 9 - placeholder routes)
      if (pathname === '/api/google/authorize' && method === 'GET') {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Google Calendar not configured yet' }));
      }

      if (pathname === '/api/google/callback' && method === 'GET') {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Google Calendar not configured yet' }));
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      console.error('[web] Server error:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    }
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[web] Dashboard listening on port ${port}`);
  });
}

export function stopWebServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
}
