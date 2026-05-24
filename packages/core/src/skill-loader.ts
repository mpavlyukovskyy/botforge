/**
 * Skill loading: auto-detect, load (via factory), init (in dependency order).
 *
 * Extracted from runtime.ts during T1.4. Pure data + small lifecycle helpers,
 * no behavior change vs the original inline logic. Tests can drive this
 * module with a fake `loadSkill` factory and assert correct ordering.
 */

import type { BotConfig } from './schema.js';
import type { Logger, Skill, SkillContext } from './skill.js';

/**
 * Skill init order — enforces dependency rules without an explicit DAG.
 * Earlier entries init before later ones. New skills get appended here.
 */
export const SKILL_INIT_ORDER = [
  // telegram-inbox FIRST so its setInbox() call patches processUpdate BEFORE
  // adapter.start() (any later skill scheduling work that triggers adapter
  // events sees the patched dispatch path).
  'telegram-inbox',
  'dlq',
  'conversation-history',
  'event-bus',
  'token-tracker',
  'context-builder',
  'circuit-breaker',
  'response-formatter',
  'reply-context',
  'pending-questions',
  'cron-scheduler',
  'daily-digest',
  'health-server',
  'tool-server',
] as const;

export type KnownSkillName = (typeof SKILL_INIT_ORDER)[number];

/**
 * Look at a parsed bot config and decide which framework skills should be
 * loaded. Returns names in init order.
 */
export function detectSkills(config: BotConfig): string[] {
  const detected = new Set<string>();

  // Telegram inbox auto-loads for any telegram platform (opt-out via
  // inbox.enabled: false in YAML).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inboxCfg = (config as any).inbox;
  if (config.platform.type === 'telegram' && inboxCfg?.enabled !== false) {
    detected.add('telegram-inbox');
  }

  // DLQ auto-loads for every bot (opt-out via dlq.enabled: false).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dlqCfg = (config as any).dlq;
  if (dlqCfg?.enabled !== false) {
    detected.add('dlq');
  }

  if (config.memory?.conversation_history?.enabled) detected.add('conversation-history');
  if (config.brain?.provider === 'claude' || config.brain?.provider === 'claude-cli') detected.add('token-tracker');
  if (config.memory?.context_blocks?.length) detected.add('context-builder');
  if (config.resilience?.circuit_breaker) detected.add('circuit-breaker');
  if (config.behavior?.reception?.keywords?.length
      || config.behavior?.reception?.patterns?.length) {
    detected.add('passive-detection');
  }
  if (config.behavior?.response) detected.add('response-formatter');
  if (config.behavior?.continuity?.reply_context) detected.add('reply-context');
  if (config.behavior?.continuity?.pending_questions) detected.add('pending-questions');
  if (config.schedule) detected.add('cron-scheduler');
  if (config.schedule) detected.add('event-bus');
  if (config.schedule?.daily_digest) detected.add('daily-digest');
  if (config.health) detected.add('health-server');
  if (config.tool_server) detected.add('tool-server');

  return SKILL_INIT_ORDER.filter(name => detected.has(name));
}

/**
 * Load each detected skill via the operator-provided factory. Failures are
 * logged but don't halt the bot — a missing optional skill is degraded
 * functionality, not an outage.
 */
export async function loadSkills(
  config: BotConfig,
  loadSkill: ((name: string) => Promise<Skill>) | undefined,
  log: Logger,
): Promise<Map<string, Skill>> {
  const skills = new Map<string, Skill>();
  if (!loadSkill) return skills;

  for (const name of detectSkills(config)) {
    try {
      const skill = await loadSkill(name);
      skills.set(name, skill);
      log.info(`Loaded skill: ${name}`);
    } catch (err) {
      log.warn(`Failed to load skill "${name}": ${err}`);
    }
  }
  return skills;
}

/**
 * Call .init(ctx) on each skill in iteration order. Init failures are logged
 * but don't halt the bot — same policy as load failures.
 */
export async function initSkills(
  skills: Map<string, Skill>,
  skillContext: SkillContext,
  log: Logger,
): Promise<void> {
  for (const [name, skill] of skills) {
    try {
      await skill.init(skillContext);
      log.info(`Initialized skill: ${name}`);
    } catch (err) {
      log.error(`Failed to initialize skill "${name}": ${err}`);
    }
  }
}
