import { z } from 'zod';
import { getThread, getEmailByMessageId } from '../lib/email-intel-db.js';

const getEmailThread = {
  name: 'get_email_thread',
  description:
    'Retrieve a full email thread by Gmail thread ID. ' +
    'Returns all messages in chronological order with sender, subject, and body text.',
  schema: {
    thread_id: z.string().describe('Gmail thread ID (from search_emails results)'),
  },
  permissions: { db: 'read' },
  execute: async (args) => {
    let messages = getThread(args.thread_id);

    // Fallback: try treating thread_id as message_id
    if (!messages || messages.length === 0) {
      const single = getEmailByMessageId(args.thread_id);
      if (single) {
        messages = [single];
      }
    }

    if (!messages || messages.length === 0) {
      return `No messages found for thread ${args.thread_id}. The gmail_thread_id may not be populated. Use search_emails to find this email by sender or subject instead.`;
    }

    const lines = messages.map((m, i) => {
      const date = m.date ? m.date.slice(0, 16).replace('T', ' ') : 'unknown';
      const from = m.from_name || m.from_address || '?';
      const subject = m.subject || '(no subject)';
      const body = m.body_text || '[NO BODY TEXT AVAILABLE]';
      const attachTag = m.has_attachments ? ' [has attachments]' : '';

      return `--- Message ${i + 1} ---\nDate: ${date}\nFrom: ${from}\nSubject: ${subject}${attachTag}\n\n${body}`;
    });

    return `Thread ${args.thread_id} (${messages.length} message(s)):\n\n${lines.join('\n\n')}`;
  },
};

export default getEmailThread;
