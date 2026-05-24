import { execSync } from 'node:child_process';
import { loadFleetConfig } from '../fleet.js';
import { overrideFilePath, shortSha } from './canary.js';

interface CanaryGcOptions {
  /** Default: dry-run (lists candidates without deleting). --force actually removes. */
  force?: boolean;
  fwBaseDir?: string;
}

const DEFAULT_FW_BASE_DIR = '/opt/botforge-fw';

/**
 * List pinned-framework directories on the server and identify which are
 * actively referenced by a bot's systemd override vs. orphaned (no override
 * pointing at them).
 *
 * Default mode is --dry-run; the operator must pass --force to actually
 * delete. Orphans are reported but not auto-removed — they might be left
 * over from a failed deploy or a manually-edited unit and deleting them
 * could break a bot that's actively running from that dir.
 */
export async function canaryGc(opts: CanaryGcOptions = {}): Promise<void> {
  const fleet = loadFleetConfig();
  const { ssh_host, ssh_user } = fleet.fleet;
  const ssh = `ssh ${ssh_user ? `${ssh_user}@` : ''}${ssh_host}`;
  const fwBaseDir = opts.fwBaseDir ?? DEFAULT_FW_BASE_DIR;

  console.log(`Surveying ${fwBaseDir}/ on ${ssh_host}...`);

  // List candidate framework dirs.
  let dirs: string[];
  try {
    const out = execSync(`${ssh} "ls -1 ${fwBaseDir} 2>/dev/null"`, { encoding: 'utf-8' });
    dirs = out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    dirs = [];
  }

  if (dirs.length === 0) {
    console.log(`(no pinned framework dirs in ${fwBaseDir})`);
    return;
  }

  // Build a map of which SHAs are referenced by which bot's override.
  const referenced = new Map<string, string[]>(); // sha12 → bot names referencing it
  for (const [botName, bot] of Object.entries(fleet.bots)) {
    if (!bot.service) continue;
    const overridePath = overrideFilePath(bot.service);
    try {
      const content = execSync(`${ssh} "sudo cat ${overridePath} 2>/dev/null"`, { encoding: 'utf-8' });
      // Match the SHA in WorkingDirectory=/opt/botforge-fw/<sha12>
      const m = content.match(new RegExp(`${fwBaseDir.replace(/[/.]/g, '\\$&')}/([a-f0-9]+)`));
      if (m) {
        const sha12 = m[1];
        const list = referenced.get(sha12) ?? [];
        list.push(botName);
        referenced.set(sha12, list);
      }
    } catch {
      // No override file for this bot — skip.
    }
  }

  // Print each candidate with its referencing bots or ORPHAN.
  console.log('');
  console.log('Pinned framework  Status                        Referenced by');
  console.log('────────────────  ────────────────────────────  ──────────────');

  let orphanCount = 0;
  const orphans: string[] = [];
  for (const dir of dirs) {
    const refs = referenced.get(dir);
    if (refs && refs.length > 0) {
      console.log(`${dir.padEnd(16)}  active                        ${refs.join(', ')}`);
    } else {
      console.log(`${dir.padEnd(16)}  ORPHAN                        (no override references it)`);
      orphanCount++;
      orphans.push(dir);
    }
  }
  console.log('');

  if (orphanCount === 0) {
    console.log('✓ No orphans to clean up.');
    return;
  }

  if (!opts.force) {
    console.log(`Found ${orphanCount} orphan${orphanCount === 1 ? '' : 's'}. Re-run with --force to delete.`);
    return;
  }

  console.log(`Removing ${orphanCount} orphan${orphanCount === 1 ? '' : 's'}...`);
  for (const dir of orphans) {
    const path = `${fwBaseDir}/${dir}`;
    console.log(`  rm -rf ${path}`);
    execSync(`${ssh} "sudo rm -rf ${path}"`, { stdio: 'inherit' });
  }
  console.log(`✓ Cleaned ${orphanCount} orphan${orphanCount === 1 ? '' : 's'}.`);
}
