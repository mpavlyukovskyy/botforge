import type { Skill, SkillContext } from '@botforge/core';

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreakerSkill implements Skill {
  readonly name = 'circuit-breaker';

  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private lastFailureTime = 0;
  private threshold = 5;
  private resetTimeoutMs = 30000;
  private halfOpenMax = 1;
  private halfOpenAttempts = 0;
  private onAlert?: (state: CircuitState, error?: string) => void;

  async init(ctx: SkillContext): Promise<void> {
    const cbConfig = ctx.config.resilience?.circuit_breaker;
    if (!cbConfig) return;

    this.threshold = cbConfig.threshold;
    this.resetTimeoutMs = cbConfig.reset_timeout_ms;
    this.halfOpenMax = cbConfig.half_open_max;

    // Alert callback sends notification via adapter AND logs
    this.onAlert = (state, error) => {
      const msg = `⚠️ Circuit breaker ${state}${error ? `: ${error}` : ''}`;
      ctx.log.warn(msg);
      // Send to Telegram so operators are notified immediately
      if (ctx.adapter) {
        const platform = ctx.config.platform;
        const chatIds = platform.type === 'telegram' ? (platform.chat_ids ?? []) : [];
        for (const chatId of chatIds) {
          ctx.adapter.send({ chatId, text: msg }).catch((err: unknown) => {
            ctx.log.error(`Failed to send circuit breaker alert to ${chatId}: ${err}`);
          });
        }
      }
    };

    ctx.log.info(`Circuit breaker initialized (threshold: ${this.threshold}, reset: ${this.resetTimeoutMs}ms)`);
  }

  getState(): CircuitState {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.halfOpenAttempts = 0;
      }
    }
    return this.state;
  }

  /** Execute a function through the circuit breaker */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === 'OPEN') {
      throw new Error('Circuit breaker is OPEN — request rejected');
    }

    if (currentState === 'HALF_OPEN' && this.halfOpenAttempts >= this.halfOpenMax) {
      throw new Error('Circuit breaker HALF_OPEN — max attempts reached');
    }

    try {
      if (currentState === 'HALF_OPEN') {
        this.halfOpenAttempts++;
      }

      const result = await fn();

      // Success: reset
      if (currentState === 'HALF_OPEN') {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.onAlert?.('CLOSED');
      } else {
        this.failureCount = 0;
      }

      return result;
    } catch (err) {
      this.failureCount++;
      this.lastFailureTime = Date.now();

      if (currentState === 'HALF_OPEN') {
        this.state = 'OPEN';
        this.onAlert?.('OPEN', `Half-open test failed: ${err}`);
      } else if (this.failureCount >= this.threshold) {
        this.state = 'OPEN';
        this.onAlert?.('OPEN', `Threshold reached (${this.failureCount}/${this.threshold})`);
      }

      throw err;
    }
  }

  /** Reset the circuit breaker manually */
  reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.halfOpenAttempts = 0;
  }

  /** Get status for health endpoint */
  getStatus(): { state: CircuitState; failureCount: number; threshold: number } {
    return {
      state: this.getState(),
      failureCount: this.failureCount,
      threshold: this.threshold,
    };
  }
}

export function createSkill(): CircuitBreakerSkill {
  return new CircuitBreakerSkill();
}

export default new CircuitBreakerSkill();
