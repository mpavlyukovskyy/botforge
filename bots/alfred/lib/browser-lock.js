/**
 * Shared Playwright browser lock
 *
 * Prevents the scraper and orderer from running Playwright concurrently,
 * which would invalidate each other's LunchDrop auth sessions.
 */

let _locked = false;
let _queue = [];

/**
 * Acquire the browser lock. Returns true if acquired, false on timeout.
 * @param {number} timeout - Max wait time in ms (default 90s)
 */
export async function acquireBrowserLock(timeout = 90_000) {
  if (!_locked) {
    _locked = true;
    return true;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Remove from queue on timeout
      const idx = _queue.indexOf(entry);
      if (idx !== -1) _queue.splice(idx, 1);
      resolve(false);
    }, timeout);
    const entry = () => {
      clearTimeout(timer);
      _locked = true;
      resolve(true);
    };
    _queue.push(entry);
  });
}

/**
 * Release the browser lock. Wakes the next queued caller if any.
 */
export function releaseBrowserLock() {
  if (_queue.length > 0) {
    const next = _queue.shift();
    next();
  } else {
    _locked = false;
  }
}

/**
 * Reset lock state (for testing only).
 */
export function _resetLock() {
  _locked = false;
  _queue = [];
}
