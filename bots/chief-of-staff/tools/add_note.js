import { z } from 'zod';
import crypto from 'node:crypto';
import { ensureDb } from '../lib/db.js';

/**
 * Ensure the notes table exists in the chief-of-staff DB.
 */
function ensureNotesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'note',
      contacts TEXT,
      project TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

const addNoteTool = {
  name: 'add_note',
  description:
    'Store a note in the chief-of-staff database. Use for call summaries, meeting notes, ' +
    'transcripts, or general context that should be persisted for later reference.',
  schema: {
    title: z.string().describe('Short title for the note'),
    content: z.string().describe('Full note content'),
    type: z
      .enum(['call', 'meeting', 'note', 'transcript'])
      .optional()
      .describe('Note type (default: "note")'),
    contacts: z
      .string()
      .optional()
      .describe('Comma-separated email addresses of people involved'),
    project: z
      .string()
      .optional()
      .describe('Project or deal name this note relates to'),
  },
  permissions: { db: 'write' },
  execute: async (args, ctx) => {
    const { title, content, type, contacts, project } = args;
    const db = ensureDb(ctx.config);

    ensureNotesTable(db);

    const id = crypto.randomUUID();
    const noteType = type || 'note';

    db.prepare(
      `INSERT INTO notes (id, title, content, type, contacts, project)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, title, content, noteType, contacts || null, project || null);

    const parts = [`Note saved: "${title}" (${noteType})`];
    if (contacts) parts.push(`Contacts: ${contacts}`);
    if (project) parts.push(`Project: ${project}`);
    parts.push(`ID: ${id}`);

    return parts.join('\n');
  },
};

export default addNoteTool;
