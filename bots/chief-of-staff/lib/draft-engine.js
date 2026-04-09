/**
 * Email draft generator — context-aware email drafting with tone calibration.
 *
 * Uses Opus for high-quality drafts. Learns from edit feedback to calibrate
 * tone per recipient type over time.
 *
 * Recipient types: customer | employee | ceo | advisor | vendor | government
 */
import crypto from 'node:crypto';
import { getThread, getContactHistory, getCustomer } from './email-intel-db.js';
import { readPage, searchKb } from './kb.js';
import { getByCustomer, getByPerson } from './commitments-db.js';
import { draft } from './claude.js';
import { ensureDb } from './db.js';
import { createDraft } from './gmail-client.js';
import { getProfile } from './person-profiles.js';

// ─── Recipient type detection ──────────────────────────────────────────────

const RECIPIENT_TYPE_HINTS = {
  customer: ['customer', 'client', 'buyer'],
  employee: ['employee', 'team', 'staff', 'internal'],
  ceo: ['ceo', 'founder', 'principal', 'managing director', 'md'],
  advisor: ['advisor', 'board', 'counsel', 'consultant'],
  vendor: ['vendor', 'supplier', 'contractor', 'partner'],
  government: ['government', 'regulatory', 'compliance', 'agency', 'council'],
};

function detectRecipientType(contactHistory, customer, instruction) {
  // Explicit instruction hint takes priority
  if (instruction) {
    const lower = instruction.toLowerCase();
    for (const [type, hints] of Object.entries(RECIPIENT_TYPE_HINTS)) {
      if (hints.some(h => lower.includes(h))) return type;
    }
  }

  // Contact category from email-intel
  if (contactHistory?.contact?.category) {
    const cat = contactHistory.contact.category.toLowerCase();
    if (cat.includes('customer') || cat.includes('client')) return 'customer';
    if (cat.includes('vendor') || cat.includes('supplier')) return 'vendor';
    if (cat.includes('government') || cat.includes('regulatory')) return 'government';
    if (cat.includes('internal') || cat.includes('employee')) return 'employee';
    if (cat.includes('advisor') || cat.includes('board')) return 'advisor';
  }

  // Customer record implies customer type
  if (customer) return 'customer';

  return 'customer'; // safe default
}

// ─── Confidentiality check ─────────────────────────────────────────────────

const CONFIDENTIAL_PATTERNS = [
  { pattern: /\$[\d,.]+[MBK]?\s*(revenue|arr|mrr|margin)/i, label: 'financial_figures' },
  { pattern: /salary|compensation|bonus|equity/i, label: 'compensation' },
  { pattern: /board\s*meeting|board\s*resolution/i, label: 'board_matters' },
  { pattern: /lawsuit|litigation|settlement|subpoena/i, label: 'legal_matters' },
  { pattern: /password|api.?key|secret|token/i, label: 'credentials' },
  { pattern: /ssn|social\s*security|tax\s*id|ein/i, label: 'pii' },
];

const RECIPIENT_RESTRICTIONS = {
  customer: ['compensation', 'board_matters', 'credentials', 'pii'],
  employee: ['financial_figures', 'board_matters', 'credentials'],
  ceo: ['credentials'],
  advisor: ['compensation', 'credentials', 'pii'],
  vendor: ['financial_figures', 'compensation', 'board_matters', 'credentials', 'pii'],
  government: ['compensation', 'credentials'],
};

export function checkConfidentiality(draftText, recipientType) {
  const restrictions = RECIPIENT_RESTRICTIONS[recipientType] || RECIPIENT_RESTRICTIONS.customer;
  const flags = [];

  for (const { pattern, label } of CONFIDENTIAL_PATTERNS) {
    if (pattern.test(draftText) && restrictions.includes(label)) {
      flags.push(label);
    }
  }

  return flags;
}

// ─── Style examples (learning loop) ───────────────────────────────────────

