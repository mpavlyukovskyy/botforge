/**
 * @botforge/tools-tasks — task-CRUD tool factory + pluggable backends.
 *
 * Kristina, Atlas, and Harry have all reimplemented create_task, update_task,
 * mark_done, query_board. This package exposes the canonical surface and a
 * TaskStore interface. Bots provide a TaskStore implementation (spok-API,
 * atlas-API, local SQLite) and wire the factory-built tools into their
 * tools dir.
 *
 * Bot usage (e.g. bots/kristina/tools/create_task.js):
 *   import { createTaskTool } from '@botforge/tools-tasks';
 *   import { spokBackend } from '../lib/spok-backend.js';
 *   export default createTaskTool({ backend: spokBackend });
 *
 * Framework provides LocalTaskStore (SQLite-backed) for bots without an
 * external Atlas/Spok target. Bot authors implement SpokTaskStore /
 * AtlasTaskStore in their own lib/ — those need credentials and project
 * IDs the framework can't know about.
 */

import { z } from 'zod';
import type { ToolImplementation } from '@botforge/core';

export interface Task {
  id: string;
  title: string;
  status: 'TODO' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
  column?: string;
  deadline?: string;
  notes?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateTaskInput {
  title: string;
  column?: string;
  deadline?: string;
  notes?: string;
}

export interface UpdateTaskInput {
  id: string;
  title?: string;
  status?: Task['status'];
  column?: string;
  deadline?: string;
  notes?: string;
}

export interface TaskStore {
  create(input: CreateTaskInput): Promise<Task>;
  update(input: UpdateTaskInput): Promise<Task>;
  markDone(id: string): Promise<Task>;
  delete(id: string): Promise<void>;
  query(opts?: { status?: Task['status']; column?: string; limit?: number }): Promise<Task[]>;
  get(id: string): Promise<Task | undefined>;
}

// ─── Tool factory functions ─────────────────────────────────────────────────

export function createTaskTool(opts: { backend: TaskStore }): ToolImplementation {
  return {
    name: 'create_task',
    description: 'Create a new task on the board.',
    schema: {
      title: z.string().describe('Task title'),
      column: z.string().optional().describe('Board column (e.g. To Do, In Progress)'),
      deadline: z.string().optional().describe('ISO 8601 deadline'),
      notes: z.string().optional().describe('Free-text notes'),
    },
    async execute(args: unknown): Promise<string> {
      const input = args as CreateTaskInput;
      const task = await opts.backend.create(input);
      return `Created task ${task.id}: "${task.title}"`;
    },
  };
}

export function updateTaskTool(opts: { backend: TaskStore }): ToolImplementation {
  return {
    name: 'update_task',
    description: 'Update an existing task by id.',
    schema: {
      id: z.string(),
      title: z.string().optional(),
      status: z.enum(['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(),
      column: z.string().optional(),
      deadline: z.string().optional(),
      notes: z.string().optional(),
    },
    async execute(args: unknown): Promise<string> {
      const task = await opts.backend.update(args as UpdateTaskInput);
      return `Updated task ${task.id}`;
    },
  };
}

export function markDoneTool(opts: { backend: TaskStore }): ToolImplementation {
  return {
    name: 'mark_done',
    description: 'Mark a task as DONE.',
    schema: { id: z.string() },
    async execute(args: unknown): Promise<string> {
      const task = await opts.backend.markDone((args as { id: string }).id);
      return `Marked ${task.id} as DONE.`;
    },
  };
}

export function deleteTaskTool(opts: { backend: TaskStore }): ToolImplementation {
  return {
    name: 'delete_task',
    description: 'Delete a task by id.',
    schema: { id: z.string() },
    async execute(args: unknown): Promise<string> {
      const id = (args as { id: string }).id;
      await opts.backend.delete(id);
      return `Deleted task ${id}`;
    },
  };
}

export function queryBoardTool(opts: { backend: TaskStore }): ToolImplementation {
  return {
    name: 'query_board',
    description: 'List tasks with optional filters.',
    schema: {
      status: z.enum(['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(),
      column: z.string().optional(),
      limit: z.number().optional(),
    },
    async execute(args: unknown): Promise<string> {
      const tasks = await opts.backend.query(args as { status?: Task['status']; column?: string; limit?: number });
      const lines = tasks.map((t) => `${t.id}\t${t.status}\t${t.title}`);
      return lines.join('\n') || '(no tasks)';
    },
  };
}

export function allTaskTools(opts: { backend: TaskStore }): ToolImplementation[] {
  return [
    createTaskTool(opts),
    updateTaskTool(opts),
    markDoneTool(opts),
    deleteTaskTool(opts),
    queryBoardTool(opts),
  ];
}

// ─── LocalTaskStore — SQLite-backed reference backend ───────────────────────

interface DatabaseLike {
  prepare(sql: string): {
    run(...params: unknown[]): { changes?: number; lastInsertRowid?: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

interface RawRow {
  id: string;
  title: string;
  status: Task['status'];
  column_name: string | null;
  deadline: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export class LocalTaskStore implements TaskStore {
  constructor(private db: DatabaseLike) {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'TODO',
        column_name TEXT,
        deadline TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();
  }

  private rowToTask(row: RawRow): Task {
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      column: row.column_name ?? undefined,
      deadline: row.deadline ?? undefined,
      notes: row.notes ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async create(input: CreateTaskInput): Promise<Task> {
    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.db.prepare(
      `INSERT INTO tasks (id, title, column_name, deadline, notes) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, input.title, input.column ?? null, input.deadline ?? null, input.notes ?? null);
    return (await this.get(id))!;
  }

  async update(input: UpdateTaskInput): Promise<Task> {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const key of ['title', 'status', 'deadline', 'notes'] as const) {
      if (input[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(input[key]);
      }
    }
    if (input.column !== undefined) {
      fields.push(`column_name = ?`);
      values.push(input.column);
    }
    if (fields.length === 0) return (await this.get(input.id))!;
    fields.push(`updated_at = datetime('now')`);
    values.push(input.id);
    this.db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return (await this.get(input.id))!;
  }

  async markDone(id: string): Promise<Task> {
    return this.update({ id, status: 'DONE' });
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  async query(opts: { status?: Task['status']; column?: string; limit?: number } = {}): Promise<Task[]> {
    const where: string[] = [];
    const values: unknown[] = [];
    if (opts.status) { where.push('status = ?'); values.push(opts.status); }
    if (opts.column) { where.push('column_name = ?'); values.push(opts.column); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = opts.limit ?? 100;
    const rows = this.db.prepare(
      `SELECT * FROM tasks ${whereClause} ORDER BY updated_at DESC LIMIT ?`,
    ).all(...values, limit) as RawRow[];
    return rows.map((r) => this.rowToTask(r));
  }

  async get(id: string): Promise<Task | undefined> {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as RawRow | undefined;
    return row ? this.rowToTask(row) : undefined;
  }
}
