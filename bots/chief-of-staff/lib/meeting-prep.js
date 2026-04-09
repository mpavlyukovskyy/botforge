/**
 * Meeting Prep — pre-meeting intelligence compiler.
 *
 * Generates a briefing 30 minutes before each calendar event by pulling data
 * from email-intel, KB, and commitments, then synthesizing via Claude.
 *
 * Usage:
 *   import { generateMeetingPrep, formatBriefingForTelegram } from './meeting-prep.js';
 *   const briefing = await generateMeetingPrep(event);
 *   const text = await formatBriefingForTelegram(briefing);
 */
import { getRecentEmails, getContactHistory, getCustomer, getThread } from './email-intel-db.js';
import { readPage, searchKb } from './kb.js';
import { getByCustomer, getByPerson } from './commitments-db.js';
import { compile } from './claude.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const INTERNAL_DOMAIN = '@science.xyz';
const EMAIL_LOOKBACK_DAYS = 90;
const MAX_THREADS_PER_ATTENDEE = 5;
const COVERAGE_NOTE = 'Based on: email (last 90d), KB, commitments. No visibility into: calls, in-person.';

const SYSTEM_PROMPT = [
  'You are a chief-of-staff briefing compiler for a CEO named Mark.',
  'Given structured intelligence about upcoming meeting attendees, generate a concise pre-meeting briefing.',
  '',
  'Format the briefing with these sections (omit any section if no relevant data):',
  '',
  'RELATIONSHIP: who they are, customer tier, revenue, how long the relationship has been active',
  'LAST MEETING: when, what was discussed (if known from email context)',
  'KEY CONTEXT: recent email threads, deal stage, open issues',
  'YOUR COMMITMENTS: what Mark owes them, what is overdue',
  'SUGGESTED TALKING POINTS: 3-5 items based on the gathered context',
  '',
  'Rules:',
  '- Be concise — each section should be 1-3 lines max',
  '- Flag anything overdue or urgent',
  '- Use bullet points (plain dash -) for lists within sections',
  '- Do not invent information — only use what is provided in the context',
  '- If attendees are unknown (no email history), note it plainly',
  '- For internal meetings, focus on agenda items and open commitments between attendees',
].join('\n');

// ─── Helpers ───────────────────────────────────────────────────────────────

function isInternal(email) {
  return email && email.endsWith(INTERNAL_DOMAIN);
}

function isInternalMeeting(attendees) {
  if (!attendees || attendees.length === 0) return false;
  return attendees.every(a => isInternal(a.email));
}

function extractDomain(email) {
  if (!email) return null;
  const parts = email.split('@');
  return parts.length === 2 ? parts[1] : null;
}

function dedup(arr) {
  return [...new Set(arr)].filter(Boolean);
}

function formatDate(iso) {
  if (!iso) return 'unknown';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text || '';
  return text.slice(0, maxLen - 3) + '...';
}

// ─── Per-attendee intelligence ─────────────────────────────────────────────

function gatherAttendeeIntel(ctx, attendee) {
  const { email, name } = attendee;
  const intel = { email, name, threads: [], kbPage: null, customer: null, commitments: [] };

  // Contact history (includes recent emails + customer association)
  const history = getContactHistory(email);
  if (history) {
    // Extract unique thread IDs from recent emails, limited to MAX_THREADS_PER_ATTENDEE
    const threadIds = dedup(
      (history.recentEmails || []).map(e => e.gmail_thread_id).filter(Boolean)
    ).slice(0, MAX_THREADS_PER_ATTENDEE);

    for (const tid of threadIds) {
      const msgs = getThread(tid);
      if (msgs.length > 0) {
        intel.threads.push({
          threadId: tid,
          subject: msgs[0].subject,
          lastDate: msgs[msgs.length - 1].date,
          messageCount: msgs.length,
          lastDirection: msgs[msgs.length - 1].direction,
        });
      }
    }

    intel.customer = history.customer || null;
  } else {
    // Fallback: try getRecentEmails directly
    const recent = getRecentEmails(email, EMAIL_LOOKBACK_DAYS);
    if (recent.length > 0) {
      const threadIds = dedup(recent.map(e => e.gmail_thread_id).filter(Boolean))
        .slice(0, MAX_THREADS_PER_ATTENDEE);
      for (const tid of threadIds) {
        const msgs = getThread(tid);
        if (msgs.length > 0) {
          intel.threads.push({
            threadId: tid,
            subject: msgs[0].subject,
            lastDate: msgs[msgs.length - 1].date,
            messageCount: msgs.length,
            lastDirection: msgs[msgs.length - 1].direction,
          });
        }
      }
    }
  }

  // KB page — search by name or email
  const searchTerm = name || email;
  if (searchTerm) {
    const kbResults = searchKb(searchTerm, { limit: 1 });
    if (kbResults.length > 0) {
      intel.kbPage = readPage(kbResults[0].path);
    }
  }

  // Customer lookup via MEMS (if not already found via contact history)
  if (!intel.customer) {
    const domain = extractDomain(email);
    if (domain && !isInternal(email)) {
      const cust = getCustomer(domain);
      if (cust) intel.customer = cust;
    }
  }

  // Commitments involving this person
  const personCommitments = getByPerson(ctx, email);
  if (personCommitments && personCommitments.length > 0) {
    intel.commitments = personCommitments;
  }

  return intel;
}

