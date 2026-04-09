/**
 * Morning briefing compiler — synthesizes multi-source context into
 * structured Telegram-ready briefings.
 *
 * Briefing types:
 *   Morning  — calendar, overnight email, overdue/due-today commitments, decay alerts
 *   EOD wrap — today's actions summary + tomorrow preview
 *   Weekly   — week in review + next week priorities
 *
 * All outputs are Markdown formatted for Telegram (under 4000 chars).
 */
import { getRecentActivity, getStats as emailStats, listCustomers } from './email-intel-db.js';
import { getTodayEvents } from './calendar-client.js';
import {
  getOverdue,
  getDueToday,
  getDueThisWeek,
  getStats as commitmentStats,
  getNeedingFollowup,
  listCommitments,
} from './commitments-db.js';
import { searchKb } from './kb.js';
import { compile } from './claude.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDate(date) {
  const d = date || new Date();
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
}

function overnightSince() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  d.setHours(22, 0, 0, 0);
  return d;
}

function hoursSince(date) {
  return Math.round((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60));
}

function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text || '';
  return text.slice(0, maxLen - 1) + '\u2026';
}

function coverageIndicator(sources) {
  const available = sources.filter(s => s.ok);
  return `\n_Coverage: ${available.length}/${sources.length} sources (${available.map(s => s.name).join(', ')})_`;
}

// ─── Data gathering ────────────────────────────────────────────────────────

async function gatherMorningData(ctx) {
  const sources = [];

  // Calendar
  let events = [];
  try {
    events = await getTodayEvents();
    sources.push({ name: 'calendar', ok: true });
  } catch (err) {
    console.warn('[briefing] Calendar fetch failed:', err.message);
    sources.push({ name: 'calendar', ok: false });
  }

  // Overnight email
  const overnightCutoff = overnightSince();
  const hoursBack = hoursSince(overnightCutoff);
  let overnightEmails = [];
  let emailStatsData = null;
  try {
    overnightEmails = getRecentActivity(hoursBack);
    emailStatsData = emailStats();
    sources.push({ name: 'email', ok: true });
  } catch (err) {
    console.warn('[briefing] Email fetch failed:', err.message);
    sources.push({ name: 'email', ok: false });
  }

  // Commitments
  let overdue = [];
  let dueToday = [];
  let needingFollowup = [];
  let cStats = null;
  try {
    overdue = getOverdue(ctx);
    dueToday = getDueToday(ctx);
    needingFollowup = getNeedingFollowup(ctx);
    cStats = commitmentStats(ctx);
    sources.push({ name: 'commitments', ok: true });
  } catch (err) {
    console.warn('[briefing] Commitments fetch failed:', err.message);
    sources.push({ name: 'commitments', ok: false });
  }

  // Relationship decay: customers with stale last contact
  let decayAlerts = [];
  try {
    const customers = listCustomers({ status: 'active' });
    decayAlerts = customers.filter(c => {
      if (!c.next_follow_up_date) return false;
      return c.next_follow_up_date <= new Date().toISOString().slice(0, 10);
    });
    sources.push({ name: 'customers', ok: true });
  } catch (err) {
    console.warn('[briefing] Customer fetch failed:', err.message);
    sources.push({ name: 'customers', ok: false });
  }

  return {
    events,
    overnightEmails,
    emailStatsData,
    overdue,
    dueToday,
    needingFollowup,
    cStats,
    decayAlerts,
    sources,
  };
}

async function gatherEodData(ctx) {
  const sources = [];

  // Today's email activity
  let todayEmails = [];
  try {
    todayEmails = getRecentActivity(16); // roughly since 6am
    sources.push({ name: 'email', ok: true });
  } catch (err) {
    console.warn('[briefing] Email fetch failed:', err.message);
    sources.push({ name: 'email', ok: false });
  }

  // Commitments created/fulfilled today
  const todayStr = new Date().toISOString().slice(0, 10);
  let allActive = [];
  let cStats = null;
  let fulfilledToday = [];
  try {
    allActive = listCommitments(ctx, { status: 'active' });
    cStats = commitmentStats(ctx);
    fulfilledToday = listCommitments(ctx, { status: 'fulfilled' }).filter(
      c => c.fulfilled_at && c.fulfilled_at.startsWith(todayStr)
    );
    sources.push({ name: 'commitments', ok: true });
  } catch (err) {
    console.warn('[briefing] Commitments fetch failed:', err.message);
    sources.push({ name: 'commitments', ok: false });
  }

  // Tomorrow's calendar
  let tomorrowEvents = [];
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const { listEvents } = await import('./calendar-client.js');
    const tStart = new Date(tomorrow);
    tStart.setHours(0, 0, 0, 0);
    const tEnd = new Date(tomorrow);
    tEnd.setHours(23, 59, 59, 999);
    tomorrowEvents = await listEvents(tStart.toISOString(), tEnd.toISOString());
    sources.push({ name: 'calendar', ok: true });
  } catch (err) {
    console.warn('[briefing] Calendar fetch failed:', err.message);
    sources.push({ name: 'calendar', ok: false });
  }

  // Tomorrow's follow-ups
  let tomorrowFollowups = [];
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    tomorrowFollowups = listCommitments(ctx, { status: 'active' }).filter(
      c => c.next_followup_date === tomorrowStr || c.due_date === tomorrowStr
    );
  } catch {
    // already tracked via commitments source
  }

  return {
    todayEmails,
    fulfilledToday,
    allActive,
    cStats,
    tomorrowEvents,
    tomorrowFollowups,
    sources,
  };
}

