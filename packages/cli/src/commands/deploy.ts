import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { loadFleetConfig, type FleetBotConfig } from '../fleet.js';
import { build } from './build.js';

/**
 * Pluggable remote-execution surface. Real deploys use SSH; tests pass a fake.
 * Returns stdout (empty string if the caller didn't ask for it via opts).
 */
export interface DeployIO {
  /** Run a shell command remotely; throws on non-zero exit. */
  runRemote: (cmd: string, opts?: { capture?: boolean }) => string;
  /** scp a local path to a remote target (rsync-recursive semantics). */
  scp: (local: string, remote: string) => void;
}

function makeSshIO(sshHost: string, sshUser: string): DeployIO {
  const ssh = `ssh ${sshUser ? `${sshUser}@` : ''}${sshHost}`;
  return {
    runRemote(cmd, opts) {
      if (opts?.capture) {
        return execSync(`${ssh} "${cmd}"`, { encoding: 'utf-8' });
      }
      execSync(`${ssh} "${cmd}"`, { stdio: 'inherit' });
      return '';
    },
    scp(local, remote) {
      execSync(`scp -r ${local} ${sshUser ? `${sshUser}@` : ''}${sshHost}:${remote}`, { stdio: 'inherit' });
    },
  };
}

export interface DeployOptions {
  /** Override the SSH layer (tests inject a fake). */
  io?: DeployIO;
}

export async function deploy(botName: string, options: DeployOptions = {}): Promise<void> {
  const fleet = loadFleetConfig();
  const bot = fleet.bots[botName];
  if (!bot) {
    console.error(`Bot "${botName}" not found in fleet config`);
    process.exit(1);
  }

  const { ssh_host, ssh_user, base_dir } = fleet.fleet;
  const io = options.io ?? makeSshIO(ssh_host, ssh_user);

  console.log(`Deploying ${botName}...`);

  // 1. Build (compiles packages, copies config, prompts, and convention dirs to dist/)
  build(botName);

  const distDir = resolve(`dist/${botName}`);

  // 2. Upload to server
  console.log('  Uploading...');
  const remoteDir = `${base_dir}/${botName}`;
  io.runRemote(`mkdir -p ${remoteDir}.new`);
  io.scp(`${distDir}/*`, `${remoteDir}.new/`);

  // 3. Atomic swap
  console.log('  Swapping...');
  io.runRemote(`[ -d ${remoteDir} ] && mv ${remoteDir} ${remoteDir}.old; mv ${remoteDir}.new ${remoteDir}`);

  // 4. Restart service
  console.log('  Restarting service...');
  io.runRemote(`systemctl restart ${bot.service}`);

  // 5. Health check (wait 5s then check)
  console.log('  Waiting for health check...');
  await new Promise(r => setTimeout(r, 5000));

  try {
    const healthUrl = `http://localhost:${bot.port}/api/health`;
    const result = io.runRemote(`curl -sf ${healthUrl}`, { capture: true });
    const health = JSON.parse(result);
    if (health.status === 'healthy') {
      console.log(`  ✓ ${botName} deployed successfully (${health.uptime}s uptime)`);
      // Clean up old version
      io.runRemote(`rm -rf ${remoteDir}.old`);
      return;
    }
  } catch {
    // Health check failed — rollback
  }

  console.error('  ✗ Health check failed! Rolling back...');
  io.runRemote(
    `mv ${remoteDir} ${remoteDir}.failed; mv ${remoteDir}.old ${remoteDir}; systemctl restart ${bot.service}`,
  );
  console.error(`  Rolled back to previous version`);
  process.exit(1);
}