/**
 * Query draft_feedback for recent examples where the user sent the draft mostly as-is.
 * These serve as few-shot examples for tone calibration.
 *
 * @param {object} ctx
 * @param {string} recipientType
 * @param {string} [topic]
 * @param {number} [limit=3]
 * @returns {Array<{ original_draft, final_sent, recipient_type, topic }>}
 */
export function getStyleExamples(ctx, recipientType, topic, limit = 3) {
  const db = ensureDb(ctx.config);

  try {
    if (topic) {
      const rows = db.prepare(`
        SELECT original_draft, final_sent, recipient_type, topic
        FROM draft_feedback
        WHERE recipient_type = ? AND topic = ? AND edit_distance < 0.3
        ORDER BY created_at DESC
        LIMIT ?
      `).all(recipientType, topic, limit);

      if (rows.length > 0) return rows;
    }

    // Fall back to recipient_type only
    return db.prepare(`
      SELECT original_draft, final_sent, recipient_type, topic
      FROM draft_feedback
      WHERE recipient_type = ? AND edit_distance < 0.3
      ORDER BY created_at DESC
      LIMIT ?
    `).all(recipientType, limit);
  } catch (err) {
    console.warn('[draft-engine] getStyleExamples error:', err.message);
    return [];
  }
}

// ─── Draft generation ──────────────────────────────────────────────────────

const DRAFT_SYSTEM_PROMPT = `You are drafting an email on behalf of Mark. Write in Mark's voice: professional, direct, warm but not overly casual. Avoid corporate jargon and filler.

Rules:
- Match the formality level to the recipient type and relationship history
- Reference specific details from the context (dates, deliverables, prior conversations)
- Keep it concise — busy people appreciate brevity
- Include a clear call to action when appropriate
- Do not invent facts not in the context
- Sign off naturally (no "Best regards, Mark" unless the tone calls for it)
- Output ONLY the email body text — no subject line, no metadata`;

/**
 * Generate an email draft with full context.
 *
 * @param {object} ctx - Bot context (has ctx.config)
 * @param {object} opts
 * @param {number}  [opts.emailId]      - Email ID to reply to
 * @param {string}  [opts.threadId]     - Gmail thread ID
 * @param {string}  [opts.contactEmail] - Recipient email address
 * @param {string}  [opts.instruction]  - Natural language instruction ("follow up on...")
 * @returns {{ draftId, draftText, recipientType, topic, confidentialityFlags, usage }}
 */
