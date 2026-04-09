/**
 * Atlas API Client — shared helpers for Alfred tools
 *
 * NOT a tool (no name/execute export) — loadToolsFromDir() will skip this file.
 * Enhanced with circuit breaker, syncAttachment, and retrySyncPending.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';

// ─── Database ───────────────────────────────────────────────────────────────

let _db;

export function ensureDb(config) {
  if (!_db) {
    mkdirSync('data', { recursive: true });
    _db = new Database(`data/${config.name}-tools.db`);
    _db.pragma('journal_mode = WAL');
    _db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        spok_id TEXT UNIQUE,
        title TEXT NOT NULL,
        column_name TEXT,
        column_id TEXT,
        assignee TEXT,
        deadline TEXT,
        status TEXT DEFAULT 'OPEN',
        source TEXT DEFAULT 'telegram',
        telegram_msg_id TEXT,
        synced_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        requester TEXT,
        requester_chat_id TEXT
      );

      CREATE TABLE IF NOT EXISTS task_subtasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        completed INTEGER DEFAULT 0,
        display_order INTEGER DEFAULT 0,
        synced_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS column_cache (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        cached_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    `);

    // Close DB on process exit
    process.on('beforeExit', () => {
      if (_db) {
        try { _db.close(); } catch {}
      }
    });
  }
  return _db;
}

// ─── Circuit Breaker ────────────────────────────────────────────────────────

let consecutiveFailures = 0;
let circuitOpenUntil = 0;
const MAX_FAILURES = 3;
const BACKOFF_MS = 15 * 60 * 1000; // 15 minutes

function isCircuitOpen() {
  if (consecutiveFailures < MAX_FAILURES) return false;
  if (Date.now() > circuitOpenUntil) {
    // Allow a retry
    consecutiveFailures = MAX_FAILURES - 1;
    return false;
  }
  return true;
}

function recordSuccess() {
  consecutiveFailures = 0;
}

function recordFailure() {
  consecutiveFailures++;
  if (consecutiveFailures >= MAX_FAILURES) {
    circuitOpenUntil = Date.now() + BACKOFF_MS;
    console.warn(`[atlas] Circuit breaker open until ${new Date(circuitOpenUntil).toISOString()}`);
  }
}

// ─── Atlas HTTP ─────────────────────────────────────────────────────────────

function getAtlasConfig(ctx) {
  const atlas = ctx.config.integrations?.atlas;
  return {
    url: (atlas?.url ?? process.env.ATLAS_SYNC_URL ?? 'https://mp-atlas.fly.dev').replace(/\/$/, ''),
    endpoint: atlas?.sync_endpoint ?? '/api/sync/alfred-bot/items',
    token: atlas?.token ?? process.env.ATLAS_SYNC_KEY,
  };
}

async function atlasFetch(ctx, path, options = {}, timeoutMs = 10_000) {
  const { url, token } = getAtlasConfig(ctx);
  const fullUrl = `${url}${path}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(fullUrl, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
    });
    clearTimeout(timeout);
    return resp;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ─── Column Cache ───────────────────────────────────────────────────────────

let cachedColumns = [];
let columnCacheTime = 0;
const COLUMN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getColumns(ctx) {
  if (Date.now() - columnCacheTime < COLUMN_CACHE_TTL && cachedColumns.length > 0) {
    return cachedColumns;
  }

  if (isCircuitOpen()) {
    console.warn('[atlas] Circuit open, returning cached columns');
    return cachedColumns;
  }

  try {
    const { endpoint } = getAtlasConfig(ctx);
    const columnsPath = endpoint.replace(/\/items$/, '/columns');
    const resp = await atlasFetch(ctx, columnsPath);

    if (!resp.ok) throw new Error(`Columns fetch failed: ${resp.status}`);

    const data = await resp.json();
    cachedColumns = data.columns;
    columnCacheTime = Date.now();

    // Update SQLite cache
    const db = ensureDb(ctx.config);
    const upsert = db.prepare(
      `INSERT OR REPLACE INTO column_cache (id, name, slug, cached_at) VALUES (?, ?, ?, datetime('now'))`
    );
    const tx = db.transaction(() => {
      for (const col of cachedColumns) {
        upsert.run(col.id, col.name, col.slug);
      }
    });
    tx();

    recordSuccess();
    return cachedColumns;
  } catch (err) {
    recordFailure();

    // Fallback to SQLite cache
    if (cachedColumns.length === 0) {
      const db = ensureDb(ctx.config);
      cachedColumns = db.prepare('SELECT id, name, slug FROM column_cache').all();
    }
    return cachedColumns;
  }
}

export function findColumnByName(name, columns) {
  const lower = name.toLowerCase();
  return (
    columns.find(c => c.name.toLowerCase() === lower) ||
    columns.find(c => c.name.toLowerCase().includes(lower)) ||
    columns.find(c => c.slug.toLowerCase().includes(lower))
  );
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

export async function getItems(ctx, opts = {}) {
  if (isCircuitOpen()) {
    ctx.log.error('[atlas] Circuit open, returning empty items');
    return [];
  }

  try {
    const { endpoint } = getAtlasConfig(ctx);
    const params = new URLSearchParams();
    if (opts.status) params.set('status', opts.status);
    if (opts.columnId) params.set('columnId', opts.columnId);

    const queryStr = params.toString();
    const path = queryStr ? `${endpoint}?${queryStr}` : endpoint;

    const resp = await atlasFetch(ctx, path);
    if (!resp.ok) throw new Error(`Get items failed: ${resp.status}`);

    const data = await resp.json();
    recordSuccess();
    return data.items.map(item => ({
      ...item,
      columnName: item.column?.name || item.columnName || '',
    }));
  } catch (err) {
    ctx.log.error(`[atlas] Failed to get items: ${err}`);
    recordFailure();
    return [];
  }
}

export async function createItem(ctx, data) {
  if (isCircuitOpen()) {
    ctx.log.warn('[atlas] Circuit open, saving locally only');
    return null;
  }

  try {
    const { endpoint } = getAtlasConfig(ctx);

    // Use longer timeout if payload has image attachments
    const hasImages = data.attachments?.some(a => a.imageBase64);
    const fetchTimeout = hasImages ? 30_000 : 10_000;

    let resp = await atlasFetch(ctx, endpoint, {
      method: 'POST',
      body: JSON.stringify(data),
    }, fetchTimeout);

    // Single retry on 4xx/5xx (not auth)
    if (!resp.ok && resp.status !== 401 && resp.status !== 403) {
      const text = await resp.text();
      ctx.log.warn(`[atlas] Create failed (${resp.status}), retrying in 1s: ${text}`);
      await new Promise(r => setTimeout(r, 1000));
      resp = await atlasFetch(ctx, endpoint, {
        method: 'POST',
        body: JSON.stringify(data),
      }, fetchTimeout);
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Create item failed: ${resp.status} ${text}`);
    }

    const result = await resp.json();
    recordSuccess();
    return { id: result.item.id, atlasId: result.item.id };
  } catch (err) {
    ctx.log.error(`[atlas] Failed to create item: ${err}`);
    recordFailure();
    return null;
  }
}

export async function updateItem(ctx, itemId, data) {
  if (isCircuitOpen()) return false;

  try {
    const { endpoint } = getAtlasConfig(ctx);
    const resp = await atlasFetch(ctx, endpoint, {
      method: 'PATCH',
      body: JSON.stringify({ itemId, ...data }),
    });

    if (!resp.ok) throw new Error(`Update item failed: ${resp.status}`);
    recordSuccess();
    return true;
  } catch (err) {
    ctx.log.error(`[atlas] Failed to update item: ${err}`);
    recordFailure();
    return false;
  }
}

export async function deleteItem(ctx, itemId) {
  if (isCircuitOpen()) return false;

  try {
    const { endpoint } = getAtlasConfig(ctx);
    const resp = await atlasFetch(ctx, `${endpoint}?id=${itemId}`, {
      method: 'DELETE',
    });

    if (!resp.ok) throw new Error(`Delete item failed: ${resp.status}`);
    recordSuccess();
    return true;
  } catch (err) {
    ctx.log.error(`[atlas] Failed to delete item: ${err}`);
    recordFailure();
    return false;
  }
}

// ─── Sync Attachment ────────────────────────────────────────────────────────

export async function syncAttachment(ctx, taskId, attachment) {
  if (isCircuitOpen()) return false;

  try {
    const hasImage = !!attachment.imageBase64;
    const { endpoint } = getAtlasConfig(ctx);
    const resp = await atlasFetch(ctx, endpoint, {
      method: 'PATCH',
      body: JSON.stringify({ itemId: taskId, attachment }),
    }, hasImage ? 30_000 : 10_000);

    if (!resp.ok) {
      throw new Error(`Sync attachment failed: ${resp.status}`);
    }

    recordSuccess();
    return true;
  } catch (err) {
    ctx.log.error(`[atlas] Failed to sync attachment: ${err}`);
    recordFailure();
    return false;
  }
}

// ─── Retry Sync Pending ─────────────────────────────────────────────────────

export async function retrySyncPending(ctx) {
  const db = ensureDb(ctx.config);
  let synced = 0;

  // Phase 1: Unsynced tasks
  const pending = db
    .prepare('SELECT id, title, column_id, assignee, deadline, status, requester, requester_chat_id FROM tasks WHERE synced_at IS NULL')
    .all();

  for (const task of pending) {
    const pendingAttachments = db
      .prepare('SELECT id, type, filename, mime_type, telegram_file_id, url, link_title, image_base64 FROM task_attachments WHERE task_id = ? AND synced_at IS NULL')
      .all(task.id);

    const pendingSubtasks = db
      .prepare('SELECT id, title FROM task_subtasks WHERE task_id = ? AND synced_at IS NULL')
      .all(task.id);

    const attachments = pendingAttachments.map(a => ({
      type: a.type,
      filename: a.filename || undefined,
      mimeType: a.mime_type || undefined,
      url: a.url || undefined,
      linkTitle: a.link_title || undefined,
      imageBase64: a.image_base64 || undefined,
    }));

    const subtasks = pendingSubtasks.map(s => ({ title: s.title }));

    const result = await createItem(ctx, {
      title: task.title,
      columnId: task.column_id || undefined,
      assignee: task.assignee,
      deadline: task.deadline,
      status: task.status,
      attachments: attachments.length > 0 ? attachments : undefined,
      subtasks: subtasks.length > 0 ? subtasks : undefined,
      requester: task.requester || undefined,
      requesterChatId: task.requester_chat_id || undefined,
    });

    if (result) {
      db.prepare("UPDATE tasks SET spok_id = ?, synced_at = datetime('now') WHERE id = ?").run(result.atlasId, task.id);
      for (const a of pendingAttachments) {
        db.prepare("UPDATE task_attachments SET synced_at = datetime('now') WHERE id = ?").run(a.id);
      }
      for (const s of pendingSubtasks) {
        db.prepare("UPDATE task_subtasks SET synced_at = datetime('now') WHERE id = ?").run(s.id);
      }
      synced++;
    }
  }

  // Phase 2: Attachments for already-synced tasks
  const syncedTasksWithPendingAttachments = db
    .prepare(`SELECT DISTINCT t.id, t.spok_id FROM tasks t
              JOIN task_attachments ta ON ta.task_id = t.id
              WHERE t.synced_at IS NOT NULL AND ta.synced_at IS NULL AND t.spok_id IS NOT NULL`)
    .all();

  for (const task of syncedTasksWithPendingAttachments) {
    const attachments = db
      .prepare('SELECT id, type, filename, mime_type, url, link_title, image_base64 FROM task_attachments WHERE task_id = ? AND synced_at IS NULL')
      .all(task.id);

    for (const a of attachments) {
      const ok = await syncAttachment(ctx, task.spok_id, {
        type: a.type,
        filename: a.filename || undefined,
        mimeType: a.mime_type || undefined,
        url: a.url || undefined,
        linkTitle: a.link_title || undefined,
        imageBase64: a.image_base64 || undefined,
      });
      if (ok) {
        db.prepare("UPDATE task_attachments SET synced_at = datetime('now') WHERE id = ?").run(a.id);
        synced++;
      }
    }
  }

  // Phase 3: Subtasks for already-synced tasks
  const syncedTasksWithPendingSubtasks = db
    .prepare(`SELECT DISTINCT t.id, t.spok_id FROM tasks t
              JOIN task_subtasks ts ON ts.task_id = t.id
              WHERE t.synced_at IS NOT NULL AND ts.synced_at IS NULL AND t.spok_id IS NOT NULL`)
    .all();

  for (const task of syncedTasksWithPendingSubtasks) {
    const subs = db
      .prepare('SELECT id, title FROM task_subtasks WHERE task_id = ? AND synced_at IS NULL')
      .all(task.id);

    try {
      const { endpoint } = getAtlasConfig(ctx);
      const resp = await atlasFetch(ctx, endpoint, {
        method: 'PATCH',
        body: JSON.stringify({ itemId: task.spok_id, subtasks: subs.map(s => ({ title: s.title })) }),
      });
      if (resp.ok) {
        for (const s of subs) {
          db.prepare("UPDATE task_subtasks SET synced_at = datetime('now') WHERE id = ?").run(s.id);
        }
        synced++;
        recordSuccess();
      }
    } catch (err) {
      ctx.log.error(`[atlas] Failed to sync subtasks: ${err}`);
      recordFailure();
    }
  }

  return synced;
}

// ─── Local DB Helpers ───────────────────────────────────────────────────────

export function findTaskByIdPrefix(ctx, idPrefix) {
  const db = ensureDb(ctx.config);
  return db.prepare(
    'SELECT id, spok_id, title, column_name FROM tasks WHERE id LIKE ? OR spok_id LIKE ?'
  ).get(`${idPrefix}%`, `${idPrefix}%`);
}
