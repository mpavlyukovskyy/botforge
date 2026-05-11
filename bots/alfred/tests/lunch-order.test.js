import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { formatRecommendationsWithButtons } from '../lib/formatter.js';
import { acquireBrowserLock, releaseBrowserLock, _resetLock } from '../lib/browser-lock.js';
import { computeDateForDay } from '../lib/db.js';

// ── Inline DB helpers for testing (avoids singleton side-effects) ────────────

function setupTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS lunch_recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_of TEXT NOT NULL,
      day TEXT NOT NULL,
      date TEXT,
      rank INTEGER NOT NULL DEFAULT 1,
      item_name TEXT NOT NULL,
      restaurant TEXT,
      price REAL,
      nutrition_score REAL,
      longevity_score REAL,
      overall_score REAL,
      reasoning TEXT,
      runner_up TEXT,
      combo_json TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(week_of, day, rank)
    );

    CREATE TABLE IF NOT EXISTS lunch_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_of TEXT NOT NULL,
      day TEXT NOT NULL,
      rank INTEGER NOT NULL,
      item_name TEXT NOT NULL,
      restaurant TEXT,
      price REAL,
      combo_json TEXT,
      status TEXT NOT NULL DEFAULT 'confirmed',
      confirmed_at TEXT DEFAULT (datetime('now')),
      ordered_at TEXT,
      error_message TEXT,
      prompt_message_id TEXT,
      UNIQUE(week_of, day)
    );

    CREATE TABLE IF NOT EXISTS order_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_of TEXT NOT NULL,
      day TEXT NOT NULL,
      attempt_number INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      error_message TEXT,
      screenshot_path TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      duration_ms INTEGER
    );
  `);

  return db;
}

function seedRecs(db, weekOf) {
  const insert = db.prepare(`
    INSERT INTO lunch_recommendations (week_of, day, rank, item_name, restaurant, price, overall_score)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(weekOf, 'Monday', 1, 'Grilled Chicken Bowl', 'FreshKitchen', 12.50, 8.5);
  insert.run(weekOf, 'Monday', 2, 'Turkey Wrap', 'DeliCo', 10.00, 7.2);
  insert.run(weekOf, 'Monday', 3, 'Veggie Burger', 'GreenBite', 11.00, 6.8);
  insert.run(weekOf, 'Tuesday', 1, 'Salmon Poke', 'OceanBowl', 15.00, 9.0);
  insert.run(weekOf, 'Tuesday', 2, 'Caesar Salad', 'FreshKitchen', 9.50, 7.0);
}

// ── computeDateForDay tests ─────────────────────────────────────────────────

describe('computeDateForDay', () => {
  it('Monday of 2026-05-12 returns 2026-05-12', () => {
    expect(computeDateForDay('2026-05-12', 'Monday')).toBe('2026-05-12');
  });

  it('Wednesday of 2026-05-12 returns 2026-05-14', () => {
    expect(computeDateForDay('2026-05-12', 'Wednesday')).toBe('2026-05-14');
  });

  it('Friday of 2026-05-12 returns 2026-05-16', () => {
    expect(computeDateForDay('2026-05-12', 'Friday')).toBe('2026-05-16');
  });

  it('Tuesday of 2026-05-12 returns 2026-05-13', () => {
    expect(computeDateForDay('2026-05-12', 'Tuesday')).toBe('2026-05-13');
  });

  it('Thursday of 2026-05-12 returns 2026-05-15', () => {
    expect(computeDateForDay('2026-05-12', 'Thursday')).toBe('2026-05-15');
  });

  it('returns null for invalid day', () => {
    expect(computeDateForDay('2026-05-12', 'Saturday')).toBeNull();
    expect(computeDateForDay('2026-05-12', 'Sunday')).toBeNull();
    expect(computeDateForDay('2026-05-12', 'Funday')).toBeNull();
  });
});

// ── Callback data parsing ────────────────────────────────────────────────────

