#!/usr/bin/env node
/**
 * bootstrap-kb.js — One-time script to seed the Chief of Staff knowledge base
 * from the email-intel DB and science docs.
 *
 * Run from botforge root:
 *   node bots/chief-of-staff/scripts/bootstrap-kb.js
 *
 * Requirements:
 *   - `claude` CLI on PATH (Claude Code)
 *   - email-intel DB at EMAIL_INTEL_DB_PATH or default location
 *   - Science docs at /Users/Mark/Documents/dev/science/
 *
 * Estimated runtime: ~5-10 minutes (20-30 Claude Code calls via claude -p)
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
  || '/Users/Mark/Documents/dev/email-intel/data/email-intel.db';
const SCIENCE_DIR = '/Users/Mark/Documents/dev/science';
const CUSTOMER_PROFILES_DIR = path.join(SCIENCE_DIR, 'customers', 'profiles');
const KB_DIR = path.join(homedir(), '.chief-of-staff', 'science', 'kb');

const SONNET_MODEL = 'claude-sonnet-4-6';
const TODAY = new Date().toISOString().slice(0, 10);
const API_DELAY_MS = 2000;

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

function readFileIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  } catch {
    // ignore
  }
  return null;
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
  // kb_pages + FTS5 — same schema as db.js
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
}

// ─── KB Write ───────────────────────────────────────────────────────────────

function writePage(db, pagePath, { title, content, category, entityType, entityName }) {
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

// ─── Claude Code Compile ────────────────────────────────────────────────────

let totalApiCalls = 0;
let totalCostUsd = 0;

function initClaude() {
  console.log('[bootstrap] Using Claude Code CLI (claude -p) for compilation');
}

async function compile(systemPrompt, context, instruction) {
  const userMessage = `<context>\n${context}\n</context>\n\n${instruction}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'chief-of-staff-bootstrap' };
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
        }, (err, stdout, stderr) => {
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

// ─── System Prompts ─────────────────────────────────────────────────────────

const KB_SYSTEM_PROMPT = `You are a knowledge base compiler for a CEO's Chief of Staff AI assistant at Science Corporation (a MEMS foundry in Durham, NC).

Your job is to compile structured, factual KB pages from raw data. Each page should be:
- Concise but comprehensive (300-800 words)
- Written in third person, factual tone
- Organized with clear markdown headings
- Focused on information a Chief of Staff needs: relationship status, key contacts, recent activity, open items, risks

Do NOT include the frontmatter comment — that will be added by the script.
Start directly with a markdown heading (# Title).`;

const INDEX_SYSTEM_PROMPT = `You are a knowledge base compiler. Generate a concise index page that summarizes a category and links to all its pages.

Format as markdown with:
- A brief 1-2 sentence overview of the category
- A bullet list of pages with: link, one-line description
- Use relative markdown links like [Page Title](filename.md)

Do NOT include frontmatter comments. Start with a # heading.`;

// ─── Seed: Customers ────────────────────────────────────────────────────────

async function seedCustomers(chiefDb, emailDb) {
  console.log('\n=== Seeding Customers ===\n');

  if (!emailDb) {
    console.warn('[skip] No email-intel DB — skipping customer seed');
    return [];
  }

  const customers = emailDb.prepare(`
    SELECT id, name, domain, tier, customer_status, annual_revenue_current,
           primary_contact_name, primary_contact_email, primary_technology,
           relationship_health, relationship_health_reason, what_they_want,
           key_risks, key_opportunities, competitive_position, notes,
           next_follow_up_action, next_follow_up_date, technologies_interested,
           products_purchased, city, state, country
    FROM mems_customers
    ORDER BY tier ASC NULLS LAST, name ASC
  `).all();

  const pages = [];
  const total = customers.length;

  for (let i = 0; i < total; i++) {
    const cust = customers[i];
    const slug = slugify(cust.name);
    const pagePath = `customers/${slug}.md`;

    console.log(`Compiling ${pagePath}... (${i + 1}/${total})`);

    // Get contacts
    const contacts = emailDb.prepare(
      'SELECT name, email, title, is_primary, contact_status FROM mems_customer_contacts WHERE customer_id = ? ORDER BY is_primary DESC'
    ).all(cust.id);

    // Get email stats from contacts table
    let emailStats = [];
    if (cust.primary_contact_email) {
      emailStats = emailDb.prepare(`
        SELECT email_address, display_name, email_count, first_seen, last_seen, category
        FROM contacts
        WHERE domain = ? AND hidden = 0
        ORDER BY email_count DESC
        LIMIT 10
      `).all(cust.domain || '');
    }

    // Read markdown profile if it exists
    const profileContent = readProfileForCustomer(cust.name);

    // Build context block
    const contextParts = [
      `Customer: ${cust.name}`,
      cust.domain ? `Domain: ${cust.domain}` : null,
      cust.tier ? `Tier: ${cust.tier}` : null,
      `Status: ${cust.customer_status || 'unknown'}`,
      `Relationship Health: ${cust.relationship_health || 'unknown'}`,
      cust.relationship_health_reason ? `Health Reason: ${cust.relationship_health_reason}` : null,
      cust.primary_technology ? `Primary Technology: ${cust.primary_technology}` : null,
      cust.technologies_interested ? `Technologies Interested: ${cust.technologies_interested}` : null,
      cust.products_purchased ? `Products Purchased: ${cust.products_purchased}` : null,
      cust.annual_revenue_current ? `Annual Revenue: $${cust.annual_revenue_current.toLocaleString()}` : null,
      cust.primary_contact_name ? `Primary Contact: ${cust.primary_contact_name} (${cust.primary_contact_email || 'no email'})` : null,
      cust.city ? `Location: ${[cust.city, cust.state, cust.country].filter(Boolean).join(', ')}` : null,
      cust.what_they_want ? `What They Want: ${cust.what_they_want}` : null,
      cust.key_risks ? `Key Risks: ${cust.key_risks}` : null,
      cust.key_opportunities ? `Key Opportunities: ${cust.key_opportunities}` : null,
      cust.competitive_position ? `Competitive Position: ${cust.competitive_position}` : null,
      cust.next_follow_up_action ? `Next Follow-Up: ${cust.next_follow_up_action} (${cust.next_follow_up_date || 'no date'})` : null,
      cust.notes ? `Notes: ${cust.notes}` : null,
    ].filter(Boolean);

    if (contacts.length > 0) {
      contextParts.push('\nContacts:');
      for (const c of contacts) {
        contextParts.push(`  - ${c.name}${c.title ? ` (${c.title})` : ''} — ${c.email || 'no email'}${c.is_primary ? ' [PRIMARY]' : ''}${c.contact_status ? ` [${c.contact_status}]` : ''}`);
      }
    }

    if (emailStats.length > 0) {
      contextParts.push('\nEmail Activity (from email-intel):');
      for (const s of emailStats) {
        contextParts.push(`  - ${s.display_name || s.email_address}: ${s.email_count} emails, first: ${s.first_seen?.slice(0, 10) || '?'}, last: ${s.last_seen?.slice(0, 10) || '?'}`);
      }
    }

    if (profileContent) {
      contextParts.push('\n--- Detailed Profile ---');
      contextParts.push(profileContent);
    }

    const context = contextParts.join('\n');

    try {
      const compiled = await compile(
        KB_SYSTEM_PROMPT,
        context,
        `Compile a KB page for the customer "${cust.name}". Include: overview, key contacts, relationship status, technology focus, recent activity, open items, and risks/opportunities.`
      );

      const frontmatter = `<!-- entity: ${cust.name} | type: customer | tier: ${cust.tier || 'untiered'} | updated: ${TODAY} -->`;
      const content = `${frontmatter}\n${compiled}`;

      writePage(chiefDb, pagePath, {
        title: cust.name,
        content,
        category: 'customers',
        entityType: 'customer',
        entityName: cust.name,
      });

      pages.push({ path: pagePath, title: cust.name });
      await sleep(API_DELAY_MS);
    } catch (err) {
      console.error(`  [error] Failed to compile ${pagePath}: ${err.message}`);
    }
  }

  return pages;
}

function readProfileForCustomer(customerName) {
  // Map customer names to profile filenames
  const profileMap = {
    'Advion Interchim Scientific': 'Advion_Profile.md',
    'BMC': 'BMC_Profile.md',
    'Coherence Neuro': 'Coherence_Neuro_Profile.md',
    'IMEC': 'IMEC_Partner_Profile.md',
    'Memscap': 'MEMSCAP_Profile.md',
    'Omnitron Sensors': 'Omnitron_Sensors_Profile.md',
    'QATCH Technologies': 'Qatch_Technologies_Profile.md',
  };

  const filename = profileMap[customerName];
  if (!filename) return null;

  const filePath = path.join(CUSTOMER_PROFILES_DIR, filename);
  return readFileIfExists(filePath);
}

// ─── Seed: People ───────────────────────────────────────────────────────────

async function seedPeople(chiefDb, emailDb) {
  console.log('\n=== Seeding People ===\n');

  // Key people to seed with their known email domains/identifiers
  const keyPeople = [
    {
      name: 'Max Hodak',
      role: 'CEO, Science Corporation',
      searchTerms: ['max@science.xyz', 'max@sciencecorp.com', 'maxhodak'],
      notes: 'Founder and CEO. All strategic decisions flow through Max.',
    },
    {
      name: 'Darius',
      role: 'Advisor, Science Corporation',
      searchTerms: ['darius'],
      notes: 'Strategic advisor. Key relationship for board-level guidance.',
    },
    {
      name: 'Tim Loughran',
      role: 'Construction Manager',
      searchTerms: ['tim', 'loughran', 'timl'],
      notes: 'Manages Durham facility construction. Barn 1 and Phase 2 builds.',
    },
    {
      name: 'Guoqing',
      role: 'Foundry Director',
      searchTerms: ['guoqing'],
      notes: 'Runs day-to-day foundry operations. Equipment, process, and yield.',
    },
    {
      name: 'Joe',
      role: 'Legal Counsel',
      searchTerms: ['joe'],
      notes: 'Handles contracts, IP, compliance, CFIUS matters.',
    },
  ];

  const pages = [];

  for (let i = 0; i < keyPeople.length; i++) {
    const person = keyPeople[i];
    const slug = slugify(person.name);
    const pagePath = `people/${slug}.md`;

    console.log(`Compiling ${pagePath}... (${i + 1}/${keyPeople.length})`);

    // Try to find email history from contacts table
    let contactInfo = [];
    if (emailDb) {
      for (const term of person.searchTerms) {
        const results = emailDb.prepare(`
          SELECT email_address, display_name, email_count, first_seen, last_seen, category
          FROM contacts
          WHERE (email_address LIKE ? OR display_name LIKE ?) AND hidden = 0
          ORDER BY email_count DESC
          LIMIT 5
        `).all(`%${term}%`, `%${term}%`);

        for (const r of results) {
          if (!contactInfo.find(c => c.email_address === r.email_address)) {
            contactInfo.push(r);
          }
        }
      }
    }

    const contextParts = [
      `Name: ${person.name}`,
      `Role: ${person.role}`,
      `Notes: ${person.notes}`,
    ];

    if (contactInfo.length > 0) {
      contextParts.push('\nEmail History:');
      for (const c of contactInfo) {
        contextParts.push(`  - ${c.display_name || c.email_address} <${c.email_address}>: ${c.email_count} emails, last: ${c.last_seen?.slice(0, 10) || '?'}, category: ${c.category || 'uncategorized'}`);
      }
    }

    const context = contextParts.join('\n');

    try {
      const compiled = await compile(
        KB_SYSTEM_PROMPT,
        context,
        `Compile a KB page for the person "${person.name}" (${person.role}). Include: role overview, relationship context, communication patterns, and what a Chief of Staff should know about working with them. Keep it factual based on available data.`
      );

      const frontmatter = `<!-- entity: ${person.name} | type: person | role: ${person.role} | updated: ${TODAY} -->`;
      const content = `${frontmatter}\n${compiled}`;

      writePage(chiefDb, pagePath, {
        title: person.name,
        content,
        category: 'people',
        entityType: 'person',
        entityName: person.name,
      });

      pages.push({ path: pagePath, title: person.name });
      await sleep(API_DELAY_MS);
    } catch (err) {
      console.error(`  [error] Failed to compile ${pagePath}: ${err.message}`);
    }
  }

  return pages;
}

// ─── Seed: Facility ─────────────────────────────────────────────────────────

async function seedFacility(chiefDb) {
  console.log('\n=== Seeding Facility ===\n');

  const facilityDocs = {
    'facility/barn-1.md': {
      title: 'Barn 1 — Durham Facility',
      entityName: 'barn-1',
      sourceFiles: [
        path.join(SCIENCE_DIR, 'durham-facility', '2026-03-12-prologis-lease-review-summary.md'),
        path.join(SCIENCE_DIR, 'durham-facility', 'lease-construction-compliance-analysis.md'),
      ],
      instruction: 'Compile a KB page about Barn 1 at the Durham facility. Cover: lease status, construction compliance, key terms, landlord relationship (Prologis), and any open items or risks.',
    },
    'facility/phase-2.md': {
      title: 'Phase 2 — Durham Expansion',
      entityName: 'phase-2',
      sourceFiles: [
        path.join(SCIENCE_DIR, 'durham-facility', 'lease-construction-compliance-analysis.md'),
        path.join(SCIENCE_DIR, 'durham-facility', 'physical-construction-modeling-plan.md'),
        path.join(SCIENCE_DIR, 'durham-facility', 'wastewater-permit-review-2026-02-26.md'),
        path.join(SCIENCE_DIR, 'durham-facility', 'linde-nitrogen-supply-review-2026-02-23.md'),
      ],
      instruction: 'Compile a KB page about Phase 2 expansion at Durham. Cover: construction status, permits (wastewater), utility supply (nitrogen/Linde), compliance analysis, and key risks or blockers.',
    },
  };

  const pages = [];
  const entries = Object.entries(facilityDocs);

  for (let i = 0; i < entries.length; i++) {
    const [pagePath, doc] = entries[i];

    console.log(`Compiling ${pagePath}... (${i + 1}/${entries.length})`);

    const contextParts = [];
    let hasContent = false;

    for (const filePath of doc.sourceFiles) {
      const content = readFileIfExists(filePath);
      if (content) {
        const filename = path.basename(filePath);
        contextParts.push(`\n--- ${filename} ---`);
        // Truncate very long docs to keep context manageable
        contextParts.push(content.length > 8000 ? content.slice(0, 8000) + '\n\n[... truncated ...]' : content);
        hasContent = true;
      } else {
        console.warn(`  [warn] Source file not found: ${filePath}`);
      }
    }

    if (!hasContent) {
      console.warn(`  [skip] No source files found for ${pagePath}`);
      continue;
    }

    const context = contextParts.join('\n');

    try {
      const compiled = await compile(KB_SYSTEM_PROMPT, context, doc.instruction);

      const frontmatter = `<!-- entity: ${doc.entityName} | type: facility | updated: ${TODAY} -->`;
      const content = `${frontmatter}\n${compiled}`;

      writePage(chiefDb, pagePath, {
        title: doc.title,
        content,
        category: 'facility',
        entityType: 'facility',
        entityName: doc.entityName,
      });

      pages.push({ path: pagePath, title: doc.title });
      await sleep(API_DELAY_MS);
    } catch (err) {
      console.error(`  [error] Failed to compile ${pagePath}: ${err.message}`);
    }
  }

  return pages;
}

// ─── Seed: PRIMA ────────────────────────────────────────────────────────────

async function seedPrima(chiefDb) {
  console.log('\n=== Seeding PRIMA ===\n');

  const primaDocs = {
    'prima/cm-evaluation.md': {
      title: 'PRIMA — Contract Manufacturer Evaluation',
      entityName: 'cm-evaluation',
      sourceFiles: [
        path.join(SCIENCE_DIR, 'prima', 'CM_Outreach_Tracker.md'),
        path.join(SCIENCE_DIR, 'prima', 'RTP_Contract_Manufacturers_Report.md'),
      ],
      instruction: 'Compile a KB page about the PRIMA contract manufacturer evaluation process. Cover: which CMs are being evaluated, outreach status, criteria, shortlist, and next steps.',
    },
    'prima/manufacturing-strategy.md': {
      title: 'PRIMA — Manufacturing Strategy',
      entityName: 'manufacturing-strategy',
      sourceFiles: [
        path.join(SCIENCE_DIR, 'prima', 'PRIMA_Manufacturing_Strategy_2026-03-26.md'),
      ],
      instruction: 'Compile a KB page about PRIMA manufacturing strategy. Cover: product overview, manufacturing approach, timeline, key decisions, and risks.',
    },
  };

  const pages = [];
  const entries = Object.entries(primaDocs);

  for (let i = 0; i < entries.length; i++) {
    const [pagePath, doc] = entries[i];

    console.log(`Compiling ${pagePath}... (${i + 1}/${entries.length})`);

    const contextParts = [];
    let hasContent = false;

    for (const filePath of doc.sourceFiles) {
      const content = readFileIfExists(filePath);
      if (content) {
        const filename = path.basename(filePath);
        contextParts.push(`\n--- ${filename} ---`);
        contextParts.push(content.length > 8000 ? content.slice(0, 8000) + '\n\n[... truncated ...]' : content);
        hasContent = true;
      } else {
        console.warn(`  [warn] Source file not found: ${filePath}`);
      }
    }

    if (!hasContent) {
      console.warn(`  [skip] No source files found for ${pagePath}`);
      continue;
    }

    const context = contextParts.join('\n');

    try {
      const compiled = await compile(KB_SYSTEM_PROMPT, context, doc.instruction);

      const frontmatter = `<!-- entity: ${doc.entityName} | type: project | updated: ${TODAY} -->`;
      const content = `${frontmatter}\n${compiled}`;

      writePage(chiefDb, pagePath, {
        title: doc.title,
        content,
        category: 'prima',
        entityType: 'project',
        entityName: doc.entityName,
      });

      pages.push({ path: pagePath, title: doc.title });
      await sleep(API_DELAY_MS);
    } catch (err) {
      console.error(`  [error] Failed to compile ${pagePath}: ${err.message}`);
    }
  }

  return pages;
}

// ─── Seed: Compliance ───────────────────────────────────────────────────────

async function seedCompliance(chiefDb) {
  console.log('\n=== Seeding Compliance ===\n');

  const cfiusPath = path.join(SCIENCE_DIR, 'CFIUS_Export_Control_Analysis.md');
  const cfiusContent = readFileIfExists(cfiusPath);

  if (!cfiusContent) {
    console.warn('  [skip] CFIUS doc not found, skipping compliance seed');
    return [];
  }

  const pagePath = 'compliance/cfius-export-controls.md';
  console.log(`Compiling ${pagePath}... (1/1)`);

  const pages = [];

  try {
    const compiled = await compile(
      KB_SYSTEM_PROMPT,
      cfiusContent.length > 8000 ? cfiusContent.slice(0, 8000) + '\n\n[... truncated ...]' : cfiusContent,
      'Compile a KB page about CFIUS and export control compliance. Cover: what regulations apply, key obligations, risk areas, current status, and action items a Chief of Staff should track.'
    );

    const frontmatter = `<!-- entity: cfius-export-controls | type: compliance | updated: ${TODAY} -->`;
    const content = `${frontmatter}\n${compiled}`;

    writePage(chiefDb, pagePath, {
      title: 'CFIUS & Export Control Compliance',
      content,
      category: 'compliance',
      entityType: 'compliance',
      entityName: 'cfius-export-controls',
    });

    pages.push({ path: pagePath, title: 'CFIUS & Export Control Compliance' });
    await sleep(API_DELAY_MS);
  } catch (err) {
    console.error(`  [error] Failed to compile ${pagePath}: ${err.message}`);
  }

  return pages;
}

// ─── Generate Index Pages ───────────────────────────────────────────────────

async function generateCategoryIndex(chiefDb, category, categoryPages, description) {
  if (categoryPages.length === 0) return;

  const pagePath = `${category}/_index.md`;
  console.log(`Generating ${pagePath}...`);

  const context = categoryPages.map(p => `- [${p.title}](${path.basename(p.path)})`).join('\n');

  try {
    const compiled = await compile(
      INDEX_SYSTEM_PROMPT,
      `Category: ${category}\nDescription: ${description}\n\nPages:\n${context}`,
      `Generate an index page for the "${category}" category with ${categoryPages.length} pages. List each page with a brief description.`
    );

    const frontmatter = `<!-- type: index | category: ${category} | updated: ${TODAY} -->`;
    const content = `${frontmatter}\n${compiled}`;

    writePage(chiefDb, pagePath, {
      title: `${category} — Index`,
      content,
      category,
    });

    await sleep(API_DELAY_MS);
  } catch (err) {
    console.error(`  [error] Failed to generate index for ${category}: ${err.message}`);
  }
}

async function generateMasterIndex(chiefDb, allCategories) {
  const pagePath = '_index.md';
  console.log(`\nGenerating master ${pagePath}...`);

  const contextParts = [];
  for (const [category, pages] of Object.entries(allCategories)) {
    if (pages.length === 0) continue;
    contextParts.push(`## ${category} (${pages.length} pages)`);
    for (const p of pages) {
      contextParts.push(`- [${p.title}](${p.path})`);
    }
    contextParts.push('');
  }

  try {
    const compiled = await compile(
      INDEX_SYSTEM_PROMPT,
      contextParts.join('\n'),
      'Generate a master index page for the entire knowledge base. Group by category, link to each category index, and provide a brief overview of what the KB covers.'
    );

    const frontmatter = `<!-- type: master-index | updated: ${TODAY} -->`;
    const content = `${frontmatter}\n${compiled}`;

    writePage(chiefDb, pagePath, {
      title: 'Knowledge Base — Master Index',
      content,
      category: null,
    });
  } catch (err) {
    console.error(`  [error] Failed to generate master index: ${err.message}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║   Chief of Staff — Knowledge Base Bootstrap   ║');
  console.log('╚═══════════════════════════════════════════════╝');
  console.log();
  console.log(`Chief DB:        ${CHIEF_DB_PATH}`);
  console.log(`Email-Intel DB:  ${EMAIL_INTEL_DB_PATH}`);
  console.log(`Science Docs:    ${SCIENCE_DIR}`);
  console.log(`KB Output:       ${KB_DIR}`);
  console.log(`Model:           ${SONNET_MODEL}`);
  console.log(`Date:            ${TODAY}`);
  console.log();

  // 1. Initialize
  initClaude();
  ensureDir(KB_DIR);

  const chiefDb = openChiefDb();
  const emailDb = openEmailIntelDb();

  // 2. Run migrations
  console.log('Running schema migrations...');
  runMigrations(chiefDb);
  console.log('Migrations complete.\n');

  const startTime = Date.now();

  // 3. Seed all categories
  const customerPages = await seedCustomers(chiefDb, emailDb);
  const peoplePages = await seedPeople(chiefDb, emailDb);
  const facilityPages = await seedFacility(chiefDb);
  const primaPages = await seedPrima(chiefDb);
  const compliancePages = await seedCompliance(chiefDb);

  const allCategories = {
    customers: customerPages,
    people: peoplePages,
    facility: facilityPages,
    prima: primaPages,
    compliance: compliancePages,
  };

  // 4. Generate category index pages
  console.log('\n=== Generating Index Pages ===\n');

  await generateCategoryIndex(chiefDb, 'customers', customerPages,
    'Customer profiles for Science Corporation MEMS foundry clients');
  await generateCategoryIndex(chiefDb, 'people', peoplePages,
    'Key people the CEO works with regularly');
  await generateCategoryIndex(chiefDb, 'facility', facilityPages,
    'Durham facility — Barn 1 and Phase 2 expansion');
  await generateCategoryIndex(chiefDb, 'prima', primaPages,
    'PRIMA medical device project — manufacturing and CM evaluation');
  await generateCategoryIndex(chiefDb, 'compliance', compliancePages,
    'Regulatory compliance — CFIUS, export controls');

  // 5. Generate master index
  await generateMasterIndex(chiefDb, allCategories);

  // 6. Cleanup
  if (emailDb) emailDb.close();
  chiefDb.close();

  // 7. Summary
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalPages = Object.values(allCategories).reduce((sum, p) => sum + p.length, 0);

  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('║              Bootstrap Complete                ║');
  console.log('╚═══════════════════════════════════════════════╝');
  console.log();
  console.log(`Pages compiled:  ${totalPages}`);
  console.log(`  customers:     ${customerPages.length}`);
  console.log(`  people:        ${peoplePages.length}`);
  console.log(`  facility:      ${facilityPages.length}`);
  console.log(`  prima:         ${primaPages.length}`);
  console.log(`  compliance:    ${compliancePages.length}`);
  console.log(`Index pages:     ${Object.values(allCategories).filter(p => p.length > 0).length + 1}`);
  console.log(`API calls:       ${totalApiCalls}`);
  console.log(`Est. cost:       $${totalCostUsd.toFixed(4)}`);
  console.log(`Elapsed:         ${elapsed}s`);
  console.log();
  console.log(`KB files:        ${KB_DIR}`);
  console.log(`SQLite DB:       ${CHIEF_DB_PATH}`);
  console.log();
}

main().catch(err => {
  console.error('\n[fatal]', err);
  process.exit(1);
});
