import { v4 as uuidv4 } from 'uuid';
import { getDb } from './index.js';

export interface Task {
  id: string;
  title: string;
  column_name: string;
  category: string;
  priority: number;
  assignee: string | null;
  deadline: string | null;
  deadline_time: string | null;
  status: string;
  source: string;
  telegram_msg_id: string | null;
  google_event_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Subtask {
  id: number;
  task_id: string;
  title: string;
  completed: number;
  display_order: number;
}

export interface Attachment {
  id: number;
  task_id: string;
  type: string;
  filename: string | null;
  mime_type: string | null;
  telegram_file_id: string | null;
  url: string | null;
  image_base64: string | null;
  created_at: string;
}

export function getOpenTasks(category?: string): Task[] {
  const db = getDb();
  if (category) {
    return db.prepare(
      "SELECT * FROM tasks WHERE status = 'OPEN' AND category = ? ORDER BY priority ASC, created_at DESC"
    ).all(category) as Task[];
  }
  return db.prepare(
    "SELECT * FROM tasks WHERE status = 'OPEN' ORDER BY priority ASC, created_at DESC"
  ).all() as Task[];
}

export function getTasksByColumn(column: string, category?: string): Task[] {
  const db = getDb();
  if (category) {
    return db.prepare(
      "SELECT * FROM tasks WHERE column_name = ? AND category = ? AND status = 'OPEN' ORDER BY priority ASC, created_at DESC"
    ).all(column, category) as Task[];
  }
  return db.prepare(
    "SELECT * FROM tasks WHERE column_name = ? AND status = 'OPEN' ORDER BY priority ASC, created_at DESC"
  ).all(column) as Task[];
}

export function getOverdueTasks(): Task[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM tasks WHERE status = 'OPEN' AND deadline IS NOT NULL AND deadline < date('now') ORDER BY deadline ASC"
  ).all() as Task[];
}

export function getDueWithin(days: number): Task[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM tasks WHERE status = 'OPEN' AND deadline IS NOT NULL AND deadline >= date('now') AND deadline <= date('now', ? || ' days') ORDER BY deadline ASC"
  ).all(String(days)) as Task[];
}

export function getNewlyOverdue(sinceISO: string): Task[] {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM tasks WHERE status = 'OPEN' AND deadline IS NOT NULL AND deadline < date('now') AND deadline >= ? ORDER BY deadline ASC"
  ).all(sinceISO) as Task[];
}

export function findTaskByIdPrefix(idPrefix: string, replyMsgId?: number): Task | null {
  const db = getDb();

  // If input is a bare number and we have a reply context, resolve via message_refs
  if (/^\d{1,3}$/.test(idPrefix) && replyMsgId) {
    const ref = db.prepare('SELECT task_id FROM message_refs WHERE msg_id = ? AND ref_num = ?')
      .get(replyMsgId, parseInt(idPrefix)) as { task_id: string } | undefined;
    if (ref) {
      return db.prepare('SELECT * FROM tasks WHERE id = ?')
        .get(ref.task_id) as Task | null;
    }
  }

  return db.prepare(
    'SELECT * FROM tasks WHERE id LIKE ?'
  ).get(`${idPrefix}%`) as Task | null;
}

