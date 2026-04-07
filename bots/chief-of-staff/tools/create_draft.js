import { z } from 'zod';
import { generateDraft, formatDraftForTelegram, checkConfidentiality } from '../lib/draft-engine.js';
import { getThread } from '../lib/email-intel-db.js';
import { createDraft } from '../lib/gmail-client.js';

const createDraftTool = {
  name: 'create_draft',
  description:
    'Create an email draft for a contact. If `body` is provided, stores the draft instantly ' +
    '(fast path). Otherwise, uses AI generation with full context (slow path — avoid during ' +
    'interactive triage).',
  schema: {
    contact_email: z.string().describe('Recipient email address'),
    thread_id: z
      .string()
      .optional()
      .describe('Gmail thread ID to reply to (from search_emails or get_email_thread)'),
    instruction: z
      .string()
      .optional()
      .describe('Natural language instruction, e.g. "follow up on capacity reservation"'),
    body: z
      .string()
      .optional()
      .describe('Pre-written draft body text (plain text, no markdown). Stores directly without AI generation.'),
    subject: z
      .string()
      .optional()
      .describe('Email subject line. Derived from thread if omitted.'),
  },
  permissions: { db: 'write' },
  execute: async (args, ctx) => {
    const { contact_email, thread_id, instruction, body, subject } = args;

    // ─── Fast path: body provided, store directly ───────────────────────
    if (body && body.trim().length > 0) {
      // Resolve subject and inReplyTo from thread if available
      let threadMessages = [];
      if (thread_id) {
        try {
          threadMessages = getThread(thread_id) || [];
        } catch (err) {
          console.warn('[create_draft] getThread error:', err.message);
        }
      }

      const resolvedSubject = subject
        || (threadMessages.length > 0 ? threadMessages[0].subject : null)
        || (instruction ? instruction.split(' ').slice(0, 8).join(' ') : null)
        || 'Follow-up';

      const inReplyTo = threadMessages.length > 0
        ? threadMessages[threadMessages.length - 1].message_id
        : undefined;

      // Confidentiality check (conservative: assume customer recipient)
      const confidentialityFlags = checkConfidentiality(body.trim(), 'customer');

      let gmailDraft = null;
      try {
        gmailDraft = await createDraft({
          to: contact_email,
          subject: resolvedSubject,
          body: body.trim(),
          threadId: thread_id || undefined,
          inReplyTo,
        });
      } catch (err) {
        console.error('[create_draft] Gmail draft creation failed:', err.message);
        return `Error creating draft: ${err.message}`;
      }

      const lines = [];
      lines.push(`Draft created for: ${contact_email}`);
      lines.push(`Subject: ${resolvedSubject}`);
      if (gmailDraft?.draftId) lines.push(`Draft ID: ${gmailDraft.draftId}`);

      if (confidentialityFlags.length > 0) {
        lines.push(`WARNING - Confidentiality flags: ${confidentialityFlags.join(', ')}`);
      }

      lines.push('');
      lines.push('--- Draft preview ---');
      lines.push(body.trim().slice(0, 500) + (body.trim().length > 500 ? '...' : ''));
      lines.push('--- End preview ---');

      if (gmailDraft?.draftId) {
        lines.push('');
        lines.push('Use send_draft to send this draft, or edit it in Gmail.');
      }

      return lines.join('\n');
    }

    // ─── Slow path: AI-generated draft via Opus ─────────────────────────
    const result = await generateDraft(ctx, {
      contactEmail: contact_email,
      threadId: thread_id || undefined,
      instruction: instruction || undefined,
    });

    if (!result || !result.draftText) {
      return `Failed to generate draft for ${contact_email}.`;
    }

    const lines = [];
    lines.push(`Draft created for: ${result.contactEmail || contact_email}`);
    if (result.subject) lines.push(`Subject: ${result.subject}`);
    if (result.draftId) lines.push(`Draft ID: ${result.draftId}`);
    if (result.recipientType) lines.push(`Recipient type: ${result.recipientType}`);

    if (result.confidentialityFlags && result.confidentialityFlags.length > 0) {
      lines.push(`WARNING - Confidentiality flags: ${result.confidentialityFlags.join(', ')}`);
    }

    lines.push('');
    lines.push('--- Draft preview ---');
    lines.push(result.draftText);
    lines.push('--- End preview ---');

    if (result.draftId) {
      lines.push('');
      lines.push('Use send_draft to send this draft, or edit it in Gmail.');
    }

    return lines.join('\n');
  },
};

export default createDraftTool;
