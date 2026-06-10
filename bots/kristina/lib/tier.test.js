/**
 * Tests for the priority-tier helper (Phase A: prioritization signal, no money).
 */
import { describe, it, expect } from 'vitest';
import { normalizeTier, rankScore, tierTag, TIER_WEIGHT } from './tier.js';

describe('normalizeTier', () => {
  it('canonicalizes synonyms', () => {
    expect(normalizeTier('drop everything')).toBe('P0');
    expect(normalizeTier('URGENT')).toBe('P0');
    expect(normalizeTier('critical')).toBe('P0');
    expect(normalizeTier('high')).toBe('IMPORTANT');
    expect(normalizeTier('P1')).toBe('IMPORTANT');
    expect(normalizeTier('whenever')).toBe('ROUTINE');
    expect(normalizeTier('low')).toBe('ROUTINE');
    expect(normalizeTier('normal')).toBe('STANDARD');
  });
  it('defaults/invalid → STANDARD', () => {
    expect(normalizeTier(undefined)).toBe('STANDARD');
    expect(normalizeTier('')).toBe('STANDARD');
    expect(normalizeTier('banana')).toBe('STANDARD');
  });
  it('canonical values pass through', () => {
    for (const t of ['ROUTINE', 'STANDARD', 'IMPORTANT', 'P0']) expect(normalizeTier(t)).toBe(t);
  });
});

describe('rankScore — WSJF ordering', () => {
  const now = new Date('2026-06-09T12:00:00Z');
  it('higher tier outranks lower at equal urgency', () => {
    expect(rankScore({ priorityTier: 'P0' }, now)).toBeGreaterThan(rankScore({ priorityTier: 'IMPORTANT' }, now));
    expect(rankScore({ priorityTier: 'IMPORTANT' }, now)).toBeGreaterThan(rankScore({ priorityTier: 'STANDARD' }, now));
    expect(rankScore({ priorityTier: 'STANDARD' }, now)).toBeGreaterThan(rankScore({ priorityTier: 'ROUTINE' }, now));
  });
  it('overdue outranks far-future at equal tier', () => {
    const overdue = { priorityTier: 'STANDARD', deadline: '2026-06-08' };
    const future = { priorityTier: 'STANDARD', deadline: '2026-12-31' };
    expect(rankScore(overdue, now)).toBeGreaterThan(rankScore(future, now));
  });
  it('an urgent STANDARD can outrank a far-future IMPORTANT? (sanity: tier still dominates by design)', () => {
    // IMPORTANT (3×) far-future vs STANDARD (1×) overdue — IMPORTANT base weight 3
    // × (1+0.5)=4.5 vs STANDARD 1×(1+3)=4 → IMPORTANT still wins. Tier-dominant.
    const impFuture = rankScore({ priorityTier: 'IMPORTANT', deadline: '2026-12-31' }, now);
    const stdOverdue = rankScore({ priorityTier: 'STANDARD', deadline: '2026-06-08' }, now);
    expect(impFuture).toBeGreaterThan(stdOverdue);
  });
  it('reads either priorityTier or priority_tier shape', () => {
    expect(rankScore({ priority_tier: 'P0' }, now)).toBe(TIER_WEIGHT.P0 * (1 + 0));
  });
});

describe('tierTag', () => {
  it('tags non-standard tiers, blanks STANDARD', () => {
    expect(tierTag('P0')).toContain('P0');
    expect(tierTag('IMPORTANT')).toContain('IMP');
    expect(tierTag('STANDARD')).toBe('');
    expect(tierTag('ROUTINE')).toContain('routine');
  });
});
