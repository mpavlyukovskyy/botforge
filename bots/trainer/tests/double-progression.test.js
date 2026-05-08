import { describe, it, expect } from 'vitest';

// Replicate the supermajority check from daily-sync.js checkProgressions().
// The real function counts how many sets hit the top of the rep range,
// then checks if that count meets a 75% (ceil) threshold.
function checkSupermajority(sets, topRep) {
  const hitsTop = sets.filter(s => s.reps >= topRep).length;
  const threshold = Math.ceil(sets.length * 0.75);
  return hitsTop >= threshold;
}

// Replicate the progression state machine from daily-sync.js checkProgressions().
// When supermajority is hit: bump weight (if increment > 0), reset stall, mark progressing.
// When missed: increment stall_weeks, mark stalled after 3 consecutive misses.
function computeNewState(hitsSupermajority, existing, increment) {
  if (hitsSupermajority) {
    return {
      status: 'progressing',
      stall_weeks: 0,
      current_weight_kg: increment > 0 ? (existing?.current_weight_kg || 80) + increment : null,
    };
  }
  const stallWeeks = (existing?.stall_weeks || 0) + 1;
  return {
    status: stallWeeks >= 3 ? 'stalled' : 'active',
    stall_weeks: stallWeeks,
    current_weight_kg: existing?.current_weight_kg || 80,
  };
}

describe('checkSupermajority', () => {
  it('triggers when 75% of sets hit top rep (3/4 = 75%)', () => {
    const sets = [{ reps: 10 }, { reps: 10 }, { reps: 10 }, { reps: 9 }];
    expect(checkSupermajority(sets, 10)).toBe(true);
  });

  it('does not trigger when below 75% (2/4 = 50%)', () => {
    const sets = [{ reps: 10 }, { reps: 10 }, { reps: 8 }, { reps: 9 }];
    expect(checkSupermajority(sets, 10)).toBe(false);
  });

  it('triggers when all sets hit top rep (3/3 = 100%)', () => {
    const sets = [{ reps: 10 }, { reps: 10 }, { reps: 10 }];
    expect(checkSupermajority(sets, 10)).toBe(true);
  });

  it('triggers with a single set that hits top rep (1/1 = 100%)', () => {
    const sets = [{ reps: 10 }];
    expect(checkSupermajority(sets, 10)).toBe(true);
  });
});

describe('computeNewState – weight increments', () => {
  it('adds 2.5kg for compound exercises on progression', () => {
    const existing = { current_weight_kg: 90, stall_weeks: 0 };
    const result = computeNewState(true, existing, 2.5);
    expect(result.status).toBe('progressing');
    expect(result.stall_weeks).toBe(0);
    expect(result.current_weight_kg).toBe(92.5);
  });

  it('adds 1.0kg for isolation exercises on progression', () => {
    const existing = { current_weight_kg: 12, stall_weeks: 0 };
    const result = computeNewState(true, existing, 1.0);
    expect(result.status).toBe('progressing');
    expect(result.stall_weeks).toBe(0);
    expect(result.current_weight_kg).toBe(13);
  });

  it('returns null weight for bodyweight exercises (increment=0) on progression', () => {
    const existing = { current_weight_kg: null, stall_weeks: 0 };
    const result = computeNewState(true, existing, 0);
    expect(result.status).toBe('progressing');
    expect(result.stall_weeks).toBe(0);
    expect(result.current_weight_kg).toBeNull();
  });
});

describe('computeNewState – stall detection', () => {
  it('marks stalled after 3 consecutive non-progression weeks', () => {
    // Simulate week 1 miss
    const after1 = computeNewState(false, { stall_weeks: 0, current_weight_kg: 80 }, 2.5);
    expect(after1.status).toBe('active');
    expect(after1.stall_weeks).toBe(1);

    // Simulate week 2 miss
    const after2 = computeNewState(false, after1, 2.5);
    expect(after2.status).toBe('active');
    expect(after2.stall_weeks).toBe(2);

    // Simulate week 3 miss → stalled
    const after3 = computeNewState(false, after2, 2.5);
    expect(after3.status).toBe('stalled');
    expect(after3.stall_weeks).toBe(3);
  });

  it('resets stall_weeks to 0 when progression triggers after a stall', () => {
    const stalled = { stall_weeks: 3, current_weight_kg: 80, status: 'stalled' };
    const result = computeNewState(true, stalled, 2.5);
    expect(result.status).toBe('progressing');
    expect(result.stall_weeks).toBe(0);
    expect(result.current_weight_kg).toBe(82.5);
  });
});
