import 'dotenv/config';
import { createServer } from 'http';
import { loadConfig, getConfig } from './config.js';
import { initDb, closeDb } from './db/index.js';
import { getTaskStats } from './db/queries.js';
import { initBot, stopBot } from './telegram/bot.js';
import { startCronJobs } from './scheduler/cron.js';
import { startWebServer, stopWebServer } from './web/server.js';
import { ensureLunchDb } from './lunch/index.js';

async function main(): Promise<void> {
  // 1. Validate config
  console.log('[startup] Loading config...');
  loadConfig();
  const config = getConfig();

  // 2. Initialize SQLite
  console.log('[startup] Initializing database...');
  initDb();
  ensureLunchDb();

  // 3. Initialize Telegram bot
  console.log('[startup] Starting Telegram bot...');
  await initBot();

  // 4. Start cron jobs
  console.log('[startup] Starting cron jobs...');
  startCronJobs();

  // 5. Start web dashboard
  console.log('[startup] Starting web dashboard...');
  startWebServer(config.DASHBOARD_PORT);

  // 6. Start health server
  startHealthServer(config.HEALTH_PORT);

  console.log(`[startup] ${config.BOT_NAME} online`);
}

function startHealthServer(port: number): void {
  const server = createServer((req, res) => {
    if (req.url === '/api/health' && req.method === 'GET') {
      const stats = getTaskStats();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          uptime: process.uptime(),
          ...stats,
        })
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    console.log(`[health] Listening on port ${port}`);
  });
}

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  console.log(`[shutdown] Received ${signal}, shutting down...`);
  stopBot();
  await stopWebServer();
  closeDb();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  console.error('[startup] Fatal error:', err);
  process.exit(1);
});
