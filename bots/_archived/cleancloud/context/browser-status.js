/**
 * Context builder: browser_status
 *
 * Injects headless browser status (running/stopped, last mutation).
 */
import { isBrowserRunning } from '../lib/browser.js';
import { ensureDb, getRecentOperations } from '../lib/db.js';

export default {
  type: 'browser_status',
  async build(ctx) {
    const running = isBrowserRunning();

    let lastMutation = 'none';
    try {
      ensureDb(ctx.config);
      const ops = getRecentOperations(ctx.config, 1);
      if (ops.length > 0) {
        lastMutation = `${ops[0].action} at ${ops[0].created_at}`;
      }
    } catch {}

    return `<browser_status>${running ? 'running' : 'stopped'} | last_mutation: ${lastMutation}</browser_status>`;
  },
};
