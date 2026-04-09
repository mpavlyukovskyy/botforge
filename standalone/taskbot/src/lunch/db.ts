/**
 * Lunch DB — separate lunch.db for menu scrapes and recommendations.
 * Follows the same singleton pattern as the main taskbot DB.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

let _db: Database.Database | null = null;

export function ensureLunchDb(): Database.Database {
  if (_db) return _db;

  const dbPath = join(process.cwd(), 'data', 'lunch.db');
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  // Run migrations
  _db.exec(`
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

  _db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_recs_week ON lunch_recommendations(week_of);
  `);

  _db.exec(`
    CREATE TABLE IF NOT EXISTS scrape_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      week_of TEXT NOT NULL,
      status TEXT NOT NULL,
      item_count INTEGER DEFAULT 0,
      error_message TEXT,
      scraped_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return _db;
}

export function getLunchDb(): Database.Database {
  return ensureLunchDb();
}

// ── Menu helpers ──────────────────────────────────────────────────────────────

export interface MenuItem {
  day: string;
  name: string;
  restaurant: string | null;
  price: number | null;
  description: string | null;
  tags: string[];
}

export interface MenuRow {
  id: number;
  week_of: string;
  day: string;
  restaurant: string | null;
  item_name: string;
  price: number | null;
  description: string | null;
  tags_json: string;
  scraped_at: string;
}

export interface RecommendationRow {
  id: number;
  week_of: string;
  day: string;
  date: string | null;
  rank: number;
  item_name: string;
  restaurant: string | null;
  price: number | null;
  nutrition_score: number | null;
  longevity_score: number | null;
  overall_score: number | null;
  reasoning: string | null;
  runner_up: string | null;
  combo_json: string | null;
  sent_at: string | null;
  created_at: string;
}

export function storeMenuItems(weekOf: string, items: MenuItem[]): void {
  const db = ensureLunchDb();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO lunch_menus (week_of, day, restaurant, item_name, price, description, tags_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((menuItems: MenuItem[]) => {
    for (const item of menuItems) {
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

export function getMenuForWeek(weekOf: string, day?: string): MenuRow[] {
  const db = ensureLunchDb();
  if (day) {
    return db.prepare(
      'SELECT * FROM lunch_menus WHERE week_of = ? AND day = ? ORDER BY restaurant, item_name'
    ).all(weekOf, day) as MenuRow[];
  }
  return db.prepare(
    'SELECT * FROM lunch_menus WHERE week_of = ? ORDER BY day, restaurant, item_name'
  ).all(weekOf) as MenuRow[];
}

export function storeRecommendations(weekOf: string, recs: Array<Record<string, unknown>>): void {
  const db = ensureLunchDb();
  db.prepare('DELETE FROM lunch_recommendations WHERE week_of = ?').run(weekOf);
  const insert = db.prepare(`
    INSERT INTO lunch_recommendations
      (week_of, day, date, rank, item_name, restaurant, price,
       nutrition_score, longevity_score, overall_score, reasoning, runner_up, combo_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((recommendations: Array<Record<string, unknown>>) => {
    for (const rec of recommendations) {
      insert.run(
        weekOf,
        rec.day || null,
        rec.date || null,
        rec.rank || 1,
        rec.item_name || '',
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

export function getRecommendationsForWeek(weekOf: string, day?: string): RecommendationRow[] {
  const db = ensureLunchDb();
  if (day) {
    return db.prepare(
      'SELECT * FROM lunch_recommendations WHERE week_of = ? AND day = ? ORDER BY rank'
    ).all(weekOf, day) as RecommendationRow[];
  }
  return db.prepare(
    'SELECT * FROM lunch_recommendations WHERE week_of = ? ORDER BY day, rank'
  ).all(weekOf) as RecommendationRow[];
}

export function dbMenuToAnalysisFormat(rows: MenuRow[]): MenuItem[] {
  return rows.map(r => ({
    day: r.day,
    name: r.item_name,
    restaurant: r.restaurant,
    price: r.price,
    description: r.description,
    tags: r.tags_json ? JSON.parse(r.tags_json) : [],
  }));
}

export function logScrape(weekOf: string, status: string, itemCount: number, errorMessage?: string): void {
  const db = ensureLunchDb();
  db.prepare(
    'INSERT INTO scrape_log (week_of, status, item_count, error_message) VALUES (?, ?, ?, ?)'
  ).run(weekOf, status, itemCount || 0, errorMessage || null);
}

/**
 * Get the Monday of the current (or next) week as YYYY-MM-DD.
 * On Sunday, returns the upcoming Monday.
 */
export function getCurrentWeekOf(): string {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ...
  const monday = new Date(now);
  if (dayOfWeek === 0) {
    monday.setDate(now.getDate() + 1);
  } else {
    monday.setDate(now.getDate() - (dayOfWeek - 1));
  }
  return monday.toISOString().slice(0, 10);
}
