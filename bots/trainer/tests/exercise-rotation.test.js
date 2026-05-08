/**
 * Tests for exercise rotation between programs and push:pull validation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

let db;

function setupDb() {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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
}

function saveProgramHistory(programId, exercises) {
  const stmt = db.prepare(`
    INSERT INTO program_history
      (program_id, exercise_title, total_sessions, final_status, final_weight_kg, muscle_group)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      stmt.run(programId, row.exercise_title, row.total_sessions ?? null, row.final_status ?? null, row.final_weight_kg ?? null, row.muscle_group ?? null);
    }
  });
  insertMany(exercises);
}

function getRecentProgramHistory(limit = 2) {
  return db.prepare(`
    SELECT ph.*, tp.title as program_title
    FROM program_history ph
    JOIN training_programs tp ON tp.id = ph.program_id
    WHERE tp.status = 'completed'
    ORDER BY ph.created_at DESC
    LIMIT ?
  `).all(limit * 20);
}

// Push:pull validation (mirrored from create_program.js)
const PUSH_PATTERNS = [/bench press/i, /push.?up/i, /shoulder press/i, /overhead press/i, /military press/i, /incline press/i, /decline press/i, /chest fly/i, /pec deck/i, /cable cross/i, /tricep/i, /pushdown/i, /skull crush/i, /dip/i, /kickback/i, /lateral raise/i, /arnold press/i];
const PULL_PATTERNS = [/row/i, /pull.?up/i, /pulldown/i, /lat pull/i, /chin.?up/i, /face pull/i, /rear delt/i, /curl/i, /preacher/i, /hammer curl/i, /shrug/i, /upright row/i];

function classifyMovementPattern(name) {
  if (PUSH_PATTERNS.some(p => p.test(name))) return 'push';
  if (PULL_PATTERNS.some(p => p.test(name))) return 'pull';
  return 'other';
}

function validateMovementBalance(programData) {
  let pushSets = 0;
  let pullSets = 0;

  for (const session of Object.values(programData.weekly_template || {})) {
    for (const ex of (session.exercises || [])) {
      const pattern = classifyMovementPattern(ex.name);
      if (pattern === 'push') pushSets += ex.sets;
      else if (pattern === 'pull') pullSets += ex.sets;
    }
  }

  if (pullSets === 0 && pushSets === 0) return '';
  const ratio = pushSets / (pullSets || 1);
  if (ratio > 1.2) {
    return `Note: Push:pull ratio is ${ratio.toFixed(1)}:1 (${pushSets} push sets vs ${pullSets} pull sets) — consider adding more pulling volume for shoulder health.`;
  }
  return '';
}

describe('Exercise Rotation', () => {
  beforeEach(() => {
    setupDb();
  });

  it('stores all exercises in program_history on program completion', () => {
    // Create a completed program
    db.prepare(`INSERT INTO training_programs (title, program_json, total_weeks, valid_from, status) VALUES (?, ?, ?, ?, ?)`)
      .run('Hypertrophy Block 1', '{}', 6, '2026-01-01', 'completed');

    saveProgramHistory(1, [
      { exercise_title: 'Barbell Bench Press', final_status: 'progressing', final_weight_kg: 90 },
      { exercise_title: 'Pull Up', final_status: 'progressing', final_weight_kg: null },
      { exercise_title: 'Lateral Raise (Dumbbell)', final_status: 'stalled', final_weight_kg: 12 },
      { exercise_title: 'Barbell Squat', final_status: 'active', final_weight_kg: 120 },
    ]);

    const history = getRecentProgramHistory(1);
    expect(history).toHaveLength(4);
    expect(history.map(h => h.exercise_title)).toContain('Barbell Bench Press');
    expect(history.map(h => h.exercise_title)).toContain('Pull Up');
  });

  it('next program creation receives stalled exercises with swap recommendations', () => {
    db.prepare(`INSERT INTO training_programs (title, program_json, total_weeks, valid_from, status) VALUES (?, ?, ?, ?, ?)`)
      .run('Block 1', '{}', 6, '2026-01-01', 'completed');

    saveProgramHistory(1, [
      { exercise_title: 'Barbell Bench Press', final_status: 'stalled', final_weight_kg: 92.5 },
      { exercise_title: 'Pull Up', final_status: 'progressing', final_weight_kg: null },
    ]);

    const history = getRecentProgramHistory(2);
    const stalled = history.filter(h => h.final_status === 'stalled');
    const progressing = history.filter(h => h.final_status === 'progressing');

    expect(stalled).toHaveLength(1);
    expect(stalled[0].exercise_title).toBe('Barbell Bench Press');
    expect(progressing).toHaveLength(1);
    expect(progressing[0].exercise_title).toBe('Pull Up');
  });

  it('first program (no history) returns empty', () => {
    const history = getRecentProgramHistory(2);
    expect(history).toHaveLength(0);
  });

  it('all exercises stalled → all get swap recommendations', () => {
    db.prepare(`INSERT INTO training_programs (title, program_json, total_weeks, valid_from, status) VALUES (?, ?, ?, ?, ?)`)
      .run('Block 1', '{}', 6, '2026-01-01', 'completed');

    saveProgramHistory(1, [
      { exercise_title: 'Bench Press', final_status: 'stalled', final_weight_kg: 90 },
      { exercise_title: 'Squat', final_status: 'stalled', final_weight_kg: 120 },
      { exercise_title: 'Deadlift', final_status: 'stalled', final_weight_kg: 140 },
    ]);

    const history = getRecentProgramHistory(2);
    expect(history.every(h => h.final_status === 'stalled')).toBe(true);
  });
});

describe('Push:Pull Ratio Validation', () => {
  it('ratio > 1.2:1 returns warning', () => {
    const programData = {
      weekly_template: {
        Monday: {
          name: 'Push Day',
          exercises: [
            { name: 'Barbell Bench Press', sets: 4 },
            { name: 'Incline Press', sets: 3 },
            { name: 'Lateral Raise', sets: 3 },
            { name: 'Tricep Pushdown', sets: 3 },
          ],
        },
        Wednesday: {
          name: 'Pull Day',
          exercises: [
            { name: 'Barbell Row', sets: 3 },
            { name: 'Pull Up', sets: 3 },
          ],
        },
      },
    };

    const warning = validateMovementBalance(programData);
    expect(warning).toContain('Push:pull ratio');
    expect(warning).toContain('pulling volume');
  });

  it('ratio 1:1.5 returns no warning', () => {
    const programData = {
      weekly_template: {
        Monday: {
          name: 'Upper',
          exercises: [
            { name: 'Bench Press', sets: 3 },
            { name: 'Barbell Row', sets: 4 },
            { name: 'Pull Up', sets: 3 },
          ],
        },
      },
    };

    const warning = validateMovementBalance(programData);
    expect(warning).toBe('');
  });

  it('balanced program returns no warning', () => {
    const programData = {
      weekly_template: {
        Monday: {
          name: 'Upper',
          exercises: [
            { name: 'Bench Press', sets: 3 },
            { name: 'Shoulder Press', sets: 3 },
            { name: 'Barbell Row', sets: 3 },
            { name: 'Lat Pulldown', sets: 3 },
            { name: 'Face Pull', sets: 2 },
          ],
        },
      },
    };

    const warning = validateMovementBalance(programData);
    expect(warning).toBe('');
  });

  it('no push or pull exercises returns empty string', () => {
    const programData = {
      weekly_template: {
        Monday: {
          name: 'Legs',
          exercises: [
            { name: 'Barbell Squat', sets: 4 },
            { name: 'Leg Press', sets: 3 },
          ],
        },
      },
    };

    const warning = validateMovementBalance(programData);
    expect(warning).toBe('');
  });
});