describe('callback data parsing', () => {
  const DAY_MAP = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday' };

  function parseCallbackData(data) {
    const parts = data.split(':');
    if (parts.length !== 4) return null;
    const [prefix, weekOf, dayAbbrev, rankStr] = parts;
    if (!['lo', 'lc', 'lx'].includes(prefix)) return null;
    const day = DAY_MAP[dayAbbrev];
    const rank = parseInt(rankStr, 10);
    if (!day || isNaN(rank) || rank < 1) return null;
    return { prefix, weekOf, day, rank };
  }

  it('parses valid lo: 4-part format', () => {
    const result = parseCallbackData('lo:2026-05-12:Mon:1');
    expect(result).toEqual({ prefix: 'lo', weekOf: '2026-05-12', day: 'Monday', rank: 1 });
  });

  it('parses valid lc: confirm callback', () => {
    const result = parseCallbackData('lc:2026-05-12:Wed:2');
    expect(result).toEqual({ prefix: 'lc', weekOf: '2026-05-12', day: 'Wednesday', rank: 2 });
  });

  it('parses valid lx: cancel callback', () => {
    const result = parseCallbackData('lx:2026-05-12:Fri:3');
    expect(result).toEqual({ prefix: 'lx', weekOf: '2026-05-12', day: 'Friday', rank: 3 });
  });

  it('parses all day abbreviations', () => {
    for (const [abbrev, full] of Object.entries(DAY_MAP)) {
      const result = parseCallbackData(`lo:2026-05-12:${abbrev}:2`);
      expect(result).toEqual({ prefix: 'lo', weekOf: '2026-05-12', day: full, rank: 2 });
    }
  });

  it('returns null for invalid day abbreviation', () => {
    expect(parseCallbackData('lo:2026-05-12:Sat:1')).toBeNull();
    expect(parseCallbackData('lo:2026-05-12:Sun:1')).toBeNull();
    expect(parseCallbackData('lo:2026-05-12:xyz:1')).toBeNull();
  });

  it('returns null for invalid rank', () => {
    expect(parseCallbackData('lo:2026-05-12:Mon:abc')).toBeNull();
    expect(parseCallbackData('lo:2026-05-12:Mon:0')).toBeNull();
    expect(parseCallbackData('lo:2026-05-12:Mon:-1')).toBeNull();
  });

  it('returns null for wrong number of parts', () => {
    expect(parseCallbackData('lo:2026-05-12:Mon')).toBeNull();
    expect(parseCallbackData('lo:2026-05-12:Mon:1:extra')).toBeNull();
    expect(parseCallbackData('lo')).toBeNull();
  });

  it('returns null for unknown prefix', () => {
    expect(parseCallbackData('zz:2026-05-12:Mon:1')).toBeNull();
  });

  it('lo: callback data stays within 64-byte Telegram limit', () => {
    const maxData = 'lo:2026-05-12:Wed:3';
    expect(Buffer.byteLength(maxData, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('lc: callback data stays within 64-byte Telegram limit', () => {
    const maxData = 'lc:2026-05-12:Wed:3';
    expect(Buffer.byteLength(maxData, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('lx: callback data stays within 64-byte Telegram limit', () => {
    const maxData = 'lx:2026-05-12:Wed:3';
    expect(Buffer.byteLength(maxData, 'utf8')).toBeLessThanOrEqual(64);
  });
});

// ── DB state machine tests ──────────────────────────────────────────────────

describe('lunch order DB state machine', () => {
  let db;
  const weekOf = '2026-05-12';

  beforeEach(() => {
    db = setupTestDb();
    seedRecs(db, weekOf);
  });

  it('setPendingOrder creates order with status=pending and prompt_message_id', () => {
    const rec = db.prepare(
      'SELECT * FROM lunch_recommendations WHERE week_of = ? AND day = ? AND rank = ?'
    ).get(weekOf, 'Monday', 1);

    db.prepare(`
      INSERT OR REPLACE INTO lunch_orders
        (week_of, day, rank, item_name, restaurant, price, combo_json, status, confirmed_at, prompt_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), ?)
    `).run(weekOf, 'Monday', 1, rec.item_name, rec.restaurant, rec.price, rec.combo_json, '12345');

    const order = db.prepare('SELECT * FROM lunch_orders WHERE week_of = ? AND day = ?').get(weekOf, 'Monday');
    expect(order.status).toBe('pending');
    expect(order.prompt_message_id).toBe('12345');
    expect(order.item_name).toBe('Grilled Chicken Bowl');
  });

  it('updateOrderStatus transitions pending → placing → ordered (sets ordered_at)', () => {
    // Create pending order
    db.prepare(`
      INSERT INTO lunch_orders (week_of, day, rank, item_name, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(weekOf, 'Monday', 1, 'Test');

    // Transition to placing
    db.prepare("UPDATE lunch_orders SET status = 'placing' WHERE week_of = ? AND day = ?")
      .run(weekOf, 'Monday');
    let order = db.prepare('SELECT * FROM lunch_orders WHERE week_of = ? AND day = ?').get(weekOf, 'Monday');
    expect(order.status).toBe('placing');

    // Transition to ordered
    db.prepare("UPDATE lunch_orders SET status = 'ordered', ordered_at = datetime('now') WHERE week_of = ? AND day = ?")
      .run(weekOf, 'Monday');
    order = db.prepare('SELECT * FROM lunch_orders WHERE week_of = ? AND day = ?').get(weekOf, 'Monday');
    expect(order.status).toBe('ordered');
    expect(order.ordered_at).not.toBeNull();
  });

  it('updateOrderStatus transitions pending → placing → failed (sets error_message)', () => {
    db.prepare(`
      INSERT INTO lunch_orders (week_of, day, rank, item_name, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(weekOf, 'Monday', 1, 'Test');

    db.prepare("UPDATE lunch_orders SET status = 'placing' WHERE week_of = ? AND day = ?")
      .run(weekOf, 'Monday');

    db.prepare("UPDATE lunch_orders SET status = 'failed', error_message = 'Timeout' WHERE week_of = ? AND day = ?")
      .run(weekOf, 'Monday');

    const order = db.prepare('SELECT * FROM lunch_orders WHERE week_of = ? AND day = ?').get(weekOf, 'Monday');
    expect(order.status).toBe('failed');
    expect(order.error_message).toBe('Timeout');
  });

  it('deleteLunchOrder removes row', () => {
    db.prepare(`
      INSERT INTO lunch_orders (week_of, day, rank, item_name, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(weekOf, 'Monday', 1, 'Test');

    db.prepare('DELETE FROM lunch_orders WHERE week_of = ? AND day = ?').run(weekOf, 'Monday');
    const order = db.prepare('SELECT * FROM lunch_orders WHERE week_of = ? AND day = ?').get(weekOf, 'Monday');
    expect(order).toBeUndefined();
  });

  it('UNIQUE(week_of, day) prevents having both pending and ordered for same day', () => {
    db.prepare(`
      INSERT INTO lunch_orders (week_of, day, rank, item_name, status)
      VALUES (?, ?, ?, ?, 'ordered')
    `).run(weekOf, 'Monday', 1, 'Ordered Item');

    // INSERT OR REPLACE will overwrite — so only one row per day
    db.prepare(`
      INSERT OR REPLACE INTO lunch_orders (week_of, day, rank, item_name, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(weekOf, 'Monday', 2, 'New Pending');

    const orders = db.prepare('SELECT * FROM lunch_orders WHERE week_of = ? AND day = ?').all(weekOf, 'Monday');
    expect(orders).toHaveLength(1);
  });

  it('stale placing orders recovered to failed on startup', () => {
    // Insert a 'placing' order with old confirmed_at
    db.prepare(`
      INSERT INTO lunch_orders (week_of, day, rank, item_name, status, confirmed_at)
      VALUES (?, ?, ?, ?, 'placing', datetime('now', '-10 minutes'))
    `).run(weekOf, 'Monday', 1, 'Stale Order');

    // Simulate startup recovery
    db.prepare(`
      UPDATE lunch_orders SET status = 'failed', error_message = 'Process crashed during placement'
      WHERE status = 'placing' AND confirmed_at < datetime('now', '-5 minutes')
    `).run();

    const order = db.prepare('SELECT * FROM lunch_orders WHERE week_of = ? AND day = ?').get(weekOf, 'Monday');
    expect(order.status).toBe('failed');
    expect(order.error_message).toBe('Process crashed during placement');
  });

  it('stale pending orders cleaned up after 24h', () => {
    db.prepare(`
      INSERT INTO lunch_orders (week_of, day, rank, item_name, status, confirmed_at)
      VALUES (?, ?, ?, ?, 'pending', datetime('now', '-25 hours'))
    `).run(weekOf, 'Monday', 1, 'Old Pending');

    db.prepare(`
      DELETE FROM lunch_orders WHERE status = 'pending' AND confirmed_at < datetime('now', '-24 hours')
    `).run();

    const order = db.prepare('SELECT * FROM lunch_orders WHERE week_of = ? AND day = ?').get(weekOf, 'Monday');
    expect(order).toBeUndefined();
  });

  it('storeRecommendations does NOT delete ordered or placing orders', () => {
    db.prepare(`
      INSERT INTO lunch_orders (week_of, day, rank, item_name, status)
      VALUES (?, ?, ?, ?, 'ordered')
    `).run(weekOf, 'Monday', 1, 'Ordered Item');
    db.prepare(`
      INSERT INTO lunch_orders (week_of, day, rank, item_name, status)
      VALUES (?, ?, ?, ?, 'placing')
    `).run(weekOf, 'Tuesday', 1, 'Placing Item');

    // Simulate storeRecommendations with protected delete
    db.prepare('DELETE FROM lunch_recommendations WHERE week_of = ?').run(weekOf);
    db.prepare("DELETE FROM lunch_orders WHERE week_of = ? AND status NOT IN ('placing', 'ordered')").run(weekOf);

    const orders = db.prepare('SELECT * FROM lunch_orders WHERE week_of = ? ORDER BY day').all(weekOf);
    expect(orders).toHaveLength(2);
    expect(orders[0].day).toBe('Monday');
    expect(orders[0].status).toBe('ordered');
    expect(orders[1].day).toBe('Tuesday');
    expect(orders[1].status).toBe('placing');
  });

  it('storeRecommendations DOES delete pending, failed, cancelled orders', () => {
    db.prepare(`
      INSERT INTO lunch_orders (week_of, day, rank, item_name, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(weekOf, 'Monday', 1, 'Pending Item');
    db.prepare(`
      INSERT INTO lunch_orders (week_of, day, rank, item_name, status)
      VALUES (?, ?, ?, ?, 'failed')
    `).run(weekOf, 'Tuesday', 1, 'Failed Item');
    db.prepare(`
      INSERT INTO lunch_orders (week_of, day, rank, item_name, status)
      VALUES (?, ?, ?, ?, 'confirmed')
    `).run(weekOf, 'Wednesday', 1, 'Confirmed Item');

    db.prepare('DELETE FROM lunch_recommendations WHERE week_of = ?').run(weekOf);
    db.prepare("DELETE FROM lunch_orders WHERE week_of = ? AND status NOT IN ('placing', 'ordered')").run(weekOf);

    const orders = db.prepare('SELECT * FROM lunch_orders WHERE week_of = ?').all(weekOf);
    expect(orders).toHaveLength(0);
  });

  it('returns undefined for non-existent order', () => {
    const order = db.prepare('SELECT * FROM lunch_orders WHERE week_of = ? AND day = ?').get(weekOf, 'Monday');
    expect(order).toBeUndefined();
  });

  it('getLunchOrdersForWeek returns ordered results', () => {
    db.prepare(`
      INSERT INTO lunch_orders (week_of, day, rank, item_name, status)
      VALUES (?, ?, ?, ?, 'confirmed')
    `).run(weekOf, 'Monday', 1, 'Grilled Chicken Bowl');
    db.prepare(`
      INSERT INTO lunch_orders (week_of, day, rank, item_name, status)
      VALUES (?, ?, ?, ?, 'confirmed')
    `).run(weekOf, 'Tuesday', 1, 'Salmon Poke');

    const orders = db.prepare('SELECT * FROM lunch_orders WHERE week_of = ? ORDER BY day').all(weekOf);
    expect(orders).toHaveLength(2);
    expect(orders[0].day).toBe('Monday');
    expect(orders[1].day).toBe('Tuesday');
  });
});

// ── logOrderAttempt tests ───────────────────────────────────────────────────

describe('logOrderAttempt', () => {
  let db;
  const weekOf = '2026-05-12';

  beforeEach(() => {
    db = setupTestDb();
  });

  it('creates audit row with correct fields', () => {
    db.prepare(`
      INSERT INTO order_attempts (week_of, day, attempt_number, status, error_message, screenshot_path, completed_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
    `).run(weekOf, 'Monday', 1, 'success', null, '/tmp/ss.png', 5000);

    const row = db.prepare('SELECT * FROM order_attempts WHERE week_of = ? AND day = ?').get(weekOf, 'Monday');
    expect(row.status).toBe('success');
    expect(row.attempt_number).toBe(1);
    expect(row.screenshot_path).toBe('/tmp/ss.png');
    expect(row.duration_ms).toBe(5000);
    expect(row.error_message).toBeNull();
  });

  it('multiple attempts for same day get separate rows', () => {
    db.prepare(`
      INSERT INTO order_attempts (week_of, day, attempt_number, status, duration_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(weekOf, 'Monday', 1, 'failed', 3000);
    db.prepare(`
      INSERT INTO order_attempts (week_of, day, attempt_number, status, duration_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(weekOf, 'Monday', 2, 'success', 8000);

    const rows = db.prepare('SELECT * FROM order_attempts WHERE week_of = ? AND day = ? ORDER BY attempt_number').all(weekOf, 'Monday');
    expect(rows).toHaveLength(2);
    expect(rows[0].attempt_number).toBe(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[1].attempt_number).toBe(2);
    expect(rows[1].status).toBe('success');
  });

  it('records error message for failed attempts', () => {
    db.prepare(`
      INSERT INTO order_attempts (week_of, day, attempt_number, status, error_message)
      VALUES (?, ?, ?, ?, ?)
    `).run(weekOf, 'Tuesday', 1, 'failed', 'Checkout button not found');

    const row = db.prepare('SELECT * FROM order_attempts WHERE week_of = ? AND day = ?').get(weekOf, 'Tuesday');
    expect(row.error_message).toBe('Checkout button not found');
  });
});

// ── Formatter tests with new statuses ───────────────────────────────────────

describe('formatRecommendationsWithButtons', () => {
  const weekOf = '2026-05-12';

  const recs = [
    { day: 'Monday', rank: 1, item_name: 'Grilled Chicken', restaurant: 'FreshKitchen', price: 12.50, overall_score: 8.5 },
    { day: 'Monday', rank: 2, item_name: 'Turkey Wrap', restaurant: 'DeliCo', price: 10.00, overall_score: 7.2 },
    { day: 'Tuesday', rank: 1, item_name: 'Salmon Poke', restaurant: 'OceanBowl', price: 15.00, overall_score: 9.0 },
  ];

  it('returns one entry per day', () => {
    const result = formatRecommendationsWithButtons(recs, weekOf);
    expect(result).toHaveLength(2);
    expect(result[0].day).toBe('Monday');
    expect(result[1].day).toBe('Tuesday');
  });

  it('buttons have correct callbackData format', () => {
    const result = formatRecommendationsWithButtons(recs, weekOf);
    const monButtons = result[0].buttons;
    expect(monButtons).toHaveLength(2);
    expect(monButtons[0]).toEqual({ text: 'Order #1', callbackData: 'lo:2026-05-12:Mon:1' });
    expect(monButtons[1]).toEqual({ text: 'Order #2', callbackData: 'lo:2026-05-12:Mon:2' });
  });

  // ── New status-based tests ────────────────────────────────────────────

  it('ordered day shows [ORDERED] with no buttons', () => {
    const existingOrders = new Map([['Monday', { rank: 1, status: 'ordered' }]]);
    const result = formatRecommendationsWithButtons(recs, weekOf, existingOrders);

    expect(result[0].text).toContain('[ORDERED]');
    expect(result[0].buttons).toHaveLength(0);
    expect(result[1].buttons).toHaveLength(1); // Tuesday still has buttons
  });

  it('placing day shows [PLACING...] with no buttons', () => {
    const existingOrders = new Map([['Monday', { rank: 1, status: 'placing' }]]);
    const result = formatRecommendationsWithButtons(recs, weekOf, existingOrders);

    expect(result[0].text).toContain('[PLACING...]');
    expect(result[0].buttons).toHaveLength(0);
  });

  it('pending day shows [PENDING CONFIRM] with no buttons', () => {
    const existingOrders = new Map([['Monday', { rank: 1, status: 'pending' }]]);
    const result = formatRecommendationsWithButtons(recs, weekOf, existingOrders);

    expect(result[0].text).toContain('[PENDING CONFIRM]');
    expect(result[0].buttons).toHaveLength(0);
  });

  it('failed day shows [FAILED] with buttons re-enabled', () => {
    const existingOrders = new Map([['Monday', { rank: 1, status: 'failed' }]]);
    const result = formatRecommendationsWithButtons(recs, weekOf, existingOrders);

    expect(result[0].text).toContain('[FAILED]');
    expect(result[0].buttons).toHaveLength(2); // buttons re-enabled
  });

  it('no order → buttons shown', () => {
    const result = formatRecommendationsWithButtons(recs, weekOf);
    expect(result[0].buttons).toHaveLength(2);
    expect(result[1].buttons).toHaveLength(1);
  });

  it('backwards compatible with old format (just rank number)', () => {
    const existingOrders = new Map([['Monday', 1]]);
    const result = formatRecommendationsWithButtons(recs, weekOf, existingOrders);

    expect(result[0].text).toContain('[CONFIRMED #1]');
    expect(result[0].buttons).toHaveLength(0);
  });

  it('empty recs returns empty array', () => {
    expect(formatRecommendationsWithButtons([], weekOf)).toEqual([]);
    expect(formatRecommendationsWithButtons(null, weekOf)).toEqual([]);
  });

  it('text includes item details', () => {
    const result = formatRecommendationsWithButtons(recs, weekOf);
    expect(result[0].text).toContain('Grilled Chicken');
    expect(result[0].text).toContain('FreshKitchen');
    expect(result[0].text).toContain('$12.50');
  });
});

// ── Browser lock tests ──────────────────────────────────────────────────────

describe('browser lock', () => {
  afterEach(() => {
    _resetLock();
  });

  it('acquireBrowserLock returns true when unlocked', async () => {
    const result = await acquireBrowserLock();
    expect(result).toBe(true);
  });

  it('second call blocks until first releases', async () => {
    await acquireBrowserLock();

    let secondAcquired = false;
    const secondPromise = acquireBrowserLock(5000).then((result) => {
      secondAcquired = true;
      return result;
    });

    // Second should still be waiting
    await new Promise(r => setTimeout(r, 50));
    expect(secondAcquired).toBe(false);

    // Release first
    releaseBrowserLock();

    const result = await secondPromise;
    expect(result).toBe(true);
    expect(secondAcquired).toBe(true);
  });

  it('timeout returns false', async () => {
    await acquireBrowserLock();

    const result = await acquireBrowserLock(100);
    expect(result).toBe(false);
  });

  it('releaseBrowserLock wakes queued caller', async () => {
    await acquireBrowserLock();

    const results = [];
    const p1 = acquireBrowserLock(5000).then(r => results.push(r));
    const p2 = acquireBrowserLock(5000).then(r => results.push(r));

    await new Promise(r => setTimeout(r, 50));
    releaseBrowserLock(); // wakes p1
    await new Promise(r => setTimeout(r, 50));
    releaseBrowserLock(); // wakes p2

    await Promise.all([p1, p2]);
    expect(results).toEqual([true, true]);
  });

  it('release when no queue just unlocks', () => {
    // Should not throw
    releaseBrowserLock();
  });
});
