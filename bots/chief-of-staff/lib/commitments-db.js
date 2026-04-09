/**
 * Commitment tracking — CRUD + queries for the commitments table
 *
 * Commitment types:
 *   P1  Deliverable promise (Mark owes someone a deliverable)
 *   P3  Response owed (someone asked Mark a question, no reply yet)
 *   W2  Waiting for response (Mark sent something, waiting for reply)
 *   W3  Delegated task (Mark assigned something to someone)
 */
import crypto from 'node:crypto';
import { ensureDb } from './db.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function now() {
  return new Date().toISOString();
}

function today() {
  return now().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function endOfWeek() {
  const d = new Date();
  const dayOfWeek = d.getDay(); // 0=Sun
  const daysUntilSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
  d.setDate(d.getDate() + daysUntilSunday);
  return d.toISOString().slice(0, 10);
}

/** Follow-up cadence: 1st +2d, 2nd +5d, 3rd+ +7d */
function nextFollowupOffset(followupCount) {
  if (followupCount <= 0) return 2;
  if (followupCount === 1) return 5;
  return 7;
}

/**
 * Calculate the initial next_followup_date for a new commitment.
 * If due_date exists: due_date - 1 day.
 * Otherwise: created_at + 3 days.
 */
function initialFollowupDate(dueDate, createdAt) {
  if (dueDate) {
    return addDays(dueDate, -1);
  }
  return addDays(createdAt.slice(0, 10), 3);
}

// ─── Create ─────────────────────────────────────────────────────────────────

export function createCommitment(ctx, {
  type,
  bearer,
  counterparty,
  description,
  dueDate,
  sourceType,
  sourceRef,
  customer,
  project,
  priority,
  confidence,
  sourceSnippet,
  conditionText,
  parentId,
  dependsOn,
}) {
  const db = ensureDb(ctx.config);
  const id = crypto.randomUUID();
  const createdAt = now();
  const nextFollowupDate = initialFollowupDate(dueDate || null, createdAt);

  db.prepare(`
    INSERT INTO commitments (
      id, type, bearer, counterparty, description, condition_text,
      source_snippet, due_date, created_at, status, source_type, source_ref,
      customer, project, priority, confidence, next_followup_date,
      parent_id, depends_on
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, 'active', ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?
    )
  `).run(
    id, type, bearer, counterparty, description, conditionText || null,
    sourceSnippet || null, dueDate || null, createdAt, sourceType || null, sourceRef || null,
    customer || null, project || null, priority || 'normal', confidence ?? 1.0, nextFollowupDate,
    parentId || null, dependsOn || null,
  );

  addEvent(ctx, id, 'created', description);

  return getCommitment(ctx, id);
}

// ─── Update ─────────────────────────────────────────────────────────────────

const UPDATABLE_FIELDS = new Map([
  ['type', 'type'],
  ['bearer', 'bearer'],
  ['counterparty', 'counterparty'],
  ['description', 'description'],
  ['conditionText', 'condition_text'],
  ['sourceSnippet', 'source_snippet'],
  ['dueDate', 'due_date'],
  ['status', 'status'],
  ['blockerId', 'blocker_id'],
  ['sourceType', 'source_type'],
  ['sourceRef', 'source_ref'],
  ['customer', 'customer'],
  ['project', 'project'],
  ['priority', 'priority'],
  ['nextFollowupDate', 'next_followup_date'],
  ['parentId', 'parent_id'],
  ['dependsOn', 'depends_on'],
  ['confidence', 'confidence'],
]);

export function updateCommitment(ctx, id, updates) {
  const db = ensureDb(ctx.config);

  const sets = [];
  const values = [];

  for (const [jsKey, colName] of UPDATABLE_FIELDS) {
    if (jsKey in updates) {
      sets.push(`${colName} = ?`);
      values.push(updates[jsKey] ?? null);
    }
  }

  if (sets.length === 0) return getCommitment(ctx, id);

  values.push(id);
  db.prepare(`UPDATE commitments SET ${sets.join(', ')} WHERE id = ?`).run(...values);

  if ('status' in updates) {
    addEvent(ctx, id, 'status_changed', `Status changed to ${updates.status}`);
  }

  return getCommitment(ctx, id);
}

// ─── Fulfill / Cancel ───────────────────────────────────────────────────────

export function fulfillCommitment(ctx, id, note) {
  const db = ensureDb(ctx.config);
  const ts = now();

  db.prepare(`
    UPDATE commitments SET status = 'fulfilled', fulfilled_at = ? WHERE id = ?
  `).run(ts, id);

  addEvent(ctx, id, 'status_changed', note || 'Fulfilled');
  return getCommitment(ctx, id);
}

export function cancelCommitment(ctx, id, reason) {
  const db = ensureDb(ctx.config);

  db.prepare(`UPDATE commitments SET status = 'cancelled' WHERE id = ?`).run(id);

  addEvent(ctx, id, 'status_changed', reason || 'Cancelled');
  return getCommitment(ctx, id);
}

// ─── Read ───────────────────────────────────────────────────────────────────

export function getCommitment(ctx, id) {
  const db = ensureDb(ctx.config);

  const commitment = db.prepare('SELECT * FROM commitments WHERE id = ?').get(id);
  if (!commitment) return null;

  const events = db.prepare(
    'SELECT * FROM commitment_events WHERE commitment_id = ? ORDER BY created_at ASC'
  ).all(id);

  return { ...commitment, events };
}

// ─── List (filtered) ────────────────────────────────────────────────────────

export function listCommitments(ctx, opts = {}) {
  const db = ensureDb(ctx.config);

  const {
    status, type, bearer, counterparty,
    customer, project, priority,
    dueBefore, dueAfter, limit,
  } = opts;

  const conditions = [];
  const params = [];

  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }
  if (type) {
    conditions.push('type = ?');
    params.push(type);
  }
  if (bearer) {
    conditions.push('bearer = ?');
    params.push(bearer);
  }
  if (counterparty) {
    conditions.push('counterparty = ?');
    params.push(counterparty);
  }
  if (customer) {
    conditions.push('customer = ?');
    params.push(customer);
  }
  if (project) {
    conditions.push('project = ?');
    params.push(project);
  }
  if (priority) {
    conditions.push('priority = ?');
    params.push(priority);
  }
  if (dueBefore) {
    conditions.push('due_date <= ?');
    params.push(dueBefore);
  }
  if (dueAfter) {
    conditions.push('due_date >= ?');
    params.push(dueAfter);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitClause = limit ? `LIMIT ${Number(limit)}` : '';

  return db.prepare(`
    SELECT * FROM commitments ${where}
    ORDER BY
      CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
      due_date ASC NULLS LAST,
      created_at DESC
    ${limitClause}
  `).all(...params);
}

// ─── Overdue / Due Today / Due This Week ────────────────────────────────────

export function getOverdue(ctx) {
  const db = ensureDb(ctx.config);
  return db.prepare(`
    SELECT * FROM commitments
    WHERE status = 'active' AND due_date < ?
    ORDER BY due_date ASC
  `).all(today());
}

export function getDueToday(ctx) {
  const db = ensureDb(ctx.config);
  return db.prepare(`
    SELECT * FROM commitments
    WHERE status = 'active' AND due_date = ?
    ORDER BY
      CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END
  `).all(today());
}

export function getDueThisWeek(ctx) {
  const db = ensureDb(ctx.config);
  const t = today();
  const eow = endOfWeek();
  return db.prepare(`
    SELECT * FROM commitments
    WHERE status = 'active' AND due_date >= ? AND due_date <= ?
    ORDER BY due_date ASC,
      CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END
  `).all(t, eow);
}

// ─── By Customer / By Person ────────────────────────────────────────────────

export function getByCustomer(ctx, customer) {
  const db = ensureDb(ctx.config);
  return db.prepare(`
    SELECT * FROM commitments
    WHERE customer = ?
    ORDER BY status ASC, due_date ASC NULLS LAST, created_at DESC
  `).all(customer);
}

export function getByPerson(ctx, person) {
  const db = ensureDb(ctx.config);
  return db.prepare(`
    SELECT * FROM commitments
    WHERE bearer = ? OR counterparty = ?
    ORDER BY status ASC, due_date ASC NULLS LAST, created_at DESC
  `).all(person, person);
}

// ─── Blocking / Needing Follow-up ───────────────────────────────────────────

export function getBlocking(ctx) {
  const db = ensureDb(ctx.config);
  return db.prepare(`
    SELECT DISTINCT b.* FROM commitments b
    JOIN commitments c ON c.blocker_id = b.id
    WHERE b.status = 'active'
    ORDER BY b.due_date ASC NULLS LAST
  `).all();
}

export function getNeedingFollowup(ctx) {
  const db = ensureDb(ctx.config);
  return db.prepare(`
    SELECT * FROM commitments
    WHERE status = 'active' AND next_followup_date <= ?
    ORDER BY next_followup_date ASC
  `).all(today());
}

// ─── Record Follow-up ──────────────────────────────────────────────────────

export function recordFollowup(ctx, id) {
  const db = ensureDb(ctx.config);

  const commitment = db.prepare('SELECT * FROM commitments WHERE id = ?').get(id);
  if (!commitment) return null;

  const ts = now();
  const newCount = (commitment.followup_count || 0) + 1;
  const offset = nextFollowupOffset(newCount);
  const nextDate = addDays(today(), offset);

  db.prepare(`
    UPDATE commitments
    SET followup_count = ?, last_followup_at = ?, next_followup_date = ?
    WHERE id = ?
  `).run(newCount, ts, nextDate, id);

  addEvent(ctx, id, 'followup_sent', `Follow-up #${newCount} sent. Next: ${nextDate}`);

  return getCommitment(ctx, id);
}

// ─── Events ─────────────────────────────────────────────────────────────────

export function getCommitmentEvents(ctx, commitmentId) {
  const db = ensureDb(ctx.config);
  return db.prepare(
    'SELECT * FROM commitment_events WHERE commitment_id = ? ORDER BY created_at ASC'
  ).all(commitmentId);
}

export function addEvent(ctx, commitmentId, eventType, detail) {
  const db = ensureDb(ctx.config);
  const id = crypto.randomUUID();

  db.prepare(`
    INSERT INTO commitment_events (id, commitment_id, event_type, detail, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, commitmentId, eventType, detail || null, now());

  return id;
}

// ─── Stats ──────────────────────────────────────────────────────────────────

export function getStats(ctx) {
  const db = ensureDb(ctx.config);

  const totalActive = db.prepare(
    "SELECT COUNT(*) as count FROM commitments WHERE status = 'active'"
  ).get().count;

  const overdue = db.prepare(
    "SELECT COUNT(*) as count FROM commitments WHERE status = 'active' AND due_date < ?"
  ).get(today()).count;

  // Fulfilled this week (Monday through Sunday)
  const d = new Date();
  const dayOfWeek = d.getDay(); // 0=Sun
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(d);
  monday.setDate(d.getDate() + mondayOffset);
  const weekStart = monday.toISOString().slice(0, 10);

  const fulfilledThisWeek = db.prepare(
    "SELECT COUNT(*) as count FROM commitments WHERE status = 'fulfilled' AND fulfilled_at >= ?"
  ).get(weekStart).count;

  const byType = db.prepare(`
    SELECT type, COUNT(*) as count FROM commitments
    WHERE status = 'active'
    GROUP BY type
    ORDER BY type
  `).all();

  return {
    totalActive,
    overdue,
    fulfilledThisWeek,
    byType,
  };
}
