/**
 * Cron handler: nudge_send
 *
 * 5:00pm ET Sun-Thu. For each In-Progress task whose chat hasn't sent a
 * message in the last 60 min, send a "status?" prompt. Recorded in
 * `nudge_log` so we don't double-nudge. Tracks delivery success.
 *
 * Skips chats that recently messaged (proxy: any task updated_at < 60min ago
 * by that chat — best-effort signal that Mark is actively working).
 *
 * Ported from standalone src/nudge/scheduler.ts:sendNudges.
 */
import { DateTime } from 'luxon';
import { ensureDb } from '../lib/atlas-client.js';
import { isWorkingDay, TIMEZONE } from '../lib/working-hours.js';
import { loadAtlasPresence, shouldSkipRun } from '../lib/presence.js';

const RECENT_ACTIVITY_MINUTES = 60;

export default {
  name: 'nudge_send',
  async execute(ctx) {
    const now = DateTime.now().setZone(TIMEZONE);
    if (!isWorkingDay(now)) {
      ctx.log.debug('nudge_send: not a work day');
      return;
    }
    const today = now.toFormat('yyyy-MM-dd');

    const db = ensureDb(ctx.config);

    // Bleed-stopper: don't nudge ghosts / don't act on unverifiable state.
    const presence = await loadAtlasPresence(ctx);
    if (shouldSkipRun(presence)) {
      ctx.log.warn('nudge_send: Atlas unverifiable, skipping run');
      return;
    }

    const tasks = db.prepare(
      `SELECT t.id, t.spok_id, t.title, t.requester_chat_id, t.updated_at
         FROM tasks t
        WHERE t.status != 'DONE'
          AND t.status != 'ARCHIVED'
          AND t.column_name = 'In Progress'
          AND t.blocked_at IS NULL
          AND t.requester_chat_id IS NOT NULL`
    ).all();

    let sent = 0;
    for (const task of tasks) {
      if (presence.skip(task)) continue;
      // Skip if nudged today already
      const existing = db.prepare(
        'SELECT id FROM nudge_log WHERE task_id = ? AND nudge_date = ?'
      ).get(task.id, today);
      if (existing) continue;

      // Skip if chat had recent activity (proxy: any task in this chat updated <60min ago)
      const recent = db.prepare(
        `SELECT 1 FROM tasks
          WHERE requester_chat_id = ?
            AND updated_at > datetime('now', '-${RECENT_ACTIVITY_MINUTES} minutes')
          LIMIT 1`
      ).get(task.requester_chat_id);
      if (recent) continue;

      let delivered = 1;
      try {
        await ctx.adapter.send({
          chatId: task.requester_chat_id,
          // Embed a resolvable id so a reply resolves to THIS task by id.
          text: `Need an update on *${task.title}* (ID:${(task.spok_id || task.id).slice(0, 8)}) — what's the status? ($0.10 deduction at 7pm if no reply)`,
          parseMode: 'Markdown',
        });
        sent++;
      } catch (err) {
        ctx.log.warn(`nudge_send: failed to send for ${task.id}: ${err}`);
        delivered = 0;
      }

      db.prepare(
        `INSERT OR IGNORE INTO nudge_log (task_id, nudge_date, sent_at, delivered)
         VALUES (?, ?, ?, ?)`
      ).run(task.id, today, new Date().toISOString(), delivered);
    }

    if (sent > 0) ctx.log.info(`nudge_send: sent ${sent} nudges for ${today}`);
  },
};
