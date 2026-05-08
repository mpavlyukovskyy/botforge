/**
 * Tests for weekly adjustments: parse, store, and apply.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

let db;

function setupDb() {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

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
}

function saveWeeklyAdjustment(data) {
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
    data.exercises_to_watch ? JSON.stringify(data.exercises_to_watch) : null,
    data.notes ?? null
  );
}

function getWeeklyAdjustment(programId, weekNumber) {
  return db.prepare(
    'SELECT * FROM weekly_adjustments WHERE program_id = ? AND week_number = ?'
  ).get(programId, weekNumber);
}

// Parse ADJUSTMENT_JSON from mock Sonnet output
function parseAdjustmentJson(sonnetOutput) {
  const lines = sonnetOutput.split('\n');
  for (const line of lines) {
    if (line.startsWith('ADJUSTMENT_JSON:')) {
      try {
        return JSON.parse(line.slice('ADJUSTMENT_JSON:'.length).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Apply adjustment to exercises
function applyAdjustment(exercises, adjustment) {
  if (!adjustment) return exercises;
  return exercises.map(ex => ({
    ...ex,
    sets: Math.max(2, ex.sets + (adjustment.volume_delta || 0)),
    rpe_target: Math.min(10, Math.max(5, (ex.rpe_target || 7) + (adjustment.rpe_delta || 0))),
  }));
}

describe('Weekly Adjustments', () => {
  beforeEach(() => {
    setupDb();
  });

  describe('ADJUSTMENT_JSON parsing', () => {
    it('parses valid ADJUSTMENT_JSON from Sonnet output', () => {
      const output = `Great week of training! You completed 4/4 sessions.

- Bench press progressing well at 90kg
- Recovery stable around 72%

ADJUSTMENT_JSON:{"volume_delta":1,"rpe_delta":0,"recommendation":"push","exercises_to_watch":[],"notes":"Good compliance, ready to push"}`;

      const parsed = parseAdjustmentJson(output);
      expect(parsed).toEqual({
        volume_delta: 1,
        rpe_delta: 0,
        recommendation: 'push',
        exercises_to_watch: [],
        notes: 'Good compliance, ready to push',
      });
    });

    it('returns null for malformed ADJUSTMENT_JSON', () => {
      const output = `Week review here.\n\nADJUSTMENT_JSON:{broken json`;
      const parsed = parseAdjustmentJson(output);
      expect(parsed).toBeNull();
    });

    it('returns null when no ADJUSTMENT_JSON present', () => {
      const output = `Just a narrative review without structured data.`;
      const parsed = parseAdjustmentJson(output);
      expect(parsed).toBeNull();
    });
  });

  describe('Storage and retrieval', () => {
    it('stores and retrieves by program_id + week_number', () => {
      saveWeeklyAdjustment({
        program_id: 1,
        week_number: 3,
        volume_delta: 1,
        rpe_delta: 0.5,
        recommendation: 'push',
        exercises_to_watch: ['Barbell Bench Press'],
        notes: 'Good week',
      });

      const adj = getWeeklyAdjustment(1, 3);
      expect(adj).toBeTruthy();
      expect(adj.volume_delta).toBe(1);
      expect(adj.rpe_delta).toBe(0.5);
      expect(adj.recommendation).toBe('push');
      expect(JSON.parse(adj.exercises_to_watch)).toEqual(['Barbell Bench Press']);
    });

    it('returns undefined for non-existent adjustment', () => {
      const adj = getWeeklyAdjustment(1, 5);
      expect(adj).toBeUndefined();
    });

    it('upserts (replaces) on duplicate program_id + week_number', () => {
      saveWeeklyAdjustment({ program_id: 1, week_number: 3, volume_delta: 1, recommendation: 'push' });
      saveWeeklyAdjustment({ program_id: 1, week_number: 3, volume_delta: -1, recommendation: 'back_off' });

      const adj = getWeeklyAdjustment(1, 3);
      expect(adj.volume_delta).toBe(-1);
      expect(adj.recommendation).toBe('back_off');
    });
  });

  describe('Applying adjustments', () => {
    it('volume_delta=+1 adds 1 set per exercise', () => {
      const exercises = [
        { name: 'Bench Press', sets: 3, rep_range: '8-10', rpe_target: 7 },
        { name: 'Row', sets: 3, rep_range: '8-10', rpe_target: 7 },
      ];
      const adjusted = applyAdjustment(exercises, { volume_delta: 1, rpe_delta: 0 });
      expect(adjusted[0].sets).toBe(4);
      expect(adjusted[1].sets).toBe(4);
    });

    it('rpe_delta=-0.5 reduces RPE targets', () => {
      const exercises = [
        { name: 'Bench Press', sets: 3, rep_range: '8-10', rpe_target: 8 },
      ];
      const adjusted = applyAdjustment(exercises, { volume_delta: 0, rpe_delta: -0.5 });
      expect(adjusted[0].rpe_target).toBe(7.5);
    });

    it('recommendation="back_off" with volume_delta=-1 reduces volume', () => {
      const exercises = [
        { name: 'Squat', sets: 4, rep_range: '5-8', rpe_target: 8 },
      ];
      const adjusted = applyAdjustment(exercises, { volume_delta: -1, rpe_delta: -0.5, recommendation: 'back_off' });
      expect(adjusted[0].sets).toBe(3);
      expect(adjusted[0].rpe_target).toBe(7.5);
    });

    it('no adjustment → no modification', () => {
      const exercises = [
        { name: 'Bench Press', sets: 3, rep_range: '8-10', rpe_target: 7 },
      ];
      const result = applyAdjustment(exercises, null);
      expect(result).toEqual(exercises);
    });

    it('adjustment + volume ramp stack correctly (adjustment applied after)', () => {
      // Simulate: ramp adds 2 sets, then adjustment adds 1 more
      const baseExercise = { name: 'Bench Press', sets: 3, rep_range: '8-10', rpe_target: 7 };
      // After volume ramp: sets = 5
      const afterRamp = { ...baseExercise, sets: 5, rpe_target: 8 };
      // After adjustment: sets = 6
      const adjusted = applyAdjustment([afterRamp], { volume_delta: 1, rpe_delta: 0 });
      expect(adjusted[0].sets).toBe(6);
      expect(adjusted[0].rpe_target).toBe(8); // rpe_delta=0, unchanged
    });

    it('sets never drop below 2', () => {
      const exercises = [
        { name: 'Curl', sets: 2, rep_range: '10-12', rpe_target: 7 },
      ];
      const adjusted = applyAdjustment(exercises, { volume_delta: -3, rpe_delta: 0 });
      expect(adjusted[0].sets).toBe(2); // Math.max(2, 2 + (-3)) = 2
    });

    it('RPE clamped between 5 and 10', () => {
      const exercises = [
        { name: 'Bench Press', sets: 3, rep_range: '8-10', rpe_target: 9 },
      ];
      const adjusted = applyAdjustment(exercises, { volume_delta: 0, rpe_delta: 3 });
      expect(adjusted[0].rpe_target).toBe(10); // capped at 10

      const adjusted2 = applyAdjustment(exercises, { volume_delta: 0, rpe_delta: -5 });
      expect(adjusted2[0].rpe_target).toBe(5); // floored at 5
    });
  });
});