async function gatherWeeklyData(ctx) {
  const sources = [];

  // This week's commitments
  let dueThisWeek = [];
  let cStats = null;
  let allActive = [];
  let fulfilledRecent = [];
  try {
    dueThisWeek = getDueThisWeek(ctx);
    cStats = commitmentStats(ctx);
    allActive = listCommitments(ctx, { status: 'active' });
    fulfilledRecent = listCommitments(ctx, { status: 'fulfilled' });
    sources.push({ name: 'commitments', ok: true });
  } catch (err) {
    console.warn('[briefing] Commitments fetch failed:', err.message);
    sources.push({ name: 'commitments', ok: false });
  }

  // Email stats
  let emailStatsData = null;
  let weekEmails = [];
  try {
    emailStatsData = emailStats();
    weekEmails = getRecentActivity(168); // 7 days
    sources.push({ name: 'email', ok: true });
  } catch (err) {
    console.warn('[briefing] Email fetch failed:', err.message);
    sources.push({ name: 'email', ok: false });
  }

  // Customer overview
  let customers = [];
  try {
    customers = listCustomers();
    sources.push({ name: 'customers', ok: true });
  } catch (err) {
    console.warn('[briefing] Customer fetch failed:', err.message);
    sources.push({ name: 'customers', ok: false });
  }

  // KB context (facility, pipeline)
  let facilityPage = null;
  let pipelinePage = null;
  try {
    const facilityResults = searchKb('facility', { category: 'facility', limit: 1 });
    facilityPage = facilityResults[0] || null;
    const pipelineResults = searchKb('pipeline', { category: 'pipeline', limit: 1 });
    pipelinePage = pipelineResults[0] || null;
    sources.push({ name: 'kb', ok: true });
  } catch (err) {
    console.warn('[briefing] KB fetch failed:', err.message);
    sources.push({ name: 'kb', ok: false });
  }

  return {
    dueThisWeek,
    cStats,
    allActive,
    fulfilledRecent,
    emailStatsData,
    weekEmails,
    customers,
    facilityPage,
    pipelinePage,
    sources,
  };
}

// ─── Context formatters ────────────────────────────────────────────────────

function formatEventsForContext(events) {
  if (!events.length) return 'No events scheduled today.';

  return events.map(e => {
    const time = e.allDay ? 'All day' : new Date(e.start).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const attendees = e.attendees.length > 0
      ? ` (${e.attendees.map(a => a.name || a.email).join(', ')})`
      : '';
    return `- ${time} ${e.summary}${attendees}${e.location ? ` @ ${e.location}` : ''}`;
  }).join('\n');
}

function formatEmailsForContext(emails) {
  if (!emails.length) return 'No emails in this period.';

  const inbound = emails.filter(e => e.direction === 'inbound');
  const outbound = emails.filter(e => e.direction === 'outbound');

  const byCategory = {};
  for (const e of inbound) {
    const cat = e.category || 'uncategorized';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(e);
  }

  const lines = [`Total: ${emails.length} (${inbound.length} inbound, ${outbound.length} outbound)`];
  for (const [cat, items] of Object.entries(byCategory)) {
    lines.push(`  ${cat}: ${items.length} — ${items.slice(0, 3).map(e => truncate(e.subject, 50)).join('; ')}`);
  }

  return lines.join('\n');
}

function formatCommitmentsForContext(commitments, label) {
  if (!commitments.length) return `${label}: None.`;

  const lines = [`${label} (${commitments.length}):`];
  for (const c of commitments.slice(0, 10)) {
    const due = c.due_date ? ` [due ${c.due_date}]` : '';
    const cust = c.customer ? ` (${c.customer})` : '';
    lines.push(`- [${c.type}] ${truncate(c.description, 80)}${cust}${due}`);
  }
  if (commitments.length > 10) {
    lines.push(`  ... and ${commitments.length - 10} more`);
  }
  return lines.join('\n');
}

function formatDecayAlertsForContext(alerts) {
  if (!alerts.length) return 'No relationship decay alerts.';

  return 'Relationship decay alerts:\n' + alerts.slice(0, 5).map(c =>
    `- ${c.name}: follow-up overdue (was due ${c.next_follow_up_date})`
  ).join('\n');
}

