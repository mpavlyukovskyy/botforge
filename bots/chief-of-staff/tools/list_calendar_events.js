import { z } from 'zod';
import { getTodayEvents, getUpcomingEvents, getEventsForDate } from '../lib/calendar-client.js';

const listCalendarEvents = {
  name: 'list_calendar_events',
  description:
    'List calendar events. Can show today\'s events, upcoming events within N hours, ' +
    'or events on a specific date.',
  schema: {
    date: z.string().optional().describe('Specific date to query (YYYY-MM-DD)'),
    hours_ahead: z.number().optional().describe('Show events in the next N hours (default: 4)'),
    today_only: z.boolean().optional().describe('If true, show only today\'s events'),
  },
  permissions: { db: 'read' },
  execute: async (args) => {
    let events;
    let label;

    if (args.date) {
      events = await getEventsForDate(args.date);
      label = `Events on ${args.date}`;
    } else if (args.today_only) {
      events = await getTodayEvents();
      label = "Today's events";
    } else {
      const hours = args.hours_ahead ?? 4;
      events = await getUpcomingEvents(hours);
      label = `Upcoming events (next ${hours}h)`;
    }

    if (!events || events.length === 0) {
      return `${label}: none found.`;
    }

    const lines = events.map((ev) => {
      const parts = [];

      // Time
      if (ev.allDay) {
        parts.push('All day');
      } else if (ev.start) {
        const start = ev.start.slice(11, 16);
        const end = ev.end ? ev.end.slice(11, 16) : '';
        parts.push(end ? `${start}-${end}` : start);
      }

      // Title
      parts.push(ev.summary);

      // Attendees
      if (ev.attendees && ev.attendees.length > 0) {
        const names = ev.attendees
          .map((a) => a.name || a.email)
          .slice(0, 5)
          .join(', ');
        const extra = ev.attendees.length > 5 ? ` +${ev.attendees.length - 5} more` : '';
        parts.push(`with: ${names}${extra}`);
      }

      // Location
      if (ev.location) {
        parts.push(`@ ${ev.location}`);
      }

      return parts.join(' | ');
    });

    return `${label} (${events.length}):\n${lines.join('\n')}`;
  },
};

export default listCalendarEvents;
