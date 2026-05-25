import { execSync } from 'node:child_process';
import { loadFleetConfig, type FleetBotConfig } from '../fleet.js';
import { overrideFilePath } from './canary.js';

interface FleetStatusEntry {
  bot: string;
  service: string;
  port: number;
  status: 'healthy' | 'unhealthy' | 'unreachable';
  frameworkSha?: string;
  uptime?: number;
  /** True when /etc/systemd/system/<service>.d/framework.conf exists on host. */
  canary?: boolean;
  error?: string;
}

/** Local branch HEAD — what the operator would deploy without a canary pin. */
function localBranchSha(): string | undefined {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return undefined;
  }
}

interface FleetStatusOptions {
  json?: boolean;
}

/**
 * SSH into the fleet host, curl each bot's /api/health endpoint, and report
 * framework SHA drift across the fleet. Used to spot bots that didn't pick up
 * a framework deploy or are pinned to a canary.
 */
export async function fleetStatus(opts: FleetStatusOptions = {}): Promise<void> {
  const fleet = loadFleetConfig();
  const { ssh_host, ssh_user } = fleet.fleet;
  const ssh = `ssh ${ssh_user ? `${ssh_user}@` : ''}${ssh_host}`;

  const results: FleetStatusEntry[] = [];

  for (const [botName, bot] of Object.entries(fleet.bots) as [string, FleetBotConfig][]) {
    const entry: FleetStatusEntry = {
      bot: botName,
      service: bot.service ?? '(no service)',
      port: bot.port,
      status: 'unreachable',
    };

    // Skip bots that don't expose a port (test fixtures, etc.).
    if (!bot.port) {
      entry.error = 'no port configured';
      results.push(entry);
      continue;
    }

    try {
      const healthUrl = `http://localhost:${bot.port}/api/health`;
      // -s silent, -f fail on non-2xx, --max-time so a hung bot doesn't block the survey
      const result = execSync(`${ssh} "curl -sf --max-time 5 ${healthUrl}"`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const parsed = JSON.parse(result);
      entry.status = parsed.status === 'healthy' ? 'healthy' : 'unhealthy';
      entry.frameworkSha = parsed.framework_sha;
      entry.uptime = parsed.uptime;

      // Detect canary by probing for the systemd drop-in file. Cheap per-bot
      // SSH; safe to skip silently if it fails.
      if (bot.service) {
        try {
          const overridePath = overrideFilePath(bot.service);
          const probe = execSync(`${ssh} "test -e ${overridePath} && echo Y || echo N"`, {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          entry.canary = probe.trim() === 'Y';
        } catch {
          // best effort
        }
      }
    } catch (err) {
      entry.error = err instanceof Error ? err.message.split('\n')[0] : String(err);
    }

    results.push(entry);
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  printDriftTable(results);
}

function printDriftTable(results: FleetStatusEntry[]): void {
  const shaCounts = new Map<string, number>();
  for (const r of results) {
    if (r.frameworkSha) {
      shaCounts.set(r.frameworkSha, (shaCounts.get(r.frameworkSha) ?? 0) + 1);
    }
  }
  const dominantSha = [...shaCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const branchSha = localBranchSha();

  console.log('');
  if (branchSha) {
    console.log(`Local branch HEAD: ${branchSha.slice(0, 12)}`);
  }
  console.log('');
  console.log('Bot                  Service                       Status       Deployed SHA  Canary  Drift?  Uptime');
  console.log('───────────────────  ────────────────────────────  ───────────  ────────────  ──────  ──────  ──────');

  for (const r of results) {
    const sha = r.frameworkSha
      ? r.frameworkSha === 'unknown'
        ? 'unknown'
        : r.frameworkSha.slice(0, 12)
      : '—';
    const canaryLabel = r.canary === true ? 'yes' : r.canary === false ? 'no' : '—';
    let driftLabel = '—';
    if (r.frameworkSha && branchSha && r.frameworkSha !== branchSha) {
      driftLabel = 'yes';
    } else if (r.frameworkSha && branchSha) {
      driftLabel = 'no';
    }
    const uptime = r.uptime !== undefined ? formatUptime(r.uptime) : '—';
    const statusLabel =
      r.status === 'healthy' ? 'healthy' : r.status === 'unhealthy' ? 'unhealthy' : 'unreachable';
    const serviceLabel = (r.service ?? '—').padEnd(29);

    console.log(
      `${r.bot.padEnd(20)} ${serviceLabel} ${statusLabel.padEnd(12)} ${sha.padEnd(13)} ${canaryLabel.padEnd(7)} ${driftLabel.padEnd(7)} ${uptime}`,
    );

    if (r.error) {
      console.log(`  └─ ${r.error}`);
    }
  }

  console.log('');
  if (shaCounts.size > 1) {
    console.log(`⚠ ${shaCounts.size} distinct framework SHAs running across the fleet`);
    for (const [sha, count] of shaCounts) {
      console.log(`    ${sha === 'unknown' ? sha : sha.slice(0, 12)}  ${count} bot${count === 1 ? '' : 's'}`);
    }
  } else if (shaCounts.size === 1 && branchSha && dominantSha === branchSha) {
    console.log(`✓ All reachable bots on branch HEAD (${branchSha.slice(0, 12)})`);
  } else if (shaCounts.size === 1) {
    console.log(`✓ All reachable bots on framework SHA ${dominantSha === 'unknown' ? 'unknown' : dominantSha!.slice(0, 12)}`);
    if (branchSha && dominantSha !== branchSha) {
      console.log(`  (branch HEAD is ${branchSha.slice(0, 12)} — fleet is behind/ahead)`);
    }
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
