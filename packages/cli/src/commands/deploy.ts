import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { loadFleetConfig, type FleetBotConfig } from '../fleet.js';
import { build } from './build.js';

export async function deploy(botName: string): Promise<void> {
  const fleet = loadFleetConfig();
  const bot = fleet.bots[botName];
  if (!bot) {
    console.error(`Bot "${botName}" not found in fleet config`);
    process.exit(1);
  }

  const { ssh_host, ssh_user, base_dir } = fleet.fleet;
  const ssh = `ssh ${ssh_user}@${ssh_host}`;

  console.log(`Deploying ${botName}...`);

  // 1. Build (compiles packages, copies config, prompts, and convention dirs to dist/)
  build(botName);

  const distDir = resolve(`dist/${botName}`);

  // 4. Upload to server
  console.log('  Uploading...');
  const remoteDir = `${base_dir}/${botName}`;
  execSync(`${ssh} "mkdir -p ${remoteDir}.new"`, { stdio: 'inherit' });
  execSync(`scp -r ${distDir}/* ${ssh_user}@${ssh_host}:${remoteDir}.new/`, { stdio: 'inherit' });

  // 5. Atomic swap
  console.log('  Swapping...');
  execSync(`${ssh} "[ -d ${remoteDir} ] && mv ${remoteDir} ${remoteDir}.old; mv ${remoteDir}.new ${remoteDir}"`, { stdio: 'inherit' });

  // 6. Restart service
  console.log('  Restarting service...');
  execSync(`${ssh} "systemctl restart ${bot.service}"`, { stdio: 'inherit' });

  // 7. Health check (wait 5s then check)
  console.log('  Waiting for health check...');
  await new Promise(r => setTimeout(r, 5000));

  try {
    const healthUrl = `http://localhost:${bot.port}/api/health`;
    const result = execSync(`${ssh} "curl -sf ${healthUrl}"`, { encoding: 'utf-8' });
    const health = JSON.parse(result);
    if (health.status === 'healthy') {
      console.log(`  ✓ ${botName} deployed successfully (${health.uptime}s uptime)`);
      // Clean up old version
      execSync(`${ssh} "rm -rf ${remoteDir}.old"`, { stdio: 'inherit' });
      return;
    }
  } catch {
    // Health check failed — rollback
  }

  console.error('  ✗ Health check failed! Rolling back...');
  execSync(`${ssh} "mv ${remoteDir} ${remoteDir}.failed; mv ${remoteDir}.old ${remoteDir}; systemctl restart ${bot.service}"`, { stdio: 'inherit' });
  console.error(`  Rolled back to previous version`);
  process.exit(1);
}
