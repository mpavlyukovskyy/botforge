import { EventEmitter } from 'node:events';
import type { Skill, SkillContext, Logger } from '@botforge/core';

export type EventHandler = (payload: Record<string, unknown>) => Promise<void>;

export class EventBus {
  private emitter = new EventEmitter();
  private log: Logger;

  constructor(log: Logger) {
    this.log = log;
    this.emitter.setMaxListeners(50);
  }

  on(event: string, handler: EventHandler): void {
    this.emitter.on(event, async (payload: Record<string, unknown>) => {
      try {
        await handler(payload);
      } catch (err) {
        this.log.error(`Event handler error for "${event}": ${err}`);
      }
    });
    this.log.debug(`Event handler registered: ${event}`);
  }

  async emit(event: string, payload: Record<string, unknown> = {}): Promise<void> {
    this.log.debug(`Event emitted: ${event}`);
    this.emitter.emit(event, payload);
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
  }
}

export class EventBusSkill implements Skill {
  readonly name = 'event-bus';
  private bus?: EventBus;

  async init(ctx: SkillContext): Promise<void> {
    this.bus = new EventBus(ctx.log);
    ctx.log.info('Event bus initialized');
  }

  getBus(): EventBus | undefined {
    return this.bus;
  }

  async destroy(): Promise<void> {
    this.bus?.removeAllListeners();
  }
}

export function createSkill(): EventBusSkill {
  return new EventBusSkill();
}

export default new EventBusSkill();
