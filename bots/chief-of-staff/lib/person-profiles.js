/**
 * Person Profiles — CRUD, skeletal creation, stale tracking, KB page writing
 *
 * Source of truth: person_profiles table (structured).
 * KB page at people/{slug}.md is a rendered cache for human reading and brain tool access.
 * profile_compile writes both atomically — if they drift, the profile table wins.
 */
import { ensureDb } from './db.js';
import { writePage, readPage } from './kb.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ─── Create / Upsert ────────────────────────────────────────────────────

/**
 * Create a skeletal profile for a new contact.
 * Used during email_check when we encounter a contact without a profile.
 */
export function createSkeletal(ctx, { email, displayName, category, company }) {
  const db = ensureDb(ctx.config);
  const slug = slugify(displayName || email.split('@')[0]);

  const existing = db.prepare('SELECT email FROM person_profiles WHERE email = ?').get(email);
  if (existing) return getProfile(ctx, email);

  db.prepare(`
    INSERT INTO person_profiles (email, display_name, slug, category, company, stale, confidence)
    VALUES (?, ?, ?, ?, ?, 1, 0.3)
  `).run(email, displayName || email.split('@')[0], slug, category || null, company || null);

  return getProfile(ctx, email);
}

/**
 * Upsert a full profile (used by bootstrap and profile_compile).
 */
export function upsertProfile(ctx, profile) {
  const db = ensureDb(ctx.config);
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
  writeProfilePage(ctx, profile.email);

  return getProfile(ctx, profile.email);
}

// ─── Read ────────────────────────────────────────────────────────────────

export function getProfile(ctx, email) {
  const db = ensureDb(ctx.config);
  const row = db.prepare('SELECT * FROM person_profiles WHERE email = ?').get(email);
  if (!row) return null;
  return parseRow(row);
}

export function getProfileBySlug(ctx, slug) {
  const db = ensureDb(ctx.config);
  const row = db.prepare('SELECT * FROM person_profiles WHERE slug = ?').get(slug);
  if (!row) return null;
  return parseRow(row);
}

function parseRow(row) {
  return {
    ...row,
    topics: safeJsonParse(row.topics_json, []),
    openItems: safeJsonParse(row.open_items_json, []),
  };
}

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// ─── List / Query ────────────────────────────────────────────────────────

export function listProfiles(ctx, opts = {}) {
  const db = ensureDb(ctx.config);
  const { category, stale, limit = 100 } = opts;

  const conditions = [];
  const params = [];

  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }
  if (stale !== undefined) {
    conditions.push('stale = ?');
    params.push(stale ? 1 : 0);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit);

  return db.prepare(`
    SELECT * FROM person_profiles ${where}
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(...params).map(parseRow);
}

/**
 * Get stale profiles for incremental update.
 */
export function getStaleProfiles(ctx, limit = 3) {
  const db = ensureDb(ctx.config);
  return db.prepare(`
    SELECT * FROM person_profiles
    WHERE stale = 1
    ORDER BY updated_at ASC
    LIMIT ?
  `).all(limit).map(parseRow);
}

/**
 * Get profile count.
 */
export function getProfileCount(ctx) {
  const db = ensureDb(ctx.config);
  return db.prepare('SELECT COUNT(*) as c FROM person_profiles').get().c;
}

// ─── Update ──────────────────────────────────────────────────────────────

export function markStale(ctx, email) {
  const db = ensureDb(ctx.config);
  db.prepare('UPDATE person_profiles SET stale = 1 WHERE email = ?').run(email);
}

export function markFresh(ctx, email) {
  const db = ensureDb(ctx.config);
  db.prepare(
    "UPDATE person_profiles SET stale = 0, last_compiled_at = datetime('now'), updated_at = datetime('now') WHERE email = ?"
  ).run(email);
}

// ─── KB Page Writing ─────────────────────────────────────────────────────

/**
 * Write the KB page for a profile (rendered markdown cache).
 */
export function writeProfilePage(ctx, email) {
  const profile = getProfile(ctx, email);
  if (!profile) return;

  const slug = profile.slug;
  const pagePath = `people/${slug}.md`;

  const lines = [];
  lines.push(`# ${profile.display_name}`);
  lines.push('');
  lines.push(`- **Email:** ${profile.email}`);
  if (profile.role) lines.push(`- **Role:** ${profile.role}`);
  if (profile.company) lines.push(`- **Company:** ${profile.company}`);
  if (profile.category) lines.push(`- **Category:** ${profile.category}`);
  if (profile.relationship_to_mark) lines.push(`- **Relationship:** ${profile.relationship_to_mark}`);
  lines.push('');

  if (profile.formality_level || profile.response_cadence || profile.communication_notes) {
    lines.push('## Communication Style');
    if (profile.formality_level) lines.push(`- Formality: ${profile.formality_level}`);
    if (profile.response_cadence) lines.push(`- Response cadence: ${profile.response_cadence}`);
    if (profile.communication_notes) lines.push(`- Notes: ${profile.communication_notes}`);
    lines.push('');
  }

  const topics = profile.topics || [];
  if (topics.length > 0) {
    lines.push('## Topics');
    for (const t of topics) {
      lines.push(`- ${typeof t === 'string' ? t : t.name || JSON.stringify(t)}`);
    }
    lines.push('');
  }

  const openItems = profile.openItems || [];
  if (openItems.length > 0) {
    lines.push('## Open Items');
    for (const item of openItems) {
      lines.push(`- ${typeof item === 'string' ? item : item.description || JSON.stringify(item)}`);
    }
    lines.push('');
  }

  if (profile.last_interaction_summary) {
    lines.push('## Last Interaction');
    if (profile.last_interaction_date) lines.push(`_${profile.last_interaction_date}_`);
    lines.push(profile.last_interaction_summary);
    lines.push('');
  }

  lines.push(`---`);
  lines.push(`_Confidence: ${profile.confidence} | Last compiled: ${profile.last_compiled_at || 'never'}_`);

  const content = lines.join('\n');

  writePage(pagePath, {
    title: profile.display_name,
    content,
    category: 'people',
    entityType: 'person',
    entityName: profile.display_name,
  });
}
