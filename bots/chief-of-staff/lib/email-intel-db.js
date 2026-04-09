/**
 * Email Intel DB — read-only SQLite reader for the email-intel database
 *
 * Opens the email-intel DB in READONLY mode. Never writes.
 * Used by chief-of-staff tools to query emails, contacts, customers, and notes.
 *
 * DB path: EMAIL_INTEL_DB_PATH env var or default location.
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

const DEFAULT_DB_PATH = '/Users/Mark/Documents/dev/email-intel/data/email-intel.db';

// ─── Singleton ──────────────────────────────────────────────────────────────

let _db;
let _dbPath = process.env.EMAIL_INTEL_DB_PATH || DEFAULT_DB_PATH;

export function initEmailIntelDb(dbPath) {
  _dbPath = dbPath;
  _db = null; // force re-open on next access
}

function getDb() {
  if (_db) return _db;

  if (!existsSync(_dbPath)) {
    console.warn(`[email-intel-db] DB not found at ${_dbPath}`);
    return null;
  }

  try {
    _db = new Database(_dbPath, { readonly: true });
    _db.pragma('journal_mode = WAL');
    const cnt = _db.prepare('SELECT COUNT(*) as c FROM emails').get();
    console.log(`[email-intel-db] DB opened: ${cnt.c} emails at ${_dbPath}`);
  } catch (err) {
    console.warn(`[email-intel-db] Failed to open DB: ${err.message}`);
    return null;
  }

  return _db;
}

// ─── searchEmails ───────────────────────────────────────────────────────────

export function searchEmails(query, opts = {}) {
  const db = getDb();
  if (!db) return [];

  const { category, direction, limit = 50, offset = 0, since, until } = opts;

  const conditions = [];
  const params = [];

  // FTS5 match
  if (query) {
    conditions.push('e.id IN (SELECT rowid FROM emails_fts WHERE emails_fts MATCH ?)');
    params.push(query);
  }

  // Category comes from the contact's category via counterparty_address
  if (category) {
    conditions.push('c.category = ?');
    params.push(category);
  }

  if (direction) {
    // Map aliases: inbound→received, outbound→sent (DB stores received/sent)
    const dirMap = { inbound: 'received', outbound: 'sent' };
    const mapped = dirMap[direction.toLowerCase()] || direction;
    conditions.push('e.direction = ?');
    params.push(mapped);
  }

  if (since) {
    conditions.push('e.date >= ?');
    params.push(since);
  }

  if (until) {
    conditions.push('e.date <= ?');
    params.push(until);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT e.id, e.message_id, e.gmail_thread_id, e.subject,
           e.from_address, e.from_name, e.to_addresses, e.date,
           e.direction, e.has_attachments, e.counterparty_address,
           e.body_text,
           c.category
    FROM emails e
    LEFT JOIN contacts c ON e.counterparty_address = c.email_address
    ${where}
    ORDER BY e.date DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);

  try {
    return db.prepare(sql).all(...params);
  } catch (err) {
    console.warn(`[email-intel-db] searchEmails error: ${err.message}`);
    return [];
  }
}

// ─── getRecentEmails ────────────────────────────────────────────────────────

export function getRecentEmails(contactEmail, days = 30) {
  const db = getDb();
  if (!db) return [];

  const sql = `
    SELECT e.id, e.message_id, e.gmail_thread_id, e.subject,
           e.from_address, e.from_name, e.to_addresses, e.date,
           e.direction, e.has_attachments, e.counterparty_address,
           e.body_text
    FROM emails e
    WHERE (e.from_address = ? OR e.counterparty_address = ?)
      AND e.date >= datetime('now', ?)
    ORDER BY e.date DESC
  `;

  try {
    return db.prepare(sql).all(contactEmail, contactEmail, `-${days} days`);
  } catch (err) {
    console.warn(`[email-intel-db] getRecentEmails error: ${err.message}`);
    return [];
  }
}

// ─── getThread ──────────────────────────────────────────────────────────────

export function getThread(threadId) {
  const db = getDb();
  if (!db) return [];

  const sql = `
    SELECT e.id, e.message_id, e.gmail_thread_id, e.subject,
           e.from_address, e.from_name, e.to_addresses, e.date,
           e.direction, e.body_text, e.has_attachments, e.counterparty_address,
           c.category
    FROM emails e
    LEFT JOIN contacts c ON e.counterparty_address = c.email_address
    WHERE e.gmail_thread_id = ?
    ORDER BY e.date ASC
  `;

  try {
    return db.prepare(sql).all(threadId);
  } catch (err) {
    console.warn(`[email-intel-db] getThread error: ${err.message}`);
    return [];
  }
}

// ─── getEmailByMessageId ─────────────────────────────────────────────────────

export function getEmailByMessageId(messageId) {
  const db = getDb();
  if (!db || !messageId) return null;

  try {
    return db.prepare(`
      SELECT e.id, e.message_id, e.gmail_thread_id, e.subject,
             e.from_address, e.from_name, e.to_addresses, e.date,
             e.direction, e.body_text, e.has_attachments, e.counterparty_address,
             c.category
      FROM emails e
      LEFT JOIN contacts c ON e.counterparty_address = c.email_address
      WHERE e.message_id = ?
    `).get(messageId) || null;
  } catch (err) {
    console.warn(`[email-intel-db] getEmailByMessageId error: ${err.message}`);
    return null;
  }
}

// ─── getThreadBySubject ──────────────────────────────────────────────────────

export function getThreadBySubject(subject, counterpartyEmail, days = 14) {
  const db = getDb();
  if (!db || !subject) return [];

  // Recursive prefix stripping (handles "Re: Fwd: Re: Subject")
  let baseSubject = subject;
  let prev;
  do {
    prev = baseSubject;
    baseSubject = baseSubject.replace(/^(Re|Fwd|Fw):\s*/i, '');
  } while (baseSubject !== prev);
  baseSubject = baseSubject.trim();
  if (!baseSubject || baseSubject.length < 3) return [];

  try {
    // Use INSTR instead of LIKE to avoid SQL wildcard injection
    return db.prepare(`
      SELECT e.id, e.message_id, e.gmail_thread_id, e.subject,
             e.from_address, e.from_name, e.to_addresses, e.date,
             e.direction, e.body_text, e.has_attachments, e.counterparty_address,
             c.category
      FROM emails e
      LEFT JOIN contacts c ON e.counterparty_address = c.email_address
      WHERE INSTR(LOWER(e.subject), LOWER(?)) > 0
        AND (LOWER(e.from_address) = LOWER(?) OR LOWER(e.counterparty_address) = LOWER(?))
        AND e.date >= datetime('now', ?)
      ORDER BY e.date ASC
    `).all(baseSubject, counterpartyEmail, counterpartyEmail, `-${days} days`);
  } catch (err) {
    console.warn(`[email-intel-db] getThreadBySubject error: ${err.message}`);
    return [];
  }
}

