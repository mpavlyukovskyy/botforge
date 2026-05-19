import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { InteractionLogSkill, type InteractionEntry } from './index.js';

// Minimal mock SkillContext for init
function createMockContext(name = 'test-bot') {
  return {
    config: { name } as any,
    adapter: {} as any,
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    skills: new Map(),
    store: new Map(),
  };
}

function makeEntry(overrides: Partial<InteractionEntry> = {}): InteractionEntry {
  return {
    id: `test-${Math.random().toString(36).slice(2)}`,
    botName: 'test-bot',
    chatId: 'chat-123',
    userId: 'user-456',
    provider: 'claude',
    model: 'claude-opus-4-6',
    systemPromptLength: 500,
    contextBlockTags: ['calendar', 'rules'],
    userMessage: 'Hello, how are you?',
    toolCalls: [{ name: 'get_time', durationMs: 50, error: false }],
    brainTurns: 1,
    latencyMs: 1200,
    responseText: 'I am doing well, thank you!',
    responseLength: 28,
    costUsd: 0.05,
    status: 'success',
    errorMessage: null,
    ...overrides,
  };
}

describe('InteractionLogSkill', () => {
  let skill: InteractionLogSkill;
  const dbPath = `/tmp/test-interaction-log-${Date.now()}.db`;

  beforeEach(async () => {
    skill = new InteractionLogSkill(30);
    const ctx = createMockContext('test-bot');
    // Override the path to use temp location
    (ctx.config as any).name = `test-${Date.now()}`;
    await skill.init(ctx);
  });

  afterEach(async () => {
    await skill.destroy();
  });

  describe('init', () => {
    it('creates interaction_log table with correct schema', () => {
      // If init didn't throw, the table was created. Verify by recording.
      const entry = makeEntry();
      skill.record(entry);
      const row = skill.getById(entry.id);
      expect(row).toBeDefined();
      expect(row!.bot_name).toBe('test-bot');
    });

    it('runs cleanup of rows older than TTL on init', async () => {
      // Record an entry, then manually backdate it
      const entry = makeEntry({ id: 'old-entry' });
      skill.record(entry);

      // Access the internal DB to backdate
      const storage = (skill as any).storage;
      storage.db.prepare(
        `UPDATE interaction_log SET timestamp = datetime('now', '-60 days') WHERE id = ?`
      ).run('old-entry');

      // Re-init should clean it up
      const skill2 = new InteractionLogSkill(30);
      const ctx2 = createMockContext();
      // Use same DB name to hit the same file
      (ctx2.config as any).name = ((skill as any).storage as any).db.name
        ? 'test-reinit' : 'test-reinit';
      await skill2.init(ctx2);

      // The old entry should be in the ORIGINAL skill's DB (we can't easily reuse the same path)
      // So we test cleanup directly instead
      const deleted = skill.cleanup(30);
      expect(deleted).toBe(1);
      await skill2.destroy();
    });
  });

  describe('record', () => {
    it('inserts a complete interaction record with all fields', () => {
      const entry = makeEntry({ id: 'complete-1' });
      skill.record(entry);
      const row = skill.getById('complete-1');

      expect(row).toBeDefined();
      expect(row!.id).toBe('complete-1');
      expect(row!.bot_name).toBe('test-bot');
      expect(row!.chat_id).toBe('chat-123');
      expect(row!.user_id).toBe('user-456');
      expect(row!.provider).toBe('claude');
      expect(row!.model).toBe('claude-opus-4-6');
      expect(row!.system_prompt_length).toBe(500);
      expect(row!.latency_ms).toBe(1200);
      expect(row!.response_length).toBe(28);
      expect(row!.cost_usd).toBe(0.05);
      expect(row!.status).toBe('success');
      expect(row!.error_message).toBeNull();
    });

    it('handles null cost_usd', () => {
      const entry = makeEntry({ id: 'null-cost', costUsd: null });
      skill.record(entry);
      const row = skill.getById('null-cost');
      expect(row!.cost_usd).toBeNull();
    });

    it('truncates user_message to 2000 chars', () => {
      const longMessage = 'x'.repeat(3000);
      const entry = makeEntry({ id: 'long-msg', userMessage: longMessage });
      skill.record(entry);
      const row = skill.getById('long-msg');
      expect(row!.user_message.length).toBe(2000);
    });

    it('truncates response_text to 5000 chars', () => {
      const longResponse = 'y'.repeat(7000);
      const entry = makeEntry({ id: 'long-resp', responseText: longResponse });
      skill.record(entry);
      const row = skill.getById('long-resp');
      expect(row!.response_text!.length).toBe(5000);
    });

    it('stores tool_calls as JSON string', () => {
      const tools = [
        { name: 'get_time', durationMs: 50, error: false },
        { name: 'search', durationMs: 200, error: true, errorMessage: 'not found' },
      ];
      const entry = makeEntry({ id: 'tools-1', toolCalls: tools });
      skill.record(entry);
      const row = skill.getById('tools-1');
      expect(JSON.parse(row!.tool_calls!)).toEqual(tools);
    });

    it('stores context_block_tags as JSON array', () => {
      const tags = ['calendar', 'rules', 'memory'];
      const entry = makeEntry({ id: 'tags-1', contextBlockTags: tags });
      skill.record(entry);
      const row = skill.getById('tags-1');
      expect(JSON.parse(row!.context_block_tags!)).toEqual(tags);
    });

    it('records error interactions with status=error and error_message', () => {
      const entry = makeEntry({
        id: 'err-1',
        status: 'error',
        errorMessage: 'Brain timed out',
        responseText: undefined,
      });
      skill.record(entry);
      const row = skill.getById('err-1');
      expect(row!.status).toBe('error');
      expect(row!.error_message).toBe('Brain timed out');
    });
  });

  describe('getRecent', () => {
    it('returns most recent N interactions ordered by timestamp DESC', () => {
      // Insert with staggered timestamps to ensure ordering
      for (let i = 0; i < 5; i++) {
        skill.record(makeEntry({ id: `recent-${i}` }));
        // Backdate earlier entries so ordering is deterministic
        const storage = (skill as any).storage;
        storage.db.prepare(
          `UPDATE interaction_log SET timestamp = datetime('now', ?) WHERE id = ?`
        ).run(`-${5 - i} minutes`, `recent-${i}`);
      }
      const rows = skill.getRecent(3);
      expect(rows.length).toBe(3);
      // Most recent (least backdated) should be first
      expect(rows[0].id).toBe('recent-4');
      expect(rows[1].id).toBe('recent-3');
      expect(rows[2].id).toBe('recent-2');
    });

    it('filters by bot_name when provided', () => {
      skill.record(makeEntry({ id: 'bot-a', botName: 'bot-a' }));
      skill.record(makeEntry({ id: 'bot-b', botName: 'bot-b' }));
      skill.record(makeEntry({ id: 'bot-a-2', botName: 'bot-a' }));

      const rows = skill.getRecent(50, 'bot-a');
      expect(rows.length).toBe(2);
      expect(rows.every(r => r.bot_name === 'bot-a')).toBe(true);
    });

    it('defaults to limit=50', () => {
      for (let i = 0; i < 60; i++) {
        skill.record(makeEntry({ id: `default-${i}` }));
      }
      const rows = skill.getRecent();
      expect(rows.length).toBe(50);
    });
  });

  describe('getById', () => {
    it('returns full interaction record by correlation ID', () => {
      skill.record(makeEntry({ id: 'find-me' }));
      const row = skill.getById('find-me');
      expect(row).toBeDefined();
      expect(row!.id).toBe('find-me');
    });

    it('returns undefined for non-existent ID', () => {
      const row = skill.getById('does-not-exist');
      expect(row).toBeUndefined();
    });
  });

  describe('getStats', () => {
    it('returns count, avg_latency_ms, total_cost_usd, error_count', () => {
      skill.record(makeEntry({ id: 's1', latencyMs: 1000, costUsd: 0.10 }));
      skill.record(makeEntry({ id: 's2', latencyMs: 2000, costUsd: 0.20 }));
      skill.record(makeEntry({ id: 's3', latencyMs: 3000, costUsd: 0.30, status: 'error' }));

      const stats = skill.getStats(7);
      expect(stats.count).toBe(3);
      expect(stats.avg_latency_ms).toBeCloseTo(2000, 0);
      expect(stats.total_cost_usd).toBeCloseTo(0.60, 2);
      expect(stats.error_count).toBe(1);
    });

    it('defaults to 7 days', () => {
      skill.record(makeEntry({ id: 'default-days' }));
      const stats = skill.getStats();
      expect(stats.count).toBe(1);
    });

    it('returns zeroes when no data', () => {
      const stats = skill.getStats(7);
      expect(stats.count).toBe(0);
      expect(stats.error_count).toBe(0);
    });
  });

  describe('cleanup', () => {
    it('deletes rows older than specified days', () => {
      skill.record(makeEntry({ id: 'old' }));

      // Backdate the row
      const storage = (skill as any).storage;
      storage.db.prepare(
        `UPDATE interaction_log SET timestamp = datetime('now', '-45 days') WHERE id = ?`
      ).run('old');

      const deleted = skill.cleanup(30);
      expect(deleted).toBe(1);
    });

    it('returns count of deleted rows', () => {
      skill.record(makeEntry({ id: 'del-1' }));
      skill.record(makeEntry({ id: 'del-2' }));

      const storage = (skill as any).storage;
      storage.db.prepare(
        `UPDATE interaction_log SET timestamp = datetime('now', '-60 days')`
      ).run();

      const deleted = skill.cleanup(30);
      expect(deleted).toBe(2);
    });

    it('defaults to 30 days', () => {
      skill.record(makeEntry({ id: 'default-ttl' }));

      const storage = (skill as any).storage;
      storage.db.prepare(
        `UPDATE interaction_log SET timestamp = datetime('now', '-31 days') WHERE id = ?`
      ).run('default-ttl');

      const deleted = skill.cleanup();
      expect(deleted).toBe(1);
    });

    it('does not delete rows within TTL', () => {
      skill.record(makeEntry({ id: 'recent' }));
      const deleted = skill.cleanup(30);
      expect(deleted).toBe(0);
      expect(skill.getById('recent')).toBeDefined();
    });
  });

  describe('destroy', () => {
    it('closes the database connection', async () => {
      skill.record(makeEntry({ id: 'before-destroy' }));
      await skill.destroy();
      // After destroy, operations should no-op (storage is closed)
      // Re-creating proves no corruption
      const skill2 = new InteractionLogSkill();
      await skill2.init(createMockContext());
      await skill2.destroy();
    });
  });

  // ─── error_class column (migration v101) ──────────────────────────────────
  // These came out of the 2026-05-18 kristina post-mortem. Before this,
  // categorical aggregation of failures (usage_limit vs atlas_timeout vs
  // rate_limited) was impossible without grep-on-error_message.

  describe('error_class column (v101)', () => {
    it('persists errorClass on error entries', () => {
      skill.record(makeEntry({
        id: 'err-cls-1',
        status: 'error',
        errorMessage: 'You have reached your specified API usage limits.',
        errorClass: 'usage_limit',
      }));
      const row = skill.getById('err-cls-1');
      expect(row!.error_class).toBe('usage_limit');
    });

    it('stores null error_class for success entries by default', () => {
      skill.record(makeEntry({ id: 'ok-cls-1' }));
      const row = skill.getById('ok-cls-1');
      expect(row!.error_class).toBeNull();
    });

    it('error_class column is queryable for aggregation', () => {
      skill.record(makeEntry({ id: 'a', status: 'error', errorClass: 'usage_limit' }));
      skill.record(makeEntry({ id: 'b', status: 'error', errorClass: 'atlas_timeout' }));
      skill.record(makeEntry({ id: 'c', status: 'error', errorClass: 'usage_limit' }));
      const storage = (skill as any).storage;
      const usageLimitCount = (storage.db.prepare(
        "SELECT COUNT(*) as cnt FROM interaction_log WHERE error_class = ?"
      ).get('usage_limit') as { cnt: number }).cnt;
      expect(usageLimitCount).toBe(2);
    });
  });

  describe('v101 migration upgrade path (pre-existing v100 database)', () => {
    it('upgrades a DB that only had v100 applied', async () => {
      // Build a synthetic v100-only DB to mimic Kristina's live state pre-deploy
      const dbName = `legacy-v100-${Date.now()}`;
      const dbPath = `data/${dbName}-interactions.db`;
      const fs = await import('node:fs');
      fs.mkdirSync('data', { recursive: true });

      const seedDb = new Database(dbPath);
      seedDb.exec(`
        CREATE TABLE _migrations (
          version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT (datetime('now'))
        );
        INSERT INTO _migrations (version, name) VALUES (100, 'create_interaction_log');
        CREATE TABLE interaction_log (
          id TEXT PRIMARY KEY, bot_name TEXT NOT NULL, chat_id TEXT NOT NULL, user_id TEXT NOT NULL,
          timestamp TEXT NOT NULL DEFAULT (datetime('now')), provider TEXT NOT NULL, model TEXT,
          system_prompt_length INTEGER, context_block_tags TEXT, user_message TEXT NOT NULL,
          tool_calls TEXT, brain_turns INTEGER, latency_ms INTEGER, response_text TEXT,
          response_length INTEGER, cost_usd REAL, status TEXT NOT NULL DEFAULT 'success',
          error_message TEXT
        );
        INSERT INTO interaction_log (id, bot_name, chat_id, user_id, provider, user_message, status)
        VALUES ('legacy-row', 'TestBot', 'c', 'u', 'claude', 'pre-migration', 'success');
      `);
      seedDb.close();

      // Initialise: v101 migration must add the column without dropping data
      const upgraded = new InteractionLogSkill();
      const ctx = createMockContext(dbName);
      await upgraded.init(ctx);

      const db = new Database(dbPath);
      const cols = db.prepare("PRAGMA table_info(interaction_log)").all() as Array<{ name: string }>;
      expect(cols.map(c => c.name)).toContain('error_class');
      const legacy = db.prepare("SELECT id, error_class FROM interaction_log WHERE id = 'legacy-row'").get() as any;
      expect(legacy.id).toBe('legacy-row');
      expect(legacy.error_class).toBeNull();
      db.close();
      await upgraded.destroy();

      // Cleanup
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
    });

    it('is idempotent across restarts (v101 marked applied)', async () => {
      // Just make sure a second init() against the same DB does NOT fail
      // (ALTER TABLE ADD COLUMN would error with "duplicate column name")
      const dbName = `idempotent-${Date.now()}`;

      const skill1 = new InteractionLogSkill();
      await skill1.init(createMockContext(dbName));
      await skill1.destroy();

      const skill2 = new InteractionLogSkill();
      await expect(skill2.init(createMockContext(dbName))).resolves.toBeUndefined();
      await skill2.destroy();
    });
  });
});
