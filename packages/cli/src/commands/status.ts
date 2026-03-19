import { loadFleetConfig } from '../fleet.js';
import { execSync } from 'node:child_process';

interface BotStatus {
  name: string;
  status: string;
  uptime?: number;
  port: number;
  platform?: string;
  brain?: string;
  error?: string;
}

export async function status(): Promise<void> {
  const fleet = loadFleetConfig();
  const { ssh_host, ssh_user } = fleet.fleet;
  const ssh = `ssh ${ssh_user}@${ssh_host}`;

  const statuses: BotStatus[] = [];

  for (const [name, bot] of Object.entries(fleet.bots)) {
    try {
      const result = execSync(`${ssh} "curl -sf http://localhost:${bot.port}/api/health"`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const health = JSON.parse(result);
      statuses.push({
        name,
        status: health.status ?? 'unknown',
        uptime: health.uptime,
        port: bot.port,
        platform: health.platform,
        brain: health.brain,
      });
    } catch {
      statuses.push({
        name,
        status: 'offline',
        port: bot.port,
        error: 'Health check failed',
      });
    }
  }

  // Print table
  console.log('\nFleet Status');
  console.log('\u2500'.repeat(80));
  console.log(
    'Bot'.padEnd(15) +
    'Status'.padEnd(12) +
    'Uptime'.padEnd(10) +
    'Port'.padEnd(8) +
    'Platform'.padEnd(12) +
    'Brain'
  );
  console.log('\u2500'.repeat(80));

  for (const s of statuses) {
    const uptime = s.uptime ? `${Math.floor(s.uptime / 3600)}h` : '-';
    const statusIcon = s.status === 'healthy' ? '\u25CF' : '\u25CB';
    console.log(
      s.name.padEnd(15) +
      `${statusIcon} ${s.status}`.padEnd(12) +
      uptime.padEnd(10) +
      String(s.port).padEnd(8) +
      (s.platform ?? '-').padEnd(12) +
      (s.brain ?? '-')
    );
  }
  console.log('\u2500'.repeat(80));
}
