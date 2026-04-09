#!/usr/bin/env node
/**
 * Bootstrap person profiles — one-time full build.
 *
 * For every contact with >=3 emails, builds a complete profile via Sonnet.
 * Run on openclaw: node bots/chief-of-staff/scripts/bootstrap-profiles.js
 *
 * Takes ~25 min for 100 contacts (sequential Sonnet calls).
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ─── Constants ──────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BOTFORGE_ROOT = path.resolve(__dirname, '..', '..', '..');

const CHIEF_DB_PATH = path.join(BOTFORGE_ROOT, 'data', 'ChiefOfStaff-tools.db');
const EMAIL_INTEL_DB_PATH = process.env.EMAIL_INTEL_DB_PATH
  || '/opt/email-intel/data/email-intel.db';
const KB_DIR = path.join(homedir(), '.chief-of-staff', 'science', 'kb');

const SONNET_MODEL = 'claude-sonnet-4-6';
const API_DELAY_MS = 2000;
const MIN_EMAILS = 3;

// ─── Helpers ────────────────────────────────────────────────────────────────

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[(),.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ─── Database Setup ─────────────────────────────────────────────────────────

function openChiefDb() {
  ensureDir(path.dirname(CHIEF_DB_PATH));
  const db = new Database(CHIEF_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function openEmailIntelDb() {
  if (!fs.existsSync(EMAIL_INTEL_DB_PATH)) {
    console.warn(`[warn] Email-intel DB not found at ${EMAIL_INTEL_DB_PATH}`);
    return null;
  }
  const db = new Database(EMAIL_INTEL_DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

function runMigrations(db) {
  // person_profiles table — same schema as db.js
  db.exec(`
    CREATE TABLE IF NOT EXISTS person_profiles (
      email TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      role TEXT,
      company TEXT,
      category TEXT,
      relationship_to_mark TEXT,

      formality_level TEXT DEFAULT 'professional',
      response_cadence TEXT,
      communication_notes TEXT,

      topics_json TEXT DEFAULT '[]',
      open_items_json TEXT DEFAULT '[]',
      last_interaction_summary TEXT,
      last_interaction_date TEXT,

      confidence REAL DEFAULT 0.5,
      kb_path TEXT,
      last_compiled_at TEXT,
      stale INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_profiles_category ON person_profiles(category);
    CREATE INDEX IF NOT EXISTS idx_profiles_stale ON person_profiles(stale);
  `);

  // kb_pages + FTS5 for writing profile pages
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_pages (
      path TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT,
      entity_type TEXT,
      entity_name TEXT,
      last_updated TEXT DEFAULT (datetime('now')),
      dirty INTEGER DEFAULT 0,
      word_count INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_kb_category ON kb_pages(category);
    CREATE INDEX IF NOT EXISTS idx_kb_dirty ON kb_pages(dirty);
    CREATE INDEX IF NOT EXISTS idx_kb_entity ON kb_pages(entity_type, entity_name);
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_pages_fts USING fts5(
      path, title, content,
      content=kb_pages,
      content_rowid=rowid
    );
  `);

  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS kb_pages_ai AFTER INSERT ON kb_pages BEGIN
        INSERT INTO kb_pages_fts(rowid, path, title, content)
        VALUES (new.rowid, new.path, new.title, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS kb_pages_ad AFTER DELETE ON kb_pages BEGIN
        INSERT INTO kb_pages_fts(kb_pages_fts, rowid, path, title, content)
        VALUES ('delete', old.rowid, old.path, old.title, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS kb_pages_au AFTER UPDATE ON kb_pages BEGIN
        INSERT INTO kb_pages_fts(kb_pages_fts, rowid, path, title, content)
        VALUES ('delete', old.rowid, old.path, old.title, old.content);
        INSERT INTO kb_pages_fts(rowid, path, title, content)
        VALUES (new.rowid, new.path, new.title, new.content);
      END;
    `);
  } catch {
    // Triggers may already exist
  }

  // commitments table (needed for getByPerson lookups)
  db.exec(`
    CREATE TABLE IF NOT EXISTS commitments (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      bearer TEXT NOT NULL,
      counterparty TEXT NOT NULL,
      description TEXT NOT NULL,
      condition_text TEXT,
      source_snippet TEXT,
      due_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      fulfilled_at TEXT,
      status TEXT DEFAULT 'active',
      blocker_id TEXT,
      source_type TEXT,
      source_ref TEXT,
      customer TEXT,
      project TEXT,
      priority TEXT DEFAULT 'normal',
      last_followup_at TEXT,
      followup_count INTEGER DEFAULT 0,
      next_followup_date TEXT,
      parent_id TEXT,
      depends_on TEXT,
      confidence REAL DEFAULT 1.0
    );
    CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments(status);
    CREATE INDEX IF NOT EXISTS idx_commitments_bearer ON commitments(bearer);
    CREATE INDEX IF NOT EXISTS idx_commitments_counterparty ON commitments(counterparty);
  `);
}

// ─── KB Write ───────────────────────────────────────────────────────────────

function writeKbPage(db, pagePath, { title, content, category, entityType, entityName }) {
  const words = countWords(content);
  const ts = now();

  db.prepare(`
    INSERT OR REPLACE INTO kb_pages (path, title, content, category, entity_type, entity_name, last_updated, dirty, word_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(pagePath, title, content, category || null, entityType || null, entityName || null, ts, words);

  // Write to disk
  const fullPath = path.join(KB_DIR, pagePath);
  ensureDir(path.dirname(fullPath));
  fs.writeFileSync(fullPath, content, 'utf-8');
}

// ─── Profile Upsert ─────────────────────────────────────────────────────────

function upsertProfile(db, profile) {
  const slug = profile.slug || slugify(profile.displayName || profile.email.split('@')[0]);
  const ts = now();

  db.prepare(`
    INSERT INTO person_profiles (
      email, display_name, slug, role, company, category, relationship_to_mark,
      formality_level, response_cadence, communication_notes,
      topics_json, open_items_json, last_interaction_summary, last_interaction_date,
      confidence, kb_path, last_compiled_at, stale, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      display_name = excluded.display_name,
      role = excluded.role,
      company = excluded.company,
      category = excluded.category,
      relationship_to_mark = excluded.relationship_to_mark,
      formality_level = excluded.formality_level,
      response_cadence = excluded.response_cadence,
      communication_notes = excluded.communication_notes,
      topics_json = excluded.topics_json,
      open_items_json = excluded.open_items_json,
      last_interaction_summary = excluded.last_interaction_summary,
      last_interaction_date = excluded.last_interaction_date,
      confidence = excluded.confidence,
      kb_path = excluded.kb_path,
      last_compiled_at = excluded.last_compiled_at,
      stale = 0,
      updated_at = excluded.updated_at
  `).run(
    profile.email,
    profile.displayName || profile.email.split('@')[0],
    slug,
    profile.role || null,
    profile.company || null,
    profile.category || null,
    profile.relationshipToMark || null,
    profile.formalityLevel || 'professional',
    profile.responseCadence || null,
    profile.communicationNotes || null,
    JSON.stringify(profile.topics || []),
    JSON.stringify(profile.openItems || []),
    profile.lastInteractionSummary || null,
    profile.lastInteractionDate || null,
    profile.confidence ?? 0.7,
    `people/${slug}.md`,
    ts,
    ts,
    ts,
  );

  // Write KB page
  writeProfileKbPage(db, profile.email, slug);
}

function writeProfileKbPage(db, email, slug) {
  const row = db.prepare('SELECT * FROM person_profiles WHERE email = ?').get(email);
  if (!row) return;

  let topics = [];
  let openItems = [];
  try { topics = JSON.parse(row.topics_json); } catch { /* ignore */ }
  try { openItems = JSON.parse(row.open_items_json); } catch { /* ignore */ }

  const pagePath = `people/${slug}.md`;
  const lines = [];
  lines.push(`# ${row.display_name}`);
  lines.push('');
  lines.push(`- **Email:** ${row.email}`);
  if (row.role) lines.push(`- **Role:** ${row.role}`);
  if (row.company) lines.push(`- **Company:** ${row.company}`);
  if (row.category) lines.push(`- **Category:** ${row.category}`);
  if (row.relationship_to_mark) lines.push(`- **Relationship:** ${row.relationship_to_mark}`);
  lines.push('');

  if (row.formality_level || row.response_cadence || row.communication_notes) {
    lines.push('## Communication Style');
    if (row.formality_level) lines.push(`- Formality: ${row.formality_level}`);
    if (row.response_cadence) lines.push(`- Response cadence: ${row.response_cadence}`);
    if (row.communication_notes) lines.push(`- Notes: ${row.communication_notes}`);
    lines.push('');
  }

  if (topics.length > 0) {
    lines.push('## Topics');
    for (const t of topics) {
      lines.push(`- ${typeof t === 'string' ? t : t.name || JSON.stringify(t)}`);
    }
    lines.push('');
  }

  if (openItems.length > 0) {
    lines.push('## Open Items');
    for (const item of openItems) {
      lines.push(`- ${typeof item === 'string' ? item : item.description || JSON.stringify(item)}`);
    }
    lines.push('');
  }

  if (row.last_interaction_summary) {
    lines.push('## Last Interaction');
    if (row.last_interaction_date) lines.push(`_${row.last_interaction_date}_`);
    lines.push(row.last_interaction_summary);
    lines.push('');
  }

  lines.push(`---`);
  lines.push(`_Confidence: ${row.confidence} | Last compiled: ${row.last_compiled_at || 'never'}_`);

  const content = lines.join('\n');

  writeKbPage(db, pagePath, {
    title: row.display_name,
    content,
    category: 'people',
    entityType: 'person',
    entityName: row.display_name,
  });
}