export async function generateDraft(ctx, { emailId, threadId, contactEmail, instruction }) {
  // 1. Gather context
  const threadMessages = threadId ? getThread(threadId) : [];
  const contactHistory = contactEmail ? getContactHistory(contactEmail) : null;

  // Resolve contact email from thread if not provided
  const resolvedEmail = contactEmail
    || threadMessages.find(m => m.direction === 'received')?.counterparty_address
    || threadMessages[0]?.counterparty_address
    || null;

  const customer = contactHistory?.customer
    || (resolvedEmail ? null : null);

  // Customer data from email-intel
  let customerData = null;
  if (customer?.name) {
    customerData = getCustomer(customer.name);
  } else if (contactHistory?.customer?.name) {
    customerData = getCustomer(contactHistory.customer.name);
  }

  // KB context
  let kbContext = '';
  if (customerData?.name) {
    const kbPage = readPage(`customers/${customerData.name.toLowerCase().replace(/\s+/g, '-')}.md`);
    if (kbPage) {
      kbContext = kbPage.content;
    }
  }
  if (!kbContext && instruction) {
    const kbResults = searchKb(instruction.split(' ').slice(0, 5).join(' '), { limit: 2 });
    if (kbResults.length > 0) {
      kbContext = kbResults.map(r => `[${r.title}]: ${r.snippet}`).join('\n\n');
    }
  }

  // Active commitments
  let commitments = [];
  if (customerData?.name) {
    commitments = getByCustomer(ctx, customerData.name).filter(c => c.status === 'active');
  } else if (resolvedEmail) {
    commitments = getByPerson(ctx, resolvedEmail).filter(c => c.status === 'active');
  }

  // 2. Determine recipient type
  const recipientType = detectRecipientType(contactHistory, customerData, instruction);

  // 3. Get style examples for tone calibration
  const topic = instruction ? instruction.split(' ').slice(0, 3).join(' ') : 'general';
  const styleExamples = getStyleExamples(ctx, recipientType, topic);

  // 4. Build context for Opus
  const contextParts = [];

  if (threadMessages.length > 0) {
    contextParts.push('=== EMAIL THREAD ===');
    for (const msg of threadMessages.slice(-5)) { // last 5 messages
      const dir = msg.direction === 'received' ? 'FROM' : 'SENT';
      const name = msg.from_name || msg.from_address;
      contextParts.push(`[${dir}] ${name} (${msg.date}):`);
      contextParts.push(`Subject: ${msg.subject}`);
      if (msg.body_text) {
        contextParts.push(msg.body_text.slice(0, 1500));
      }
      contextParts.push('');
    }
  }

  if (contactHistory) {
    contextParts.push('=== CONTACT ===');
    const c = contactHistory.contact;
    contextParts.push(`Name: ${c.display_name || c.email_address}`);
    contextParts.push(`Email: ${c.email_address}`);
    contextParts.push(`Category: ${c.category || 'unknown'}`);
    contextParts.push(`Total emails exchanged: ${c.email_count || 0}`);
    if (contactHistory.recentEmails.length > 0) {
      const lastEmail = contactHistory.recentEmails[0];
      contextParts.push(`Last contact: ${lastEmail.date} — "${lastEmail.subject}"`);
    }
    contextParts.push('');
  }

  if (customerData) {
    contextParts.push('=== CUSTOMER ===');
    contextParts.push(`Name: ${customerData.name}`);
    if (customerData.customer_type) contextParts.push(`Type: ${customerData.customer_type}`);
    if (customerData.customer_status) contextParts.push(`Status: ${customerData.customer_status}`);
    if (customerData.primary_technology) contextParts.push(`Technology: ${customerData.primary_technology}`);
    if (customerData.tier != null) contextParts.push(`Tier: ${customerData.tier}`);
    contextParts.push('');
  }

  if (kbContext) {
    contextParts.push('=== KNOWLEDGE BASE ===');
    contextParts.push(kbContext.slice(0, 1000));
    contextParts.push('');
  }

  if (commitments.length > 0) {
    contextParts.push('=== ACTIVE COMMITMENTS ===');
    for (const c of commitments.slice(0, 5)) {
      const due = c.due_date ? ` (due ${c.due_date})` : '';
      contextParts.push(`- [${c.type}] ${c.description}${due}`);
    }
    contextParts.push('');
  }

  if (styleExamples.length > 0) {
    contextParts.push('=== TONE EXAMPLES (emails Mark approved with minimal edits) ===');
    for (const ex of styleExamples) {
      contextParts.push(`[${ex.recipient_type}/${ex.topic}]:`);
      contextParts.push(ex.final_sent || ex.original_draft);
      contextParts.push('---');
    }
    contextParts.push('');
  }

  contextParts.push(`Recipient type: ${recipientType}`);

  const context = contextParts.join('\n');

  const draftInstruction = instruction
    ? `Draft an email: ${instruction}`
    : 'Draft an appropriate reply to the most recent inbound message in this thread.';

  // 5. Call Opus
  const result = await draft(DRAFT_SYSTEM_PROMPT, context, draftInstruction, {
    maxTokens: 2048,
    temperature: 0.7,
  });

  const draftText = result.text.trim();

  // 6. Confidentiality check
  const confidentialityFlags = checkConfidentiality(draftText, recipientType);

  if (confidentialityFlags.length > 0) {
    console.warn(
      `[draft-engine] Confidentiality flags for ${recipientType}: ${confidentialityFlags.join(', ')}`
    );
  }

  // 7. Create Gmail draft
  const subject = threadMessages.length > 0
    ? threadMessages[0].subject
    : (instruction ? instruction.split(' ').slice(0, 8).join(' ') : 'Follow-up');

  let gmailDraft = null;
  try {
    gmailDraft = await createDraft({
      to: resolvedEmail,
      subject,
      body: draftText,
      threadId: threadId || undefined,
      inReplyTo: threadMessages.length > 0
        ? threadMessages[threadMessages.length - 1].message_id
        : undefined,
    });
  } catch (err) {
    console.warn('[draft-engine] Gmail draft creation failed:', err.message);
  }

  return {
    draftId: gmailDraft?.draftId || null,
    draftText,
    recipientType,
    topic,
    confidentialityFlags,
    contactEmail: resolvedEmail,
    customerName: customerData?.name || null,
    subject,
    threadId: threadId || null,
    usage: result.usage,
  };
}