export function createTask(data: {
  title: string;
  column_name?: string;
  category?: string;
  priority?: number;
  assignee?: string;
  deadline?: string;
  deadline_time?: string;
  status?: string;
  source?: string;
  telegram_msg_id?: string;
  subtasks?: string[];
}): string {
  const db = getDb();
  const id = uuidv4();

  db.prepare(
    `INSERT INTO tasks (id, title, column_name, category, priority, assignee, deadline, deadline_time, status, source, telegram_msg_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
  ).run(
    id,
    data.title,
    data.column_name || 'To Do',
    data.category || 'home',
    data.priority ?? 2,
    data.assignee || null,
    data.deadline || null,
    data.deadline_time || null,
    data.status || 'OPEN',
    data.source || 'telegram',
    data.telegram_msg_id || null,
  );

  // Store subtasks
  if (data.subtasks && data.subtasks.length > 0) {
    const stmt = db.prepare(
      'INSERT INTO task_subtasks (task_id, title, display_order) VALUES (?, ?, ?)'
    );
    data.subtasks.forEach((title, idx) => stmt.run(id, title, idx));
  }

  return id;
}

export function updateTask(id: string, fields: {
  title?: string;
  column_name?: string;
  category?: string;
  priority?: number;
  assignee?: string;
  deadline?: string;
  deadline_time?: string;
  status?: string;
  google_event_id?: string;
}): void {
  const db = getDb();

  // Auto-sync column ↔ status (only when the other isn't explicitly provided)
  if (fields.status === undefined && fields.column_name !== undefined) {
    if (fields.column_name === 'Done') {
      fields.status = 'DONE';
    } else {
      const current = db.prepare('SELECT status FROM tasks WHERE id = ?').get(id) as { status: string } | undefined;
      if (current && current.status !== 'ARCHIVED') {
        fields.status = 'OPEN';
      }
    }
  }

  const sets: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      sets.push(`${key} = ?`);
      values.push(value);
    }
  }

  values.push(id);
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function markDone(ids: string[]): void {
  const db = getDb();
  const stmt = db.prepare(
    "UPDATE tasks SET status = 'DONE', column_name = 'Done', updated_at = datetime('now') WHERE id = ?"
  );
  for (const id of ids) {
    stmt.run(id);
  }
}

export function deleteTask(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

export function getTaskById(id: string): Task | null {
  const db = getDb();
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | null;
}

export function getTaskStats(): { open: number; done: number; overdue: number; byCategory: Record<string, number> } {
  const db = getDb();
  const open = (db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'OPEN'").get() as { cnt: number }).cnt;
  const done = (db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status = 'DONE'").get() as { cnt: number }).cnt;
  const overdue = (db.prepare(
    "SELECT COUNT(*) as cnt FROM tasks WHERE status = 'OPEN' AND deadline IS NOT NULL AND deadline < date('now')"
  ).get() as { cnt: number }).cnt;

  const categories = db.prepare(
    "SELECT category, COUNT(*) as cnt FROM tasks WHERE status = 'OPEN' GROUP BY category"
  ).all() as Array<{ category: string; cnt: number }>;

  const byCategory: Record<string, number> = {};
  for (const c of categories) {
    byCategory[c.category] = c.cnt;
  }

  return { open, done, overdue, byCategory };
}

export function getAllTasks(statusFilter?: string): Task[] {
  const db = getDb();
  if (statusFilter) {
    return db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, created_at DESC')
      .all(statusFilter) as Task[];
  }
  return db.prepare("SELECT * FROM tasks WHERE status IN ('OPEN', 'DONE') ORDER BY priority ASC, created_at DESC")
    .all() as Task[];
}

export function getSubtasks(taskId: string): Subtask[] {
  const db = getDb();
  return db.prepare('SELECT * FROM task_subtasks WHERE task_id = ? ORDER BY display_order')
    .all(taskId) as Subtask[];
}

export function toggleSubtask(subtaskId: number): void {
  const db = getDb();
  db.prepare("UPDATE task_subtasks SET completed = CASE WHEN completed = 0 THEN 1 ELSE 0 END, updated_at = datetime('now') WHERE id = ?")
    .run(subtaskId);
}

export function addSubtask(taskId: string, title: string): number {
  const db = getDb();
  const maxOrder = (db.prepare('SELECT MAX(display_order) as m FROM task_subtasks WHERE task_id = ?')
    .get(taskId) as { m: number | null })?.m ?? -1;
  const result = db.prepare('INSERT INTO task_subtasks (task_id, title, display_order) VALUES (?, ?, ?)')
    .run(taskId, title, maxOrder + 1);
  return result.lastInsertRowid as number;
}

export function getAttachments(taskId: string): Attachment[] {
  const db = getDb();
  return db.prepare('SELECT * FROM task_attachments WHERE task_id = ? ORDER BY display_order')
    .all(taskId) as Attachment[];
}
