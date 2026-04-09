/**
 * Knowledge Base manager — dual-layer storage for structured wiki pages.
 *
 * Storage layers:
 * 1. SQLite (kb_pages + kb_pages_fts) — structured metadata + full-text search
 * 2. Markdown files on disk (~/.chief-of-staff/science/kb/) — human-readable wiki
 *
 * Usage:
 *   import { initKb, writePage, readPage, searchKb } from './kb.js';
 *   initKb(config, baseDir);
 *   writePage('customers/bmc.md', { title: 'BMC', content: '...', category: 'customers' });
 *   const results = searchKb('powder coating', { category: 'customers', limit: 5 });
 */

import { ensureDb } from './db.js';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// ─── Module state ───────────────────────────────────────────────────────────

let _config = null;
let _baseDir = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

function expandHome(dir) {
  if (dir.startsWith('~/') || dir === '~') {
    return join(homedir(), dir.slice(1));
  }
  return dir;
}

function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function diskPath(pagePath) {
  return join(_baseDir, pagePath);
}

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ─── Initialization ─────────────────────────────────────────────────────────

/**
 * Set config and resolve the KB base directory.
 *
 * @param {object} config - Bot config (passed to ensureDb)
 * @param {string} [baseDir] - Override base directory (default: config.kbDir or ~/.chief-of-staff/science/kb)
 */
export function initKb(config, baseDir) {
  _config = config;
  const dir = baseDir || config?.kbDir || '~/.chief-of-staff/science/kb';
  _baseDir = expandHome(dir);
  mkdirSync(_baseDir, { recursive: true });
}

// ─── Write / Read ───────────────────────────────────────────────────────────

/**
 * Write a KB page to both SQLite and disk.
 *
 * @param {string} pagePath - Relative path, e.g. 'customers/bmc.md'
 * @param {object} opts
 * @param {string}  opts.title      - Page title
 * @param {string}  opts.content    - Markdown content
 * @param {string}  [opts.category]   - customers, pipeline, facility, etc.
 * @param {string}  [opts.entityType] - customer, person, project, deal
 * @param {string}  [opts.entityName] - BMC, Guoqing, barn-1
 */
export function writePage(pagePath, { title, content, category, entityType, entityName }) {
  const db = ensureDb(_config);
  const words = countWords(content);
  const ts = now();

  db.prepare(`
    INSERT OR REPLACE INTO kb_pages (path, title, content, category, entity_type, entity_name, last_updated, dirty, word_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(pagePath, title, content, category || null, entityType || null, entityName || null, ts, words);

  // Write to disk
  const fullPath = diskPath(pagePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf-8');
}

/**
 * Read a KB page from SQLite.
 *
 * @param {string} pagePath
 * @returns {{ path, title, content, category, entityType, entityName, lastUpdated, dirty, wordCount } | null}
 */
export function readPage(pagePath) {
  const db = ensureDb(_config);
  const row = db.prepare('SELECT * FROM kb_pages WHERE path = ?').get(pagePath);
  if (!row) return null;

  return {
    path: row.path,
    title: row.title,
    content: row.content,
    category: row.category,
    entityType: row.entity_type,
    entityName: row.entity_name,
    lastUpdated: row.last_updated,
    dirty: row.dirty,
    wordCount: row.word_count,
  };
}

// ─── Search ─────────────────────────────────────────────────────────────────

/**
 * Full-text search across KB pages.
 *
 * @param {string} query - FTS5 search query
 * @param {object} [opts]
 * @param {string} [opts.category] - Filter by category
 * @param {number} [opts.limit=10] - Max results
 * @returns {Array<{ path, title, category, snippet, lastUpdated }>}
 */
export function searchKb(query, opts = {}) {
  const db = ensureDb(_config);
  const { category, limit = 10 } = opts;

  const conditions = ['kb_pages_fts MATCH ?'];
  const params = [query];

  if (category) {
    conditions.push('p.category = ?');
    params.push(category);
  }

  params.push(limit);

  const sql = `
    SELECT p.path, p.title, p.category, p.last_updated,
           snippet(kb_pages_fts, 2, '<b>', '</b>', '...', 48) AS snippet
    FROM kb_pages_fts fts
    JOIN kb_pages p ON p.rowid = fts.rowid
    WHERE ${conditions.join(' AND ')}
    ORDER BY rank
    LIMIT ?
  `;

  try {
    return db.prepare(sql).all(...params);
  } catch (err) {
    console.warn(`[kb] searchKb error: ${err.message}`);
    return [];
  }
}

// ─── List / Filter ──────────────────────────────────────────────────────────

/**
 * List KB pages with optional filters.
 *
 * @param {object} [opts]
 * @param {string} [opts.category]   - Filter by category
 * @param {string} [opts.entityType] - Filter by entity_type
 * @param {number} [opts.dirty]      - Filter by dirty flag (0 or 1)
 * @returns {Array<{ path, title, category, entityType, entityName, lastUpdated, dirty, wordCount }>}
 */
export function listPages(opts = {}) {
  const db = ensureDb(_config);
  const { category, entityType, dirty } = opts;

  const conditions = [];
  const params = [];

  if (category) {
    conditions.push('category = ?');
    params.push(category);
  }

  if (entityType) {
    conditions.push('entity_type = ?');
    params.push(entityType);
  }

  if (dirty !== undefined && dirty !== null) {
    conditions.push('dirty = ?');
    params.push(dirty);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT path, title, category, entity_type, entity_name, last_updated, dirty, word_count
    FROM kb_pages
    ${where}
    ORDER BY category, path
  `).all(...params);

  return rows.map(r => ({
    path: r.path,
    title: r.title,
    category: r.category,
    entityType: r.entity_type,
    entityName: r.entity_name,
    lastUpdated: r.last_updated,
    dirty: r.dirty,
    wordCount: r.word_count,
  }));
}

