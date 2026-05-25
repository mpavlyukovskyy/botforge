import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/**
 * Return the git SHA of the framework code currently running.
 *
 * Lookup order:
 *   1. `BOTFORGE_FRAMEWORK_SHA` env var — set by systemd overrides for canary deploys
 *   2. `FRAMEWORK_SHA` file shipped next to this module in dist/ (written by `botforge build`)
 *   3. `"unknown"` if neither is available
 *
 * Cached after the first read.
 */
export function getFrameworkSha(): string {
  if (cached !== undefined) return cached;

  if (process.env.BOTFORGE_FRAMEWORK_SHA) {
    cached = process.env.BOTFORGE_FRAMEWORK_SHA.trim();
    return cached;
  }

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const shaPath = resolve(here, 'FRAMEWORK_SHA');
    if (existsSync(shaPath)) {
      const sha = readFileSync(shaPath, 'utf-8').trim();
      if (sha) {
        cached = sha;
        return cached;
      }
    }
  } catch {
    // fall through to "unknown"
  }

  cached = 'unknown';
  return cached;
}

/** Test-only: reset the cache so tests don't bleed into each other. */
export function _resetFrameworkShaCache(): void {
  cached = undefined;
}
