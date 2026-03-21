/**
 * Sliding-window rate limiter per user.
 * In-memory, no persistence needed.
 */

const windows = new Map<string, number[]>();

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of windows) {
    const filtered = timestamps.filter(t => now - t < 300_000);
    if (filtered.length === 0) {
      windows.delete(key);
    } else {
      windows.set(key, filtered);
    }
  }
}, 300_000).unref();

export function shouldAllow(userId: string, limit: number, windowSeconds: number): boolean {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const timestamps = windows.get(userId) ?? [];

  // Remove expired timestamps
  const valid = timestamps.filter(t => now - t < windowMs);

  if (valid.length >= limit) {
    windows.set(userId, valid);
    return false;
  }

  valid.push(now);
  windows.set(userId, valid);
  return true;
}
