/**
 * Cron handler: customer_sync
 *
 * Daily customer state page compilation for tier-1 and tier-2 customers.
 * Each customer gets a KB page with recent activity, commitments, and action items.
 * Runs 9:05am ET weekdays.
 */
import { listCustomers, getCustomer, searchEmails, getNotes } from '../lib/email-intel-db.js';
import { compile } from '../lib/claude.js';
import { getByCustomer } from '../lib/commitments-db.js';
import { writePage, readPage } from '../lib/kb.js';

export default {
  name: 'customer_sync',
  async execute(ctx) {
    // 1. Get all tier-1 and tier-2 customers
    const tier1 = listCustomers({ tier: 1 });
    const tier2 = listCustomers({ tier: 2 });
    const customers = [...tier1, ...tier2];

    if (customers.length === 0) {
      ctx.log.info('customer_sync: no tier-1/2 customers found');
      return;
    }

    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let compiled = 0;

    for (const customer of customers) {
      try {
        // 2a. Get full customer data
        const full = getCustomer(customer.name);
        if (!full) continue;

        // 2b. Get recent emails from primary contacts
        const contactEmails = (full.contacts || []).map(c => c.email).filter(Boolean);
        const recentEmails = [];
        for (const email of contactEmails) {
          const emails = searchEmails(email, { limit: 10, since: since30d });
          recentEmails.push(...emails);
        }
        // Deduplicate and sort by date descending
        const seenIds = new Set();
        const uniqueEmails = recentEmails
          .filter(e => {
            if (seenIds.has(e.id || e.message_id)) return false;
            seenIds.add(e.id || e.message_id);
            return true;
          })
          .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
          .slice(0, 20);

        // 2c. Get commitments
        const commitments = getByCustomer(ctx, customer.name);

        // 2d. Get notes linked to customer contacts
        const notes = [];
        for (const email of contactEmails) {
          const contactNotes = getNotes({ contactEmail: email });
          notes.push(...contactNotes);
        }

        // 2e. Get existing KB page
        const slug = customer.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const existingPage = readPage(`customers/${slug}.md`);

        // 2f. Build context
        const contextParts = [];

        contextParts.push(`=== CUSTOMER: ${customer.name} ===`);
        if (full.tier) contextParts.push(`Tier: ${full.tier}`);
        if (full.status) contextParts.push(`Status: ${full.status}`);
        if (full.revenue) contextParts.push(`Revenue: ${full.revenue}`);

        if (full.contacts && full.contacts.length > 0) {
          contextParts.push('\n=== KEY CONTACTS ===');
          for (const c of full.contacts) {
            const role = c.role ? ` (${c.role})` : '';
            contextParts.push(`- ${c.name || c.email}${role}: ${c.email}`);
          }
        }

        if (uniqueEmails.length > 0) {
          contextParts.push('\n=== RECENT EMAILS (last 30d) ===');
          for (const e of uniqueEmails) {
            const dir = e.direction === 'received' ? '\u2190' : '\u2192';
            contextParts.push(`[${e.date?.slice(0, 10)}] ${dir} ${e.from_name || e.from_address}: ${e.subject}`);
            if (e.body_text) contextParts.push(`  ${e.body_text.slice(0, 200)}`);
          }
        }

        if (commitments.length > 0) {
          contextParts.push('\n=== ACTIVE COMMITMENTS ===');
          for (const c of commitments) {
            const due = c.due_date ? ` (due ${c.due_date})` : '';
            const status = c.status ? ` [${c.status}]` : '';
            contextParts.push(`- [${c.type}] ${c.description}${due}${status} \u2014 ${c.bearer} \u2192 ${c.counterparty}`);
          }
        }

        if (notes.length > 0) {
          contextParts.push('\n=== NOTES ===');
          for (const n of notes.slice(0, 10)) {
            contextParts.push(`[${n.date}] ${n.content?.slice(0, 300)}`);
          }
        }

        if (existingPage) {
          contextParts.push('\n=== PREVIOUS STATE PAGE ===');
          contextParts.push(existingPage.content.slice(0, 2000));
        }

        const context = contextParts.join('\n');

        // 2g. Compile via Sonnet
        const systemPrompt = `You are a customer relationship manager compiling a state page for a Science Corp customer.
Compile a concise customer state page in markdown. Include sections for:
- Relationship Summary (one paragraph: who they are, what they buy, current health)
- Key Contacts (table: name | role | email | last interaction)
- Recent Activity (last 30d summary of emails, meetings, events)
- Active Commitments (what's owed by whom, with due dates)
- Mark's Action Items (specific things Mark needs to do or follow up on)

Be factual, concise, reference specific dates and people. Today is ${new Date().toISOString().slice(0, 10)}.`;

        const result = await compile(systemPrompt, context, `Compile the customer state page for ${customer.name}.`);

        if (result.is_error) {
          ctx.log.error(`customer_sync failed for ${customer.name}: ${result.text}`);
          continue;
        }

        // 2h. Write KB page
        writePage(`customers/${slug}.md`, {
          title: customer.name,
          content: result.text,
          category: 'customers',
          entityType: 'customer',
          entityName: customer.name,
        });

        compiled++;
      } catch (err) {
        ctx.log.error(`customer_sync error for ${customer.name}: ${err.message}`);
      }
    }

    ctx.log.info(`customer_sync: compiled ${compiled} customer page${compiled !== 1 ? 's' : ''} (${customers.length} total)`);
  },
};
