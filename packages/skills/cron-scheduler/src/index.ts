import type { Skill, SkillContext } from '@botforge/core';
import cron from 'node-cron';

export type CronHandler = () => Promise<void>;

export class CronSchedulerSkill implements Skill {
  readonly name = 'cron-scheduler';
  private tasks: cron.ScheduledTask[] = [];
  private handlers = new Map<string, CronHandler>();

  async init(ctx: SkillContext): Promise<void> {
    const schedule = ctx.config.schedule;
    if (!schedule) return;

    // Register cron jobs from config
    for (const [jobName, jobConfig] of Object.entries(schedule)) {
      const handler = this.handlers.get(jobName);
      if (!handler) {
        ctx.log.debug(`No handler registered for cron job "${jobName}", skipping`);
        continue;
      }

      if (!cron.validate(jobConfig.cron)) {
        ctx.log.warn(`Invalid cron expression for "${jobName}": ${jobConfig.cron}`);
        continue;
      }

      const task = cron.schedule(jobConfig.cron, async () => {
        ctx.log.info(`Running cron job: ${jobName}`);
        try {
          await handler();
        } catch (err) {
          ctx.log.error(`Cron job "${jobName}" failed: ${err}`);
        }
      }, {
        timezone: jobConfig.timezone ?? 'UTC',
        scheduled: true,
      });

      this.tasks.push(task);
      ctx.log.info(`Scheduled cron job: ${jobName} (${jobConfig.cron} ${jobConfig.timezone ?? 'UTC'})`);
    }
  }

  /** Register a named handler that other skills can set up before init */
  registerHandler(name: string, handler: CronHandler): void {
    this.handlers.set(name, handler);
  }

  async destroy(): Promise<void> {
    for (const task of this.tasks) {
      task.stop();
    }
    this.tasks = [];
  }
}

export function createSkill(): CronSchedulerSkill {
  return new CronSchedulerSkill();
}

export default new CronSchedulerSkill();
