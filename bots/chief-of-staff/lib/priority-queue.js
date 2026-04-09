/**
 * Priority Queue — CRUD, deterministic scoring, and lifecycle management
 *
 * Queue entries represent emails needing Mark's attention, ranked by priority score.
 * Status flow: pending → draft_ready → presented → acted | expired | superseded
 */
import crypto from 'node:crypto';
import { ensureDb } from './db.js';
import { getByPerson } from './commitments-db.js';

// Status sets for queries
export const ACTIVE_STATUSES = ['pending', 'draft_ready', 'presented'];
export const MUTABLE_STATUSES = ['pending', 'draft_ready'];

// ─── Priority Scoring (deterministic, no LLM) ────────────────────────────

/**
 * Calculate priority score for a queue entry.
 *
 * @param {object} opts
 * @param {string}  [opts.contactCategory]
 * @param {number}  [opts.customerTier]
 * @param {string}  [opts.urgency]        - 'high' | 'normal'
 * @param {boolean} [opts.hasCommitments]
 * @param {boolean} [opts.hasOverdueCommitment]
 * @param {number}  [opts.emailAgeHours]
 * @returns {{ score: number, factors: object }}
 */
export function calculateScore(opts = {}) {
  const factors = {};
  let score = 0.30;
  factors.base = 0.30;

  if (opts.customerTier === 1) {
    score += 0.25;
    factors.tier1_customer = 0.25;
  } else if (opts.customerTier === 2) {
    score += 0.15;
    factors.tier2_customer = 0.15;
  }

  if (opts.contactCategory === 'customer') {
    score += 0.15;
    factors.customer_category = 0.15;
  } else if (opts.contactCategory === 'construction') {
    score += 0.10;
    factors.construction_category = 0.10;
  }

  if (opts.urgency === 'high') {
    score += 0.15;
    factors.high_urgency = 0.15;
  }

  if (opts.hasCommitments) {
    score += 0.10;
    factors.active_commitments = 0.10;
  }

  if (opts.hasOverdueCommitment) {
    score += 0.10;
    factors.overdue_commitment = 0.10;
  }

  const ageH = opts.emailAgeHours || 0;
  if (ageH > 72) {
    score += 0.10;
    factors.age_72h = 0.10;
  } else if (ageH > 48) {
    score += 0.05;
    factors.age_48h = 0.05;
  }

  score = Math.min(score, 1.0);
  return { score: Math.round(score * 1000) / 1000, factors };
}

// ─── Insert ───────────────────────────────────────────────────────────────

/**
 * Insert or update a queue entry.
 *
 * @param {object} ctx
 * @param {object} entry
 * @returns {object} The inserted/updated row
 */
export function upsertQueueEntry(ctx, entry) {
  const db = ensureDb(ctx.config);
  const id = entry.id || crypto.randomUUID();

  db.prepare(`
    INSERT INTO priority_queue (
      id, message_id, thread_id, from_address, from_name, subject,
      contact_category, customer_name, customer_tier,
      priority_score, priority_factors, status, summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      thread_id = COALESCE(excluded.thread_id, priority_queue.thread_id),
      priority_score = excluded.priority_score,
      priority_factors = excluded.priority_factors,
      summary = excluded.summary,
      contact_category = excluded.contact_category,
      customer_name = excluded.customer_name,
      customer_tier = excluded.customer_tier
  `).run(
    id,
    entry.messageId,
    entry.threadId || null,
    entry.fromAddress,
    entry.fromName || null,
    entry.subject || null,
    entry.contactCategory || null,
    entry.customerName || null,
    entry.customerTier ?? null,
    entry.priorityScore,
    JSON.stringify(entry.priorityFactors || {}),
    entry.status || 'pending',
    entry.summary || null,
  );

  return getByMessageId(ctx, entry.messageId);
}

// ─── Read ─────────────────────────────────────────────────────────────────

export function getQueueEntry(ctx, id) {
  const db = ensureDb(ctx.config);
  return db.prepare('SELECT * FROM priority_queue WHERE id = ?').get(id) || null;
}

export function getByMessageId(ctx, messageId) {
  const db = ensureDb(ctx.config);
  return db.prepare('SELECT * FROM priority_queue WHERE message_id = ?').get(messageId) || null;
}

export function getByThreadId(ctx, threadId) {
  const db = ensureDb(ctx.config);
  return db.prepare(
    "SELECT * FROM priority_queue WHERE thread_id = ? AND status IN ('pending', 'draft_ready', 'presented') ORDER BY priority_score DESC LIMIT 1"
  ).get(threadId) || null;
}

/**
 * Check if any entry for this thread was previously dismissed.
 * Prevents re-queueing emails in threads Mark already dealt with.
 */
export function isThreadDismissed(ctx, threadId) {
  if (!threadId) return false;
  const db = ensureDb(ctx.config);
  const row = db.prepare(
    "SELECT id FROM priority_queue WHERE thread_id = ? AND status = 'dismissed' LIMIT 1"
  ).get(threadId);
  return !!row;
}

/**
 * List queue entries by status, ordered by priority score desc.
 *
 * @param {object} ctx
 * @param {object} [opts]
 * @param {string|string[]} [opts.status] - Status filter(s), default 'pending'+'draft_ready'
 * @param {number} [opts.limit]
 * @returns {Array}
 */
