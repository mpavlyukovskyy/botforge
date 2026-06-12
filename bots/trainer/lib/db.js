/**
 * Trainer DB — schema migrations and helpers
 *
 * Pattern: alfred/lib/db.js
 * Uses ensureDb(config) singleton since ctx.db is always undefined.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';

// ─── Database singleton ─────────────────────────────────────────────────────

let _db;

export function ensureDb(config) {
  if (!_db) {
    mkdirSync('data', { recursive: true });
    _db = new Database(`data/${config.name}-trainer.db`);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('busy_timeout = 5000');
    migrateOAuthTokens(_db);
  }
  return _db;
}

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// Lock stolen if held longer than this. Must exceed the refresh fetch timeout
// (30s) by a wide margin so a hung holder can never overlap a stealer.
export const OAUTH_LOCK_STEAL_SEC = 120;

/**
 * oauth_tokens migration runs at first DB touch — NOT only in the lifecycle
 * start hook — because cron jobs are scheduled before start hooks fire and a
 * tick in that window would hit missing columns.
 *
 * All timestamp columns here are JS epoch SECONDS (never compared against
 * SQL datetime('now'), which fake timers can't control in tests).
 */
function migrateOAuthTokens(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      provider TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at INTEGER,
      locked_at INTEGER,
      updated_at TEXT DEFAULT (datetime('now')),
      status TEXT DEFAULT 'active',
      dead_reason TEXT,
      dead_at INTEGER,
      consecutive_invalid_request INTEGER DEFAULT 0,
      first_transient_failure_at INTEGER,
      lock_token TEXT,
      last_dead_probe_at INTEGER
    );
  `);
  const alters = [
    "ALTER TABLE oauth_tokens ADD COLUMN status TEXT DEFAULT 'active'",
    'ALTER TABLE oauth_tokens ADD COLUMN dead_reason TEXT',
    'ALTER TABLE oauth_tokens ADD COLUMN dead_at INTEGER',
    'ALTER TABLE oauth_tokens ADD COLUMN consecutive_invalid_request INTEGER DEFAULT 0',
    'ALTER TABLE oauth_tokens ADD COLUMN first_transient_failure_at INTEGER',
    'ALTER TABLE oauth_tokens ADD COLUMN lock_token TEXT',
    'ALTER TABLE oauth_tokens ADD COLUMN last_dead_probe_at INTEGER',
  ];
  for (const sql of alters) {
    try {
      db.exec(sql);
    } catch (err) {
      // Only an already-applied migration is ignorable; SQLITE_BUSY or any
      // other failure must surface, not silently leave columns missing.
      if (!/duplicate column name/i.test(err.message)) throw err;
    }
  }
}

export function getDb(config) {
  return ensureDb(config);
}

// ─── Migrations ─────────────────────────────────────────────────────────────

export function runMigrations(ctx) {
  const db = ensureDb(ctx.config);

  // ── OAuth tokens ──────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      provider TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at INTEGER,
      locked_at INTEGER,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Goals ─────────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_text TEXT NOT NULL,
      category TEXT,
      target_date TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Training programs ─────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS training_programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      program_json TEXT NOT NULL,
      goals_snapshot TEXT,
      current_week INTEGER DEFAULT 1,
      total_weeks INTEGER,
      valid_from TEXT NOT NULL,
      valid_until TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Check-ins ─────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS check_ins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      summary TEXT NOT NULL,
      metrics_json TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Daily recovery cache ──────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS recovery_daily (
      date TEXT PRIMARY KEY,
      whoop_recovery_score REAL,
      whoop_hrv REAL,
      whoop_rhr REAL,
      whoop_strain REAL,
      whoop_sleep_performance REAL,
      eightsleep_sleep_score REAL,
      eightsleep_hrv REAL,
      eightsleep_deep_sleep_min REAL,
      eightsleep_total_sleep_min REAL,
      combined_readiness TEXT,
      raw_json TEXT,
      synced_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Exercise templates (cached from Hevy) ─────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS exercise_templates (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      muscle_group TEXT,
      equipment TEXT,
      fetched_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Workout cache ─────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS workout_cache (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      title TEXT,
      exercises_json TEXT,
      duration_seconds INTEGER,
      fetched_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_wc_date ON workout_cache(date);
  `);

  // ── Pending workouts (bridge between morning card + approve callback) ───
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_workouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      exercises_json TEXT NOT NULL,
      time_minutes INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Add pushed_at to pending_workouts ─────────────────────────────────
  try {
    db.exec('ALTER TABLE pending_workouts ADD COLUMN pushed_at TEXT');
  } catch { /* column already exists */ }

  // ── Onboarding analysis (singleton row, id=1) ──────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS onboarding_analysis (
      id INTEGER PRIMARY KEY DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      workout_count INTEGER,
      metrics_json TEXT,
      narrative TEXT,
      inferred_goals_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT
    );
  `);

  // ── Exercise config (custom metadata, separate from Hevy-synced templates) ─
  db.exec(`
    CREATE TABLE IF NOT EXISTS exercise_config (
      exercise_title TEXT PRIMARY KEY,
      category TEXT DEFAULT 'compound',
      increment_kg REAL DEFAULT 2.5,
      fatigue_weight REAL DEFAULT 1.0,
      recovery_hours INTEGER DEFAULT 72,
      muscle_groups TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Exercise progression (double progression state per exercise per program) ─
  db.exec(`
    CREATE TABLE IF NOT EXISTS exercise_progression (
      exercise_title TEXT NOT NULL,
      program_id INTEGER NOT NULL,
      current_weight_kg REAL,
      prescribed_rep_range TEXT,
      last_sets_json TEXT,
      consecutive_top_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active',
      stall_weeks INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (exercise_title, program_id)
    );
  `);

  // ── Workout feedback (post-workout subjective feedback) ─────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS workout_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workout_date TEXT NOT NULL,
      session_title TEXT,
      fatigue_level TEXT,
      rpe_accuracy TEXT,
      joint_pain TEXT,
      joint_pain_location TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Muscle fatigue JSON column on recovery_daily ────────────────────────
  try {
    db.exec('ALTER TABLE recovery_daily ADD COLUMN muscle_fatigue_json TEXT');
  } catch { /* column already exists */ }

  // ── Weekly adjustments (structured review-to-next-week adjustments) ─────
  db.exec(`
    CREATE TABLE IF NOT EXISTS weekly_adjustments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      program_id INTEGER NOT NULL,
      week_number INTEGER NOT NULL,
      volume_delta INTEGER DEFAULT 0,
      rpe_delta REAL DEFAULT 0,
      recommendation TEXT,
      exercises_to_watch TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(program_id, week_number)
    );
  `);

  // ── Program history (exercise usage + final status per completed program) ─
  db.exec(`
    CREATE TABLE IF NOT EXISTS program_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      program_id INTEGER NOT NULL,
      exercise_title TEXT NOT NULL,
      total_sessions INTEGER,
      final_status TEXT,
      final_weight_kg REAL,
      muscle_group TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Add notified_at to workout_cache (for event-sync dedup) ─────────
  try {
    db.exec('ALTER TABLE workout_cache ADD COLUMN notified_at TEXT');
  } catch { /* column already exists */ }

  // ── Bot state (key-value store for sync cursors, etc.) ────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // ── Backfill volume_progression for active programs that lack it ────────
  const activePrograms = db.prepare("SELECT id, program_json FROM training_programs WHERE status = 'active'").all();
  for (const p of activePrograms) {
    try {
      const data = JSON.parse(p.program_json);
      if (!data.volume_progression) {
        data.volume_progression = { strategy: 'none' };
        db.prepare('UPDATE training_programs SET program_json = ? WHERE id = ?')
          .run(JSON.stringify(data), p.id);
      }
    } catch { /* skip malformed JSON */ }
  }
}

// ─── Goal helpers ───────────────────────────────────────────────────────────

export function getActiveGoals(config) {
  const db = ensureDb(config);
  return db.prepare("SELECT * FROM goals WHERE status = 'active' ORDER BY created_at").all();
}

export function setGoal(config, goalText, category, targetDate) {
  const db = ensureDb(config);
  return db.prepare(
    'INSERT INTO goals (goal_text, category, target_date) VALUES (?, ?, ?)'
  ).run(goalText, category || null, targetDate || null);
}

export function updateGoalStatus(config, goalId, status) {
  const db = ensureDb(config);
  return db.prepare(
    "UPDATE goals SET status = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(status, goalId);
}

// ─── Program helpers ────────────────────────────────────────────────────────

export function getActiveProgram(config) {
  const db = ensureDb(config);
  return db.prepare(
    "SELECT * FROM training_programs WHERE status = 'active' ORDER BY created_at DESC LIMIT 1"
  ).get();
}

export function createProgram(config, title, programJson, goalsSnapshot, totalWeeks, validFrom) {
  const db = ensureDb(config);
  // Deactivate any existing active programs
  db.prepare("UPDATE training_programs SET status = 'completed' WHERE status = 'active'").run();
  return db.prepare(
    'INSERT INTO training_programs (title, program_json, goals_snapshot, total_weeks, valid_from) VALUES (?, ?, ?, ?, ?)'
  ).run(title, programJson, goalsSnapshot, totalWeeks, validFrom);
}

export function advanceProgramWeek(config, programId) {
  const db = ensureDb(config);
  return db.prepare(
    'UPDATE training_programs SET current_week = current_week + 1 WHERE id = ?'
  ).run(programId);
}

export function completeProgramById(config, programId) {
  const db = ensureDb(config);
  return db.prepare(
    "UPDATE training_programs SET status = 'completed' WHERE id = ?"
  ).run(programId);
}

// ─── Recovery helpers ───────────────────────────────────────────────────────

export function getRecoveryForDate(config, date) {
  const db = ensureDb(config);
  return db.prepare('SELECT * FROM recovery_daily WHERE date = ?').get(date);
}

export function upsertRecovery(config, data) {
  const db = ensureDb(config);
  return db.prepare(`
    INSERT OR REPLACE INTO recovery_daily
      (date, whoop_recovery_score, whoop_hrv, whoop_rhr, whoop_strain, whoop_sleep_performance,
       eightsleep_sleep_score, eightsleep_hrv, eightsleep_deep_sleep_min, eightsleep_total_sleep_min,
       combined_readiness, raw_json, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    data.date,
    data.whoop_recovery_score ?? null,
    data.whoop_hrv ?? null,
    data.whoop_rhr ?? null,
    data.whoop_strain ?? null,
    data.whoop_sleep_performance ?? null,
    data.eightsleep_sleep_score ?? null,
    data.eightsleep_hrv ?? null,
    data.eightsleep_deep_sleep_min ?? null,
    data.eightsleep_total_sleep_min ?? null,
    data.combined_readiness ?? null,
    data.raw_json ? JSON.stringify(data.raw_json) : null
  );
}

export function refreshWhoopRecovery(config, date, recoveryScore, hrv, rhr) {
  const db = ensureDb(config);
  const existing = db.prepare(
    'SELECT eightsleep_sleep_score FROM recovery_daily WHERE date = ?'
  ).get(date);
  if (!existing) return false;

  const scores = [];
  if (recoveryScore != null) scores.push(recoveryScore);
  if (existing.eightsleep_sleep_score != null) scores.push(existing.eightsleep_sleep_score);
  const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const readiness = avg == null ? 'unknown'
    : avg >= 67 ? 'green' : avg >= 34 ? 'yellow' : 'red';

  db.prepare(`
    UPDATE recovery_daily
    SET whoop_recovery_score = ?, whoop_hrv = ?, whoop_rhr = ?,
        combined_readiness = ?, synced_at = datetime('now')
    WHERE date = ?
  `).run(recoveryScore, hrv, rhr, readiness, date);
  return true;
}

export function getRecoveryRange(config, startDate, endDate) {
  const db = ensureDb(config);
  return db.prepare(
    'SELECT * FROM recovery_daily WHERE date >= ? AND date <= ? ORDER BY date'
  ).all(startDate, endDate);
}

// ─── Exercise template helpers ──────────────────────────────────────────────

export function getExerciseTemplate(config, id) {
  const db = ensureDb(config);
  return db.prepare('SELECT * FROM exercise_templates WHERE id = ?').get(id);
}

export function upsertExerciseTemplate(config, template) {
  const db = ensureDb(config);
  return db.prepare(`
    INSERT OR REPLACE INTO exercise_templates (id, title, muscle_group, equipment, fetched_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(template.id, template.title, template.muscle_group || null, template.equipment || null);
}

export function getAllExerciseTemplates(config) {
  const db = ensureDb(config);
  return db.prepare('SELECT * FROM exercise_templates ORDER BY title').all();
}

export function searchExerciseTemplatesByName(config, query) {
  const db = ensureDb(config);
  return db.prepare(
    "SELECT * FROM exercise_templates WHERE title LIKE ? ORDER BY title"
  ).all(`%${query}%`);
}

// ─── Workout cache helpers ──────────────────────────────────────────────────

export function getCachedWorkouts(config, startDate, endDate) {
  const db = ensureDb(config);
  return db.prepare(
    'SELECT * FROM workout_cache WHERE date >= ? AND date <= ? ORDER BY date DESC'
  ).all(startDate, endDate);
}

export function upsertWorkoutCache(config, workout) {
  const db = ensureDb(config);
  return db.prepare(`
    INSERT OR REPLACE INTO workout_cache (id, date, title, exercises_json, duration_seconds, fetched_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(
    workout.id,
    workout.date,
    workout.title || null,
    workout.exercises_json ? JSON.stringify(workout.exercises_json) : null,
    workout.duration_seconds || null
  );
}

// ─── Check-in helpers ───────────────────────────────────────────────────────

export function createCheckIn(config, type, summary, metricsJson) {
  const db = ensureDb(config);
  return db.prepare(
    'INSERT INTO check_ins (type, summary, metrics_json) VALUES (?, ?, ?)'
  ).run(type, summary, metricsJson ? JSON.stringify(metricsJson) : null);
}

export function getRecentCheckIns(config, type, limit = 4) {
  const db = ensureDb(config);
  return db.prepare(
    'SELECT * FROM check_ins WHERE type = ? ORDER BY created_at DESC LIMIT ?'
  ).all(type, limit);
}

// ─── OAuth token helpers ────────────────────────────────────────────────────
//
// Token-rotation safety model (see docs/RCA-whoop-token-spam-2026-06-11.md):
// Whoop rotates refresh tokens on every use with reuse-revocation of the whole
// grant chain, so every write here is compare-and-swap'd on the refresh token
// that was actually presented. INSERT OR REPLACE is banned on oauth_tokens —
// REPLACE deletes+reinserts the row, silently resetting state columns.

export function getOAuthToken(config, provider) {
  const db = ensureDb(config);
  return db.prepare('SELECT * FROM oauth_tokens WHERE provider = ?').get(provider);
}

export function upsertOAuthToken(config, provider, accessToken, refreshToken, expiresAt) {
  const db = ensureDb(config);
  return db.prepare(`
    INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = excluded.refresh_token,
      expires_at = excluded.expires_at,
      updated_at = datetime('now')
  `).run(provider, accessToken, refreshToken || null, expiresAt || null);
}

/**
 * Acquire the refresh lock. Returns an ownership token (string) on success,
 * null if another holder has it. A lock older than OAUTH_LOCK_STEAL_SEC is
 * considered abandoned (crashed holder) and is stolen.
 */
export function lockOAuthToken(config, provider) {
  const db = ensureDb(config);
  const now = nowSec();
  const lockToken = `${process.pid}-${now}-${Math.random().toString(36).slice(2, 10)}`;
  const result = db.prepare(`
    UPDATE oauth_tokens SET locked_at = ?, lock_token = ?
    WHERE provider = ? AND (locked_at IS NULL OR locked_at < ?)
  `).run(now, lockToken, provider, now - OAUTH_LOCK_STEAL_SEC);
  return result.changes > 0 ? lockToken : null;
}

/** Release only OUR lock — never clear a stealer's lock from a stale finally. */
export function unlockOAuthToken(config, provider, lockToken) {
  const db = ensureDb(config);
  db.prepare(
    'UPDATE oauth_tokens SET locked_at = NULL, lock_token = NULL WHERE provider = ? AND lock_token = ?'
  ).run(provider, lockToken || '');
}

/**
 * Persist a successful refresh iff the row still holds the refresh token we
 * presented. Resets ALL failure/dead state in the same statement.
 * Returns false when the token rotated under us (caller must re-read, discard).
 */
export function casUpdateTokenOnSuccess(config, provider, usedRefreshToken, { accessToken, refreshToken, expiresAt }) {
  const db = ensureDb(config);
  const r = db.prepare(`
    UPDATE oauth_tokens SET
      access_token = ?, refresh_token = ?, expires_at = ?,
      status = 'active', dead_reason = NULL, dead_at = NULL,
      consecutive_invalid_request = 0, first_transient_failure_at = NULL,
      last_dead_probe_at = NULL, updated_at = datetime('now')
    WHERE provider = ? AND refresh_token = ?
  `).run(accessToken, refreshToken, expiresAt, provider, usedRefreshToken);
  return r.changes > 0;
}

/**
 * Mark the token dead iff the row still holds the refresh token we presented.
 * Sets last_dead_probe_at = dead_at so the first escape-hatch verification
 * happens at dead_at + 12h, not immediately.
 * Returns false when the token rotated under us (failure was stale — transient).
 */
export function casMarkTokenDead(config, provider, usedRefreshToken, reason) {
  const db = ensureDb(config);
  const now = nowSec();
  const r = db.prepare(`
    UPDATE oauth_tokens SET status = 'dead', dead_reason = ?, dead_at = ?, last_dead_probe_at = ?
    WHERE provider = ? AND refresh_token = ?
  `).run(reason, now, now, provider, usedRefreshToken);
  return r.changes > 0;
}

/**
 * Increment the consecutive generic-invalid_request counter (CAS'd).
 * Returns the new count, or null if the token rotated under us.
 */
export function casIncrementInvalidRequest(config, provider, usedRefreshToken) {
  const db = ensureDb(config);
  const r = db.prepare(`
    UPDATE oauth_tokens SET consecutive_invalid_request = consecutive_invalid_request + 1
    WHERE provider = ? AND refresh_token = ?
  `).run(provider, usedRefreshToken);
  if (r.changes === 0) return null;
  return db.prepare('SELECT consecutive_invalid_request FROM oauth_tokens WHERE provider = ?')
    .get(provider).consecutive_invalid_request;
}

/** Stamp the start of a transient-failure window (only if not already open). */
export function setFirstTransientFailure(config, provider) {
  const db = ensureDb(config);
  db.prepare(
    'UPDATE oauth_tokens SET first_transient_failure_at = ? WHERE provider = ? AND first_transient_failure_at IS NULL'
  ).run(nowSec(), provider);
}

/**
 * Claim the right to run ONE dead-token verification refresh (escape hatch).
 * CAS'd so exactly one caller — across processes and restarts — probes per
 * interval. Returns true only for the winner.
 */
export function casClaimDeadProbe(config, provider, seenRefreshToken, intervalSec = 43200) {
  const db = ensureDb(config);
  const now = nowSec();
  const r = db.prepare(`
    UPDATE oauth_tokens SET last_dead_probe_at = ?
    WHERE provider = ? AND status = 'dead' AND refresh_token = ?
      AND (last_dead_probe_at IS NULL OR last_dead_probe_at < ?)
  `).run(now, provider, seenRefreshToken, now - intervalSec);
  return r.changes > 0;
}

// ─── Onboarding analysis helpers ──────────────────────────────────────────

export function getOnboardingAnalysis(config) {
  const db = ensureDb(config);
  return db.prepare('SELECT * FROM onboarding_analysis WHERE id = 1').get();
}

export function upsertOnboardingAnalysis(config, data) {
  const db = ensureDb(config);
  return db.prepare(`
    INSERT OR REPLACE INTO onboarding_analysis
      (id, status, workout_count, metrics_json, narrative, inferred_goals_json, created_at, completed_at)
    VALUES (1, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM onboarding_analysis WHERE id = 1), datetime('now')), ?)
  `).run(
    data.status || 'pending',
    data.workout_count ?? null,
    data.metrics_json ? JSON.stringify(data.metrics_json) : null,
    data.narrative ?? null,
    data.inferred_goals_json ? JSON.stringify(data.inferred_goals_json) : null,
    data.status === 'complete' ? new Date().toISOString() : null
  );
}

export function clearOnboardingAnalysis(config) {
  const db = ensureDb(config);
  return db.prepare('DELETE FROM onboarding_analysis WHERE id = 1').run();
}

// ─── Pending workout helpers ───────────────────────────────────────────────

export function savePendingWorkout(config, title, exercises, timeMinutes) {
  const db = ensureDb(config);
  const result = db.prepare(
    'INSERT INTO pending_workouts (title, exercises_json, time_minutes) VALUES (?, ?, ?)'
  ).run(title, JSON.stringify(exercises), timeMinutes || null);
  db.prepare("DELETE FROM pending_workouts WHERE created_at < datetime('now', '-1 day')").run();
  return result.lastInsertRowid;
}

export function getPendingWorkout(config, id) {
  const db = ensureDb(config);
  return db.prepare('SELECT * FROM pending_workouts WHERE id = ?').get(id);
}

export function deletePendingWorkout(config, id) {
  const db = ensureDb(config);
  db.prepare('DELETE FROM pending_workouts WHERE id = ?').run(id);
}

export function markPendingWorkoutPushed(config, id, routineTitle) {
  const db = ensureDb(config);
  db.prepare(
    "UPDATE pending_workouts SET pushed_at = datetime('now'), title = COALESCE(?, title) WHERE id = ?"
  ).run(routineTitle || null, id);
}

export function getAllCachedWorkouts(config) {
  const db = ensureDb(config);
  return db.prepare('SELECT * FROM workout_cache ORDER BY date DESC').all();
}

// ─── Exercise config helpers ────────────────────────────────────────────────

export function getExerciseConfig(config, exerciseTitle) {
  const db = ensureDb(config);
  return db.prepare('SELECT * FROM exercise_config WHERE exercise_title = ?').get(exerciseTitle);
}

export function upsertExerciseConfig(config, data) {
  const db = ensureDb(config);
  return db.prepare(`
    INSERT OR REPLACE INTO exercise_config
      (exercise_title, category, increment_kg, fatigue_weight, recovery_hours, muscle_groups, created_at)
    VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM exercise_config WHERE exercise_title = ?), datetime('now')))
  `).run(
    data.exercise_title,
    data.category || 'compound',
    data.increment_kg ?? 2.5,
    data.fatigue_weight ?? 1.0,
    data.recovery_hours ?? 72,
    data.muscle_groups ? (typeof data.muscle_groups === 'string' ? data.muscle_groups : JSON.stringify(data.muscle_groups)) : null,
    data.exercise_title
  );
}

export function getAllExerciseConfigs(config) {
  const db = ensureDb(config);
  return db.prepare('SELECT * FROM exercise_config ORDER BY exercise_title').all();
}

// ─── Exercise progression helpers ───────────────────────────────────────────

export function getExerciseProgression(config, exerciseTitle, programId) {
  const db = ensureDb(config);
  return db.prepare(
    'SELECT * FROM exercise_progression WHERE exercise_title = ? AND program_id = ?'
  ).get(exerciseTitle, programId);
}

export function upsertExerciseProgression(config, data) {
  const db = ensureDb(config);
  return db.prepare(`
    INSERT OR REPLACE INTO exercise_progression
      (exercise_title, program_id, current_weight_kg, prescribed_rep_range, last_sets_json,
       consecutive_top_count, status, stall_weeks, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    data.exercise_title,
    data.program_id,
    data.current_weight_kg ?? null,
    data.prescribed_rep_range ?? null,
    data.last_sets_json ?? null,
    data.consecutive_top_count ?? 0,
    data.status ?? 'active',
    data.stall_weeks ?? 0
  );
}

export function getProgressionForProgram(config, programId) {
  const db = ensureDb(config);
  return db.prepare(
    'SELECT * FROM exercise_progression WHERE program_id = ? ORDER BY exercise_title'
  ).all(programId);
}

// ─── Workout feedback helpers ───────────────────────────────────────────────

export function saveWorkoutFeedback(config, data) {
  const db = ensureDb(config);
  return db.prepare(`
    INSERT INTO workout_feedback
      (workout_date, session_title, fatigue_level, rpe_accuracy, joint_pain, joint_pain_location, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.workout_date,
    data.session_title ?? null,
    data.fatigue_level ?? null,
    data.rpe_accuracy ?? null,
    data.joint_pain ?? null,
    data.joint_pain_location ?? null,
    data.notes ?? null
  );
}

export function getRecentFeedback(config, limit = 3) {
  const db = ensureDb(config);
  return db.prepare(
    'SELECT * FROM workout_feedback ORDER BY workout_date DESC, created_at DESC LIMIT ?'
  ).all(limit);
}

export function getFeedbackForDate(config, date) {
  const db = ensureDb(config);
  return db.prepare(
    'SELECT * FROM workout_feedback WHERE workout_date = ? ORDER BY created_at DESC'
  ).all(date);
}

// ─── Weekly adjustment helpers ──────────────────────────────────────────────

export function saveWeeklyAdjustment(config, data) {
  const db = ensureDb(config);
  return db.prepare(`
    INSERT OR REPLACE INTO weekly_adjustments
      (program_id, week_number, volume_delta, rpe_delta, recommendation, exercises_to_watch, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.program_id,
    data.week_number,
    data.volume_delta ?? 0,
    data.rpe_delta ?? 0,
    data.recommendation ?? null,
    data.exercises_to_watch ? (typeof data.exercises_to_watch === 'string' ? data.exercises_to_watch : JSON.stringify(data.exercises_to_watch)) : null,
    data.notes ?? null
  );
}

export function getWeeklyAdjustment(config, programId, weekNumber) {
  const db = ensureDb(config);
  return db.prepare(
    'SELECT * FROM weekly_adjustments WHERE program_id = ? AND week_number = ?'
  ).get(programId, weekNumber);
}

// ─── Program history helpers ────────────────────────────────────────────────

export function saveProgramHistory(config, programId, exercises) {
  const db = ensureDb(config);
  const stmt = db.prepare(`
    INSERT INTO program_history
      (program_id, exercise_title, total_sessions, final_status, final_weight_kg, muscle_group)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      stmt.run(
        programId,
        row.exercise_title,
        row.total_sessions ?? null,
        row.final_status ?? null,
        row.final_weight_kg ?? null,
        row.muscle_group ?? null
      );
    }
  });
  insertMany(exercises);
}

export function getRecentProgramHistory(config, limit = 2) {
  const db = ensureDb(config);
  // Get exercises from last N completed programs
  return db.prepare(`
    SELECT ph.*, tp.title as program_title
    FROM program_history ph
    JOIN training_programs tp ON tp.id = ph.program_id
    WHERE tp.status = 'completed'
    ORDER BY ph.created_at DESC
    LIMIT ?
  `).all(limit * 20); // ~20 exercises per program
}

// ─── Recovery daily helpers (muscle fatigue) ────────────────────────────────

export function updateMuscleFatigue(config, date, muscleFatigueJson) {
  const db = ensureDb(config);
  return db.prepare(
    'UPDATE recovery_daily SET muscle_fatigue_json = ? WHERE date = ?'
  ).run(typeof muscleFatigueJson === 'string' ? muscleFatigueJson : JSON.stringify(muscleFatigueJson), date);
}

// ─── Bot state helpers (key-value store) ─────────────────────────────────

export function getState(config, key) {
  const db = ensureDb(config);
  const row = db.prepare('SELECT value FROM bot_state WHERE key = ?').get(key);
  return row?.value ?? null;
}

export function setState(config, key, value) {
  const db = ensureDb(config);
  return db.prepare(`
    INSERT OR REPLACE INTO bot_state (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
  `).run(key, value);
}

export function deleteState(config, key) {
  const db = ensureDb(config);
  return db.prepare('DELETE FROM bot_state WHERE key = ?').run(key);
}

// ─── Workout notification dedup helpers ──────────────────────────────────

export function isWorkoutNotified(config, workoutId) {
  const db = ensureDb(config);
  const row = db.prepare('SELECT notified_at FROM workout_cache WHERE id = ? AND notified_at IS NOT NULL').get(workoutId);
  return !!row;
}

export function markWorkoutNotified(config, workoutId) {
  const db = ensureDb(config);
  return db.prepare(
    "UPDATE workout_cache SET notified_at = datetime('now') WHERE id = ?"
  ).run(workoutId);
}
