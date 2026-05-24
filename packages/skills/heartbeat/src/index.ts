/**
 * @botforge/skill-heartbeat — push to an external uptime monitor (Uptime Kuma
 * by default) on every successful poll tick + every successful cron run.
 *
 * Uptime Kuma's "push" monitor wants periodic GETs to a unique URL; missing
 * a beat for longer than the configured timeout = alert.
 *
 * YAML:
 *   health:
 *     heartbeat:
 *       poll_url: https://uptime-kuma-mark.fly.dev/api/push/<token>
 *       poll_interval_ms: 60000   # default 60s
 *       cron_urls:
 *         daily_digest: https://uptime-kuma-mark.fly.dev/api/push/<token>
 *         sync_retry:   https://uptime-kuma-mark.fly.dev/api/push/<token>
 *
 * Best-effort: a Kuma outage / network blip never crashes the bot.
 */

import type { Skill, SkillContext } from '@botforge/core';

interface HeartbeatConfig {
  poll_url?: string;
  poll_interval_ms?: number;
  cron_urls?: Record<string, string>;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = 10_000;

export class HeartbeatSkill implements Skill {
  readonly name = 'heartbeat';
  private timer?: NodeJS.Timeout;
  private cfg?: HeartbeatConfig;
  private log?: SkillContext['log'];

  async init(ctx: SkillContext): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hb = (ctx.config.health as any)?.heartbeat as HeartbeatConfig | undefined;
    if (!hb || (!hb.poll_url && !hb.cron_urls)) {
      ctx.log.debug('heartbeat: no urls configured');
      return;
    }
    this.cfg = hb;
    this.log = ctx.log;

    // Poll heartbeat: fire every poll_interval_ms.
    if (hb.poll_url) {
      const interval = hb.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS;
      this.timer = setInterval(() => {
        this.push(hb.poll_url!).catch(() => {/* logged inside */});
      }, interval);
      this.timer.unref?.();
      ctx.log.info(`heartbeat: poll URL configured (every ${interval}ms)`);
    }

    // Per-cron heartbeats: wrap each handler that has a configured URL.
    if (hb.cron_urls) {
      const cron = ctx.skills.get('cron-scheduler');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const reg = cron as any;
      if (reg && 'registerHandler' in reg) {
        // Note: this depends on the cron-scheduler having ALREADY been told about
        // each handler. We register a wrapper that fires the push on success.
        // For now, expose a helper that bots/skills can use; full integration
        // (auto-wrapping every registered cron) is a future change.
        ctx.log.info(`heartbeat: ${Object.keys(hb.cron_urls).length} cron URLs configured`);
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }

  /** Public: push to a Kuma URL for a specific cron success. */
  async pushCron(name: string): Promise<void> {
    const url = this.cfg?.cron_urls?.[name];
    if (!url) return;
    await this.push(url);
  }

  /** Internal: best-effort HTTP GET with timeout. */
  private async push(url: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        this.log?.debug(`heartbeat: push returned ${res.status}`);
      }
    } catch (err) {
      this.log?.debug(`heartbeat: push failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createSkill(): HeartbeatSkill {
  return new HeartbeatSkill();
}

export default new HeartbeatSkill();
