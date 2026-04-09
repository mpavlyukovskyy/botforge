/**
 * Context builder: recent_email_activity
 *
 * Primary: injects top priority queue entries for the brain's system context.
 * Fallback: if the priority_queue table is empty or missing, falls back to
 * the legacy 24h/48h email activity summary from email-intel.
 */
import { getTopEntries, getQueueCount } from '../lib/priority-queue.js';
import { getRecentActivity, getStats, getActionableEmails } from '../lib/email-intel-db.js';


export default {
  type: 'recent_email_activity',
  async build(ctx) {
    // ── Priority queue path (preferred) ──────────────────────────────────
    try {
      const count = getQueueCount(ctx);
      if (count > 0) {
        const top = getTopEntries(ctx, 5);
        const lines = top.map((e, i) => {
          const score = (e.priority_score * 100).toFixed(0);
          const draft = e.draft_status === 'ready' ? ' [draft ready]' : '';
          const cat = e.contact_category ? ` (${e.contact_category})` : '';
          const customer = e.customer_name ? ` {${e.customer_name}}` : '';
          const name = e.from_name || e.from_address;
          return `Q${i + 1}. [${score}%] ${name}${cat}${customer}${draft}: ${e.subject}`;
        });

        return [
          '<priority_queue>',
          `${count} emails in queue. Top ${top.length}:`,
          ...lines,
          '',
          'IMPORTANT: Only subject lines shown above — email bodies NOT loaded. Do NOT describe email content. Call get_queue_item(N) to read the actual thread before presenting any email.',
          'Queue items are labeled Q1, Q2, etc. Morning briefing items use plain numbers (1, 2, 3). These are DIFFERENT lists — when Mark says "first email" after a briefing, resolve from the BRIEFING, not the queue. When calling queue tools (get_queue_item, dismiss_queue_item), pass the number only (Q1 → position 1).',
          '</priority_queue>',
        ].join('\n');
      }
    } catch {
      // priority_queue table may not exist yet — fall through to legacy
    }

    // ── Legacy fallback: actionable emails from email-intel ─────────────
    let emails;
    try {
      emails = getActionableEmails(168); // 7 days
    } catch (err) {
      return '<recent_email_activity>Failed to load email activity.</recent_email_activity>';
    }

    if (!emails || emails.length === 0) {
      // No recent emails — but tell Claude the DB has data so it uses search tool
      try {
        const stats = getStats();
        if (stats.totalEmails > 0) {
          return `<recent_email_activity>No actionable emails in the last 7 days, but the email database contains ${stats.totalEmails.toLocaleString()} emails total (last sync: ${stats.lastSync || 'unknown'}). Use the search_emails tool to query historical emails.</recent_email_activity>`;
        }
      } catch { /* stats unavailable */ }
      return '<recent_email_activity>No actionable emails in the last 7 days.</recent_email_activity>';
    }

    // Cap at 20 items, unreplied first (already sorted by query)
    const capped = emails.slice(0, 20);

    const lines = capped.map((e, i) => {
      const date = e.date ? e.date.slice(0, 10) : '?';
      const name = e.from_name || e.from_address || '?';
      const cat = e.category ? ` (${e.category})` : '';
      const subject = e.subject || '(no subject)';
      const replied = e.has_reply ? ' [REPLIED]' : '';
      return `Q${i + 1}. [${date}] ${name}${cat}: ${subject}${replied}`;
    });

    const unrepliedCount = emails.filter(e => !e.has_reply).length;
    const repliedCount = emails.filter(e => e.has_reply).length;

    return [
      '<recent_email_activity>',
      `Priority queue is empty. ${unrepliedCount} unreplied + ${repliedCount} replied email(s) in last 7 days:`,
      ...lines,
      '',
      'IMPORTANT: Only subject lines shown above — email bodies NOT loaded. Do NOT describe or paraphrase email content from subject lines alone. Emails marked [REPLIED] already have a sent response from Mark — deprioritize these. Focus on unreplied emails. Use get_person_profile to check sender importance. Use search_emails with the sender name or subject to read full email content.',
      '</recent_email_activity>',
    ].join('\n');
  },
};
