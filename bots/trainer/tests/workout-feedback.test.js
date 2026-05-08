/**
 * Tests for workout feedback storage and retrieval.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// In-memory DB helpers that mirror lib/db.js patterns
let db;

function setupDb() {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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
}

function saveWorkoutFeedback(data) {
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

function getRecentFeedback(limit = 3) {
  return db.prepare(
    'SELECT * FROM workout_feedback ORDER BY workout_date DESC, created_at DESC LIMIT ?'
  ).all(limit);
}

describe('Workout Feedback', () => {
  beforeEach(() => {
    setupDb();
  });

  it('saves feedback correctly and retrieves by date', () => {
    saveWorkoutFeedback({
      workout_date: '2026-05-05',
      session_title: 'Upper A',
      fatigue_level: 'fatigued',
      rpe_accuracy: 'harder_than_prescribed',
      joint_pain: 'none',
      joint_pain_location: null,
    });

    const results = getRecentFeedback(3);
    expect(results).toHaveLength(1);
    expect(results[0].workout_date).toBe('2026-05-05');
    expect(results[0].session_title).toBe('Upper A');
    expect(results[0].fatigue_level).toBe('fatigued');
    expect(results[0].rpe_accuracy).toBe('harder_than_prescribed');
    expect(results[0].joint_pain).toBe('none');
  });

  it('getRecentFeedback returns last N entries ordered by date DESC', () => {
    saveWorkoutFeedback({ workout_date: '2026-05-01', session_title: 'Lower A', fatigue_level: 'normal', rpe_accuracy: 'as_prescribed', joint_pain: 'none' });
    saveWorkoutFeedback({ workout_date: '2026-05-03', session_title: 'Upper A', fatigue_level: 'fresh', rpe_accuracy: 'easier_than_prescribed', joint_pain: 'none' });
    saveWorkoutFeedback({ workout_date: '2026-05-05', session_title: 'Lower B', fatigue_level: 'fatigued', rpe_accuracy: 'harder_than_prescribed', joint_pain: 'minor', joint_pain_location: 'knee' });
    saveWorkoutFeedback({ workout_date: '2026-05-07', session_title: 'Upper B', fatigue_level: 'exhausted', rpe_accuracy: 'harder_than_prescribed', joint_pain: 'significant', joint_pain_location: 'shoulder' });

    const last3 = getRecentFeedback(3);
    expect(last3).toHaveLength(3);
    expect(last3[0].workout_date).toBe('2026-05-07');
    expect(last3[1].workout_date).toBe('2026-05-05');
    expect(last3[2].workout_date).toBe('2026-05-03');
  });

  it('stores joint pain location correctly', () => {
    saveWorkoutFeedback({
      workout_date: '2026-05-05',
      session_title: 'Upper A',
      fatigue_level: 'normal',
      rpe_accuracy: 'as_prescribed',
      joint_pain: 'significant',
      joint_pain_location: 'shoulder',
    });

    const results = getRecentFeedback(1);
    expect(results[0].joint_pain).toBe('significant');
    expect(results[0].joint_pain_location).toBe('shoulder');
  });

  it('handles multiple workouts on same day', () => {
    saveWorkoutFeedback({ workout_date: '2026-05-05', session_title: 'Morning Cardio', fatigue_level: 'fresh', rpe_accuracy: 'as_prescribed', joint_pain: 'none' });
    saveWorkoutFeedback({ workout_date: '2026-05-05', session_title: 'Evening Weights', fatigue_level: 'fatigued', rpe_accuracy: 'harder_than_prescribed', joint_pain: 'minor', joint_pain_location: 'knee' });

    const results = getRecentFeedback(5);
    expect(results).toHaveLength(2);
    // Both should be from the same date
    expect(results[0].workout_date).toBe('2026-05-05');
    expect(results[1].workout_date).toBe('2026-05-05');
  });

  it('handles optional notes field', () => {
    saveWorkoutFeedback({
      workout_date: '2026-05-05',
      session_title: 'Upper A',
      fatigue_level: 'normal',
      rpe_accuracy: 'as_prescribed',
      joint_pain: 'none',
      notes: 'Felt great today, good pump on chest exercises',
    });

    const results = getRecentFeedback(1);
    expect(results[0].notes).toBe('Felt great today, good pump on chest exercises');
  });

  it('returns empty array when no feedback exists', () => {
    const results = getRecentFeedback(3);
    expect(results).toHaveLength(0);
  });
});
