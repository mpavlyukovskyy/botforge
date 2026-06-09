/**
 * Tests for the Atlas-presence bleed-stopper (lib/presence.js).
 * Guards the 2026-06-09 incident: ghost tasks (local rows whose spok_id is
 * absent from Atlas) must be skipped by the financial/nudge crons, and the
 * crons must refuse to act when Atlas can't be verified.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the raw Atlas fetch the guard depends on.
vi.mock('./atlas-client.js', () => ({
  fetchAtlasLiveIds: vi.fn(),
}));

import { fetchAtlasLiveIds } from './atlas-client.js';
import { loadAtlasPresence, shouldSkipRun, PRESENCE_ENABLED } from './presence.js';

const ctx = { log: { warn: () => {} } };

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.clearAllMocks(); });

describe('loadAtlasPresence — ghost detection', () => {
  it('skips a task whose spok_id is absent from Atlas (the ghost)', async () => {
    fetchAtlasLiveIds.mockResolvedValue(new Set(['cuid_live']));
    const p = await loadAtlasPresence(ctx);
    expect(p.available).toBe(true);
    expect(p.skip({ spok_id: 'cuid_dead' })).toBe(true);   // ghost
    expect(p.skip({ spok_id: 'cuid_live' })).toBe(false);  // present
  });

  it('NEVER skips a not-yet-synced row (spok_id null/empty)', async () => {
    fetchAtlasLiveIds.mockResolvedValue(new Set(['cuid_live']));
    const p = await loadAtlasPresence(ctx);
    expect(p.skip({ spok_id: null })).toBe(false);
    expect(p.skip({ spok_id: undefined })).toBe(false);
    expect(p.skip({ spok_id: '' })).toBe(false);
    expect(p.skip({})).toBe(false);
  });
});

describe('loadAtlasPresence — Atlas unverifiable', () => {
  it('available=false and skip()=false when the live-id fetch returns null', async () => {
    fetchAtlasLiveIds.mockResolvedValue(null);
    const p = await loadAtlasPresence(ctx);
    expect(p.enabled).toBe(true);
    expect(p.available).toBe(false);
    expect(p.skip({ spok_id: 'anything' })).toBe(false); // never reap on uncertainty
  });

  it('shouldSkipRun is true when enabled but Atlas unverifiable (do nothing this cycle)', async () => {
    fetchAtlasLiveIds.mockResolvedValue(null);
    const p = await loadAtlasPresence(ctx);
    expect(shouldSkipRun(p)).toBe(true);
  });

  it('shouldSkipRun is false when Atlas is verifiable', async () => {
    fetchAtlasLiveIds.mockResolvedValue(new Set(['x']));
    const p = await loadAtlasPresence(ctx);
    expect(shouldSkipRun(p)).toBe(false);
  });

  it('empty Atlas board is verifiable (not the same as unverifiable) → every spok_id task is a ghost', async () => {
    fetchAtlasLiveIds.mockResolvedValue(new Set());
    const p = await loadAtlasPresence(ctx);
    expect(p.available).toBe(true);
    expect(shouldSkipRun(p)).toBe(false);
    expect(p.skip({ spok_id: 'cuid_dead' })).toBe(true);
    expect(p.skip({ spok_id: null })).toBe(false);
  });
});

describe('flag', () => {
  it('PRESENCE_ENABLED defaults on (env not "0")', () => {
    // The test runner does not set KRISTINA_EXCLUDE_ABSENT=0, so it is enabled.
    expect(PRESENCE_ENABLED).toBe(true);
  });
});