// ─── Morning Briefing ──────────────────────────────────────────────────────

const MORNING_SYSTEM_PROMPT = `You are Mark's Chief of Staff AI. Generate a concise morning briefing for Telegram.

Rules:
- Use Telegram Markdown (bold with *, italic with _, code with \`)
- Keep total output under 3800 characters
- Lead with the date greeting
- Group into clear sections with emoji headers
- Prioritize actionable items
- For "needs attention" items, include a bracketed suggested action like [Draft check-in]
- Be direct and specific — no filler
- End with a coverage indicator line

Format:
Good morning. [Day of week], [Month] [Day].

[Sections as appropriate]`;

export async function generateMorningBriefing(ctx) {
  const data = await gatherMorningData(ctx);

  const contextParts = [
    `Date: ${formatDate()}`,
    '',
    '=== CALENDAR ===',
    formatEventsForContext(data.events),
    '',
    '=== OVERNIGHT EMAIL ===',
    formatEmailsForContext(data.overnightEmails),
    '',
    '=== OVERDUE COMMITMENTS ===',
    formatCommitmentsForContext(data.overdue, 'Overdue'),
    '',
    '=== DUE TODAY ===',
    formatCommitmentsForContext(data.dueToday, 'Due today'),
    '',
    '=== NEEDING FOLLOW-UP ===',
    formatCommitmentsForContext(data.needingFollowup, 'Follow-ups due'),
    '',
    '=== RELATIONSHIP DECAY ===',
    formatDecayAlertsForContext(data.decayAlerts),
    '',
    '=== COMMITMENT STATS ===',
    data.cStats
      ? `Active: ${data.cStats.totalActive} | Overdue: ${data.cStats.overdue} | Fulfilled this week: ${data.cStats.fulfilledThisWeek}`
      : 'No commitment stats available.',
  ];

  const context = contextParts.join('\n');

  const instruction = [
    'Synthesize this data into a morning briefing for Mark.',
    'Use the exact section format from your system prompt.',
    'Highlight the top 3 items that need immediate attention.',
    'For email, summarize categories and call out anything that needs a reply.',
    'Include commitment stats at the end if there are active commitments.',
    `Append this coverage line at the very end:\n${coverageIndicator(data.sources)}`,
  ].join('\n');

  const result = await compile(MORNING_SYSTEM_PROMPT, context, instruction, {
    maxTokens: 2048,
    temperature: 0.3,
  });

  return {
    text: result.text,
    usage: result.usage,
    data: {
      eventsCount: data.events.length,
      emailsCount: data.overnightEmails.length,
      overdueCount: data.overdue.length,
      dueTodayCount: data.dueToday.length,
      followupCount: data.needingFollowup.length,
      decayCount: data.decayAlerts.length,
    },
  };
}

// ─── End of Day Wrap ───────────────────────────────────────────────────────

const EOD_SYSTEM_PROMPT = `You are Mark's Chief of Staff AI. Generate a concise end-of-day wrap-up for Telegram.

Rules:
- Use Telegram Markdown (bold with *, italic with _, code with \`)
- Keep total output under 3800 characters
- Summarize what happened today
- Preview tomorrow
- Be concise — bullet points, not paragraphs

Format:
*End of Day Wrap* — [Day of week], [Month] [Day]

[Sections]`;

export async function generateEndOfDayWrap(ctx) {
  const data = await gatherEodData(ctx);

  const inbound = data.todayEmails.filter(e => e.direction === 'inbound');
  const outbound = data.todayEmails.filter(e => e.direction === 'outbound');

  const contextParts = [
    `Date: ${formatDate()}`,
    '',
    '=== TODAY EMAIL ACTIVITY ===',
    `Received: ${inbound.length} | Sent: ${outbound.length}`,
    formatEmailsForContext(data.todayEmails),
    '',
    '=== COMMITMENTS FULFILLED TODAY ===',
    data.fulfilledToday.length > 0
      ? data.fulfilledToday.map(c => `- ${truncate(c.description, 80)} (${c.customer || c.counterparty})`).join('\n')
      : 'None fulfilled today.',
    '',
    '=== COMMITMENT STATS ===',
    data.cStats
      ? `Active: ${data.cStats.totalActive} | Overdue: ${data.cStats.overdue} | Fulfilled this week: ${data.cStats.fulfilledThisWeek}`
      : 'N/A',
    '',
    '=== TOMORROW CALENDAR ===',
    formatEventsForContext(data.tomorrowEvents),
    '',
    '=== TOMORROW FOLLOW-UPS ===',
    data.tomorrowFollowups.length > 0
      ? data.tomorrowFollowups.map(c => `- ${truncate(c.description, 80)} (${c.customer || c.counterparty})`).join('\n')
      : 'No follow-ups due tomorrow.',
  ];

  const context = contextParts.join('\n');

  const instruction = [
    'Synthesize this into an end-of-day wrap-up for Mark.',
    'Summarize today: emails processed, commitments fulfilled, key actions.',
    'Preview tomorrow: calendar events and follow-ups due.',
    'Keep it brief and actionable.',
    `Append this coverage line at the very end:\n${coverageIndicator(data.sources)}`,
  ].join('\n');

  const result = await compile(EOD_SYSTEM_PROMPT, context, instruction, {
    maxTokens: 2048,
    temperature: 0.3,
  });

  return {
    text: result.text,
    usage: result.usage,
    data: {
      emailsToday: data.todayEmails.length,
      fulfilledToday: data.fulfilledToday.length,
      tomorrowEvents: data.tomorrowEvents.length,
      tomorrowFollowups: data.tomorrowFollowups.length,
    },
  };
}

