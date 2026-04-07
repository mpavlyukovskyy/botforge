import { z } from 'zod';
import { getByPosition, updateStatus } from '../lib/priority-queue.js';
import { getThread, getEmailByMessageId, getThreadBySubject } from '../lib/email-intel-db.js';
import { getProfile } from '../lib/person-profiles.js';
import { getCustomer } from '../lib/email-intel-db.js';
import { getByPerson } from '../lib/commitments-db.js';
import { ensureDb } from '../lib/db.js';
import { readPage } from '../lib/kb.js';

const getQueueItemTool = {
  name: 'get_queue_item',
  description:
    'Get full context for a queue item by position (1-indexed). Returns the email thread, ' +
    'person profile, customer data, active commitments, pre-generated draft, and construction ' +
    'status if relevant. Marks the item as presented.',
  schema: {
    position: z.number().describe('1-indexed position in the priority queue'),
  },
  permissions: { db: 'read' },
  execute: async (args, ctx) => {
    const { position } = args;

    // 1. Get queue entry by position
    const entry = getByPosition(ctx, position);
    if (!entry) {
      return `No item at position ${position} in the priority queue.`;
    }

    // 2. Mark as presented
    updateStatus(ctx, entry.id, 'presented');

    // 3. Gather all context
    const sections = [];

    // === QUEUE ITEM HEADER ===
    const score = (entry.priority_score * 100).toFixed(0);
    const factors = entry.priority_factors ? JSON.parse(entry.priority_factors) : {};
    const factorList = Object.entries(factors)
      .map(([k, v]) => `${k}: +${(v * 100).toFixed(0)}%`)
      .join(', ');

    sections.push(
      `=== QUEUE ITEM #${position} (score: ${score}%) ===`,
      `Subject: ${entry.subject || '(no subject)'}`,
      `From: ${entry.from_name || ''} <${entry.from_address}> | Category: ${entry.contact_category || 'unknown'} | Customer: ${entry.customer_name || 'none'}`,
      `Status: ${entry.status} | Draft: ${entry.draft_status || 'none'}`,
      `Factors: ${factorList || 'base'}`,
    );

    // === EMAIL THREAD ===
    let threadMessages = [];
    let threadSource = null;

    // Fallback chain: thread_id → message_id → subject match
    if (entry.thread_id) {
      try {
        threadMessages = getThread(entry.thread_id);
        if (threadMessages.length > 0) threadSource = 'thread_id';
      } catch (err) {
        sections.push(`\n(Thread lookup failed: ${err.message})`);
      }
    }

    if (threadMessages.length === 0 && entry.message_id) {
      try {
        const single = getEmailByMessageId(entry.message_id);
        if (single) {
          // Follow gmail_thread_id to get the full thread
          if (single.gmail_thread_id) {
            const fullThread = getThread(single.gmail_thread_id);
            if (fullThread.length > 0) {
              threadMessages = fullThread;
              threadSource = 'message_id→thread_id';
            }
          }
          // Fall back to single message if thread lookup failed
          if (threadMessages.length === 0) {
            threadMessages = [single];
            threadSource = 'message_id_fallback';
          }
        }
      } catch { /* fall through */ }
    }

    if (threadMessages.length === 0 && entry.subject) {
      try {
        threadMessages = getThreadBySubject(entry.subject, entry.from_address, 14);
        if (threadMessages.length > 0) threadSource = 'subject_fallback';
      } catch { /* fall through */ }
    }

    if (threadMessages.length > 0) {
      const lastN = threadMessages.slice(-5);
      const truncNote = threadMessages.length > 5
        ? ` [TRUNCATED: showing last ${lastN.length} of ${threadMessages.length}]`
        : '';
      sections.push('');
      sections.push(`=== EMAIL THREAD (${lastN.length} messages, source: ${threadSource})${truncNote} ===`);

      for (const msg of lastN) {
        const dir = msg.direction === 'received' ? 'FROM' : 'SENT';
        const name = msg.from_name || msg.from_address || '?';
        const date = msg.date ? msg.date.slice(0, 16) : 'unknown';
        sections.push(`[${dir}] ${name} (${date}):`);
        sections.push(`Subject: ${msg.subject || '(no subject)'}`);
        if (msg.body_text) {
          const MAX_BODY = 3000;
          if (msg.body_text.length > MAX_BODY) {
            sections.push(msg.body_text.slice(0, MAX_BODY) + `\n[...truncated, ${msg.body_text.length} chars total]`);
          } else {
            sections.push(msg.body_text);
          }
        } else {
          sections.push('[NO BODY TEXT AVAILABLE]');
        }
        sections.push('');
      }
    } else {
      sections.push('');
      sections.push('=== EMAIL THREAD ===');
      sections.push('[EMAIL BODY NOT AVAILABLE — all lookup methods failed]');
      sections.push('WARNING: Do NOT describe, paraphrase, or guess email content. Tell Mark you cannot retrieve this email.');
      sections.push('');
    }

    // === PERSON PROFILE ===
    let profile = null;
    try {
      profile = getProfile(ctx, entry.from_address);
      if (profile) {
        sections.push('=== PERSON PROFILE ===');
        sections.push(`Name: ${profile.display_name} | Role: ${profile.role || 'unknown'} | Company: ${profile.company || 'unknown'}`);
        if (profile.relationship_to_mark) sections.push(`Relationship: ${profile.relationship_to_mark}`);
        if (profile.formality_level || profile.response_cadence) {
          sections.push(`Communication: formality=${profile.formality_level || '?'}, cadence=${profile.response_cadence || '?'}`);
        }
        if (profile.communication_notes) sections.push(`Notes: ${profile.communication_notes}`);

        const topics = profile.topics || [];
        if (topics.length > 0) {
          sections.push(`Topics: ${topics.map(t => typeof t === 'string' ? t : t.name || JSON.stringify(t)).join(', ')}`);
        }

        const openItems = profile.openItems || [];
        if (openItems.length > 0) {
          sections.push(`Open items: ${openItems.map(i => typeof i === 'string' ? i : i.description || JSON.stringify(i)).join('; ')}`);
        }

        if (profile.last_interaction_summary) {
          sections.push(`Last interaction: ${profile.last_interaction_date || '?'} — ${profile.last_interaction_summary}`);
        }
        sections.push('');
      }
    } catch {
      sections.push('[PERSON PROFILE: lookup failed]');
    }

    if (!profile) {
      sections.push('=== PERSON PROFILE ===');
      sections.push('[No profile on file for this contact]');
      sections.push('');
    }

    // === CUSTOMER ===
    const shouldLookupCustomer =
      entry.customer_name ||
      entry.contact_category === 'customer';

    if (shouldLookupCustomer) {
      try {
        const customerName = entry.customer_name || entry.from_address.split('@')[1]?.split('.')[0];
        if (customerName) {
          const customer = getCustomer(customerName);
          if (customer) {
            sections.push('=== CUSTOMER ===');
            sections.push(`Name: ${customer.name} | Tier: ${customer.tier ?? 'untiered'} | Status: ${customer.customer_status || 'unknown'}`);
            if (customer.primary_technology) sections.push(`Technology: ${customer.primary_technology}`);
            if (customer.annual_revenue_current) sections.push(`Revenue: $${customer.annual_revenue_current.toLocaleString()}`);
            if (customer.relationship_health) sections.push(`Health: ${customer.relationship_health}`);
            if (customer.what_they_want) sections.push(`Wants: ${customer.what_they_want}`);
            sections.push('');
          }
        }
      } catch {
        sections.push('[CUSTOMER DATA: lookup failed]');
      }
    }

    // === ACTIVE COMMITMENTS ===
    try {
      const commitments = getByPerson(ctx, entry.from_address).filter(c => c.status === 'active');
      if (commitments.length > 0) {
        sections.push('=== ACTIVE COMMITMENTS ===');
        for (const c of commitments.slice(0, 8)) {
          const due = c.due_date ? ` (due ${c.due_date})` : '';
          const priority = c.priority !== 'normal' ? ` [${c.priority}]` : '';
          sections.push(`- [${c.type}] ${c.description}${due}${priority}`);
        }
        if (commitments.length > 8) {
          sections.push(`  ... and ${commitments.length - 8} more`);
        }
        sections.push('');
      }
    } catch {
      sections.push('[COMMITMENTS: lookup failed]');
    }

    // === PRE-GENERATED DRAFT ===
    if (entry.draft_status === 'ready' && entry.draft_id) {
      try {
        const db = ensureDb(ctx.config);
        const draft = db.prepare(
          'SELECT * FROM gmail_drafts WHERE draft_id = ?'
        ).get(entry.draft_id);

        if (draft) {
          sections.push('=== PRE-GENERATED DRAFT ===');
          sections.push(`Draft ID: ${draft.draft_id} (use send_draft to send)`);
          sections.push('---');
          sections.push(draft.body_text || draft.body_preview || '(draft body not stored locally)');
          sections.push('---');
          sections.push('');
        }
      } catch {
        sections.push('[DRAFT: lookup failed]');
      }
    }

    // === CONSTRUCTION STATUS ===
    if (entry.contact_category === 'construction') {
      try {
        const page = readPage('facility/construction-status.md');
        if (page && page.content) {
          sections.push('=== CONSTRUCTION STATUS (excerpt) ===');
          sections.push(page.content.slice(0, 800));
          if (page.content.length > 800) sections.push('...');
          sections.push('');
        }
      } catch {
        // KB page not found — not critical
      }
    }

    return sections.join('\n');
  },
};

export default getQueueItemTool;
