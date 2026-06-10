/**
 * S3 procedural-justice tools: contest_deduction (owner-or-Mark, flags only),
 * reverse_deduction (Mark-only, refunds), recognize (Mark-only).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

let db;
let admin = false;
const patchSpy = vi.fn(async () => true);
const recogSpy = vi.fn(async () => true);
const sent = [];

vi.mock('../lib/atlas-client.js', () => ({
  ensureDb: () => db,
  findDeductionByIdPrefix: (_ctx, p) => db.prepare('SELECT id, amount, reason, requester_chat_id, reversed_at, contested_at FROM deductions WHERE id LIKE ?').get(`${p}%`),
  patchDeduction: patchSpy,
  postRecognition: recogSpy,
}));
vi.mock('../lib/db.js', () => ({ isAdmin: () => admin, findTaskByIdPrefix: () => null }));

const contestDeduction = (await import('./contest_deduction.js')).default;
const reverseDeduction = (await import('./reverse_deduction.js')).default;
const recognize = (await import('./recognize.js')).default;

function ctx(chatId = '999') {
  return { config: { name: 't', behavior: { access: { admin_users: ['381823289'] } } }, chatId, adapter: { send: async (m) => sent.push(m) }, log: { warn() {}, info() {} } };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`CREATE TABLE deductions (id TEXT PRIMARY KEY, amount REAL, reason TEXT, requester_chat_id TEXT, billing_month TEXT, reversed_at TEXT, contested_at TEXT, contest_note TEXT);`);
  db.prepare("INSERT INTO deductions (id, amount, reason, requester_chat_id, billing_month) VALUES ('ded12345abc', 0.1, 'no update on X', '555', '2026-06')").run();
  admin = false; patchSpy.mockClear(); recogSpy.mockClear(); sent.length = 0;
});

describe('contest_deduction', () => {
  it('owner can contest → flags (contested_at set), not reversed', async () => {
    const out = await contestDeduction.execute({ deduction_id: 'D:ded12345', reason: 'was blocked' }, ctx('555'));
    expect(out).toMatch(/Flagged/i);
    const r = db.prepare("SELECT contested_at, reversed_at FROM deductions WHERE id='ded12345abc'").get();
    expect(r.contested_at).toBeTruthy();
    expect(r.reversed_at).toBeNull();
    expect(patchSpy).toHaveBeenCalledWith(expect.anything(), 'ded12345abc', expect.objectContaining({ action: 'contest' }));
  });
  it('non-owner non-admin CANNOT contest someone else\'s deduction', async () => {
    const out = await contestDeduction.execute({ deduction_id: 'D:ded12345' }, ctx('777'));
    expect(out).toMatch(/only contest your own/i);
    expect(patchSpy).not.toHaveBeenCalled();
  });
  it('admin can contest any', async () => {
    admin = true;
    const out = await contestDeduction.execute({ deduction_id: 'ded12345' }, ctx('111'));
    expect(out).toMatch(/Flagged/i);
  });
  it('rejects an already-reversed deduction', async () => {
    db.prepare("UPDATE deductions SET reversed_at = datetime('now') WHERE id='ded12345abc'").run();
    const out = await contestDeduction.execute({ deduction_id: 'ded12345' }, ctx('555'));
    expect(out).toMatch(/already reversed/i);
  });
});

describe('reverse_deduction', () => {
  it('Mark reverses → reversed_at set + Atlas patched + charged user notified', async () => {
    admin = true;
    const out = await reverseDeduction.execute({ deduction_id: 'D:ded12345' }, ctx('381823289'));
    expect(out).toMatch(/Reversed/i);
    expect(db.prepare("SELECT reversed_at FROM deductions WHERE id='ded12345abc'").get().reversed_at).toBeTruthy();
    expect(patchSpy).toHaveBeenCalledWith(expect.anything(), 'ded12345abc', expect.objectContaining({ action: 'reverse' }));
    expect(sent.some(m => m.chatId === '555')).toBe(true); // notified the charged user
  });
  it('non-admin cannot reverse', async () => {
    admin = false;
    const out = await reverseDeduction.execute({ deduction_id: 'ded12345' }, ctx('555'));
    expect(out).toMatch(/Only Mark/i);
    expect(patchSpy).not.toHaveBeenCalled();
  });
});

describe('recognize', () => {
  it('Mark-only', async () => {
    admin = false;
    expect(await recognize.execute({ note: 'great' }, ctx('555'))).toMatch(/Only Mark/i);
    expect(recogSpy).not.toHaveBeenCalled();
    admin = true;
    expect(await recognize.execute({ note: 'great job on the flight' }, ctx('381823289'))).toMatch(/recorded/i);
    expect(recogSpy).toHaveBeenCalledOnce();
  });
});