// ─── hasReplyAfter ───────────────────────────────────────────────────────────

/**
 * Check if the most recent email with a counterparty is outbound (Mark replied).
 * Used by queue maintenance to detect already-replied queue entries.
 */
export function hasOutboundReply(counterpartyAddress) {
  const db = getDb();
  if (!db || !counterpartyAddress) return false;

  try {
    const row = db.prepare(`
      SELECT direction FROM emails
      WHERE counterparty_address = ? COLLATE NOCASE
      ORDER BY date DESC
      LIMIT 1
    `).get(counterpartyAddress);
    return row?.direction === 'sent';
  } catch (err) {
    console.warn(`[email-intel-db] hasOutboundReply error: ${err.message}`);
    return false;
  }
}

// ─── getContactHistory ──────────────────────────────────────────────────────

export function getContactHistory(email) {
  const db = getDb();
  if (!db) return null;

  try {
    const contact = db.prepare(
      'SELECT * FROM contacts WHERE email_address = ?'
    ).get(email);

    if (!contact) return null;

    const recentEmails = db.prepare(`
      SELECT e.id, e.subject, e.from_address, e.to_addresses, e.date,
             e.direction, e.has_attachments
      FROM emails e
      WHERE e.from_address = ? OR e.counterparty_address = ?
      ORDER BY e.date DESC
      LIMIT 20
    `).all(email, email);

    // Find customer association via mems_customer_contacts
    const customer = db.prepare(`
      SELECT mc.*
      FROM mems_customers mc
      JOIN mems_customer_contacts mcc ON mcc.customer_id = mc.id
      WHERE mcc.email = ?
      LIMIT 1
    `).get(email);

    return { contact, recentEmails, customer: customer || null };
  } catch (err) {
    console.warn(`[email-intel-db] getContactHistory error: ${err.message}`);
    return null;
  }
}

// ─── getContact ─────────────────────────────────────────────────────────────

export function getContact(email) {
  const db = getDb();
  if (!db) return null;

  try {
    return db.prepare('SELECT * FROM contacts WHERE email_address = ?').get(email) || null;
  } catch (err) {
    console.warn(`[email-intel-db] getContact error: ${err.message}`);
    return null;
  }
}