// ─── Context serializer ────────────────────────────────────────────────────

function serializeContext(event, attendeeIntel, customerIntel) {
  const sections = [];

  // Event info
  const startTime = event.start
    ? new Date(event.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : 'unknown time';

  sections.push([
    `<event>`,
    `Title: ${event.summary || '(No title)'}`,
    `Time: ${startTime}`,
    event.location ? `Location: ${event.location}` : null,
    event.description ? `Description: ${truncate(event.description, 500)}` : null,
    `</event>`,
  ].filter(Boolean).join('\n'));

  // Per-attendee context
  for (const intel of attendeeIntel) {
    const lines = [`<attendee email="${intel.email}" name="${intel.name || 'unknown'}">`];

    if (intel.threads.length === 0) {
      lines.push('No prior email history found.');
    } else {
      lines.push('Recent email threads:');
      for (const t of intel.threads) {
        lines.push(`- "${t.subject}" (${formatDate(t.lastDate)}, ${t.messageCount} msgs, last: ${t.lastDirection})`);
      }
    }

    if (intel.customer) {
      const c = intel.customer;
      const tier = c.tier != null ? `Tier ${c.tier}` : 'untiered';
      const rev = c.annual_revenue_current ? `$${Number(c.annual_revenue_current).toLocaleString()}/yr` : 'revenue unknown';
      const health = c.relationship_health || 'unknown';
      lines.push(`Customer: ${c.name} (${tier}, ${rev}, health: ${health})`);
      if (c.primary_technology) lines.push(`Technology: ${c.primary_technology}`);
      if (c.customer_status) lines.push(`Status: ${c.customer_status}`);
    }

    if (intel.kbPage) {
      lines.push(`KB context: ${truncate(intel.kbPage.content, 800)}`);
    }

    if (intel.commitments.length > 0) {
      lines.push('Active commitments:');
      for (const cm of intel.commitments) {
        const overdue = cm.due_date && new Date(cm.due_date) < new Date() && cm.status === 'active';
        const dueStr = cm.due_date ? ` (due ${formatDate(cm.due_date)}${overdue ? ' — OVERDUE' : ''})` : '';
        lines.push(`- [${cm.bearer}→${cm.counterparty}] ${cm.description}${dueStr}`);
      }
    }

    lines.push('</attendee>');
    sections.push(lines.join('\n'));
  }

  // Customer-level context (if we found a customer)
  if (customerIntel) {
    const lines = [`<customer_context>`];

    if (customerIntel.kbPage) {
      lines.push(`KB: ${truncate(customerIntel.kbPage.content, 600)}`);
    }

    if (customerIntel.commitments && customerIntel.commitments.length > 0) {
      lines.push('Customer-level commitments:');
      for (const cm of customerIntel.commitments) {
        const overdue = cm.due_date && new Date(cm.due_date) < new Date() && cm.status === 'active';
        const dueStr = cm.due_date ? ` (due ${formatDate(cm.due_date)}${overdue ? ' — OVERDUE' : ''})` : '';
        lines.push(`- [${cm.bearer}→${cm.counterparty}] ${cm.description}${dueStr}`);
      }
    }

    lines.push('</customer_context>');
    if (lines.length > 2) {
      sections.push(lines.join('\n'));
    }
  }

  return sections.join('\n\n');
}

// ─── Main export ───────────────────────────────────────────────────────────

/**
 * Generate a pre-meeting briefing for a calendar event.
 *
 * @param {{ id, summary, start, end, attendees: Array<{email, name}>, description, location }} event
 * @returns {Promise<{ briefingText: string, attendeeSummaries: object[], coverageNote: string }>}
 */
export async function generateMeetingPrep(ctx, event) {
  const attendees = event.attendees || [];
  const internal = isInternalMeeting(attendees);

  // Gather per-attendee intel
  const attendeeIntel = attendees.map(a => gatherAttendeeIntel(ctx, a));

  // Gather customer-level context from the first customer we find
  let customerIntel = null;
  const firstCustomer = attendeeIntel.find(a => a.customer)?.customer;
  if (firstCustomer) {
    const customerName = firstCustomer.name;

    // KB page for the customer
    let kbPage = null;
    const kbResults = searchKb(customerName, { category: 'customers', limit: 1 });
    if (kbResults.length > 0) {
      kbPage = readPage(kbResults[0].path);
    }

    // Customer-level commitments
    const commitments = getByCustomer(ctx, customerName);

    customerIntel = { kbPage, commitments };
  }

  // No attendees: just show event info + any KB matches from event summary
  if (attendees.length === 0) {
    let eventKb = null;
    if (event.summary) {
      const kbResults = searchKb(event.summary, { limit: 1 });
      if (kbResults.length > 0) {
        eventKb = readPage(kbResults[0].path);
      }
    }

    if (eventKb) {
      customerIntel = { kbPage: eventKb, commitments: [] };
    }
  }

  // Build the context string
  const context = serializeContext(event, attendeeIntel, customerIntel);

  // Build the instruction
  let instruction;
  if (attendees.length === 0) {
    instruction = 'Generate a brief meeting note. There are no attendees listed — focus on the event description and any KB context.';
  } else if (internal) {
    instruction = 'This is an internal meeting (all attendees are within the organization). Focus the briefing on agenda items, open commitments between attendees, and action items rather than relationship/revenue context.';
  } else {
    instruction = 'Generate a pre-meeting briefing covering relationship, recent context, commitments, and suggested talking points.';
  }

  // Single LLM call
  const result = await compile(SYSTEM_PROMPT, context, instruction, {
    maxTokens: 2048,
    temperature: 0.3,
  });

  // Build attendee summaries for structured return
  const attendeeSummaries = attendeeIntel.map(a => ({
    email: a.email,
    name: a.name,
    hasEmailHistory: a.threads.length > 0,
    customer: a.customer?.name || null,
    commitmentCount: a.commitments.length,
    overdueCount: a.commitments.filter(
      c => c.due_date && new Date(c.due_date) < new Date() && c.status === 'active'
    ).length,
  }));

  return {
    briefingText: result.text,
    attendeeSummaries,
    coverageNote: COVERAGE_NOTE,
  };
}

// ─── Telegram formatter ────────────────────────────────────────────────────

const TELEGRAM_MAX_CHARS = 4000;

/**
 * Format a meeting briefing for Telegram (MarkdownV2-safe bold sections, under 4000 chars).
 *
 * @param {{ briefingText: string, attendeeSummaries: object[], coverageNote: string }} briefing
 * @param {{ summary: string, start: string }} [event] - Optional event metadata for the header
 * @returns {string}
 */
export function formatBriefingForTelegram(briefing, event) {
  const { briefingText, coverageNote } = briefing;

  const startTime = event?.start
    ? new Date(event.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : '';

  const title = event?.summary || 'Meeting';
  const header = startTime
    ? `*BRIEFING: ${title} (${startTime})*`
    : `*BRIEFING: ${title}*`;

  const footer = `\n_${coverageNote}_`;
  const overhead = header.length + footer.length + 4; // newlines

  // Trim briefing text to fit within budget
  let body = briefingText;
  if (body.length + overhead > TELEGRAM_MAX_CHARS) {
    const budget = TELEGRAM_MAX_CHARS - overhead - 20;
    body = body.slice(0, budget) + '\n...(truncated)';
  }

  return [header, '', body, footer].join('\n');
}
