/**
 * Test for isAdmin(ctx) — the helper that gates cancel/delete/deadline-change.
 *
 * Background: in the 2026-05-18 post-cutover smoke test, query_board.js
 * silently filtered out 13 of 16 OPEN tasks because Mark's DM chat
 * (381823289) wasn't in registered_chats. The isAdmin helper bypasses
 * requester filtering for admins and gates destructive operations.
 */
import { describe, it, expect } from 'vitest';
import { isAdmin } from './db.js';

const ADMIN_ID = '381823289'; // Mark

function makeConfig(adminUsers = [ADMIN_ID]) {
  return {
    name: 'Kristina',
    behavior: { access: { admin_users: adminUsers } },
  };
}

describe('isAdmin', () => {
  it('returns true when userId matches admin list', () => {
    const ctx = { config: makeConfig(), userId: ADMIN_ID, chatId: '-100' };
    expect(isAdmin(ctx)).toBe(true);
  });

  it('returns true when chatId matches admin list (DM where chatId == userId)', () => {
    const ctx = { config: makeConfig(), userId: 'other', chatId: ADMIN_ID };
    expect(isAdmin(ctx)).toBe(true);
  });

  it('returns false when neither userId nor chatId match', () => {
    const ctx = { config: makeConfig(), userId: '12345', chatId: '-5211981099' };
    expect(isAdmin(ctx)).toBe(false);
  });

  it('compares as strings (handles numeric userId from Telegram)', () => {
    const ctx = { config: makeConfig(), userId: 381823289, chatId: 381823289 };
    expect(isAdmin(ctx)).toBe(true);
  });

  it('returns false when admin_users is empty', () => {
    const ctx = { config: makeConfig([]), userId: ADMIN_ID, chatId: ADMIN_ID };
    expect(isAdmin(ctx)).toBe(false);
  });

  it('returns false when config.behavior is missing', () => {
    const ctx = { config: { name: 'Kristina' }, userId: ADMIN_ID, chatId: ADMIN_ID };
    expect(isAdmin(ctx)).toBe(false);
  });

  it('returns false when config is missing entirely', () => {
    const ctx = { userId: ADMIN_ID, chatId: ADMIN_ID };
    expect(isAdmin(ctx)).toBe(false);
  });

  it('supports multiple admins', () => {
    const ctx = { config: makeConfig([ADMIN_ID, '999']), userId: '999', chatId: '-1' };
    expect(isAdmin(ctx)).toBe(true);
  });
});