// ─── Telegram formatting ───────────────────────────────────────────────────

/**
 * Format a draft result for Telegram display with inline keyboard data.
 *
 * @param {object} draftInfo - Result from generateDraft()
 * @returns {{ text: string, inlineKeyboard: Array }}
 */
export function formatDraftForTelegram(draftInfo) {
  const {
    draftId,
    draftText,
    recipientType,
    topic,
    confidentialityFlags,
    contactEmail,
    customerName,
    subject,
  } = draftInfo;

  const lines = [];

  // Header
  const recipientLabel = customerName
    ? `${customerName} (${contactEmail})`
    : contactEmail || 'unknown';

  lines.push(`\u{1F4E7} *DRAFT:* ${subject}`);
  lines.push(`To: ${recipientLabel}`);

  if (customerName) {
    lines.push(`Type: ${recipientType} | Topic: ${topic}`);
  }

  lines.push('');

  // Draft preview (truncated for Telegram)
  const preview = draftText.length > 800
    ? draftText.slice(0, 800) + '\u2026'
    : draftText;

  lines.push(`\u201C${preview}\u201D`);

  // Confidentiality warnings
  if (confidentialityFlags.length > 0) {
    lines.push('');
    lines.push(`\u26A0\uFE0F *Confidentiality:* ${confidentialityFlags.join(', ')}`);
  }

  // Inline keyboard data for the Telegram handler to use
  const inlineKeyboard = draftId
    ? [
        [
          { text: '\u2713 Send', callback_data: `da:send:${draftId}` },
          { text: '\u270F\uFE0F Edit', callback_data: `da:edit:${draftId}` },
          { text: '\u23F0 Tomorrow', callback_data: `da:tomorrow:${draftId}` },
          { text: '\u2717 Skip', callback_data: `da:skip:${draftId}` },
        ],
      ]
    : [];

  return {
    text: lines.join('\n'),
    inlineKeyboard,
  };
}

// ─── Draft feedback (learning loop) ───────────────────────────────────────

/**
 * Calculate a simple edit distance ratio.
 * Returns 0.0 (identical) to 1.0 (completely different).
 */
function editDistanceRatio(original, final) {
  if (!original || !final) return 1.0;
  if (original === final) return 0.0;

  // Simple approach: 1 - (common characters / max length)
  const maxLen = Math.max(original.length, final.length);
  if (maxLen === 0) return 0.0;

  // Count common characters (order-aware, using longest common subsequence approximation)
  let common = 0;
  const shorter = original.length <= final.length ? original : final;
  const longer = original.length > final.length ? original : final;
  const used = new Set();

  for (let i = 0; i < shorter.length; i++) {
    for (let j = 0; j < longer.length; j++) {
      if (!used.has(j) && shorter[i] === longer[j]) {
        common++;
        used.add(j);
        break;
      }
    }
  }

  return 1 - (common / maxLen);
}

