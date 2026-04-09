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
  }
  return _db;
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

export function getOAuthToken(config, provider) {
  const db = ensureDb(config);
  return db.prepare('SELECT * FROM oauth_tokens WHERE provider = ?').get(provider);
}

export function upsertOAuthToken(config, provider, accessToken, refreshToken, expiresAt) {
  const db = ensureDb(config);
  return db.prepare(`
    INSERT OR REPLACE INTO oauth_tokens (provider, access_token, refresh_token, expires_at, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(provider, accessToken, refreshToken || null, expiresAt || null);
}

export function lockOAuthToken(config, provider) {
  const db = ensureDb(config);
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    'UPDATE oauth_tokens SET locked_at = ? WHERE provider = ? AND (locked_at IS NULL OR locked_at < ?)'
  ).run(now, provider, now - 30);
  return result.changes > 0;
}

export function unlockOAuthToken(config, provider) {
  const db = ensureDb(config);
  db.prepare('UPDATE oauth_tokens SET locked_at = NULL WHERE provider = ?').run(provider);
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

export function getAllCachedWorkouts(config) {
  const db = ensureDb(config);
  return db.prepare('SELECT * FROM workout_cache ORDER BY date DESC').all();
}
