// Bot-side unit tests (LOCAL-ONLY — botforge CI has no vitest job).
// Run: pnpm run test:argus  (root vitest over all per-bot globs)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseOrderId, callDashboard, runStatusCommand } from './findlays-api.js';

describe('parseOrderId', () => {
  it('accepts plain and #-prefixed numeric ids', () => {
    expect(parseOrderId('8300')).toBe('8300');
    expect(parseOrderId(' #8300 ')).toBe('8300');
  });
  it('rejects empty/non-numeric', () => {
    expect(parseOrderId('')).toBeNull();
    expect(parseOrderId('abc')).toBeNull();
    expect(parseOrderId('#83a0')).toBeNull();
    expect(parseOrderId(undefined)).toBeNull();
  });
});

describe('callDashboard', () => {
  beforeEach(() => {
    process.env.FINDLAYS_WEBSITE_URL = 'https://dash.example';
    process.env.HALI99_SHARED_SECRET = 's3cret';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FINDLAYS_WEBSITE_URL;
    delete process.env.HALI99_SHARED_SECRET;
  });

  it('returns {status, body} WITHOUT throwing on non-200 (400 usage bodies render)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 400, json: async () => ({ ok: false, text: 'Usage: /order <id>' }) }))
    );
    const r = await callDashboard('/api/x');
    expect(r.status).toBe(400);
    expect(r.body.text).toBe('Usage: /order <id>');
  });

  it('sends Bearer auth to the joined URL', async () => {
    const f = vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, text: 'hi' }) }));
    vi.stubGlobal('fetch', f);
    await callDashboard('/api/telegram-bot/orders-status?view=today');
    expect(f.mock.calls[0][0]).toBe('https://dash.example/api/telegram-bot/orders-status?view=today');
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer s3cret');
  });

  it('throws when env missing', async () => {
    delete process.env.FINDLAYS_WEBSITE_URL;
    await expect(callDashboard('/x')).rejects.toThrow(/not configured/);
  });
});

describe('runStatusCommand', () => {
  function ctx() {
    return {
      chatId: '-5181340999',
      adapter: { send: vi.fn(async () => 1), sendChatAction: vi.fn(async () => {}) },
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

  it('typing indicator (positional args!) → sends body.text verbatim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, text: '📋 reply', meta: { source: 'live', ccCount: 1, onlineCount: 0, posCount: 1 } }) }))
    );
    const c = ctx();
    await runStatusCommand(c, '/api/x');
    expect(c.adapter.sendChatAction).toHaveBeenCalledWith('-5181340999', 'typing');
    expect(c.adapter.send).toHaveBeenCalledWith({ chatId: '-5181340999', text: '📋 reply' });
    expect(c.log.info).toHaveBeenCalled(); // meta logged for journalctl
  });

  it('renders body.text even on 400 (usage line)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 400, json: async () => ({ ok: false, text: 'Usage: x' }) })));
    const c = ctx();
    await runStatusCommand(c, '/api/x');
    expect(c.adapter.send).toHaveBeenCalledWith({ chatId: '-5181340999', text: 'Usage: x' });
  });

  it('transport failure → generic line, never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout'); }));
    const c = ctx();
    await runStatusCommand(c, '/api/x');
    expect(c.adapter.send.mock.calls[0][0].text).toContain("Couldn't fetch");
    expect(c.log.error).toHaveBeenCalled();
  });

  it('missing sendChatAction (optional) does not break', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, text: 'hi' }) })));
    const c = ctx();
    delete c.adapter.sendChatAction;
    await runStatusCommand(c, '/api/x');
    expect(c.adapter.send).toHaveBeenCalled();
  });
});