// ─── Dirty tracking ─────────────────────────────────────────────────────────

/**
 * Mark a page as dirty (needs recompilation).
 *
 * @param {string} pagePath
 */
export function markDirty(pagePath) {
  const db = ensureDb(_config);
  db.prepare('UPDATE kb_pages SET dirty = 1 WHERE path = ?').run(pagePath);
}

/**
 * Get all pages that are marked dirty.
 *
 * @returns {Array<{ path, title, category, lastUpdated }>}
 */
export function getDirtyPages() {
  const db = ensureDb(_config);
  return db.prepare(`
    SELECT path, title, category, last_updated
    FROM kb_pages
    WHERE dirty = 1
    ORDER BY category, path
  `).all();
}

// ─── Index pages ────────────────────────────────────────────────────────────

/**
 * Read the _index.md page for a category.
 *
 * @param {string} category
 * @returns {{ path, title, content, category, lastUpdated } | null}
 */
export function getIndexPage(category) {
  return readPage(`${category}/_index.md`);
}

/**
 * Write the _index.md page for a category.
 *
 * @param {string} category
 * @param {string} content - Markdown content for the index
 */
export function writeIndexPage(category, content) {
  writePage(`${category}/_index.md`, {
    title: `${category} — Index`,
    content,
    category,
  });
}

// ─── Delete ─────────────────────────────────────────────────────────────────

/**
 * Remove a page from both SQLite and disk.
 *
 * @param {string} pagePath
 */
export function deletePage(pagePath) {
  const db = ensureDb(_config);
  db.prepare('DELETE FROM kb_pages WHERE path = ?').run(pagePath);

  const fullPath = diskPath(pagePath);
  if (existsSync(fullPath)) {
    unlinkSync(fullPath);
  }
}

// ─── Stats ──────────────────────────────────────────────────────────────────

/**
 * Get aggregate KB statistics.
 *
 * @returns {{ totalPages, byCategory, dirtyCount, totalWords }}
 */
export function getKbStats() {
  const db = ensureDb(_config);

  const totalPages = db.prepare('SELECT COUNT(*) AS count FROM kb_pages').get().count;
  const dirtyCount = db.prepare('SELECT COUNT(*) AS count FROM kb_pages WHERE dirty = 1').get().count;
  const totalWords = db.prepare('SELECT COALESCE(SUM(word_count), 0) AS total FROM kb_pages').get().total;

  const byCategory = db.prepare(`
    SELECT category, COUNT(*) AS count
    FROM kb_pages
    WHERE category IS NOT NULL
    GROUP BY category
    ORDER BY count DESC
  `).all();

  return { totalPages, byCategory, dirtyCount, totalWords };
}
