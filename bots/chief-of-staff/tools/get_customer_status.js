import { z } from 'zod';
import { readPage } from '../lib/kb.js';
import { getCustomer } from '../lib/email-intel-db.js';

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[(),.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const getCustomerStatusTool = {
  name: 'get_customer_status',
  description:
    'Get the full status page for a customer by name. Checks the knowledge base first, ' +
    'then falls back to raw email-intel data if no KB page exists.',
  schema: {
    name: z.string().describe('Customer name (e.g. "BMC", "IMEC", "Advion")'),
  },
  permissions: { db: 'read' },
  execute: async (args, _ctx) => {
    const { name } = args;
    const slug = slugify(name);

    // 1. Try KB page first
    const page = readPage(`customers/${slug}.md`);
    if (page) {
      const lines = [];
      lines.push(`=== CUSTOMER: ${page.title || name} ===`);
      lines.push(`Source: KB page (customers/${slug}.md)`);
      lines.push(`Last updated: ${page.lastUpdated || 'unknown'}`);
      lines.push('');
      lines.push(page.content);
      return lines.join('\n');
    }

    // 2. Fall back to email-intel raw data
    const customer = getCustomer(name);
    if (!customer) {
      return `Customer not found: "${name}". No KB page at customers/${slug}.md and no match in the email-intel database. Check the spelling or try search_kb with a partial name.`;
    }

    const lines = [];
    lines.push(`=== CUSTOMER: ${customer.name} ===`);
    lines.push(`Source: email-intel database (no KB page compiled yet)`);
    lines.push('');
    if (customer.domain) lines.push(`Domain: ${customer.domain}`);
    if (customer.tier != null) lines.push(`Tier: ${customer.tier}`);
    if (customer.customer_status) lines.push(`Status: ${customer.customer_status}`);
    if (customer.customer_type) lines.push(`Type: ${customer.customer_type}`);
    if (customer.primary_technology) lines.push(`Technology: ${customer.primary_technology}`);
    if (customer.relationship_health) lines.push(`Relationship health: ${customer.relationship_health}`);
    if (customer.annual_revenue_current) lines.push(`Annual revenue: $${customer.annual_revenue_current.toLocaleString()}`);
    if (customer.primary_contact_name) {
      lines.push(`Primary contact: ${customer.primary_contact_name} (${customer.primary_contact_email || 'no email'})`);
    }
    if (customer.what_they_want) lines.push(`What they want: ${customer.what_they_want}`);
    if (customer.key_risks) lines.push(`Key risks: ${customer.key_risks}`);
    if (customer.key_opportunities) lines.push(`Key opportunities: ${customer.key_opportunities}`);
    if (customer.next_follow_up_action) {
      lines.push(`Next follow-up: ${customer.next_follow_up_action} (${customer.next_follow_up_date || 'no date'})`);
    }

    // Contacts
    if (customer.contacts && customer.contacts.length > 0) {
      lines.push('');
      lines.push('--- Contacts ---');
      for (const c of customer.contacts) {
        const primary = c.is_primary ? ' [PRIMARY]' : '';
        lines.push(`- ${c.name || c.email} ${c.title ? `(${c.title})` : ''} — ${c.email}${primary}`);
      }
    }

    // Revenue
    if (customer.revenue && customer.revenue.length > 0) {
      lines.push('');
      lines.push('--- Revenue History ---');
      for (const r of customer.revenue.slice(0, 12)) {
        lines.push(`- ${r.year}-${String(r.month).padStart(2, '0')}: $${(r.amount || 0).toLocaleString()}`);
      }
    }

    return lines.join('\n');
  },
};

export default getCustomerStatusTool;