export function listQueue(ctx, opts = {}) {
  const db = ensureDb(ctx.config);
  const limit = opts.limit || 25;

  let statuses = opts.status || ['pending', 'draft_ready', 'presented'];
  if (typeof statuses === 'string') statuses = [statuses];

  const placeholders = statuses.map(() => '?').join(', ');
  return db.prepare(`
    SELECT * FROM priority_queue
    WHERE status IN (${placeholders})
    ORDER BY priority_score DESC, inserted_at ASC
    LIMIT ?
  `).all(...statuses, limit);
}

/**
 * Get the top N entries for context injection.
 */
export function getTopEntries(ctx, n = 5) {
  return listQueue(ctx, { limit: n });
}

/**
 * Get queue entry by position (1-indexed) in priority order.
 */
export function getByPosition(ctx, position) {
  const db = ensureDb(ctx.config);
  const offset = Math.max(0, position - 1);
  return db.prepare(`
    SELECT * FROM priority_queue
    WHERE status IN ('pending', 'draft_ready', 'presented')
    ORDER BY priority_score DESC, inserted_at ASC
    LIMIT 1 OFFSET ?
  `).get(offset) || null;
}

// ─── Update ───────────────────────────────────────────────────────────────

export function updateStatus(ctx, id, status) {
  const db = ensureDb(ctx.config);
  const timeCol = status === 'presented' ? 'presented_at'
    : status === 'acted' ? 'acted_at'
    : null;

  if (timeCol) {
    db.prepare(
      `UPDATE priority_queue SET status = ?, ${timeCol} = datetime('now') WHERE id = ?`
    ).run(status, id);
  } else {
    db.prepare('UPDATE priority_queue SET status = ? WHERE id = ?').run(status, id);
  }
}

export function updateDraftStatus(ctx, id, draftStatus, draftId) {
  const db = ensureDb(ctx.config);
  if (draftId) {
    db.prepare(
      'UPDATE priority_queue SET draft_status = ?, draft_id = ? WHERE id = ?'
    ).run(draftStatus, draftId, id);
  } else {
    db.prepare(
      'UPDATE priority_queue SET draft_status = ? WHERE id = ?'
    ).run(draftStatus, id);
  }
}

export function updateScore(ctx, id, score, factors) {
  const db = ensureDb(ctx.config);
  db.prepare(
    'UPDATE priority_queue SET priority_score = ?, priority_factors = ? WHERE id = ?'
  ).run(score, JSON.stringify(factors), id);
}

// ─── Lifecycle ────────────────────────────────────────────────────────────

/**
 * Expire old pending entries (>48h).
 */
export function expireOld(ctx, hoursThreshold = 48) {
  const db = ensureDb(ctx.config);
  return db.prepare(`
    UPDATE priority_queue SET status = 'expired'
    WHERE status IN ('pending', 'draft_ready', 'presented')
      AND inserted_at < datetime('now', ?)
  `).run(`-${hoursThreshold} hours`).changes;
}

/**
 * Supersede older entries for the same thread when a new email arrives.
 */
export function supersedeByThread(ctx, threadId, newEntryId) {
  const db = ensureDb(ctx.config);
  return db.prepare(`
    UPDATE priority_queue SET status = 'superseded', superseded_by = ?
    WHERE thread_id = ? AND id != ?
      AND status IN ('pending', 'draft_ready', 'presented')
  `).run(newEntryId, threadId, newEntryId).changes;
}

/**
 * Cap total active entries at maxSize by expiring lowest-scored entries.
 */
export function capQueue(ctx, maxSize = 25) {
  const db = ensureDb(ctx.config);
  const count = db.prepare(
    "SELECT COUNT(*) as c FROM priority_queue WHERE status IN ('pending', 'draft_ready')"
  ).get().c;

  if (count <= maxSize) return 0;

  const excess = count - maxSize;
  return db.prepare(`
    UPDATE priority_queue SET status = 'expired'
    WHERE id IN (
      SELECT id FROM priority_queue
      WHERE status IN ('pending', 'draft_ready')
      ORDER BY priority_score ASC, inserted_at ASC
      LIMIT ?
    )
  `).run(excess).changes;
}

/**
 * Invalidate drafts for entries in a thread (new email arrived).
 */
export function invalidateDrafts(ctx, threadId) {
  const db = ensureDb(ctx.config);
  const staled = db.prepare(`
    UPDATE priority_queue SET draft_status = 'stale'
    WHERE thread_id = ? AND draft_status = 'ready'
  `).run(threadId).changes;

  // Delete orphaned gmail_drafts rows for stale entries
  if (staled > 0) {
    db.prepare(`
      DELETE FROM gmail_drafts
      WHERE draft_id IN (
        SELECT draft_id FROM priority_queue
        WHERE thread_id = ? AND draft_status = 'stale' AND draft_id IS NOT NULL
      )
    `).run(threadId);
  }

  return staled;
}

/**
 * Get count of active queue entries.
 */
export function getQueueCount(ctx) {
  const db = ensureDb(ctx.config);
  return db.prepare(
    "SELECT COUNT(*) as c FROM priority_queue WHERE status IN ('pending', 'draft_ready', 'presented')"
  ).get().c;
}

/**
 * Get entries needing draft generation.
 */
export function getEntriesNeedingDraft(ctx, limit = 3) {
  const db = ensureDb(ctx.config);
  return db.prepare(`
    SELECT * FROM priority_queue
    WHERE status IN ('pending', 'draft_ready')
      AND draft_status IN ('none', 'stale')
    ORDER BY priority_score DESC
    LIMIT ?
  `).all(limit);
}
