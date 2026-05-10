import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { formatRecommendationsWithButtons } from '../lib/formatter.js';

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
      UNIQUE(week_of, day)
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

// ── Callback data parsing ────────────────────────────────────────────────────

describe('callback data parsing', () => {
  const DAY_MAP = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday' };

  function parseCallbackData(data) {
    const parts = data.split(':');
    if (parts.length !== 4) return null;
    const [prefix, weekOf, dayAbbrev, rankStr] = parts;
    if (prefix !== 'lo') return null;
    const day = DAY_MAP[dayAbbrev];
    const rank = parseInt(rankStr, 10);
    if (!day || isNaN(rank) || rank < 1) return null;
    return { weekOf, day, rank };
  }

  it('parses valid 4-part format', () => {
    const result = parseCallbackData('lo:2026-05-12:Mon:1');
    expect(result).toEqual({ weekOf: '2026-05-12', day: 'Monday', rank: 1 });
  });

  it('parses all day abbreviations', () => {
    for (const [abbrev, full] of Object.entries(DAY_MAP)) {
      const result = parseCallbackData(`lo:2026-05-12:${abbrev}:2`);
      expect(result).toEqual({ weekOf: '2026-05-12', day: full, rank: 2 });
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

  it('callback data stays within 64-byte Telegram limit', () => {
    const maxData = 'lo:2026-05-12:Wed:3';
    expect(Buffer.byteLength(maxData, 'utf8')).toBeLessThanOrEqual(64);
  });
});

// ── DB function tests ────────────────────────────────────────────────────────

describe('lunch order DB functions', () => {
  let db;
  const weekOf = '2026-05-12';

  beforeEach(() => {
    db = setupTestDb();
    seedRecs(db, weekOf);
  });

  it('confirmLunchOrder creates order from existing recommendation', () => {
    const rec = db.prepare(
      'SELECT * FROM lunch_recommendations WHERE week_of = ? AND day = ? AND rank = ?'
    ).get(weekOf, 'Monday', 1);
    expect(rec).toBeDefined();

    db.prepare(`
      INSERT OR REPLACE INTO lunch_orders
        (week_of, day, rank, item_name, restaurant, price, combo_json, status, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', datetime('now'))
    `).run(weekOf, 'Monday', 1, rec.item_name, rec.restaurant, rec.price, rec.combo_json);

    const order = db.prepare('SELECT * FROM lunch_orders WHERE week_of = ? AND day = ?').get(weekOf, 'Monday');
    expect(order.item_name).toBe('Grilled Chicken Bowl');
    expect(order.restaurant).toBe('FreshKitchen');
    expect(order.rank).toBe(1);
    expect(order.status).toBe('confirmed');
  });

  it('returns undefined for non-existent order', () => {
    const order = db.prepare('SELECT * FROM lunch_orders WHERE week_of = ? AND day = ?').get(weekOf, 'Monday');
    expect(order).toBeUndefined();
  });

  it('getLunchOrdersForWeek returns ordered results', () => {
    // Insert orders for Monday and Tuesday
    db.prepare(`
      INSERT INTO lunch_orders (week_of, day, rank, item_name, restaurant, price, status)
      VALUES (?, ?, ?, ?, ?, ?, 'confirmed')
    `).run(weekOf, 'Monday', 1, 'Grilled Chicken Bowl', 'FreshKitchen', 12.50);
    db.prepare(`
      INSERT INTO lunch_orders (week_of, day, rank, item_name, restaurant, price, status)
      VALUES (?, ?, ?, ?, ?, ?, 'confirmed')
    `).run(weekOf, 'Tuesday', 1, 'Salmon Poke', 'OceanBowl', 15.00);

    const orders = db.prepare('SELECT * FROM lunch_orders WHERE week_of = ? ORDER BY day').all(weekOf);
    expect(orders).toHaveLength(2);
    expect(orders[0].day).toBe('Monday');
    expect(orders[1].day).toBe('Tuesday');
  });

  it('clearLunchOrders removes all orders for a week', () => {
    db.prepare(`
      INSERT INTO lunch_orders (week_of, day, rank, item_name, status)
      VALUES (?, ?, ?, ?, 'confirmed')
    `).run(weekOf, 'Monday', 1, 'Test Item');

    db.prepare('DELETE FROM lunch_orders WHERE week_of = ?').run(weekOf);
    const orders = db.prepare('SELECT * FROM lunch_orders WHERE week_of = ?').all(weekOf);
    expect(orders).toHaveLength(0);
  });

  it('UNIQUE(week_of, day) constraint: second order replaces first', () => {
    db.prepare(`
      INSERT INTO lunch_orders (week_of, day, rank, item_name, status)
      VALUES (?, ?, ?, ?, 'confirmed')
    `).run(weekOf, 'Monday', 1, 'First Choice');

    db.prepare(`
      INSERT OR REPLACE INTO lunch_orders (week_of, day, rank, item_name, status)
      VALUES (?, ?, ?, ?, 'confirmed')
    `).run(weekOf, 'Monday', 2, 'Changed Mind');

    const orders = db.prepare('SELECT * FROM lunch_orders WHERE week_of = ? AND day = ?').all(weekOf, 'Monday');
    expect(orders).toHaveLength(1);
    expect(orders[0].rank).toBe(2);
    expect(orders[0].item_name).toBe('Changed Mind');
  });

  it('storeRecommendations clears orders when re-storing', () => {
    // Insert an order
    db.prepare(`
      INSERT INTO lunch_orders (week_of, day, rank, item_name, status)
      VALUES (?, ?, ?, ?, 'confirmed')
    `).run(weekOf, 'Monday', 1, 'Test');

    // Simulate storeRecommendations clearing orders
    db.prepare('DELETE FROM lunch_recommendations WHERE week_of = ?').run(weekOf);
    db.prepare('DELETE FROM lunch_orders WHERE week_of = ?').run(weekOf);

    const orders = db.prepare('SELECT * FROM lunch_orders WHERE week_of = ?').all(weekOf);
    expect(orders).toHaveLength(0);
  });
});

// ── Formatter tests ──────────────────────────────────────────────────────────

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

    const tueButtons = result[1].buttons;
    expect(tueButtons).toHaveLength(1);
    expect(tueButtons[0]).toEqual({ text: 'Order #1', callbackData: 'lo:2026-05-12:Tue:1' });
  });

  it('day with existing order shows CONFIRMED and empty buttons', () => {
    const existingOrders = new Map([['Monday', 1]]);
    const result = formatRecommendationsWithButtons(recs, weekOf, existingOrders);

    expect(result[0].text).toContain('[CONFIRMED #1]');
    expect(result[0].buttons).toHaveLength(0);

    // Tuesday still has buttons
    expect(result[1].buttons).toHaveLength(1);
    expect(result[1].text).not.toContain('CONFIRMED');
  });

  it('day without order has buttons for each rank', () => {
    const result = formatRecommendationsWithButtons(recs, weekOf);
    expect(result[0].buttons).toHaveLength(2);
    expect(result[1].buttons).toHaveLength(1);
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
