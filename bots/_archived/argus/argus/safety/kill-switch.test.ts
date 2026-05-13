/**
 * Tests for Argus kill switch module.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executeKillSwitch,
  formatKillSwitchReport,
  requestKillConfirmation,
  confirmKill,
  cancelKillConfirmation,
} from './kill-switch.js';

// Mock getDb to avoid file system dependency
vi.mock('../lib/db.js', () => {
  const strategies = [
    { id: 'funding-rate' },
    { id: 'yield' },
    { id: 'reserve' },
  ];

  const mockDb = {
    prepare: vi.fn((sql: string) => {
      if (sql.includes('SELECT id FROM strategies')) {
        return { all: () => strategies };
      }
      if (sql.includes('UPDATE strategies')) {
        return { run: vi.fn() };
      }
      return { all: () => [], get: () => undefined, run: vi.fn() };
    }),
  };

  return {
    getDb: () => mockDb,
  };
});

describe('executeKillSwitch', () => {
  const mockDeps = () => ({
    cancelAllOrders: vi.fn().mockResolvedValue({ cancelled: 3, errors: [] }),
    closeAllPerps: vi.fn().mockResolvedValue({ closed: 2, errors: [] }),
    withdrawAllAave: vi.fn().mockResolvedValue({ withdrawn: 1, errors: [] }),
    sendAlert: vi.fn().mockResolvedValue(undefined),
  });

  it('executes all steps in order', async () => {
    const deps = mockDeps();
    const result = await executeKillSwitch(deps);

    expect(deps.cancelAllOrders).toHaveBeenCalledOnce();
    expect(deps.closeAllPerps).toHaveBeenCalledOnce();
    expect(deps.withdrawAllAave).toHaveBeenCalledOnce();
    expect(deps.sendAlert).toHaveBeenCalledOnce();

    expect(result.cancelledOrders).toBe(3);
    expect(result.closedPositions).toBe(2);
    expect(result.withdrawnSupply).toBe(1);
    expect(result.haltedStrategies).toContain('funding-rate');
    expect(result.haltedStrategies).toContain('yield');
    expect(result.haltedStrategies).toContain('reserve');
    expect(result.errors).toHaveLength(0);
  });

  it('dry run skips execution but reports strategies', async () => {
    const deps = mockDeps();
    const result = await executeKillSwitch(deps, { dryRun: true });

    expect(deps.cancelAllOrders).not.toHaveBeenCalled();
    expect(deps.closeAllPerps).not.toHaveBeenCalled();
    expect(deps.withdrawAllAave).not.toHaveBeenCalled();

    // Strategies are still listed (would-be halted)
    expect(result.haltedStrategies.length).toBeGreaterThan(0);

    // Alert is still sent for dry runs
    expect(deps.sendAlert).toHaveBeenCalledOnce();
    expect(deps.sendAlert).toHaveBeenCalledWith(
      'critical',
      'Kill Switch Dry-Run Complete',
      expect.any(String),
    );
  });

  it('continues on error and collects all errors', async () => {
    const deps = {
      cancelAllOrders: vi.fn().mockRejectedValue(new Error('exchange down')),
      closeAllPerps: vi.fn().mockRejectedValue(new Error('timeout')),
      withdrawAllAave: vi.fn().mockResolvedValue({ withdrawn: 0, errors: ['partial failure'] }),
      sendAlert: vi.fn().mockResolvedValue(undefined),
    };

    const result = await executeKillSwitch(deps);

    // All steps attempted despite failures
    expect(deps.cancelAllOrders).toHaveBeenCalledOnce();
    expect(deps.closeAllPerps).toHaveBeenCalledOnce();
    expect(deps.withdrawAllAave).toHaveBeenCalledOnce();

    // Errors collected
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    expect(result.errors.some(e => e.includes('exchange down'))).toBe(true);
    expect(result.errors.some(e => e.includes('timeout'))).toBe(true);

    // Alert sent with 'emergency' severity due to errors
    expect(deps.sendAlert).toHaveBeenCalledWith(
      'emergency',
      'KILL SWITCH ACTIVATED',
      expect.any(String),
    );
  });

  it('measures execution time', async () => {
    const deps = mockDeps();
    const result = await executeKillSwitch(deps);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.executionTimeMs).toBeLessThan(5000); // Should be fast in tests
  });
});

describe('formatKillSwitchReport', () => {
  it('formats clean report', () => {
    const report = formatKillSwitchReport(
      {
        cancelledOrders: 3,
        closedPositions: 2,
        withdrawnSupply: 1,
        haltedStrategies: ['funding-rate', 'yield'],
        errors: [],
        executionTimeMs: 250,
      },
      false,
    );

    expect(report).toContain('Orders cancelled: 3');
    expect(report).toContain('Positions closed: 2');
    expect(report).toContain('Aave withdrawals: 1');
    expect(report).toContain('funding-rate, yield');
    expect(report).toContain('250ms');
    expect(report).not.toContain('ERRORS');
  });

  it('includes errors when present', () => {
    const report = formatKillSwitchReport(
      {
        cancelledOrders: 0,
        closedPositions: 0,
        withdrawnSupply: 0,
        haltedStrategies: [],
        errors: ['exchange down', 'timeout'],
        executionTimeMs: 100,
      },
      false,
    );

    expect(report).toContain('ERRORS');
    expect(report).toContain('exchange down');
    expect(report).toContain('timeout');
  });

  it('prefixes with DRY-RUN', () => {
    const report = formatKillSwitchReport(
      {
        cancelledOrders: 0,
        closedPositions: 0,
        withdrawnSupply: 0,
        haltedStrategies: [],
        errors: [],
        executionTimeMs: 50,
      },
      true,
    );

    expect(report).toContain('DRY-RUN');
  });
});

describe('Kill confirmation flow', () => {
  beforeEach(() => {
    // Clean up any lingering confirmations
    cancelKillConfirmation('test-chat');
  });

  it('confirm returns false without prior request', () => {
    expect(confirmKill('test-chat')).toBe(false);
  });

  it('confirm returns true after request', () => {
    requestKillConfirmation('test-chat');
    expect(confirmKill('test-chat')).toBe(true);
  });

  it('confirm can only be used once', () => {
    requestKillConfirmation('test-chat');
    expect(confirmKill('test-chat')).toBe(true);
    expect(confirmKill('test-chat')).toBe(false); // Already consumed
  });

  it('cancel removes pending confirmation', () => {
    requestKillConfirmation('test-chat');
    cancelKillConfirmation('test-chat');
    expect(confirmKill('test-chat')).toBe(false);
  });

  it('confirmations are per-chat', () => {
    requestKillConfirmation('chat-a');
    requestKillConfirmation('chat-b');
    expect(confirmKill('chat-a')).toBe(true);
    expect(confirmKill('chat-b')).toBe(true);
    expect(confirmKill('chat-a')).toBe(false);
  });
});
