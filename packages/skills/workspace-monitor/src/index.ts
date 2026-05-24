/**
 * @botforge/skill-workspace-monitor — alerts when the bot is approaching the
 * Anthropic workspace cap.
 *
 * Each bot only knows its OWN spend (from token-tracker). True workspace
 * monitoring needs cross-bot aggregation which the framework doesn't have
 * yet. This skill is the simpler-but-still-useful version:
 *
 *   - Reads ANTHROPIC_WORKSPACE_CAP_USD env (or workspace_monitor.cap_usd YAML)
 *   - Compares THIS bot's daily spend to its assumed share of the workspace
 *     cap (config field: assumed_workspace_share, default 1.0 = the whole cap)
 *   - DMs admin once per day when >= 80%, again at >= 100%
 *
 * For the proper cross-bot aggregator, see T2.7's future evolution.
 *
 * YAML:
 *   workspace_monitor:
 *     enabled: true             # default OFF — opt in once cap is known
 *     cap_usd: 30               # daily workspace cap; or ANTHROPIC_WORKSPACE_CAP_USD env
 *     assumed_workspace_share: 0.5   # this bot is up to 50% of the cap
 *     admin_chat_id: "381823289"     # where to DM alerts; defaults to platform.chat_ids[0]
 */

import type { Skill, SkillContext, Logger } from '@botforge/core';

interface WorkspaceMonitorConfig {
  enabled?: boolean;
  cap_usd?: number;
  assumed_workspace_share?: number;
  admin_chat_id?: string;
}

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const WARN_THRESHOLD = 0.8;
const EXHAUSTED_THRESHOLD = 1.0;

export class WorkspaceMonitorSkill implements Skill {
  readonly name = 'workspace-monitor';
  private timer?: NodeJS.Timeout;
  private ctx?: SkillContext;
  private cfg?: WorkspaceMonitorConfig;
  private capUsd?: number;
  private adminChatId?: string;
  private warnedToday?: string;
  private exhaustedToday?: string;
  private log?: Logger;

  async init(ctx: SkillContext): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = (ctx.config as any).workspace_monitor as WorkspaceMonitorConfig | undefined;
    if (!cfg?.enabled) {
      ctx.log.debug('workspace-monitor: not enabled');
      return;
    }
    const capFromYaml = cfg.cap_usd;
    const capFromEnv = process.env.ANTHROPIC_WORKSPACE_CAP_USD;
    this.capUsd = capFromYaml ?? (capFromEnv ? Number(capFromEnv) : undefined);
    if (!this.capUsd || this.capUsd <= 0) {
      ctx.log.warn('workspace-monitor: enabled but no cap_usd set (YAML or ANTHROPIC_WORKSPACE_CAP_USD)');
      return;
    }
    this.ctx = ctx;
    this.cfg = cfg;
    this.log = ctx.log;

    // Pick admin chat: YAML override > platform.chat_ids[0]
    this.adminChatId = cfg.admin_chat_id;
    if (!this.adminChatId && ctx.config.platform.type === 'telegram') {
      this.adminChatId = ctx.config.platform.chat_ids?.[0];
    }
    if (!this.adminChatId) {
      ctx.log.warn('workspace-monitor: no admin_chat_id resolved; alerts will only log');
    }

    this.timer = setInterval(() => {
      this.check().catch((err) => ctx.log.error(`workspace-monitor check error: ${err}`));
    }, CHECK_INTERVAL_MS);
    this.timer.unref?.();

    ctx.log.info(`workspace-monitor: enabled (cap $${this.capUsd}/day, share ${cfg.assumed_workspace_share ?? 1})`);
  }

  async destroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }

  /** Manually check; returns the threshold state. */
  async check(): Promise<'ok' | 'warn' | 'exhausted'> {
    if (!this.ctx || !this.cfg || !this.capUsd) return 'ok';
    const tokenTracker = this.ctx.skills.get('token-tracker');
    if (!tokenTracker || !('getDailySpend' in tokenTracker)) return 'ok';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spent = (tokenTracker as any).getDailySpend() as number;
    const share = this.cfg.assumed_workspace_share ?? 1;
    const limit = this.capUsd * share;
    const today = new Date().toISOString().split('T')[0];

    if (spent >= limit * EXHAUSTED_THRESHOLD) {
      if (this.exhaustedToday !== today) {
        await this.alert(`🚨 *Workspace cap exhausted* — ${this.ctx.config.name} has spent $${spent.toFixed(4)} today (cap share: $${limit.toFixed(2)}).`);
        this.exhaustedToday = today;
      }
      return 'exhausted';
    }
    if (spent >= limit * WARN_THRESHOLD) {
      if (this.warnedToday !== today) {
        await this.alert(`⚠️ *Workspace cap warning* — ${this.ctx.config.name} at ${Math.round((spent / limit) * 100)}% of share ($${spent.toFixed(4)} / $${limit.toFixed(2)}).`);
        this.warnedToday = today;
      }
      return 'warn';
    }
    return 'ok';
  }

  private async alert(message: string): Promise<void> {
    this.log?.warn(`workspace-monitor: ${message}`);
    if (!this.adminChatId || !this.ctx) return;
    try {
      await this.ctx.adapter.send({
        chatId: this.adminChatId,
        text: message,
        parseMode: 'Markdown',
      });
    } catch (err) {
      this.log?.error(`workspace-monitor: alert DM failed: ${err}`);
    }
  }
}

export function createSkill(): WorkspaceMonitorSkill {
  return new WorkspaceMonitorSkill();
}

export default new WorkspaceMonitorSkill();
