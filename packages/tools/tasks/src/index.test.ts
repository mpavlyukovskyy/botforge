import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import {
  LocalTaskStore,
  createTaskTool,
  updateTaskTool,
  markDoneTool,
  deleteTaskTool,
  queryBoardTool,
  allTaskTools,
} from './index.js';

let store: LocalTaskStore;

beforeEach(() => {
  const db = new Database(':memory:');
  store = new LocalTaskStore(db);
});

describe('LocalTaskStore', () => {
  it('create returns a Task with id, defaults to TODO', async () => {
    const t = await store.create({ title: 'foo' });
    assert.ok(t.id.startsWith('t'));
    assert.equal(t.title, 'foo');
    assert.equal(t.status, 'TODO');
  });

  it('get retrieves a created task', async () => {
    const created = await store.create({ title: 'bar', column: 'To Do', deadline: '2026-06-01' });
    const got = await store.get(created.id);
    assert.equal(got?.title, 'bar');
    assert.equal(got?.column, 'To Do');
    assert.equal(got?.deadline, '2026-06-01');
  });

  it('update modifies the given fields', async () => {
    const t = await store.create({ title: 'baz' });
    const updated = await store.update({ id: t.id, status: 'IN_PROGRESS', notes: 'started' });
    assert.equal(updated.status, 'IN_PROGRESS');
    assert.equal(updated.notes, 'started');
  });

  it('markDone shorthand', async () => {
    const t = await store.create({ title: 'finish me' });
    const done = await store.markDone(t.id);
    assert.equal(done.status, 'DONE');
  });

  it('delete removes the task', async () => {
    const t = await store.create({ title: 'gone' });
    await store.delete(t.id);
    assert.equal(await store.get(t.id), undefined);
  });

  it('query filters by status', async () => {
    await store.create({ title: 'a' });
    const b = await store.create({ title: 'b' });
    await store.markDone(b.id);
    const todos = await store.query({ status: 'TODO' });
    const dones = await store.query({ status: 'DONE' });
    assert.equal(todos.length, 1);
    assert.equal(todos[0].title, 'a');
    assert.equal(dones.length, 1);
    assert.equal(dones[0].title, 'b');
  });

  it('query filters by column', async () => {
    await store.create({ title: 'a', column: 'To Do' });
    await store.create({ title: 'b', column: 'In Progress' });
    const filtered = await store.query({ column: 'In Progress' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].title, 'b');
  });

  it('query respects limit', async () => {
    for (let i = 0; i < 5; i++) await store.create({ title: `t${i}` });
    const rows = await store.query({ limit: 2 });
    assert.equal(rows.length, 2);
  });
});

describe('Tool factories', () => {
  it('createTaskTool wires the backend correctly', async () => {
    const tool = createTaskTool({ backend: store });
    assert.equal(tool.name, 'create_task');
    const out = await tool.execute({ title: 'hello' }, {} as any);
    assert.match(out, /Created task t/);
    const rows = await store.query();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'hello');
  });

  it('updateTaskTool wires status changes', async () => {
    const t = await store.create({ title: 'x' });
    const tool = updateTaskTool({ backend: store });
    const out = await tool.execute({ id: t.id, status: 'IN_PROGRESS' }, {} as any);
    assert.match(out, /Updated task/);
    assert.equal((await store.get(t.id))?.status, 'IN_PROGRESS');
  });

  it('markDoneTool delegates to backend', async () => {
    const t = await store.create({ title: 'finish' });
    const tool = markDoneTool({ backend: store });
    await tool.execute({ id: t.id }, {} as any);
    assert.equal((await store.get(t.id))?.status, 'DONE');
  });

  it('deleteTaskTool removes the row', async () => {
    const t = await store.create({ title: 'temp' });
    const tool = deleteTaskTool({ backend: store });
    await tool.execute({ id: t.id }, {} as any);
    assert.equal(await store.get(t.id), undefined);
  });

  it('queryBoardTool formats output as tab-separated lines', async () => {
    await store.create({ title: 'a' });
    await store.create({ title: 'b' });
    const tool = queryBoardTool({ backend: store });
    const out = await tool.execute({}, {} as any);
    const lines = out.split('\n');
    assert.equal(lines.length, 2);
    for (const line of lines) assert.match(line, /\tTODO\t/);
  });

  it('queryBoardTool returns "(no tasks)" when empty', async () => {
    const tool = queryBoardTool({ backend: store });
    const out = await tool.execute({}, {} as any);
    assert.equal(out, '(no tasks)');
  });

  it('allTaskTools returns the 5 standard tools in order', () => {
    const tools = allTaskTools({ backend: store });
    assert.deepEqual(tools.map((t) => t.name), [
      'create_task', 'update_task', 'mark_done', 'delete_task', 'query_board',
    ]);
  });
});