// ─── Weekly Review ─────────────────────────────────────────────────────────

const WEEKLY_SYSTEM_PROMPT = `You are Mark's Chief of Staff AI. Generate a concise weekly review for Telegram.

Rules:
- Use Telegram Markdown (bold with *, italic with _, code with \`)
- Keep total output under 3800 characters
- Review what happened this week across all domains
- Suggest next week priorities
- Include metrics where available

Format:
*Weekly Review* — Week of [Date]

[Sections with emoji headers]`;

export async function generateWeeklyReview(ctx) {
  const data = await gatherWeeklyData(ctx);

  // Categorize week's emails
  const customerEmails = data.weekEmails.filter(e => e.category === 'customer');
  const inbound = data.weekEmails.filter(e => e.direction === 'inbound');
  const outbound = data.weekEmails.filter(e => e.direction === 'outbound');

  // Unique customers contacted
  const contactedCustomers = new Set();
  for (const e of data.weekEmails) {
    if (e.category === 'customer' && e.counterparty_address) {
      contactedCustomers.add(e.counterparty_address);
    }
  }

  const contextParts = [
    `Week of: ${formatDate()}`,
    '',
    '=== EMAIL SUMMARY ===',
    `Total: ${data.weekEmails.length} (${inbound.length} in, ${outbound.length} out)`,
    `Customer emails: ${customerEmails.length}`,
    `Unique customers contacted: ${contactedCustomers.size}`,
    '',
    '=== COMMITMENTS ===',
    data.cStats
      ? [
          `Active: ${data.cStats.totalActive}`,
          `Overdue: ${data.cStats.overdue}`,
          `Fulfilled this week: ${data.cStats.fulfilledThisWeek}`,
          `By type: ${data.cStats.byType.map(t => `${t.type}: ${t.count}`).join(', ')}`,
        ].join('\n')
      : 'N/A',
    '',
    '=== DUE THIS WEEK ===',
    formatCommitmentsForContext(data.dueThisWeek, 'Due this week'),
    '',
    '=== CUSTOMER OVERVIEW ===',
    `Total customers: ${data.customers.length}`,
    data.customers.filter(c => c.relationship_health).length > 0
      ? 'By health: ' + (() => {
          const byHealth = {};
          for (const c of data.customers) {
            const h = c.relationship_health || 'unknown';
            byHealth[h] = (byHealth[h] || 0) + 1;
          }
          return Object.entries(byHealth).map(([k, v]) => `${k}: ${v}`).join(', ');
        })()
      : '',
    '',
    '=== FACILITY ===',
    data.facilityPage ? truncate(data.facilityPage.snippet || data.facilityPage.title, 200) : 'No facility data in KB.',
    '',
    '=== PIPELINE ===',
    data.pipelinePage ? truncate(data.pipelinePage.snippet || data.pipelinePage.title, 200) : 'No pipeline data in KB.',
  ];

  const context = contextParts.join('\n');

  const instruction = [
    'Synthesize this into a weekly review for Mark.',
    'Cover: email activity, commitment progress, customer engagement, facility, pipeline.',
    'End with 3-5 suggested priorities for next week based on the data.',
    'Be specific — use numbers and names, not generalities.',
    `Append this coverage line at the very end:\n${coverageIndicator(data.sources)}`,
  ].join('\n');

  const result = await compile(WEEKLY_SYSTEM_PROMPT, context, instruction, {
    maxTokens: 2048,
    temperature: 0.3,
  });

  return {
    text: result.text,
    usage: result.usage,
    data: {
      weekEmailsCount: data.weekEmails.length,
      customersContacted: contactedCustomers.size,
      commitmentsFulfilled: data.cStats?.fulfilledThisWeek || 0,
      overdueCount: data.cStats?.overdue || 0,
      activeCommitments: data.cStats?.totalActive || 0,
    },
  };
}
