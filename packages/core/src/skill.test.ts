import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runWithRequestContext,
  getRequestContext,
  mintTelegramRequestId,
} from './skill.js';

/**
 * Pino writes to stdout directly. To inspect output without corrupting the
 * test runner's TAP stream, spawn a sub-process that runs createLogger and
 * captures its stdout.
 */
function runLogScenario(scenarioName: 'json' | 'level' | 'redact' | 'structured'): Array<Record<string, unknown>> {
  const tmp = mkdtempSync(join(tmpdir(), 'skill-log-'));
  const scriptPath = join(tmp, 'runner.mjs');
  const scripts: Record<string, string> = {
    json: `
      import { createLogger } from '${join(import.meta.dirname ?? '.', 'skill.ts')}';
      const log = createLogger('TestBot');
      log.info('hello world');
    `,
    level: `
      import { createLogger } from '${join(import.meta.dirname ?? '.', 'skill.ts')}';
      const log = createLogger('TestBot');
      log.debug('should not appear');
      log.info('should appear');
    `,
    redact: `
      import { createLogger } from '${join(import.meta.dirname ?? '.', 'skill.ts')}';
      const log = createLogger('TestBot');
      log.info('login attempt', { user: 'mark', password: 'sekret-123', token: 'bearer-xyz', apiKey: 'sk-abc' });
    `,
    structured: `
      import { createLogger } from '${join(import.meta.dirname ?? '.', 'skill.ts')}';
      const log = createLogger('TestBot');
      log.info('event', { order_id: 42, latency_ms: 123 });
    `,
  };
  writeFileSync(scriptPath, scripts[scenarioName], 'utf-8');
  const out = execSync(`node --import tsx ${scriptPath}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  rmSync(tmp, { recursive: true, force: true });
  return out.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l) as Record<string, unknown>; } catch { return { _raw: l }; }
  });
}

describe('mintTelegramRequestId', () => {
  it('formats tg:{chat_id}:{update_id}', () => {
    assert.equal(mintTelegramRequestId('42', 100), 'tg:42:100');
  });

  it('handles undefined chat_id', () => {
    assert.equal(mintTelegramRequestId(undefined, 99), 'tg:unknown:99');
  });

  it('handles undefined update_id with a fallback', () => {
    const id = mintTelegramRequestId('42', undefined);
    assert.match(id, /^tg:42:\d+$/, 'falls back to Date.now()-ish value');
  });
});

describe('createLogger — JSON output (via subprocess capture)', () => {
  it('emits JSON lines with bot name and ISO timestamp', () => {
    const lines = runLogScenario('json');
    const last = lines[lines.length - 1];
    assert.equal(last.bot, 'TestBot');
    assert.equal(last.msg, 'hello world');
    assert.equal(last.level, 'info');
    assert.ok(typeof last.time === 'string' && /T/.test(last.time as string));
  });

  it('respects level: debug() suppressed at default info level', () => {
    const msgs = runLogScenario('level').map((l) => l.msg);
    assert.ok(!msgs.includes('should not appear'));
    assert.ok(msgs.includes('should appear'));
  });

  it('redacts password/token/apiKey paths', () => {
    const last = runLogScenario('redact').pop()!;
    assert.equal(last.password, '[REDACTED]');
    assert.equal(last.token, '[REDACTED]');
    assert.equal(last.apiKey, '[REDACTED]');
    assert.equal(last.user, 'mark');
  });

  it('passes structured args as top-level fields', () => {
    const last = runLogScenario('structured').pop()!;
    assert.equal(last.order_id, 42);
    assert.equal(last.latency_ms, 123);
  });
});

describe('request_id propagation via AsyncLocalStorage', () => {
  it('getRequestContext returns the active context inside run', () => {
    let observed: string | undefined;
    runWithRequestContext({ request_id: 'tg:x:1' }, () => {
      observed = getRequestContext()?.request_id;
    });
    assert.equal(observed, 'tg:x:1');
  });

  it('getRequestContext returns undefined outside the context', () => {
    assert.equal(getRequestContext(), undefined);
  });

  it('request_id propagates across await boundaries', async () => {
    let observed: string | undefined;
    await runWithRequestContext({ request_id: 'tg:chat-async:7' }, async () => {
      await Promise.resolve();
      observed = getRequestContext()?.request_id;
    });
    assert.equal(observed, 'tg:chat-async:7');
  });

  it('concurrent runs do not bleed request_ids (ALS isolation)', async () => {
    const observations: Array<{ which: 'A' | 'B'; id?: string }> = [];
    await Promise.all([
      runWithRequestContext({ request_id: 'tg:A:1' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        observations.push({ which: 'A', id: getRequestContext()?.request_id });
      }),
      runWithRequestContext({ request_id: 'tg:B:2' }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        observations.push({ which: 'B', id: getRequestContext()?.request_id });
      }),
    ]);
    const a = observations.find((o) => o.which === 'A')!;
    const b = observations.find((o) => o.which === 'B')!;
    assert.equal(a.id, 'tg:A:1');
    assert.equal(b.id, 'tg:B:2');
  });
});
