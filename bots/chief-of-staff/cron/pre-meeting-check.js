/**
 * Cron handler: pre_meeting_check
 *
 * Checks for upcoming meetings and sends prep briefings.
 * Runs every 5 min during work hours.
 */
import { getEventsBefore } from '../lib/calendar-client.js';
import { generateMeetingPrep, formatBriefingForTelegram } from '../lib/meeting-prep.js';
import { ensureDb } from '../lib/db.js';

export default {
  name: 'pre_meeting_check',
  async execute(ctx) {
    const db = ensureDb(ctx.config);
    const chatId = ctx.config.platform?.chat_ids?.[0]
      || ctx.config.behavior?.access?.admin_users?.[0];
    if (!chatId) return;

    // Get events starting in next 35 minutes (30min prep + 5min buffer)
    let events;
    try {
      events = await getEventsBefore(35);
    } catch (err) {
      ctx.log.error(`Calendar fetch failed: ${err.message}`);
      return;
    }

    if (!events || events.length === 0) return;

    let briefingsSent = 0;

    for (const event of events) {
      const eventId = event.id || event.eventId;
      if (!eventId) continue;

      // Upsert event into calendar_events table
      db.prepare(`
        INSERT OR REPLACE INTO calendar_events
          (event_id, summary, start_time, end_time, attendees, location, description, briefing_sent)
        VALUES (?, ?, ?, ?, ?, ?, ?,
          COALESCE((SELECT briefing_sent FROM calendar_events WHERE event_id = ?), 0))
      `).run(
        eventId,
        event.summary || event.title || 'Untitled',
        event.start?.dateTime || event.start || null,
        event.end?.dateTime || event.end || null,
        JSON.stringify(event.attendees || []),
        event.location || null,
        event.description || null,
        eventId,
      );

      // Check if briefing already sent
      const row = db.prepare(
        'SELECT briefing_sent FROM calendar_events WHERE event_id = ?'
      ).get(eventId);

      if (row && row.briefing_sent) continue;

      // Generate and send meeting prep
      try {
        const prep = await generateMeetingPrep(ctx, event);
        const text = formatBriefingForTelegram(prep, event);

        await ctx.adapter.send({ chatId, text, parseMode: 'Markdown' });

        // Mark briefing as sent
        db.prepare(
          'UPDATE calendar_events SET briefing_sent = 1 WHERE event_id = ?'
        ).run(eventId);

        briefingsSent++;
      } catch (err) {
        ctx.log.error(`Meeting prep failed for "${event.summary}": ${err.message}`);
      }
    }

    if (briefingsSent > 0) {
      ctx.log.info(`Pre-meeting check: sent ${briefingsSent} briefing(s)`);
    }
  },
};
