// Bot-side unit tests (LOCAL-ONLY — botforge CI has no vitest job).
// Run: pnpm vitest run bots/hali99
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fix from './fix.js';
import fixmap from './fixmap.js';
import fixAction from '../callbacks/fix-action.js';
import { postDashboard } from '../lib/findlays-api.js';

function makeCtx() {
  return {
    chatId: '-5181340999',
    userId: '381823289',
    userName: 'mark',
    adapter: { send: vi.fn(async () => {}), sendChatAction: vi.fn(async () => {}) },
    answerCallback: vi.fn(async () => {}),
    log: { info: vi.fn(), error: vi.fn() },
  };
}

beforeEach(() => {
  process.env.FINDLAYS_WEBSITE_URL = 'https://dash.example';
  process.env.HALI99_SHARED_SECRET = 's3cret';
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FINDLAYS_WEBSITE_URL;
  delete process.env.HALI99_SHARED_SECRET;
});

describe('postDashboard', () => {
  it('POSTs JSON with Bearer auth and never throws on HTTP status', async () => {
    const fetchMock = vi.fn(async () => ({ status: 401, json: async () => ({ ok: false }) }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await postDashboard('/api/telegram-bot/fix', { chatId: '-1' });
    expect(r.status).toBe(401);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://dash.example/api/telegram-bot/fix');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer s3cret');
    expect(JSON.parse(init.body)).toEqual({ chatId: '-1' });
  });
});

describe('/fix command', () => {
  it('silent on success (menu arrives as the dashboard message)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, text: '' }) })));
    const ctx = makeCtx();
    await fix.execute('', ctx);
    expect(ctx.adapter.send).not.toHaveBeenCalled();
  });

  it('relays refusal text (non-operator)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, text: 'Sorry — approved operators only.' }) })));
    const ctx = makeCtx();
    await fix.execute('', ctx);
    expect(ctx.adapter.send).toHaveBeenCalledWith({ chatId: ctx.chatId, text: 'Sorry — approved operators only.' });
  });

  it('transport failure → generic line, never a crash', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const ctx = makeCtx();
    await fix.execute('', ctx);
    expect(ctx.adapter.send.mock.calls[0][0].text).toContain("Couldn't reach the dashboard");
  });
});

describe('/fixmap command', () => {
  it('forwards raw args for server-side parsing', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, text: '' }) }));
    vi.stubGlobal('fetch', fetchMock);
    const ctx = makeCtx();
    await fixmap.execute(' 29 5216 ', ctx);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).args).toBe('29 5216');
  });
});

describe('fix-action callback', () => {
  it('parses fix:<plan>:<action>, forwards the tap, answers with the ack', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, text: '⏳ Confirm #6795 — working, result will follow here.' }) }));
    vi.stubGlobal('fetch', fetchMock);
    const ctx = makeCtx();
    await fixAction.execute('fix:p1234567:a0', ctx);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent).toEqual({ planId: 'p1234567', actionId: 'a0', userId: '381823289', userName: 'mark' });
    expect(ctx.answerCallback).toHaveBeenCalledOnce();
    expect(ctx.answerCallback.mock.calls[0][0]).toContain('working');
  });

  it('malformed data → "Bad button data", no dashboard call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const ctx = makeCtx();
    await fixAction.execute('fix:', ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.answerCallback).toHaveBeenCalledWith('Bad button data');
  });

  it('long result text truncated to the answerCallback cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, text: 'x'.repeat(500) }) })));
    const ctx = makeCtx();
    await fixAction.execute('fix:p:a0', ctx);
    expect(ctx.answerCallback.mock.calls[0][0].length).toBeLessThanOrEqual(190);
  });

  it('transport failure → apologetic toast', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout'); }));
    const ctx = makeCtx();
    await fixAction.execute('fix:p:a0', ctx);
    expect(ctx.answerCallback.mock.calls[0][0]).toContain("Couldn't reach");
  });
});