// ─── listContacts ───────────────────────────────────────────────────────────

export function listContacts(opts = {}) {
  const db = getDb();
  if (!db) return [];

  const { category, minCount, limit = 100 } = opts;

  const conditions = ['hidden = 0'];
  const params = [];

  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }

  if (minCount) {
    conditions.push('email_count >= ?');
    params.push(minCount);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT * FROM contacts
    ${where}
    ORDER BY email_count DESC
    LIMIT ?
  `;
  params.push(limit);

  try {
    return db.prepare(sql).all(...params);
  } catch (err) {
    console.warn(`[email-intel-db] listContacts error: ${err.message}`);
    return [];
  }
}

// ─── getCustomer ────────────────────────────────────────────────────────────

export function getCustomer(nameOrDomain) {
  const db = getDb();
  if (!db) return null;

  try {
    // Try exact name match first, then domain, then LIKE
    let customer = db.prepare(
      'SELECT * FROM mems_customers WHERE name = ? COLLATE NOCASE'
    ).get(nameOrDomain);

    if (!customer) {
      customer = db.prepare(
        'SELECT * FROM mems_customers WHERE domain = ? COLLATE NOCASE'
      ).get(nameOrDomain);
    }

    if (!customer) {
      customer = db.prepare(
        'SELECT * FROM mems_customers WHERE name LIKE ? COLLATE NOCASE'
      ).get(`%${nameOrDomain}%`);
    }

    if (!customer) return null;

    const contacts = db.prepare(
      'SELECT * FROM mems_customer_contacts WHERE customer_id = ? ORDER BY is_primary DESC'
    ).all(customer.id);

    const revenue = db.prepare(
      'SELECT * FROM mems_customer_revenue WHERE customer_id = ? ORDER BY year DESC, month DESC'
    ).all(customer.id);

    return { ...customer, contacts, revenue };
  } catch (err) {
    console.warn(`[email-intel-db] getCustomer error: ${err.message}`);
    return null;
  }
}

// ─── listCustomers ──────────────────────────────────────────────────────────

export function listCustomers(opts = {}) {
  const db = getDb();
  if (!db) return [];

  const { tier, status } = opts;

  const conditions = [];
  const params = [];

  if (tier != null) {
    conditions.push('tier = ?');
    params.push(tier);
  }

  if (status) {
    conditions.push('customer_status = ?');
    params.push(status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const sql = `
    SELECT id, name, domain, customer_type, customer_status, tier,
           relationship_health, primary_contact_name, primary_contact_email,
           primary_technology, annual_revenue_current, next_follow_up_date
    FROM mems_customers
    ${where}
    ORDER BY name ASC
  `;

  try {
    return db.prepare(sql).all(...params);
  } catch (err) {
    console.warn(`[email-intel-db] listCustomers error: ${err.message}`);
    return [];
  }
}

// ─── getStats ───────────────────────────────────────────────────────────────

export function getStats() {
  const db = getDb();
  if (!db) {
    return {
      totalEmails: 0, totalContacts: 0, categoryCounts: [],
      directionCounts: [], lastSync: null,
    };
  }

  try {
    const totalEmails = db.prepare('SELECT COUNT(*) as count FROM emails').get().count;
    const totalContacts = db.prepare('SELECT COUNT(*) as count FROM contacts WHERE hidden = 0').get().count;

    const categoryCounts = db.prepare(`
      SELECT c.category, COUNT(*) as count
      FROM emails e
      JOIN contacts c ON e.counterparty_address = c.email_address
      WHERE c.category IS NOT NULL
      GROUP BY c.category
      ORDER BY count DESC
    `).all();

    const directionCounts = db.prepare(`
      SELECT direction, COUNT(*) as count
      FROM emails
      GROUP BY direction
    `).all();

    const lastSyncRow = db.prepare(
      "SELECT value FROM sync_state WHERE key = 'last_sync'"
    ).get();

    return {
      totalEmails,
      totalContacts,
      categoryCounts,
      directionCounts,
      lastSync: lastSyncRow?.value || null,
    };
  } catch (err) {
    console.warn(`[email-intel-db] getStats error: ${err.message}`);
    return {
      totalEmails: 0, totalContacts: 0, categoryCounts: [],
      directionCounts: [], lastSync: null,
    };
  }
}

// ─── getRecentActivity ──────────────────────────────────────────────────────

export function getRecentActivity(hours = 24) {
  const db = getDb();
  if (!db) return [];

  const sql = `
    SELECT e.id, e.message_id, e.gmail_thread_id, e.subject,
           e.from_address, e.from_name, e.to_addresses, e.date,
           e.direction, e.has_attachments, e.counterparty_address,
           c.category
    FROM emails e
    LEFT JOIN contacts c ON e.counterparty_address = c.email_address
    WHERE e.date >= datetime('now', ?)
    ORDER BY e.date DESC
  `;

  try {
    return db.prepare(sql).all(`-${hours} hours`);
  } catch (err) {
    console.warn(`[email-intel-db] getRecentActivity error: ${err.message}`);
    return [];
  }
}

// ─── getEmailBodyById ─────────────────────────────────────────────────────

export function getEmailBodyById(emailId) {
  const db = getDb();
  if (!db) return null;

  try {
    const row = db.prepare('SELECT body_text FROM emails WHERE id = ?').get(emailId);
    return row?.body_text || null;
  } catch (err) {
    console.warn(`[email-intel-db] getEmailBodyById error: ${err.message}`);
    return null;
  }
}

// ─── getNotes ───────────────────────────────────────────────────────────────

export function getNotes(opts = {}) {
  const db = getDb();
  if (!db) return [];

  const { contactEmail, project, limit = 20 } = opts;

  if (contactEmail) {
    const sql = `
      SELECT n.*
      FROM notes n
      JOIN note_contacts nc ON nc.note_id = n.id
      WHERE nc.email_address = ?
      ORDER BY n.date DESC
      LIMIT ?
    `;
    try {
      return db.prepare(sql).all(contactEmail, limit);
    } catch (err) {
      console.warn(`[email-intel-db] getNotes error: ${err.message}`);
      return [];
    }
  }

  if (project) {
    const sql = `
      SELECT n.*
      FROM notes n
      JOIN note_projects np ON np.note_id = n.id
      WHERE np.project_slug = ?
      ORDER BY n.date DESC
      LIMIT ?
    `;
    try {
      return db.prepare(sql).all(project, limit);
    } catch (err) {
      console.warn(`[email-intel-db] getNotes error: ${err.message}`);
      return [];
    }
  }

  // No filter — return most recent
  try {
    return db.prepare('SELECT * FROM notes ORDER BY date DESC LIMIT ?').all(limit);
  } catch (err) {
    console.warn(`[email-intel-db] getNotes error: ${err.message}`);
    return [];
  }
}

// ─── getAllEmailsForContact ──────────────────────────────────────────────────

/**
 * Get ALL emails exchanged with a contact (for full profile bootstrap).
 * Returns emails in chronological order. Use with caution — can be large.
 */
export function getAllEmailsForContact(email, limit = 500) {
  const db = getDb();
  if (!db) return [];

  const sql = `
    SELECT e.id, e.message_id, e.gmail_thread_id, e.subject,
           e.from_address, e.from_name, e.to_addresses, e.date,
           e.direction, e.body_text, e.has_attachments, e.counterparty_address
    FROM emails e
    WHERE e.from_address = ? OR e.counterparty_address = ?
    ORDER BY e.date ASC
    LIMIT ?
  `;

  try {
    return db.prepare(sql).all(email, email, limit);
  } catch (err) {
    console.warn(`[email-intel-db] getAllEmailsForContact error: ${err.message}`);
    return [];
  }
}

// ─── getContactsWithMinEmails ───────────────────────────────────────────────

/**
 * Get all unhidden contacts with at least minCount emails.
 * Used by bootstrap-profiles to find contacts worth profiling.
 */
export function getContactsWithMinEmails(minCount = 3) {
  const db = getDb();
  if (!db) return [];

  try {
    return db.prepare(`
      SELECT c.*, mc.name as customer_name, mc.tier as customer_tier,
             mc.customer_status, mc.primary_technology, mc.annual_revenue_current
      FROM contacts c
      LEFT JOIN mems_customer_contacts mcc ON mcc.email = c.email_address
      LEFT JOIN mems_customers mc ON mc.id = mcc.customer_id
      WHERE c.hidden = 0 AND c.email_count >= ?
      ORDER BY c.email_count DESC
    `).all(minCount);
  } catch (err) {
    console.warn(`[email-intel-db] getContactsWithMinEmails error: ${err.message}`);
    return [];
  }
}

// ─── getConstructionStatus ─────────────────────────────────────────────────

/**
 * Gather construction-related data from email-intel for the construction sync.
 * Returns: submittals/RFIs from Procore tables (if they exist), construction emails, notes.
 */
export function getConstructionStatus(days = 14) {
  const db = getDb();
  if (!db) return { emails: [], notes: [], milestones: [] };

  const result = { emails: [], notes: [], milestones: [] };

  // Construction category emails
  try {
    result.emails = db.prepare(`
      SELECT e.id, e.message_id, e.gmail_thread_id, e.subject,
             e.from_address, e.from_name, e.to_addresses, e.date,
             e.direction, e.body_text, e.counterparty_address
      FROM emails e
      JOIN contacts c ON e.counterparty_address = c.email_address
      WHERE c.category = 'construction'
        AND e.date >= datetime('now', ?)
      ORDER BY e.date DESC
    `).all(`-${days} days`);
  } catch (err) {
    console.warn(`[email-intel-db] getConstructionStatus emails error: ${err.message}`);
  }

  // Construction-linked notes
  try {
    result.notes = db.prepare(`
      SELECT DISTINCT n.*
      FROM notes n
      JOIN note_contacts nc ON nc.note_id = n.id
      JOIN contacts c ON c.email_address = nc.email_address
      WHERE c.category = 'construction'
        AND n.date >= datetime('now', ?)
      ORDER BY n.date DESC
      LIMIT 20
    `).all(`-${days} days`);
  } catch (err) {
    console.warn(`[email-intel-db] getConstructionStatus notes error: ${err.message}`);
  }

  // Schedule milestones (if table exists)
  try {
    result.milestones = db.prepare(`
      SELECT * FROM schedule_milestones
      WHERE status != 'completed'
      ORDER BY
        CASE WHEN is_critical_path = 1 THEN 0 ELSE 1 END,
        end_date ASC
    `).all();
  } catch {
    // Table may not exist yet
  }

  return result;
}

// ─── getActionableEmails ─────────────────────────────────────────────────────

export function getActionableEmails(hours = 168) {
  const db = getDb();
  if (!db) return [];

  const sql = `
    SELECT e.id, e.message_id, e.gmail_thread_id, e.subject,
           e.from_address, e.from_name, e.to_addresses, e.date,
           e.direction, e.has_attachments, e.counterparty_address,
           c.category,
           CASE WHEN EXISTS (
             SELECT 1 FROM emails e2
             WHERE e2.direction = 'sent'
               AND e2.counterparty_address = e.counterparty_address
               AND e2.date > e.date
           ) THEN 1 ELSE 0 END AS has_reply
    FROM emails e
    LEFT JOIN contacts c ON e.counterparty_address = c.email_address
    WHERE e.direction = 'received'
      AND e.date >= datetime('now', ?)
      AND e.from_address NOT LIKE 'no-reply@%'
      AND e.from_address NOT LIKE 'noreply@%'
      AND e.from_address NOT LIKE 'notifications@%'
      AND e.from_address NOT LIKE '%@calendar.google.com'
    ORDER BY has_reply ASC, e.date DESC
  `;

  try {
    return db.prepare(sql).all(`-${hours} hours`);
  } catch (err) {
    console.warn(`[email-intel-db] getActionableEmails error: ${err.message}`);
    return [];
  }
}

// ─── getDiagnostics ──────────────────────────────────────────────────────────

export function getDiagnostics() {
  const result = {
    dbPath: _dbPath,
    connected: false,
    totalEmails: 0,
    totalContacts: 0,
    dateRange: { earliest: null, latest: null },
    directionValues: [],
    categories: [],
    lastSync: null,
    error: null,
  };

  const db = getDb();
  if (!db) {
    result.error = `DB not found or failed to open at ${_dbPath}`;
    return result;
  }

  try {
    result.connected = true;
    result.totalEmails = db.prepare('SELECT COUNT(*) as c FROM emails').get().c;
    result.totalContacts = db.prepare('SELECT COUNT(*) as c FROM contacts WHERE hidden = 0').get().c;

    const earliest = db.prepare('SELECT MIN(date) as d FROM emails').get();
    const latest = db.prepare('SELECT MAX(date) as d FROM emails').get();
    result.dateRange = { earliest: earliest?.d || null, latest: latest?.d || null };

    result.directionValues = db.prepare(
      'SELECT direction, COUNT(*) as count FROM emails GROUP BY direction'
    ).all();

    try {
      result.categories = db.prepare(`
        SELECT c.category, COUNT(*) as count
        FROM emails e
        JOIN contacts c ON e.counterparty_address = c.email_address
        WHERE c.category IS NOT NULL
        GROUP BY c.category
        ORDER BY count DESC
      `).all();
    } catch { /* categories table may not exist */ }

    try {
      const syncRow = db.prepare("SELECT value FROM sync_state WHERE key = 'last_sync'").get();
      result.lastSync = syncRow?.value || null;
    } catch { /* sync_state table may not exist */ }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}
