/**
 * Module Loader — generic directory loader for commands, callbacks, and other modules
 *
 * Mirrors the loadToolsFromDir pattern with a pluggable validation callback.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load and validate modules from a directory.
 * Reads `.js`/`.ts` files, skips `.d.ts`, `.test.`, and `_`-prefixed files.
 */
export async function loadModulesFromDir<T>(
  dir: string,
  validate: (mod: unknown, filePath: string) => T | null,
): Promise<T[]> {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }

  const moduleFiles = files.filter(f =>
    (f.endsWith('.js') || f.endsWith('.ts')) &&
    !f.endsWith('.d.ts') &&
    !f.includes('.test.') &&
    !f.startsWith('_')
  );

  const modules: T[] = [];

  for (const file of moduleFiles) {
    try {
      const mod = await import(join(dir, file));
      const resolved = mod.default ?? mod;
      const validated = validate(resolved, join(dir, file));

      if (validated) {
        modules.push(validated);
      } else {
        console.warn(`Skipped ${file}: validation returned null`);
      }
    } catch (err) {
      console.warn(`Failed to load module from ${file}: ${err}`);
    }
  }

  return modules;
}
