import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: Database.Database;

export function initDb(dbPath?: string): void {
  const path = dbPath || join(process.cwd(), 'data', 'taskbot.db');
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Try multiple paths for schema.sql (works in dev and compiled)
  const schemaPaths = [
    join(__dirname, 'schema.sql'),
    join(process.cwd(), 'src', 'db', 'schema.sql'),
  ];

  let schema: string | null = null;
  for (const p of schemaPaths) {
    if (existsSync(p)) {
      schema = readFileSync(p, 'utf-8');
      break;
    }
  }

  if (!schema) {
    throw new Error('schema.sql not found in any expected location');
  }

  db.exec(schema);
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function closeDb(): void {
  if (db) db.close();
}