/**
 * Record feedback on a draft: the original vs what Mark actually sent.
 *
 * @param {object} ctx
 * @param {object} opts
 * @param {string}  opts.draftId       - The Gmail draft ID
 * @param {string}  opts.originalDraft - The AI-generated draft text
 * @param {string}  opts.finalSent     - The text Mark actually sent
 * @param {string}  opts.recipientType - customer, employee, etc.
 * @param {string}  [opts.topic]       - Topic tag
 * @returns {{ id, editDistance }}
 */
export function recordDraftFeedback(ctx, { draftId, originalDraft, finalSent, recipientType, topic }) {
  const db = ensureDb(ctx.config);
  const id = crypto.randomUUID();
  const editDistance = editDistanceRatio(originalDraft, finalSent);

  try {
    db.prepare(`
      INSERT INTO draft_feedback (id, recipient, recipient_type, topic, original_draft, final_sent, edit_distance, sent_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(id, draftId, recipientType, topic || null, originalDraft, finalSent, editDistance);
  } catch (err) {
    console.warn('[draft-engine] recordDraftFeedback error:', err.message);
  }

  return { id, editDistance };
}

// ─── Tiered context assembly ─────────────────────────────────────────────

/**
 * Tiered context assembly for draft generation.
 * Total budget: ~8000 tokens (~32000 chars).
 *
 * Used by draft_pregenerate and the brain for building rich context
 * before calling generateDraft or an LLM directly.
 *
 * @param {object} ctx
 * @param {object} opts
 * @param {string}  opts.threadId
 * @param {string}  opts.contactEmail
 * @param {string}  [opts.instruction]
 * @returns {{ context: string, recipientType: string, subject: string }}
 */
export function buildDraftContext(ctx, { threadId, contactEmail, instruction }) {
  const TIER_BUDGETS = {
    thread: 12000,        // ~3000 tokens
    profile: 2000,        // ~500 tokens
    customer: 2000,       // ~500 tokens
    commitments: 2000,    // ~500 tokens
    construction: 3200,   // ~800 tokens
    kbSearch: 3200,       // ~800 tokens
    styleExamples: 2400,  // ~600 tokens
    extraThread: 5200,    // remaining budget for extra thread messages
  };

  const sections = [];
  let detectedRecipientType = 'customer';
  let detectedSubject = instruction ? instruction.split(' ').slice(0, 8).join(' ') : 'Follow-up';

  // ── Tier 1: Email thread (budget: 12000 chars) ───────────────────────
  let threadMessages = [];
  if (threadId) {
    try {
      threadMessages = getThread(threadId);
    } catch {
      // Thread lookup failed
    }
  }

  if (threadMessages.length > 0) {
    detectedSubject = threadMessages[0].subject || detectedSubject;

    const lastN = threadMessages.slice(-5);
    const threadLines = ['=== EMAIL THREAD ==='];
    let threadChars = 0;

    for (const msg of lastN) {
      if (threadChars >= TIER_BUDGETS.thread) break;
      const dir = msg.direction === 'received' ? 'FROM' : 'SENT';
      const name = msg.from_name || msg.from_address;
      threadLines.push(`[${dir}] ${name} (${msg.date}):`);
      threadLines.push(`Subject: ${msg.subject}`);
      if (msg.body_text) {
        const body = msg.body_text.slice(0, Math.min(1500, TIER_BUDGETS.thread - threadChars));
        threadLines.push(body);
        threadChars += body.length;
      }
      threadLines.push('');
    }

    sections.push(threadLines.join('\n'));
  }

  // Resolve contact email from thread if not provided
  const resolvedEmail = contactEmail
    || threadMessages.find(m => m.direction === 'received')?.counterparty_address
    || threadMessages[0]?.counterparty_address
    || null;

  // ── Tier 2: Person profile (budget: 2000 chars) ──────────────────────
  let profile = null;
  if (resolvedEmail) {
    try {
      profile = getProfile(ctx, resolvedEmail);
    } catch {
      // Profile lookup failed
    }
  }

  if (profile) {
    const profileLines = ['=== PERSON PROFILE ==='];
    profileLines.push(`Name: ${profile.display_name} | Role: ${profile.role || '?'} | Company: ${profile.company || '?'}`);
    if (profile.relationship_to_mark) profileLines.push(`Relationship: ${profile.relationship_to_mark}`);
    if (profile.formality_level) profileLines.push(`Formality: ${profile.formality_level}`);
    if (profile.response_cadence) profileLines.push(`Cadence: ${profile.response_cadence}`);
    if (profile.communication_notes) profileLines.push(`Notes: ${profile.communication_notes}`);

    const topics = profile.topics || [];
    if (topics.length > 0) {
      profileLines.push(`Topics: ${topics.map(t => typeof t === 'string' ? t : t.name).join(', ')}`);
    }

    const openItems = profile.openItems || [];
    if (openItems.length > 0) {
      profileLines.push(`Open items: ${openItems.map(i => typeof i === 'string' ? i : i.description).join('; ')}`);
    }

    sections.push(profileLines.join('\n').slice(0, TIER_BUDGETS.profile));

    // Use profile for recipient type detection
    if (profile.category) {
      const cat = profile.category.toLowerCase();
      if (cat.includes('customer') || cat.includes('client')) detectedRecipientType = 'customer';
      else if (cat.includes('vendor') || cat.includes('supplier')) detectedRecipientType = 'vendor';
      else if (cat.includes('government') || cat.includes('regulatory')) detectedRecipientType = 'government';
      else if (cat.includes('internal') || cat.includes('employee')) detectedRecipientType = 'employee';
      else if (cat.includes('advisor') || cat.includes('board')) detectedRecipientType = 'advisor';
      else if (cat.includes('construction')) detectedRecipientType = 'vendor';
    }
  }

  // Detect recipient type from instruction override
  if (instruction) {
    const lower = instruction.toLowerCase();
    for (const [type, hints] of Object.entries(RECIPIENT_TYPE_HINTS)) {
      if (hints.some(h => lower.includes(h))) {
        detectedRecipientType = type;
        break;
      }
    }
  }

  // ── Tier 3: Customer data (budget: 2000 chars) ────────────────────────
  let contactHistory = null;
  if (resolvedEmail) {
    try {
      contactHistory = getContactHistory(resolvedEmail);
    } catch {
      // Contact history lookup failed
    }
  }

  let customerData = null;
  if (contactHistory?.customer?.name) {
    try {
      customerData = getCustomer(contactHistory.customer.name);
    } catch {
      // Customer lookup failed
    }
  }

  if (customerData) {
    const custLines = ['=== CUSTOMER ==='];
    custLines.push(`Name: ${customerData.name}`);
    if (customerData.customer_type) custLines.push(`Type: ${customerData.customer_type}`);
    if (customerData.customer_status) custLines.push(`Status: ${customerData.customer_status}`);
    if (customerData.primary_technology) custLines.push(`Technology: ${customerData.primary_technology}`);
    if (customerData.tier != null) custLines.push(`Tier: ${customerData.tier}`);
    if (customerData.relationship_health) custLines.push(`Health: ${customerData.relationship_health}`);

    sections.push(custLines.join('\n').slice(0, TIER_BUDGETS.customer));
    detectedRecipientType = 'customer';
  }

  // ── Tier 4: Commitments (budget: 2000 chars) ─────────────────────────
  let commitments = [];
  if (customerData?.name) {
    try {
      commitments = getByCustomer(ctx, customerData.name).filter(c => c.status === 'active');
    } catch { /* ignore */ }
  } else if (resolvedEmail) {
    try {
      commitments = getByPerson(ctx, resolvedEmail).filter(c => c.status === 'active');
    } catch { /* ignore */ }
  }

  if (commitments.length > 0) {
    const commitLines = ['=== ACTIVE COMMITMENTS ==='];
    for (const c of commitments.slice(0, 5)) {
      const due = c.due_date ? ` (due ${c.due_date})` : '';
      commitLines.push(`- [${c.type}] ${c.description}${due}`);
    }
    sections.push(commitLines.join('\n').slice(0, TIER_BUDGETS.commitments));
  }

  // ── Tier 5: Construction state (budget: 3200 chars) ───────────────────
  const isConstruction = profile?.category === 'construction'
    || contactHistory?.contact?.category === 'construction';

  if (isConstruction) {
    try {
      const constructionPage = readPage('facility/construction-status.md');
      if (constructionPage?.content) {
        const constLines = ['=== CONSTRUCTION STATUS ==='];
        constLines.push(constructionPage.content.slice(0, TIER_BUDGETS.construction - 40));
        sections.push(constLines.join('\n'));
      }
    } catch {
      // KB page not found
    }
  }

  // ── Tier 6: KB search (budget: 3200 chars) ───────────────────────────
  let kbContext = '';
  if (customerData?.name) {
    try {
      const kbPage = readPage(`customers/${customerData.name.toLowerCase().replace(/\s+/g, '-')}.md`);
      if (kbPage) {
        kbContext = kbPage.content;
      }
    } catch { /* ignore */ }
  }

  if (!kbContext && instruction) {
    try {
      const kbResults = searchKb(instruction.split(' ').slice(0, 5).join(' '), { limit: 2 });
      if (kbResults.length > 0) {
        kbContext = kbResults.map(r => `[${r.title}]: ${r.snippet}`).join('\n\n');
      }
    } catch { /* ignore */ }
  }

  if (kbContext) {
    const kbLines = ['=== KNOWLEDGE BASE ==='];
    kbLines.push(kbContext.slice(0, TIER_BUDGETS.kbSearch - 30));
    sections.push(kbLines.join('\n'));
  }

  // ── Tier 7: Style examples (budget: 2400 chars) ──────────────────────
  const topic = instruction ? instruction.split(' ').slice(0, 3).join(' ') : 'general';
  const styleExamples = getStyleExamples(ctx, detectedRecipientType, topic);

  if (styleExamples.length > 0) {
    const styleLines = ['=== TONE EXAMPLES (emails Mark approved with minimal edits) ==='];
    let styleChars = 0;

    for (const ex of styleExamples) {
      const exText = `[${ex.recipient_type}/${ex.topic}]:\n${ex.final_sent || ex.original_draft}\n---`;
      if (styleChars + exText.length > TIER_BUDGETS.styleExamples) break;
      styleLines.push(exText);
      styleChars += exText.length;
    }

    sections.push(styleLines.join('\n'));
  }

  // ── Tier 8: Additional thread messages (remaining budget) ─────────────
  const currentLength = sections.join('\n').length;
  const remaining = 32000 - currentLength;

  if (remaining > 500 && threadMessages.length > 5) {
    const extraMsgs = threadMessages.slice(0, -5); // messages not already included
    const extraLines = ['=== EARLIER THREAD MESSAGES ==='];
    let extraChars = 0;

    for (const msg of extraMsgs.slice(-3)) {
      if (extraChars >= remaining - 100) break;
      const dir = msg.direction === 'received' ? 'FROM' : 'SENT';
      const name = msg.from_name || msg.from_address;
      extraLines.push(`[${dir}] ${name} (${msg.date}):`);
      if (msg.body_text) {
        const body = msg.body_text.slice(0, Math.min(800, remaining - extraChars - 100));
        extraLines.push(body);
        extraChars += body.length;
      }
      extraLines.push('');
    }

    if (extraLines.length > 1) {
      sections.push(extraLines.join('\n'));
    }
  }

  // ── Final: add recipient type label ────────────────────────────────────
  sections.push(`Recipient type: ${detectedRecipientType}`);

  return {
    context: sections.join('\n\n'),
    recipientType: detectedRecipientType,
    subject: detectedSubject,
  };
}
