/**
 * Alfred DB — schema migrations and helpers
 *
 * Pattern: chief-of-staff/lib/db.js
 * Uses ensureDb(config) singleton since ctx.db is always undefined.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';

// ─── Database singleton ─────────────────────────────────────────────────────

let _db;

export function ensureDb(config) {
  if (!_db) {
    mkdirSync('data', { recursive: true });
    _db = new Database(`data/${config.name}-lunch.db`);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
  }
  return _db;
}

export function getDb(config) {
  return ensureDb(config);
}

// ─── Migrations ─────────────────────────────────────────────────────────────

export function runMigrations(ctx) {
  const db = ensureDb(ctx.config);

  // ── Lunch menus ─────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS lunch_menus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_of TEXT NOT NULL,
      day TEXT NOT NULL,
      restaurant TEXT,
      item_name TEXT NOT NULL,
      price REAL,
      description TEXT,
      tags_json TEXT DEFAULT '[]',
      scraped_at TEXT DEFAULT (datetime('now')),
      UNIQUE(week_of, day, item_name, restaurant)
    );
    CREATE INDEX IF NOT EXISTS idx_menus_week ON lunch_menus(week_of);
    CREATE INDEX IF NOT EXISTS idx_menus_day ON lunch_menus(week_of, day);
  `);

  // ── Lunch recommendations ───────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS lunch_recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_of TEXT NOT NULL,
      day TEXT NOT NULL,
      date TEXT,
      item_name TEXT NOT NULL,
      restaurant TEXT,
      price REAL,
      nutrition_score REAL,
      longevity_score REAL,
      overall_score REAL,
      reasoning TEXT,
      runner_up TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(week_of, day)
    );
    CREATE INDEX IF NOT EXISTS idx_recs_week ON lunch_recommendations(week_of);
  `);

  // ── Add combo_json column (idempotent) ─────────────────────────────────
  try {
    db.exec('ALTER TABLE lunch_recommendations ADD COLUMN combo_json TEXT');
  } catch { /* column already exists */ }

  // ── Add rank column + recreate unique constraint ────────────────────────
  try {
    db.prepare('SELECT rank FROM lunch_recommendations LIMIT 1').get();
  } catch {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lunch_recommendations_new (
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
      INSERT INTO lunch_recommendations_new
        (id, week_of, day, date, rank, item_name, restaurant, price,
         nutrition_score, longevity_score, overall_score, reasoning,
         runner_up, combo_json, sent_at, created_at)
      SELECT id, week_of, day, date, 1, item_name, restaurant, price,
             nutrition_score, longevity_score, overall_score, reasoning,
             runner_up, combo_json, sent_at, created_at
      FROM lunch_recommendations;
      DROP TABLE lunch_recommendations;
      ALTER TABLE lunch_recommendations_new RENAME TO lunch_recommendations;
      CREATE INDEX IF NOT EXISTS idx_recs_week ON lunch_recommendations(week_of);
      DELETE FROM lunch_recommendations;
    `);
  }

  // ── Scrape log ──────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS scrape_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_of TEXT NOT NULL,
      status TEXT NOT NULL,
      item_count INTEGER DEFAULT 0,
      error_message TEXT,
      scraped_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ─── Menu helpers ───────────────────────────────────────────────────────────

export function storeMenuItems(config, weekOf, items) {
  const db = ensureDb(config);
  const insert = db.prepare(`
    INSERT OR REPLACE INTO lunch_menus (week_of, day, restaurant, item_name, price, description, tags_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((items) => {
    for (const item of items) {
      insert.run(
        weekOf,
        item.day,
        item.restaurant || null,
        item.name,
        item.price || null,
        item.description || null,
        JSON.stringify(item.tags || [])
      );
    }
  });

  tx(items);
}

export function getMenuForWeek(config, weekOf, day) {
  const db = ensureDb(config);
  if (day) {
    return db.prepare(
      'SELECT * FROM lunch_menus WHERE week_of = ? AND day = ? ORDER BY restaurant, item_name'
    ).all(weekOf, day);
  }
  return db.prepare(
    'SELECT * FROM lunch_menus WHERE week_of = ? ORDER BY day, restaurant, item_name'
  ).all(weekOf);
}

// ─── Recommendation helpers ─────────────────────────────────────────────────

export function storeRecommendations(config, weekOf, recs) {
  const db = ensureDb(config);
  db.prepare('DELETE FROM lunch_recommendations WHERE week_of = ?').run(weekOf);
  const insert = db.prepare(`
    INSERT INTO lunch_recommendations
      (week_of, day, date, rank, item_name, restaurant, price,
       nutrition_score, longevity_score, overall_score, reasoning, runner_up, combo_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((recs) => {
    for (const rec of recs) {
      insert.run(
        weekOf,
        rec.day,
        rec.date || null,
        rec.rank || 1,
        rec.item_name,
        rec.restaurant || null,
        rec.price || null,
        rec.nutrition_score || null,
        rec.longevity_score || null,
        rec.overall_score || null,
        rec.reasoning || null,
        rec.runner_up || null,
        rec.combo_json || null
      );
    }
  });

  tx(recs);
}

export function getRecommendationsForWeek(config, weekOf, day) {
  const db = ensureDb(config);
  if (day) {
    return db.prepare(
      'SELECT * FROM lunch_recommendations WHERE week_of = ? AND day = ? ORDER BY rank'
    ).all(weekOf, day);
  }
  return db.prepare(
    'SELECT * FROM lunch_recommendations WHERE week_of = ? ORDER BY day, rank'
  ).all(weekOf);
}

export function dbMenuToAnalysisFormat(rows) {
  return rows.map(r => ({
    day: r.day,
    name: r.item_name,
    restaurant: r.restaurant,
    price: r.price,
    description: r.description,
    tags: r.tags_json ? JSON.parse(r.tags_json) : [],
  }));
}

// ─── Scrape log helpers ─────────────────────────────────────────────────────

export function logScrape(config, weekOf, status, itemCount, errorMessage) {
  const db = ensureDb(config);
  db.prepare(
    'INSERT INTO scrape_log (week_of, status, item_count, error_message) VALUES (?, ?, ?, ?)'
  ).run(weekOf, status, itemCount || 0, errorMessage || null);
}

// ─── Week helpers ───────────────────────────────────────────────────────────

/**
 * Get the Monday of the current (or next) week as YYYY-MM-DD.
 * On Sunday, returns the upcoming Monday.
 */
export function getCurrentWeekOf() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ...
  const diff = dayOfWeek === 0 ? 1 : (1 - dayOfWeek + 7) % 7 || 0;
  const monday = new Date(now);
  if (dayOfWeek === 0) {
    // Sunday: next Monday
    monday.setDate(now.getDate() + 1);
  } else {
    // Mon-Sat: this Monday
    monday.setDate(now.getDate() - (dayOfWeek - 1));
  }
  return monday.toISOString().slice(0, 10);
}
