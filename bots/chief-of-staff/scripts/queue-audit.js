#!/usr/bin/env node
/**
 * Queue Audit Script
 *
 * Audits the COS bot priority queue for false positives:
 * - Emails where Mark already replied in the thread
 * - Internal forwards (FYI only)
 * - Stale entries (>48h old)
 *
 * Usage:
 *   node scripts/queue-audit.js          # audit only (read-only)
 *   node scripts/queue-audit.js --fix    # audit + dismiss false positives
 */
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

// ─── DB paths (production defaults) ──────────────────────────────────────────

const COS_DB_PATH = process.env.COS_DB_PATH
  || '/opt/botforge/data/ChiefOfStaff-tools.db';

const EMAIL_INTEL_DB_PATH = process.env.EMAIL_INTEL_DB_PATH
  || '/opt/email-intel/data/email-intel.db';

const FIX_MODE = process.argv.includes('--fix');

// ─── Open databases ──────────────────────────────────────────────────────────

function openDb(path, readonly = true) {
  if (!existsSync(path)) {
    console.error(`DB not found: ${path}`);
    process.exit(1);
  }
  const db = new Database(path, { readonly });
  db.pragma('journal_mode = WAL');
  return db;
}

const cosDb = openDb(COS_DB_PATH, !FIX_MODE);
const emailDb = openDb(EMAIL_INTEL_DB_PATH, true);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getThread(threadId) {
  if (!threadId) return [];
  try {
    return emailDb.prepare(`
      SELECT id, message_id, gmail_thread_id, subject,
             from_address, from_name, to_addresses, date,
             direction, body_text
      FROM emails
      WHERE gmail_thread_id = ?
      ORDER BY date ASC
    `).all(threadId);
  } catch {
    return [];
  }
}

function getActiveQueue() {
  return cosDb.prepare(`
    SELECT id, message_id, thread_id, from_address, from_name,
           subject, status, priority_score, inserted_at
    FROM priority_queue
    WHERE status IN ('pending', 'draft_ready', 'presented')
    ORDER BY priority_score DESC
  `).all();
}

function dismissEntry(id) {
  cosDb.prepare(`
    UPDATE priority_queue
    SET status = 'dismissed'
    WHERE id = ?
  `).run(id);
}

// ─── Audit ───────────────────────────────────────────────────────────────────

console.log('╔════════════════════════════════════════╗');
console.log('║       QUEUE AUDIT                      ║');
console.log('╚════════════════════════════════════════╝');
console.log(`COS DB:         ${COS_DB_PATH}`);
console.log(`Email-Intel DB: ${EMAIL_INTEL_DB_PATH}`);
console.log(`Mode:           ${FIX_MODE ? 'FIX (will dismiss false positives)' : 'AUDIT (read-only)'}`);
console.log('');

const entries = getActiveQueue();
console.log(`Active queue entries: ${entries.length}\n`);

let ok = 0;
let falsePositives = 0;
let stale = 0;

for (const entry of entries) {
  const thread = getThread(entry.thread_id);
  const markSent = thread.filter(m => m.direction === 'sent');
  const isInternal = entry.from_address?.endsWith('@science.xyz');
  const isForward = /^(Fwd|Fw):/i.test(entry.subject);
  const ageHours = (Date.now() - new Date(entry.inserted_at).getTime()) / (1000 * 60 * 60);

  let verdict = 'OK';
  let reason = '';

  if (markSent.length > 0) {
    verdict = 'FALSE_POSITIVE';
    reason = `Mark replied on ${markSent[markSent.length - 1].date.slice(0, 10)}`;
    falsePositives++;
  } else if (isInternal && isForward) {
    verdict = 'FALSE_POSITIVE';
    reason = 'Internal forward (FYI)';
    falsePositives++;
  } else if (ageHours > 48) {
    verdict = 'STALE';
    reason = `${Math.round(ageHours)}h old`;
    stale++;
  } else {
    ok++;
  }

  const icon = verdict === 'OK' ? '✅' : verdict === 'STALE' ? '⏰' : '❌';
  console.log(`${icon} [${entry.status}] ${entry.from_name || entry.from_address}: ${entry.subject}`);
  console.log(`   Score: ${entry.priority_score} | Thread msgs: ${thread.length} | Mark sent: ${markSent.length}`);
  if (reason) console.log(`   → ${verdict}: ${reason}`);

  if (FIX_MODE && verdict === 'FALSE_POSITIVE') {
    dismissEntry(entry.id);
    console.log(`   → DISMISSED (id=${entry.id})`);
  }

  console.log('');
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('────────────────────────────────────────');
console.log(`OK: ${ok} | FALSE_POSITIVE: ${falsePositives} | STALE: ${stale}`);
if (FIX_MODE && falsePositives > 0) {
  console.log(`\n${falsePositives} false positive(s) dismissed.`);
}
if (!FIX_MODE && falsePositives > 0) {
  console.log(`\nRun with --fix to dismiss ${falsePositives} false positive(s).`);
}

cosDb.close();
emailDb.close();
