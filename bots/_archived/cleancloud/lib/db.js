/**
 * CleanCloud DB — schema migrations and helpers
 *
 * Pattern: trainer/lib/db.js
 * Uses ensureDb(config) singleton since ctx.db is always undefined.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';

// ─── Database singleton ─────────────────────────────────────────────────────

let _db;

export function ensureDb(config) {
  if (!_db) {
    mkdirSync('data', { recursive: true });
    _db = new Database(`data/${config.name}-cleancloud.db`);
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

  // ── Sections ────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS sections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER,
      synced_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Products ────────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      section_id TEXT,
      sort_order INTEGER,
      sku TEXT,
      type TEXT,
      pieces INTEGER,
      is_parent INTEGER DEFAULT 0,
      parent_id TEXT,
      synced_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_products_section ON products(section_id);
    CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
    CREATE INDEX IF NOT EXISTS idx_products_parent ON products(parent_id);
  `);

  // ── Product prices (composite PK for multiple price lists) ──────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_prices (
      product_id TEXT NOT NULL,
      price_list_id TEXT NOT NULL,
      price TEXT,
      express_price TEXT,
      synced_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (product_id, price_list_id)
    );
  `);

  // ── Price lists ─────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_lists (
      id TEXT PRIMARY KEY,
      name TEXT,
      synced_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Operations log ──────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      description TEXT,
      details_json TEXT,
      screenshot_path TEXT,
      status TEXT DEFAULT 'pending',
      user_id TEXT,
      user_name TEXT,
      error_msg TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_operations_created ON operations(created_at);
  `);

  // ── Sync snapshots ─────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      products_json TEXT,
      sections_json TEXT,
      product_count INTEGER,
      section_count INTEGER,
      synced_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ─── Section helpers ───────────────────────────────────────────────────────

export function getAllSections(config) {
  const db = ensureDb(config);
  return db.prepare('SELECT * FROM sections ORDER BY sort_order, name').all();
}

export function getSection(config, id) {
  const db = ensureDb(config);
  return db.prepare('SELECT * FROM sections WHERE id = ?').get(id);
}

export function getSectionsWithCounts(config) {
  const db = ensureDb(config);
  return db.prepare(`
    SELECT s.*, COUNT(p.id) as product_count
    FROM sections s
    LEFT JOIN products p ON p.section_id = s.id
    GROUP BY s.id
    ORDER BY s.sort_order, s.name
  `).all();
}

export function upsertSection(config, section) {
  const db = ensureDb(config);
  return db.prepare(`
    INSERT OR REPLACE INTO sections (id, name, sort_order, synced_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(section.id, section.name, section.sort_order ?? null);
}

// ─── Product helpers ───────────────────────────────────────────────────────

export function getProductsBySection(config, sectionId, limit = 30, offset = 0) {
  const db = ensureDb(config);
  return db.prepare(`
    SELECT p.*, pp.price, pp.express_price
    FROM products p
    LEFT JOIN product_prices pp ON pp.product_id = p.id AND pp.price_list_id = '0'
    WHERE p.section_id = ?
    ORDER BY p.sort_order, p.name
    LIMIT ? OFFSET ?
  `).all(sectionId, limit, offset);
}

export function getProductCountBySection(config, sectionId) {
  const db = ensureDb(config);
  return db.prepare('SELECT COUNT(*) as count FROM products WHERE section_id = ?').get(sectionId).count;
}

export function getProduct(config, id) {
  const db = ensureDb(config);
  return db.prepare(`
    SELECT p.*, pp.price, pp.express_price
    FROM products p
    LEFT JOIN product_prices pp ON pp.product_id = p.id AND pp.price_list_id = '0'
    WHERE p.id = ?
  `).get(id);
}

export function getProductWithPriceList(config, productId, priceListId) {
  const db = ensureDb(config);
  return db.prepare(`
    SELECT p.*, pp.price, pp.express_price
    FROM products p
    LEFT JOIN product_prices pp ON pp.product_id = p.id AND pp.price_list_id = ?
    WHERE p.id = ?
  `).get(priceListId, productId);
}

export function searchProducts(config, query, limit = 20) {
  const db = ensureDb(config);
  return db.prepare(`
    SELECT p.*, pp.price, pp.express_price, s.name as section_name
    FROM products p
    LEFT JOIN product_prices pp ON pp.product_id = p.id AND pp.price_list_id = '0'
    LEFT JOIN sections s ON s.id = p.section_id
    WHERE p.name LIKE ?
    ORDER BY p.name
    LIMIT ?
  `).all(`%${query}%`, limit);
}

export function upsertProduct(config, product) {
  const db = ensureDb(config);
  return db.prepare(`
    INSERT OR REPLACE INTO products (id, name, section_id, sort_order, sku, type, pieces, is_parent, parent_id, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    product.id,
    product.name,
    product.section_id ?? null,
    product.sort_order ?? null,
    product.sku ?? null,
    product.type ?? null,
    product.pieces ?? null,
    product.is_parent ? 1 : 0,
    product.parent_id ?? null,
  );
}

export function getTotalProductCount(config) {
  const db = ensureDb(config);
  return db.prepare('SELECT COUNT(*) as count FROM products').get().count;
}

export function getTotalSectionCount(config) {
  const db = ensureDb(config);
  return db.prepare('SELECT COUNT(*) as count FROM sections').get().count;
}

// ─── Product price helpers ─────────────────────────────────────────────────

export function upsertProductPrice(config, productId, priceListId, price, expressPrice) {
  const db = ensureDb(config);
  return db.prepare(`
    INSERT OR REPLACE INTO product_prices (product_id, price_list_id, price, express_price, synced_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(productId, priceListId, price, expressPrice ?? null);
}

export function getProductPrice(config, productId, priceListId) {
  const db = ensureDb(config);
  return db.prepare(
    'SELECT * FROM product_prices WHERE product_id = ? AND price_list_id = ?'
  ).get(productId, priceListId);
}

// ─── Price list helpers ────────────────────────────────────────────────────

export function getAllPriceLists(config) {
  const db = ensureDb(config);
  return db.prepare('SELECT * FROM price_lists ORDER BY name').all();
}

export function upsertPriceList(config, priceList) {
  const db = ensureDb(config);
  return db.prepare(`
    INSERT OR REPLACE INTO price_lists (id, name, synced_at)
    VALUES (?, ?, datetime('now'))
  `).run(priceList.id, priceList.name);
}

// ─── Operations log helpers ────────────────────────────────────────────────

export function logOperation(config, op) {
  const db = ensureDb(config);
  return db.prepare(`
    INSERT INTO operations (action, target_type, target_id, description, details_json, screenshot_path, status, user_id, user_name, error_msg)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    op.action,
    op.target_type ?? null,
    op.target_id ?? null,
    op.description ?? null,
    op.details_json ? JSON.stringify(op.details_json) : null,
    op.screenshot_path ?? null,
    op.status ?? 'completed',
    op.user_id ?? null,
    op.user_name ?? null,
    op.error_msg ?? null,
  );
}

export function getRecentOperations(config, limit = 5) {
  const db = ensureDb(config);
  return db.prepare(
    'SELECT * FROM operations ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
}

// ─── Sync snapshot helpers ─────────────────────────────────────────────────

export function saveSyncSnapshot(config, data) {
  const db = ensureDb(config);
  return db.prepare(`
    INSERT INTO sync_snapshots (products_json, sections_json, product_count, section_count)
    VALUES (?, ?, ?, ?)
  `).run(
    data.products_json ? JSON.stringify(data.products_json) : null,
    data.sections_json ? JSON.stringify(data.sections_json) : null,
    data.product_count ?? 0,
    data.section_count ?? 0,
  );
}

export function getLastSync(config) {
  const db = ensureDb(config);
  return db.prepare(
    'SELECT * FROM sync_snapshots ORDER BY synced_at DESC LIMIT 1'
  ).get();
}

// ─── Cache invalidation ────────────────────────────────────────────────────

export function updateProductPrice(config, productId, priceListId, price, expressPrice) {
  upsertProductPrice(config, productId, priceListId || '0', price, expressPrice);
}

export function updateSectionName(config, sectionId, newName) {
  const db = ensureDb(config);
  return db.prepare(
    "UPDATE sections SET name = ?, synced_at = datetime('now') WHERE id = ?"
  ).run(newName, sectionId);
}
