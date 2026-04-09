/**
 * Context builder: todays_calendar
 *
 * Injects today's calendar events into LLM context.
 */
import { getTodayEvents } from '../lib/calendar-client.js';

export default {
  type: 'todays_calendar',
  async build(ctx) {
    let events;
    try {
      events = await getTodayEvents();
    } catch (err) {
      return '<todays_calendar>Failed to load calendar.</todays_calendar>';
    }

    if (!events || events.length === 0) {
      return '<todays_calendar>No events today.</todays_calendar>';
    }

    const lines = events.map((e) => {
      let line = '';

      if (e.allDay) {
        line = `[All day] ${e.summary}`;
      } else {
        const startTime = new Date(e.start).toLocaleTimeString('en-US', {
          timeZone: 'America/New_York',
          hour: '2-digit',
          minute: '2-digit',
          hour12: true,
        });
        const endTime = e.end
          ? new Date(e.end).toLocaleTimeString('en-US', {
              timeZone: 'America/New_York',
              hour: '2-digit',
              minute: '2-digit',
              hour12: true,
            })
          : null;
        line = endTime ? `${startTime}-${endTime} ${e.summary}` : `${startTime} ${e.summary}`;
      }

      if (e.attendees && e.attendees.length > 0) {
        const names = e.attendees
          .map((a) => a.name || a.email)
          .slice(0, 5)
          .join(', ');
        line += ` (${names})`;
      }

      if (e.location) {
        line += ` @ ${e.location}`;
      }

      return `- ${line}`;
    });

    const text = lines.join('\n');
    return `<todays_calendar>\n${text}\n</todays_calendar>`;
  },
};
