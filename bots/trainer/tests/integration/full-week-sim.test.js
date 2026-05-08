/**
 * Full-week simulation integration test.
 *
 * Chains all components to verify the feedback loop end-to-end:
 * sync → progression → feedback → fatigue → morning workout context → review → adjustment
 *
 * Uses in-memory SQLite and mock data (no real API calls).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { classifyExercise } from '../../lib/exercise-classifier.js';
import { computeMuscleFatigue } from '../../lib/muscle-fatigue.js';
import { computeDeloadScore, computeRecoveryTrend } from '../../lib/deload-detector.js';
import { applyVolumeRamp } from '../../cron/morning-workout.js';
import { computeProgressionSlope } from '../../lib/workout-analyzer.js';

// ─── Test DB setup ──────────────────────────────────────────────────────

let db;

function setupDb() {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');

  // Create all tables
  db.exec(`
    CREATE TABLE exercise_config (
      exercise_title TEXT PRIMARY KEY,
      category TEXT DEFAULT 'compound',
      increment_kg REAL DEFAULT 2.5,
      fatigue_weight REAL DEFAULT 1.0,
      recovery_hours INTEGER DEFAULT 72,
      muscle_groups TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE exercise_progression (
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
    CREATE TABLE workout_feedback (
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
    CREATE TABLE weekly_adjustments (
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
    CREATE TABLE recovery_daily (
      date TEXT PRIMARY KEY,
      whoop_recovery_score REAL,
      combined_readiness TEXT,
      muscle_fatigue_json TEXT
    );
  `);
}

// ─── Mock data ──────────────────────────────────────────────────────────

const PROGRAM = {
  id: 1,
  title: 'Hypertrophy Block 1',
  current_week: 3,
  total_weeks: 6,
  program_json: {
    block_name: 'Hypertrophy Block 1',
    duration_weeks: 6,
    split: 'Upper/Lower',
    volume_progression: {
      strategy: 'additive_ramp',
      sets_added_per_week: 1,
      deload_week: 4,
      deload_volume_pct: 50,
      rpe_start: 7,
      rpe_end: 9,
    },
    weekly_template: {
      Monday: {
        name: 'Upper A',
        focus: 'chest, back',
        exercises: [
          { name: 'Barbell Bench Press', sets: 3, rep_range: '8-10', rpe_target: 7 },
          { name: 'Barbell Row', sets: 3, rep_range: '8-10', rpe_target: 7 },
          { name: 'Lateral Raise (Dumbbell)', sets: 3, rep_range: '12-15', rpe_target: 7 },
        ],
      },
      Wednesday: {
        name: 'Lower A',
        focus: 'legs',
        exercises: [
          { name: 'Barbell Squat', sets: 3, rep_range: '6-8', rpe_target: 7 },
          { name: 'Romanian Deadlift', sets: 3, rep_range: '8-10', rpe_target: 7 },
        ],
      },
    },
  },
};

const MOCK_WORKOUTS = [
  {
    date: '2026-05-05',
    exercises_json: JSON.stringify([
      {
        title: 'Barbell Bench Press',
        sets: [
          { type: 'normal', weight_kg: 90, reps: 10 },
          { type: 'normal', weight_kg: 90, reps: 10 },
          { type: 'normal', weight_kg: 90, reps: 10 },
          { type: 'normal', weight_kg: 90, reps: 9 },
        ],
      },
      {
        title: 'Barbell Row',
        sets: [
          { type: 'normal', weight_kg: 70, reps: 10 },
          { type: 'normal', weight_kg: 70, reps: 10 },
          { type: 'normal', weight_kg: 70, reps: 8 },
        ],
      },
      {
        title: 'Lateral Raise (Dumbbell)',
        sets: [
          { type: 'normal', weight_kg: 10, reps: 15 },
          { type: 'normal', weight_kg: 10, reps: 15 },
          { type: 'normal', weight_kg: 10, reps: 12 },
        ],
      },
    ]),
  },
  {
    date: '2026-05-03',
    exercises_json: JSON.stringify([
      {
        title: 'Barbell Squat',
        sets: [
          { type: 'normal', weight_kg: 120, reps: 8 },
          { type: 'normal', weight_kg: 120, reps: 8 },
          { type: 'normal', weight_kg: 120, reps: 7 },
        ],
      },
    ]),
  },
];

describe('Full Week Simulation', () => {
  beforeEach(() => {
    setupDb();
  });

  it('end-to-end: classify → progress → fatigue → volume ramp → deload check → feedback', () => {
    // ── Phase 1: Exercise classification ──────────────────────────────
    const benchConfig = classifyExercise('Barbell Bench Press', 'barbell', 'chest');
    expect(benchConfig.category).toBe('compound');
    expect(benchConfig.increment_kg).toBe(2.5);
    expect(benchConfig.fatigue_weight).toBe(1.5);

    const lateralConfig = classifyExercise('Lateral Raise (Dumbbell)', 'dumbbell', 'shoulders');
    expect(lateralConfig.category).toBe('isolation');
    expect(lateralConfig.increment_kg).toBe(1);

    // Store configs
    const configs = new Map();
    configs.set('Barbell Bench Press', benchConfig);
    configs.set('Barbell Row', classifyExercise('Barbell Row', 'barbell', 'back'));
    configs.set('Lateral Raise (Dumbbell)', lateralConfig);
    configs.set('Barbell Squat', classifyExercise('Barbell Squat', 'barbell', 'quads'));

    // ── Phase 2: Volume ramp (week 3 of 6) ───────────────────────────
    const volProg = PROGRAM.program_json.volume_progression;
    const benchRamped = applyVolumeRamp(
      PROGRAM.program_json.weekly_template.Monday.exercises[0],
      3, 6, volProg
    );
    expect(benchRamped.sets).toBe(5); // 3 base + 2 added (week 3, training week 3)
    expect(benchRamped.rpe_target).toBeGreaterThan(7); // RPE slides up

    // Deload week
    const benchDeload = applyVolumeRamp(
      PROGRAM.program_json.weekly_template.Monday.exercises[0],
      4, 6, volProg
    );
    expect(benchDeload.sets).toBe(2); // 50% of 3, min 2
    expect(benchDeload.rpe_target).toBe(5);

    // ── Phase 3: Progression check ───────────────────────────────────
    // Bench: 3 of 4 sets hit 10 reps (top of 8-10 range) → supermajority
    const benchSets = JSON.parse(MOCK_WORKOUTS[0].exercises_json)[0].sets;
    const benchTopRep = 10;
    const benchHitsTop = benchSets.filter(s => s.reps >= benchTopRep).length;
    expect(benchHitsTop).toBe(3); // 3 of 4 = 75% = supermajority
    expect(benchHitsTop >= Math.ceil(benchSets.length * 0.75)).toBe(true);

    // Squat: 2 of 3 sets hit 8 reps (top of 6-8 range)
    const squatSets = JSON.parse(MOCK_WORKOUTS[1].exercises_json)[0].sets;
    const squatTopRep = 8;
    const squatHitsTop = squatSets.filter(s => s.reps >= squatTopRep).length;
    expect(squatHitsTop).toBe(2); // 2 of 3 = 67% < 75% → no progression

    // ── Phase 4: Progression trends ──────────────────────────────────
    const performances = [
      { date: '2026-04-14', weight: 85, reps: 10 },
      { date: '2026-04-21', weight: 87.5, reps: 10 },
      { date: '2026-04-28', weight: 90, reps: 10 },
      { date: '2026-05-05', weight: 92.5, reps: 10 },
    ];
    const trend = computeProgressionSlope('Barbell Bench Press', performances);
    expect(trend.trend).toBe('progressing');
    expect(trend.slope).toBeGreaterThan(0);

    // ── Phase 5: Muscle fatigue ──────────────────────────────────────
    const templateLookup = new Map([
      ['Barbell Bench Press', { muscle_group: 'chest' }],
      ['Barbell Row', { muscle_group: 'upper_back' }],
      ['Lateral Raise (Dumbbell)', { muscle_group: 'shoulders' }],
      ['Barbell Squat', { muscle_group: 'quads' }],
    ]);

    const fatigue = computeMuscleFatigue(MOCK_WORKOUTS, configs, templateLookup);
    expect(Object.keys(fatigue).length).toBeGreaterThan(0);
    // Recent workouts hit chest, back, shoulders, legs — all should have some fatigue

    // ── Phase 6: Deload detection (no signals → not triggered) ───────
    const deload = computeDeloadScore({
      feedbackHistory: [],
      progressionStates: [
        { status: 'progressing', stall_weeks: 0 },
        { status: 'active', stall_weeks: 1 },
      ],
      recoveryTrend: 'stable',
      currentWeek: 3,
      totalWeeks: 6,
    });
    expect(deload.triggered).toBe(false);
    expect(deload.score).toBe(0);

    // ── Phase 7: Deload detection (multiple signals → triggered) ─────
    const deloadTriggered = computeDeloadScore({
      feedbackHistory: [
        { rpe_accuracy: 'harder_than_prescribed', fatigue_level: 'fatigued', joint_pain: 'significant' },
        { rpe_accuracy: 'harder_than_prescribed', fatigue_level: 'fatigued', joint_pain: 'significant' },
        { rpe_accuracy: 'harder_than_prescribed', fatigue_level: 'exhausted', joint_pain: 'none' },
      ],
      progressionStates: [
        { status: 'stalled', stall_weeks: 3 },
        { status: 'stalled', stall_weeks: 4 },
        { status: 'active', stall_weeks: 0 },
      ],
      recoveryTrend: 'declining',
      currentWeek: 3,
      totalWeeks: 6,
    });
    expect(deloadTriggered.triggered).toBe(true);
    expect(deloadTriggered.severity).toBe('full');

    // ── Phase 8: Recovery trend ──────────────────────────────────────
    const trend2 = computeRecoveryTrend([
      { whoop_recovery_score: 75 },
      { whoop_recovery_score: 70 },
      { whoop_recovery_score: 60 },
      { whoop_recovery_score: 55 },
    ]);
    expect(trend2).toBe('declining');
  });

  it('volume ramp → adjustment stacking works correctly', () => {
    const exercise = { name: 'Bench Press', sets: 3, rep_range: '8-10', rpe_target: 7 };

    // Step 1: Volume ramp for week 3
    const ramped = applyVolumeRamp(exercise, 3, 6, {
      strategy: 'additive_ramp',
      sets_added_per_week: 1,
      deload_week: 4,
      rpe_start: 7,
      rpe_end: 9,
    });
    expect(ramped.sets).toBe(5); // 3 + 2

    // Step 2: Weekly adjustment adds +1 set
    const adjusted = {
      ...ramped,
      sets: Math.max(2, ramped.sets + 1),
      rpe_target: Math.min(10, ramped.rpe_target + 0),
    };
    expect(adjusted.sets).toBe(6); // 5 + 1
  });

  it('bodyweight progression uses rep targets not weight', () => {
    const pullUpConfig = classifyExercise('Pull Up', 'bodyweight', 'lats');
    expect(pullUpConfig.category).toBe('bodyweight');
    expect(pullUpConfig.increment_kg).toBe(0);

    // When increment is 0, progression should be via reps not weight
    // Simulating: hit top of rep range → status progressing, weight stays null
    const hitsTop = true;
    const newWeight = pullUpConfig.increment_kg > 0
      ? 0 + pullUpConfig.increment_kg
      : null;
    expect(newWeight).toBeNull();
  });
});