// ─── Claude Code Compile ────────────────────────────────────────────────────

let totalApiCalls = 0;
let totalCostUsd = 0;

async function compile(systemPrompt, context, instruction) {
  const userMessage = `<context>\n${context}\n</context>\n\n${instruction}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'chief-of-staff-bootstrap-profiles' };
      delete env.CLAUDECODE;

      const result = await new Promise((resolve, reject) => {
        const proc = execFile('claude', [
          '-p',
          '--output-format', 'json',
          '--model', SONNET_MODEL,
          '--system-prompt', systemPrompt,
        ], {
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
          env,
        }, (err, stdout, _stderr) => {
          if (err) return reject(err);
          resolve(stdout);
        });

        proc.stdin.write(userMessage);
        proc.stdin.end();
      });

      totalApiCalls++;

      try {
        const parsed = JSON.parse(result);
        totalCostUsd += parsed.total_cost_usd || parsed.cost_usd || 0;
        return parsed.result || parsed.text || result.trim();
      } catch {
        return result.trim();
      }
    } catch (err) {
      if (attempt === 2) throw err;
      const delay = Math.min(2000 * 2 ** attempt, 10000);
      console.warn(`  [retry] Claude CLI error, waiting ${delay}ms...`);
      await sleep(delay);
    }
  }
}

// ─── System Prompt ──────────────────────────────────────────────────────────

const PROFILE_SYSTEM_PROMPT = `You are building a person profile for a CEO's Chief of Staff AI assistant. Given email history and context about a contact, produce a structured JSON profile.

Output ONLY valid JSON with this exact schema:
{
  "displayName": "Full Name",
  "role": "Their job title / role",
  "company": "Company name",
  "category": "customer|employee|construction|vendor|advisor|government|investor|personal|other",
  "relationshipToMark": "Brief description of their relationship to Mark / Science Corp",
  "formalityLevel": "casual|professional|formal",
  "responseCadence": "Description of typical response pattern (e.g. 'replies within hours', 'weekly check-ins')",
  "communicationNotes": "Any notable communication style observations",
  "topics": ["topic1", "topic2"],
  "openItems": ["any pending items or follow-ups"],
  "lastInteractionSummary": "Brief summary of most recent interaction",
  "lastInteractionDate": "YYYY-MM-DD",
  "confidence": 0.7
}

Rules:
- Infer category from email content and domain
- Be factual — only include what the data supports
- Set confidence: 0.9 if >20 emails with clear pattern, 0.7 for moderate data, 0.5 for sparse
- Topics should be the main subjects discussed (max 5)
- Open items should be genuinely pending matters only
- If data is insufficient for a field, use null`;

// ─── Email-intel queries ────────────────────────────────────────────────────

function getContactsWithMinEmails(emailDb, minCount) {
  return emailDb.prepare(`
    SELECT c.*, mc.name as customer_name, mc.tier as customer_tier,
           mc.customer_status, mc.primary_technology
    FROM contacts c
    LEFT JOIN mems_customer_contacts mcc ON mcc.email = c.email_address
    LEFT JOIN mems_customers mc ON mc.id = mcc.customer_id
    WHERE c.hidden = 0 AND c.email_count >= ?
    ORDER BY c.email_count DESC
  `).all(minCount);
}

function getAllEmailsForContact(emailDb, email) {
  return emailDb.prepare(`
    SELECT e.id, e.message_id, e.gmail_thread_id, e.subject,
           e.from_address, e.from_name, e.to_addresses, e.date,
           e.direction, e.body_text, e.has_attachments, e.counterparty_address
    FROM emails e
    WHERE e.from_address = ? OR e.counterparty_address = ?
    ORDER BY e.date ASC
    LIMIT 500
  `).all(email, email);
}

function getContactHistory(emailDb, email) {
  const contact = emailDb.prepare(
    'SELECT * FROM contacts WHERE email_address = ?'
  ).get(email);

  if (!contact) return null;

  const recentEmails = emailDb.prepare(`
    SELECT e.id, e.subject, e.from_address, e.to_addresses, e.date,
           e.direction, e.has_attachments
    FROM emails e
    WHERE e.from_address = ? OR e.counterparty_address = ?
    ORDER BY e.date DESC
    LIMIT 20
  `).all(email, email);

  let customer = null;
  try {
    customer = emailDb.prepare(`
      SELECT mc.*
      FROM mems_customers mc
      JOIN mems_customer_contacts mcc ON mcc.customer_id = mc.id
      WHERE mcc.email = ?
      LIMIT 1
    `).get(email);
  } catch { /* table may not exist */ }

  return { contact, recentEmails, customer: customer || null };
}

function getNotes(emailDb, contactEmail) {
  try {
    return emailDb.prepare(`
      SELECT n.*
      FROM notes n
      JOIN note_contacts nc ON nc.note_id = n.id
      WHERE nc.email_address = ?
      ORDER BY n.date DESC
      LIMIT 10
    `).all(contactEmail);
  } catch {
    return [];
  }
}

function getCommitmentsForPerson(chiefDb, email) {
  try {
    return chiefDb.prepare(`
      SELECT * FROM commitments
      WHERE (bearer = ? OR counterparty = ?) AND status = 'active'
      ORDER BY due_date ASC NULLS LAST
    `).all(email, email);
  } catch {
    return [];
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Chief of Staff — Bootstrap Person Profiles ===');
  console.log();
  console.log(`Chief DB:        ${CHIEF_DB_PATH}`);
  console.log(`Email-Intel DB:  ${EMAIL_INTEL_DB_PATH}`);
  console.log(`KB Output:       ${KB_DIR}`);
  console.log(`Model:           ${SONNET_MODEL}`);
  console.log(`Min emails:      ${MIN_EMAILS}`);
  console.log();

  // 1. Initialize databases
  ensureDir(KB_DIR);
  const chiefDb = openChiefDb();
  const emailDb = openEmailIntelDb();

  if (!emailDb) {
    console.error('[fatal] Email-intel DB not available — cannot bootstrap profiles');
    process.exit(1);
  }

  // 2. Run migrations
  console.log('Running schema migrations...');
  runMigrations(chiefDb);
  console.log('Migrations complete.\n');

  // 3. Get contacts with >= MIN_EMAILS
  const contacts = getContactsWithMinEmails(emailDb, MIN_EMAILS);
  console.log(`Found ${contacts.length} contacts with >= ${MIN_EMAILS} emails\n`);

  if (contacts.length === 0) {
    console.log('No contacts to profile. Exiting.');
    chiefDb.close();
    emailDb.close();
    return;
  }

  const startTime = Date.now();
  let profilesCreated = 0;
  let profilesFailed = 0;

  // 4. Profile each contact
  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    const email = contact.email_address;
    const displayName = contact.display_name || email.split('@')[0];

    console.log(`[${i + 1}/${contacts.length}] Profiling: ${displayName} (${email})...`);

    try {
      // a. Get ALL emails
      const allEmails = getAllEmailsForContact(emailDb, email);

      // b. Get contact history
      const history = getContactHistory(emailDb, email);

      // c. Get notes
      const notes = getNotes(emailDb, email);

      // d. Get commitments
      const commitments = getCommitmentsForPerson(chiefDb, email);

      // e. Build context string
      const contextParts = [];
      contextParts.push(`Contact: ${displayName} <${email}>`);
      contextParts.push(`Total emails: ${allEmails.length}`);

      if (history?.contact) {
        const c = history.contact;
        if (c.category) contextParts.push(`Category: ${c.category}`);
        if (c.first_seen) contextParts.push(`First seen: ${c.first_seen.slice(0, 10)}`);
        if (c.last_seen) contextParts.push(`Last seen: ${c.last_seen.slice(0, 10)}`);
        if (c.domain) contextParts.push(`Domain: ${c.domain}`);
      }

      if (contact.customer_name) {
        contextParts.push(`Customer: ${contact.customer_name} (tier ${contact.customer_tier || '?'}, status: ${contact.customer_status || '?'})`);
        if (contact.primary_technology) contextParts.push(`Technology: ${contact.primary_technology}`);
      }

      // Email samples (first 3, last 5 — skip body for brevity, just subjects)
      contextParts.push('\n--- Email Timeline ---');
      const first3 = allEmails.slice(0, 3);
      const last5 = allEmails.slice(-5);
      const samples = [...first3];
      for (const e of last5) {
        if (!samples.find(s => s.id === e.id)) samples.push(e);
      }
      samples.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

      for (const e of samples) {
        const dir = e.direction === 'received' ? '<-' : '->';
        const date = e.date ? e.date.slice(0, 10) : '?';
        contextParts.push(`  ${date} ${dir} ${e.subject || '(no subject)'}`);
      }

      // Last 3 emails with body text for deeper analysis
      contextParts.push('\n--- Recent Emails (with body) ---');
      const recentWithBody = allEmails.slice(-3);
      for (const e of recentWithBody) {
        const dir = e.direction === 'received' ? 'FROM' : 'SENT';
        contextParts.push(`[${dir}] ${e.date?.slice(0, 16) || '?'} — ${e.subject || '(no subject)'}`);
        if (e.body_text) {
          contextParts.push(e.body_text.slice(0, 800));
        }
        contextParts.push('');
      }

      // Notes
      if (notes.length > 0) {
        contextParts.push('\n--- Notes ---');
        for (const n of notes.slice(0, 5)) {
          contextParts.push(`  ${n.date?.slice(0, 10) || '?'}: ${(n.content || n.title || '').slice(0, 200)}`);
        }
      }

      // Commitments
      if (commitments.length > 0) {
        contextParts.push('\n--- Active Commitments ---');
        for (const c of commitments.slice(0, 5)) {
          const due = c.due_date ? ` (due ${c.due_date})` : '';
          contextParts.push(`  [${c.type}] ${c.description}${due}`);
        }
      }

      const context = contextParts.join('\n');

      // f. Call compile() via Sonnet
      const result = await compile(
        PROFILE_SYSTEM_PROMPT,
        context,
        `Build a person profile for ${displayName} (${email}). Analyze their email history, communication patterns, and relationship with Mark / Science Corp.`
      );

      // g. Parse JSON result
      let profile;
      try {
        // Extract JSON from possible markdown code blocks
        let jsonStr = result;
        const jsonMatch = result.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
        if (jsonMatch) jsonStr = jsonMatch[1];
        profile = JSON.parse(jsonStr);
      } catch (parseErr) {
        console.warn(`  [warn] Failed to parse profile JSON for ${email}: ${parseErr.message}`);
        profilesFailed++;
        continue;
      }

      // h. Upsert profile
      profile.email = email;
      upsertProfile(chiefDb, profile);
      profilesCreated++;
      console.log(`  Profiled: ${profile.displayName || displayName} [${profile.category || '?'}] (confidence: ${profile.confidence || '?'})`);

      // i. Sleep to avoid rate limiting
      await sleep(API_DELAY_MS);
    } catch (err) {
      console.error(`  [error] Failed to profile ${email}: ${err.message}`);
      profilesFailed++;
    }
  }

  // 5. Cleanup
  chiefDb.close();
  emailDb.close();

  // 6. Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n=== Bootstrap Profiles Complete ===');
  console.log();
  console.log(`Contacts processed: ${contacts.length}`);
  console.log(`Profiles created:   ${profilesCreated}`);
  console.log(`Profiles failed:    ${profilesFailed}`);
  console.log(`API calls:          ${totalApiCalls}`);
  console.log(`Est. cost:          $${totalCostUsd.toFixed(4)}`);
  console.log(`Elapsed:            ${elapsed}s`);
  console.log();
  console.log(`KB files:           ${KB_DIR}/people/`);
  console.log(`SQLite DB:          ${CHIEF_DB_PATH}`);
  console.log();
}

main().catch(err => {
  console.error('\n[fatal]', err);
  process.exit(1);
});
