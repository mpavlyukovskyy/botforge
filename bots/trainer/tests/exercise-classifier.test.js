import { describe, it, expect } from 'vitest';
import { classifyExercise, inferMuscleGroupFromTitle } from '../lib/exercise-classifier.js';

describe('classifyExercise', () => {
  it('classifies barbell compound exercises', () => {
    const result = classifyExercise('Barbell Bench Press', 'barbell', 'chest');
    expect(result.category).toBe('compound');
    expect(result.increment_kg).toBe(2.5);
    expect(result.fatigue_weight).toBe(1.5);
    expect(result.recovery_hours).toBe(72);
  });

  it('classifies dumbbell isolation exercises', () => {
    const result = classifyExercise('Lateral Raise (Dumbbell)', 'dumbbell', 'shoulders');
    expect(result.category).toBe('isolation');
    expect(result.increment_kg).toBe(1);
    expect(result.fatigue_weight).toBe(0.5);
    expect(result.recovery_hours).toBe(48);
  });

  it('classifies bodyweight exercises', () => {
    const result = classifyExercise('Pull Up', 'bodyweight', 'lats');
    expect(result.category).toBe('bodyweight');
    expect(result.increment_kg).toBe(0);
    expect(result.fatigue_weight).toBe(1.0);
    expect(result.recovery_hours).toBe(72);
  });

  it('classifies machine exercises', () => {
    const result = classifyExercise('Leg Press', 'machine', 'quads');
    expect(result.category).toBe('machine');
    expect(result.increment_kg).toBe(5);
    expect(result.fatigue_weight).toBe(1.0);
    expect(result.recovery_hours).toBe(72);
  });

  it('defaults unknown equipment to compound with 2.5kg increment', () => {
    const result = classifyExercise('Some Exercise', 'unknown_thing', 'chest');
    expect(result.category).toBe('compound');
    expect(result.increment_kg).toBe(2.5);
  });

  it('falls back to title-based inference when muscle_group is null', () => {
    const result = classifyExercise('Barbell Bench Press', 'barbell', null);
    expect(result.muscle_groups).toBeDefined();
    expect(result.category).toBeDefined();
  });

  it('classifies cable isolation exercises', () => {
    const result = classifyExercise('Cable Lateral Raise', 'cable', 'shoulders');
    expect(result.category).toBe('isolation');
  });

  it('classifies barbell isolation exercises by muscle group', () => {
    const result = classifyExercise('Barbell Curl', 'barbell', 'biceps');
    expect(result.category).toBe('isolation');
  });
});

describe('inferMuscleGroupFromTitle', () => {
  it('infers chest from bench press', () => {
    expect(inferMuscleGroupFromTitle('Barbell Bench Press')).toBe('chest');
  });

  it('infers back from pull up', () => {
    expect(inferMuscleGroupFromTitle('Pull Up')).toBe('back');
  });

  it('infers legs from squat', () => {
    expect(inferMuscleGroupFromTitle('Barbell Squat')).toBe('legs');
  });

  it('returns unknown for unrecognized exercises', () => {
    expect(inferMuscleGroupFromTitle('Unknown Exercise')).toBe('unknown');
  });
});
