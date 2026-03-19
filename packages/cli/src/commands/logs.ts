import { execSync, spawnSync } from 'node:child_process';
import { loadFleetConfig } from '../fleet.js';

export async function logs(botName: string, opts: { follow?: boolean; lines?: number }): Promise<void> {
  const fleet = loadFleetConfig();
  const bot = fleet.bots[botName];
  if (!bot) {
    console.error(`Bot "${botName}" not found in fleet config`);
    process.exit(1);
  }

  const { ssh_host, ssh_user } = fleet.fleet;
  const lines = opts.lines ?? 50;
  const followFlag = opts.follow ? '-f ' : '';

  // Both follow and non-follow use the same pattern: SSH + journalctl
  // For follow mode, the process blocks until user presses Ctrl+C
  const result = spawnSync('ssh', [
    `${ssh_user}@${ssh_host}`,
    `journalctl -u ${bot.service} ${followFlag}--no-pager -n ${lines}`,
  ], { stdio: 'inherit' });

  process.exit(result.status ?? 0);
}
