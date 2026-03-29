/**
 * Tests for Argus Trade Write-Ahead Log.
 *
 * Uses mocked DB to test the WAL flow without file system.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db module
const mockRun = vi.fn().mockReturnValue({ lastInsertRowid: 42, changes: 1 });
const mockAll = vi.fn().mockReturnValue([]);
const mockPrepare = vi.fn().mockReturnValue({ run: mockRun, all: mockAll });
const mockExec = vi.fn();

const mockDb = {
  prepare: mockPrepare,
  exec: mockExec,
};

vi.mock('../lib/db.js', () => ({
  getDb: () => mockDb,
  beginImmediate: (db: any) => db.exec('BEGIN IMMEDIATE'),
  commit: (db: any) => db.exec('COMMIT'),
  rollback: (db: any) => db.exec('ROLLBACK'),
}));

import {
  recordTradeIntent,
  markSubmitted,
  markConfirmed,
  markFailed,
  getIncompleteTradeEntries,
  getRecentTrades,
  countRecentTrades,
  executeWithWal,
} from './trade-wal.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockRun.mockReturnValue({ lastInsertRowid: 42, changes: 1 });
});

describe('recordTradeIntent', () => {
  it('records trade with pending status', () => {
    const walId = recordTradeIntent({
      strategy: 'funding-rate',
      asset: 'ETH',
      protocol: 'hyperliquid',
      direction: 'short',
      size: '1.5',
      intentPrice: '2500',
    });

    expect(walId).toBe(42);
    expect(mockExec).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockExec).toHaveBeenCalledWith('COMMIT');
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO trade_wal'));
    expect(mockRun).toHaveBeenCalledWith(
      'funding-rate', 'ETH', 'hyperliquid', 'short', '1.5', '2500'
    );
  });

  it('rolls back on error', () => {
    mockRun.mockImplementationOnce(() => { throw new Error('constraint violation'); });

    expect(() => recordTradeIntent({
      strategy: 'funding-rate',
      asset: 'ETH',
      protocol: 'hyperliquid',
      direction: 'short',
      size: '1',
      intentPrice: '2500',
    })).toThrow('constraint violation');

    expect(mockExec).toHaveBeenCalledWith('ROLLBACK');
  });
});

describe('markSubmitted', () => {
  it('updates status and tx_hash', () => {
    markSubmitted(42, '0xabc');

    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('submitted'));
    expect(mockRun).toHaveBeenCalledWith('0xabc', 42);
  });

  it('handles missing tx_hash', () => {
    markSubmitted(42);

    expect(mockRun).toHaveBeenCalledWith(null, 42);
  });
});

describe('markConfirmed', () => {
  it('updates status with fill details', () => {
    markConfirmed(42, {
      txHash: '0xdef',
      fillPrice: '2498',
      fillSize: '1.5',
    });

    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('confirmed'));
    expect(mockRun).toHaveBeenCalledWith('0xdef', '2498', '1.5', 42);
  });
});

describe('markFailed', () => {
  it('updates status with error', () => {
    markFailed(42, 'Insufficient margin');

    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('failed'));
    expect(mockRun).toHaveBeenCalledWith('Insufficient margin', 42);
  });
});

describe('getIncompleteTradeEntries', () => {
  it('queries for pending and submitted trades', () => {
    getIncompleteTradeEntries();

    expect(mockPrepare).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('pending', 'submitted')")
    );
    expect(mockAll).toHaveBeenCalled();
  });
});

describe('getRecentTrades', () => {
  it('uses default limit of 20', () => {
    getRecentTrades();

    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('LIMIT'));
    expect(mockAll).toHaveBeenCalledWith(20);
  });

  it('accepts custom limit', () => {
    getRecentTrades(50);

    expect(mockAll).toHaveBeenCalledWith(50);
  });
});

describe('countRecentTrades', () => {
  it('queries count for time window', () => {
    mockAll.mockReturnValueOnce(undefined);
    // countRecentTrades uses get(), not all()
    const mockGet = vi.fn().mockReturnValue({ count: 3 });
    mockPrepare.mockReturnValueOnce({ get: mockGet });

    const count = countRecentTrades(1);

    expect(count).toBe(3);
    expect(mockPrepare).toHaveBeenCalledWith(
      expect.stringContaining("status IN ('submitted', 'confirmed')")
    );
  });
});

describe('executeWithWal', () => {
  it('records intent, executes, and confirms on success', async () => {
    const executeFn = vi.fn().mockResolvedValue({
      success: true,
      txHash: '0xresult',
      fillPrice: 2498,
      fillSize: 1.5,
    });

    const { walId, result } = await executeWithWal(
      {
        strategy: 'funding-rate',
        asset: 'ETH',
        protocol: 'hyperliquid',
        direction: 'short',
        size: '1.5',
        intentPrice: '2500',
      },
      executeFn,
    );

    expect(walId).toBe(42);
    expect(result.success).toBe(true);
    expect(executeFn).toHaveBeenCalledOnce();

    // Should have: BEGIN IMMEDIATE, COMMIT (from recordTradeIntent),
    // then prepare calls for markSubmitted and markConfirmed
    expect(mockExec).toHaveBeenCalledWith('BEGIN IMMEDIATE');
    expect(mockExec).toHaveBeenCalledWith('COMMIT');
  });

  it('marks failed on execution error', async () => {
    const executeFn = vi.fn().mockRejectedValue(new Error('network timeout'));

    await expect(
      executeWithWal(
        {
          strategy: 'funding-rate',
          asset: 'ETH',
          protocol: 'hyperliquid',
          direction: 'short',
          size: '1',
          intentPrice: '2500',
        },
        executeFn,
      ),
    ).rejects.toThrow('network timeout');

    // markFailed should be called with the error
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('failed'));
  });

  it('marks failed on unsuccessful result', async () => {
    const executeFn = vi.fn().mockResolvedValue({
      success: false,
      error: 'Order rejected',
    });

    const { result } = await executeWithWal(
      {
        strategy: 'yield',
        asset: 'USDC',
        protocol: 'aave',
        direction: 'supply',
        size: '10000',
        intentPrice: '1',
      },
      executeFn,
    );

    expect(result.success).toBe(false);
    // markFailed called
    expect(mockPrepare).toHaveBeenCalledWith(expect.stringContaining('failed'));
  });
});
