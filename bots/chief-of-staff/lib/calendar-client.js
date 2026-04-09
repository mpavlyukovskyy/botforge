/**
 * Google Calendar API client
 *
 * OAuth2 authentication with automatic token refresh.
 * Functional style, no classes.
 */
import { google } from 'googleapis';
import { readFileSync, writeFileSync } from 'node:fs';

// ─── Module state ───────────────────────────────────────────────────────────

let _calendar = null;
let _auth = null;
let _tokenPath = null;
let _calendarIds = ['primary'];

// ─── Initialization ─────────────────────────────────────────────────────────

/**
 * Initialize the OAuth2 client and calendar API.
 *
 * @param {string} [credentialsPath] - Path to OAuth2 credentials JSON (default: env GOOGLE_CREDENTIALS_PATH)
 * @param {string} [tokenPath]       - Path to stored token JSON (default: env GOOGLE_TOKEN_PATH)
 * @param {object} [options]
 * @param {string[]} [options.calendarIds] - Calendar IDs to query (default: ['primary'])
 * @returns {{ calendar, auth }} Google calendar resource + auth client
 */
export function initCalendar(credentialsPath, tokenPath, options = {}) {
  const credsFile = credentialsPath || process.env.GOOGLE_CREDENTIALS_PATH;
  const tokFile = tokenPath || process.env.GOOGLE_TOKEN_PATH;

  if (!credsFile || !tokFile) {
    console.warn('[calendar-client] Missing credentials or token path — calendar calls will return empty results');
    return null;
  }

  let credentials;
  try {
    credentials = JSON.parse(readFileSync(credsFile, 'utf-8'));
  } catch (err) {
    console.warn(`[calendar-client] Cannot read credentials file (${credsFile}):`, err.message);
    return null;
  }

  // Support both "installed" and "web" credential shapes
  const creds = credentials.installed || credentials.web;
  if (!creds) {
    console.warn('[calendar-client] Credentials file missing "installed" or "web" key');
    return null;
  }

  const oauth2 = new google.auth.OAuth2(
    creds.client_id,
    creds.client_secret,
    creds.redirect_uris?.[0] || 'urn:ietf:wg:oauth:2.0:oob',
  );

  let token;
  try {
    token = JSON.parse(readFileSync(tokFile, 'utf-8'));
  } catch (err) {
    console.warn(`[calendar-client] Cannot read token file (${tokFile}):`, err.message);
    return null;
  }

  oauth2.setCredentials(token);
  _tokenPath = tokFile;

  // Auto-refresh: persist new tokens when the library refreshes them
  oauth2.on('tokens', (newTokens) => {
    try {
      const merged = { ...token, ...newTokens };
      writeFileSync(_tokenPath, JSON.stringify(merged, null, 2));
      token = merged;
    } catch (err) {
      console.warn('[calendar-client] Failed to save refreshed token:', err.message);
    }
  });

  _auth = oauth2;
  _calendar = google.calendar({ version: 'v3', auth: oauth2 });

  if (options.calendarIds) {
    _calendarIds = options.calendarIds;
  }

  return { calendar: _calendar, auth: _auth };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function ensureCalendar() {
  if (!_calendar) {
    initCalendar();
  }
  return _calendar;
}

/**
 * Strip HTML tags from a string (for event descriptions).
 */
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Normalize a single Google Calendar event into a flat object.
 */
function normalizeEvent(event) {
  const isAllDay = !event.start?.dateTime;

  const attendees = (event.attendees || []).map((a) => ({
    email: a.email || '',
    name: a.displayName || '',
    responseStatus: a.responseStatus || 'needsAction',
  }));

  return {
    id: event.id,
    summary: event.summary || '(No title)',
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    allDay: isAllDay,
    attendees,
    location: event.location || '',
    description: stripHtml(event.description),
    htmlLink: event.htmlLink || '',
  };
}

/**
 * Start of day in ISO 8601 (local timezone).
 */
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * End of day in ISO 8601 (local timezone).
 */
function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

// ─── Core fetch ─────────────────────────────────────────────────────────────

/**
 * List events across all configured calendars in a time range.
 *
 * @param {string} timeMin - ISO 8601 start time
 * @param {string} timeMax - ISO 8601 end time
 * @returns {Promise<object[]>} Normalized event objects sorted by start time
 */
export async function listEvents(timeMin, timeMax) {
  const cal = ensureCalendar();
  if (!cal) return [];

  const allEvents = [];

  for (const calendarId of _calendarIds) {
    try {
      const res = await cal.events.list({
        calendarId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
      });
      const items = res.data.items || [];
      allEvents.push(...items.map(normalizeEvent));
    } catch (err) {
      console.warn(`[calendar-client] Error fetching calendar "${calendarId}":`, err.message);
    }
  }

  // Sort merged results by start time
  allEvents.sort((a, b) => {
    const ta = a.start ? new Date(a.start).getTime() : 0;
    const tb = b.start ? new Date(b.start).getTime() : 0;
    return ta - tb;
  });

  return allEvents;
}

// ─── Convenience functions ──────────────────────────────────────────────────

/**
 * Get all events for today.
 */
export async function getTodayEvents() {
  const now = new Date();
  return listEvents(startOfDay(now), endOfDay(now));
}

/**
 * Get events in the next N hours (default: 4).
 */
export async function getUpcomingEvents(hours = 4) {
  const now = new Date();
  const later = new Date(now.getTime() + hours * 60 * 60 * 1000);
  return listEvents(now.toISOString(), later.toISOString());
}

/**
 * Get events on a specific date.
 *
 * @param {string} date - YYYY-MM-DD
 */
export async function getEventsForDate(date) {
  const d = new Date(date + 'T00:00:00');
  return listEvents(startOfDay(d), endOfDay(d));
}

/**
 * Find the very next upcoming event (closest future start).
 * Returns null if nothing is scheduled.
 */
export async function findNextEvent() {
  const now = new Date();
  // Look ahead 7 days
  const later = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const events = await listEvents(now.toISOString(), later.toISOString());

  // Filter to events that haven't started yet (or started within last minute for buffer)
  const upcoming = events.filter((e) => {
    if (!e.start) return false;
    return new Date(e.start).getTime() > now.getTime() - 60_000;
  });

  return upcoming[0] || null;
}

/**
 * Get events starting within the next N minutes.
 * Useful for pre-meeting briefing triggers.
 *
 * @param {number} minutesBefore - Window in minutes (default: 15)
 */
export async function getEventsBefore(minutesBefore = 15) {
  const now = new Date();
  const cutoff = new Date(now.getTime() + minutesBefore * 60 * 1000);
  const events = await listEvents(now.toISOString(), cutoff.toISOString());

  // Only include events that start within the window (not already in progress)
  return events.filter((e) => {
    if (!e.start || e.allDay) return false;
    const startTime = new Date(e.start).getTime();
    return startTime >= now.getTime() && startTime <= cutoff.getTime();
  });
}
