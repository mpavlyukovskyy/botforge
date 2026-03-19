import { execSync } from 'node:child_process';
import { loadFleetConfig } from '../fleet.js';

export async function rollback(botName: string): Promise<void> {
  const fleet = loadFleetConfig();
  const bot = fleet.bots[botName];
  if (!bot) {
    console.error(`Bot "${botName}" not found in fleet config`);
    process.exit(1);
  }

  const { ssh_host, ssh_user, base_dir } = fleet.fleet;
  const ssh = `ssh ${ssh_user}@${ssh_host}`;
  const remoteDir = `${base_dir}/${botName}`;

  console.log(`Rolling back ${botName}...`);

  // Check if .old exists
  try {
    execSync(`${ssh} "test -d ${remoteDir}.old"`, { stdio: 'pipe' });
  } catch {
    console.error(`No previous version found for ${botName}`);
    process.exit(1);
  }

  // Swap
  execSync(`${ssh} "mv ${remoteDir} ${remoteDir}.rollback; mv ${remoteDir}.old ${remoteDir}"`, { stdio: 'inherit' });
  execSync(`${ssh} "systemctl restart ${bot.service}"`, { stdio: 'inherit' });

  // Health check
  await new Promise(r => setTimeout(r, 5000));
  try {
    const result = execSync(`${ssh} "curl -sf http://localhost:${bot.port}/api/health"`, { encoding: 'utf-8' });
    const health = JSON.parse(result);
    console.log(`✓ Rolled back ${botName} (status: ${health.status})`);
    execSync(`${ssh} "rm -rf ${remoteDir}.rollback"`, { stdio: 'inherit' });
  } catch {
    console.error('✗ Rollback health check failed!');
    process.exit(1);
  }
}
