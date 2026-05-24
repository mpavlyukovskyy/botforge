import { execSync } from 'node:child_process';
import { loadFleetConfig, type FleetBotConfig } from '../fleet.js';

interface FleetStatusEntry {
  bot: string;
  service: string;
  port: number;
  status: 'healthy' | 'unhealthy' | 'unreachable';
  frameworkSha?: string;
  uptime?: number;
  error?: string;
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
      service: bot.service,
      port: bot.port,
      status: 'unreachable',
    };

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

  console.log('');
  console.log('Bot                  Service                       Status       SHA           Uptime');
  console.log('───────────────────  ────────────────────────────  ───────────  ────────────  ──────');

  for (const r of results) {
    const sha = r.frameworkSha
      ? r.frameworkSha === 'unknown'
        ? 'unknown'
        : r.frameworkSha.slice(0, 12)
      : '—';
    const drift = r.frameworkSha && dominantSha && r.frameworkSha !== dominantSha ? ' ⚠' : '';
    const uptime = r.uptime !== undefined ? formatUptime(r.uptime) : '—';
    const statusLabel =
      r.status === 'healthy' ? 'healthy' : r.status === 'unhealthy' ? 'unhealthy' : 'unreachable';

    console.log(
      `${r.bot.padEnd(20)} ${r.service.padEnd(29)} ${statusLabel.padEnd(12)} ${(sha + drift).padEnd(13)} ${uptime}`,
    );

    if (r.error) {
      console.log(`  └─ ${r.error}`);
    }
  }

  console.log('');
  if (shaCounts.size > 1) {
    console.log(`⚠ Framework drift detected: ${shaCounts.size} distinct SHAs across the fleet`);
    for (const [sha, count] of shaCounts) {
      console.log(`    ${sha === 'unknown' ? sha : sha.slice(0, 12)}  ${count} bot${count === 1 ? '' : 's'}`);
    }
  } else if (shaCounts.size === 1) {
    console.log(`✓ All reachable bots on framework SHA ${dominantSha === 'unknown' ? 'unknown' : dominantSha!.slice(0, 12)}`);
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
