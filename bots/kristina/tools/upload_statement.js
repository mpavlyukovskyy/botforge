import { z } from 'zod';
import { getAtlasConfig } from '../lib/atlas-client.js';

/**
 * P2: upload a bank/credit-card statement PDF (sent by Kristina in the current
 * message) to the finance app's review queue. Auto-detects the account; if the
 * account is ambiguous, returns the candidates so Kristina can re-send naming one.
 * Nothing is auto-applied — Mark approves it on the dashboard.
 */
const uploadStatement = {
  name: 'upload_statement',
  description: 'Upload the bank/credit-card statement PDF from the current message to Mark\'s finance review queue. Use when the user sends a statement PDF. Optionally pass account if the bank is ambiguous.',
  schema: {
    account: z.string().optional().describe('Account name/id, only if auto-detection was ambiguous'),
  },
  execute: async (args, ctx) => {
    try {
      const file = ctx.files?.[0];
      if (!file || file.length === 0) return 'No statement file found in this message — please attach the PDF.';
      const meta = ctx.fileMetadata?.[0] ?? {};
      const fileName = meta.fileName || 'statement.pdf';
      const mime = meta.mimeType || '';
      if (!/pdf/i.test(mime) && !/\.pdf$/i.test(fileName)) {
        return `That file (${fileName}) doesn't look like a PDF statement. Send the bank/card statement as a PDF.`;
      }

      const { url, token } = getAtlasConfig(ctx);
      if (!token) return 'Finance upload is not configured (missing sync key).';

      const res = await fetch(`${url}/api/finance-import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, pdfBase64: file.toString('base64'), accountId: args.account }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.ok) {
        return `📄 Statement "${fileName}" parsed for *${data.account}*: ${data.newTransactions} new transaction(s)`
          + (data.duplicates ? `, ${data.duplicates} already on file` : '')
          + `. Queued for Mark to review/approve on the dashboard — nothing was added to the books yet.`;
      }
      if (res.status === 409 || data.needsAccount) {
        const opts = (data.accounts || []).map(a => `${a.name}${a.lastFour ? ' ·'+a.lastFour : ''}`).join(', ');
        return `I couldn't tell which account "${fileName}" belongs to`
          + (data.detectedInstitution ? ` (looks like ${data.detectedInstitution})` : '')
          + `. Re-send and tell me the account${opts ? ` — options: ${opts}` : ''}.`;
      }
      return `Couldn't import "${fileName}": ${data.error || `HTTP ${res.status}`}.`;
    } catch (err) {
      return `Error uploading statement: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export default uploadStatement;
