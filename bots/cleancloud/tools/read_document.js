/**
 * Brain tool: read_document
 *
 * Parse attached document files (.xlsx, .xls, .csv, .pdf, .txt).
 * Returns extracted contents as text for the brain to process.
 */
import { z } from 'zod';
import XLSX from 'xlsx';
import { extractText } from 'unpdf';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const PARSE_TIMEOUT = 10_000; // 10 seconds

export default {
  name: 'read_document',
  description: 'Read and extract contents from a document attached to the current message (supports .xlsx, .xls, .csv, .pdf, .txt). Call this whenever a user sends a document file.',
  schema: {
    sheet_name: z.string().optional().describe('For spreadsheets: specific sheet name to read. Reads all sheets if omitted.'),
  },
  async execute(args, ctx) {
    if (!ctx.files?.length) return 'No file attached to this message.';

    const buffer = ctx.files[0];
    const meta = ctx.fileMetadata?.[0];
    const fileName = meta?.fileName || 'unknown';
    const mimeType = meta?.mimeType || detectMimeFromBuffer(buffer);

    if (buffer.length > MAX_FILE_SIZE) {
      return `File "${fileName}" is ${Math.round(buffer.length / 1024 / 1024)}MB — exceeds 10MB limit.`;
    }

    try {
      // xlsx/xls/csv
      if (isSpreadsheet(mimeType, fileName)) {
        return await parseWithTimeout(() => parseSpreadsheet(buffer, args.sheet_name), fileName);
      }
      // pdf
      if (mimeType?.includes('pdf') || fileName.toLowerCase().endsWith('.pdf')) {
        return await parseWithTimeout(() => parsePdf(buffer), fileName);
      }
      // plain text
      if (mimeType?.startsWith('text/') || /\.(txt|csv|tsv|log|json|xml)$/i.test(fileName)) {
        return `Contents of "${fileName}":\n\n${buffer.toString('utf-8')}`;
      }
      return `Unsupported file type: "${fileName}" (${mimeType}). Supported: .xlsx, .xls, .csv, .pdf, .txt`;
    } catch (err) {
      ctx.log.error(`read_document failed for "${fileName}": ${err}`);
      return `Failed to parse "${fileName}": ${err.message}`;
    }
  },
};

// --- Helpers ---

function isSpreadsheet(mime, name) {
  return mime?.includes('spreadsheet') || mime?.includes('excel') ||
    /\.(xlsx|xls|csv|ods)$/i.test(name);
}

function detectMimeFromBuffer(buf) {
  if (buf[0] === 0x50 && buf[1] === 0x4B) return 'application/zip'; // xlsx is ZIP
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'application/pdf';
  return 'application/octet-stream';
}

function parseWithTimeout(fn, fileName) {
  return Promise.race([
    fn(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Parse timed out after 10s')), PARSE_TIMEOUT)),
  ]);
}

function parseSpreadsheet(buffer, sheetName) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheets = sheetName ? [sheetName] : workbook.SheetNames;
  const parts = [];
  for (const name of sheets) {
    const ws = workbook.Sheets[name];
    if (!ws) { parts.push(`Sheet "${name}" not found.`); continue; }
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!rows.length) { parts.push(`Sheet "${name}": empty`); continue; }
    // Build markdown table
    const header = rows[0].map(String);
    const divider = header.map(() => '---');
    const body = rows.slice(1).map(r => r.map(String));
    const table = [header.join(' | '), divider.join(' | '), ...body.map(r => r.join(' | '))].join('\n');
    parts.push(`### Sheet: ${name} (${rows.length - 1} rows)\n\n${table}`);
  }
  return parts.join('\n\n');
}

async function parsePdf(buffer) {
  const { text } = await extractText(buffer);
  return text || 'PDF contained no extractable text.';
}
