import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Golden test for the deploy path resolution.
 *
 * Prior to PR0, `botforge.yaml` had `base_dir: /opt/botforge` and deploy.ts
 * did `${base_dir}/${botName}` — producing `/opt/botforge/<bot>/` which is
 * NOT where bots actually live on the server. The server has bots at
 * `/opt/botforge/bots/<name>/`. This made `pnpm botforge deploy` write to a
 * dead path silently.
 *
 * This test pins the corrected resolution so a future yaml edit can't
 * regress it.
 */
describe('deploy path resolution from fleet config', () => {
  const yamlPath = resolve(__dirname, '../../../../botforge.yaml');
  const raw = readFileSync(yamlPath, 'utf-8');
  const fleet = parseYaml(raw) as { fleet: { base_dir: string }; bots: Record<string, { service?: string }> };

  it('base_dir points at the directory bots actually live in on acemagic', () => {
    assert.equal(fleet.fleet.base_dir, '/opt/botforge/bots');
  });

  it('every bot with a service resolves to /opt/botforge/bots/<bot>', () => {
    for (const [name, bot] of Object.entries(fleet.bots)) {
      if (!bot.service) continue;
      const remoteDir = `${fleet.fleet.base_dir}/${name}`;
      assert.equal(
        remoteDir,
        `/opt/botforge/bots/${name}`,
        `deploy path for ${name} would be ${remoteDir}`,
      );
    }
  });
});
