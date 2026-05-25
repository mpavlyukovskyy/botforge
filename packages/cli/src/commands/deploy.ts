import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadFleetConfig, type FleetBotConfig } from '../fleet.js';
import { build } from './build.js';
import {
  buildOverrideFile,
  fwStorePath,
  overrideFilePath,
  shortSha,
  validateSha,
} from './canary.js';

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
  /** Pin this bot to a specific framework SHA via systemd drop-in. */
  frameworkVersion?: string;
  /** Path on the server where pinned-framework copies live (default: /opt/botforge-fw). */
  fwBaseDir?: string;
}

const DEFAULT_FW_BASE_DIR = '/opt/botforge-fw';

export async function deploy(botName: string, options: DeployOptions = {}): Promise<void> {
  const fleet = loadFleetConfig();
  const bot = fleet.bots[botName];
  if (!bot) {
    console.error(`Bot "${botName}" not found in fleet config`);
    process.exit(1);
  }

  const { ssh_host, ssh_user, base_dir } = fleet.fleet;
  const io = options.io ?? makeSshIO(ssh_host, ssh_user);
  const fwBaseDir = options.fwBaseDir ?? DEFAULT_FW_BASE_DIR;

  console.log(`Deploying ${botName}...`);

  // 0. If pinning a framework SHA, validate and pre-stage on the server.
  //    If NOT pinning but the bot currently has a canary override, remove it
  //    so this deploy returns the bot to the shared framework.
  let canarySha: string | undefined;
  if (options.frameworkVersion) {
    const v = validateSha(options.frameworkVersion);
    if (!v.ok) {
      console.error(`Invalid --framework-version: ${v.reason}`);
      process.exit(1);
    }
    canarySha = options.frameworkVersion;
    installCanaryFramework(io, canarySha, fwBaseDir);
  } else {
    removeCanaryOverrideIfPresent(io, bot.service);
  }

  // 1. Build (compiles packages, copies config, prompts, and convention dirs to dist/)
  build(botName, { frameworkVersion: options.frameworkVersion });

  const distDir = resolve(`dist/${botName}`);

  // 2. Upload to server
  console.log('  Uploading...');
  const remoteDir = `${base_dir}/${botName}`;
  io.runRemote(`mkdir -p ${remoteDir}.new`);
  io.scp(`${distDir}/*`, `${remoteDir}.new/`);

  // 3. Atomic swap
  console.log('  Swapping...');
  io.runRemote(`[ -d ${remoteDir} ] && mv ${remoteDir} ${remoteDir}.old; mv ${remoteDir}.new ${remoteDir}`);

  // 4. If pinning a framework SHA, write the systemd drop-in BEFORE restart so
  //    the service starts on the canary framework.
  if (canarySha) {
    writeCanaryOverride(io, {
      sha: canarySha,
      botName,
      service: bot.service,
      baseDir: base_dir,
      fwBaseDir,
    });
  }

  // 5. Restart service
  console.log('  Restarting service...');
  io.runRemote(`sudo systemctl restart ${bot.service}`);

  // 6. Health check (wait 5s then check)
  console.log('  Waiting for health check...');
  await new Promise(r => setTimeout(r, 5000));

  const healthOk = checkHealth(io, bot.port, canarySha);

  if (healthOk) {
    console.log(`  ✓ ${botName} deployed successfully`);
    // Clean up old version
    io.runRemote(`rm -rf ${remoteDir}.old`);
    return;
  }

  console.error('  ✗ Health check failed! Rolling back...');
  if (canarySha) {
    // Remove the override too — bot returns to shared framework
    io.runRemote(`sudo rm -f ${overrideFilePath(bot.service)} && sudo systemctl daemon-reload`);
  }
  io.runRemote(
    `mv ${remoteDir} ${remoteDir}.failed; mv ${remoteDir}.old ${remoteDir}; sudo systemctl restart ${bot.service}`,
  );
  console.error(`  Rolled back to previous version`);
  process.exit(1);
}

/**
 * Copy the locally-built canary framework (from .canary-worktree/<sha12>/) to
 * /opt/botforge-fw/<sha12>/ on the server, then run pnpm install --frozen-lockfile
 * remotely so the install uses acemagic's shared pnpm store. Much cheaper than
 * SCP'ing all of node_modules (~865 MB) per canary.
 */
function installCanaryFramework(io: DeployIO, sha: string, fwBaseDir: string): void {
  const sha12 = shortSha(sha);
  const remotePath = fwStorePath(fwBaseDir, sha);
  const localWorktree = resolve(`.canary-worktree/${sha12}`);

  if (!existsSync(localWorktree)) {
    throw new Error(`canary worktree missing at ${localWorktree}; build.ts should have created it`);
  }

  console.log(`  Installing canary framework at ${remotePath}...`);
  io.runRemote(`sudo mkdir -p ${remotePath} && sudo chown $(whoami) ${remotePath}`);
  // Ship source/dist/lockfiles only — install happens remotely against the
  // shared pnpm store on acemagic.
  io.scp(
    `${localWorktree}/packages ${localWorktree}/package.json ${localWorktree}/pnpm-lock.yaml ${localWorktree}/pnpm-workspace.yaml`,
    `${remotePath}/`,
  );
  io.runRemote(`cd ${remotePath} && pnpm install --frozen-lockfile --prod=false`);
}

/**
 * Write the per-bot systemd drop-in, daemon-reload, and verify systemd
 * actually picked up the override via DropInPaths. A bare daemon-reload can
 * succeed without applying the unit edit; the explicit check catches that.
 */
function writeCanaryOverride(
  io: DeployIO,
  args: { sha: string; botName: string; service: string; baseDir: string; fwBaseDir: string },
): void {
  const content = buildOverrideFile({
    sha: args.sha,
    botName: args.botName,
    baseDir: args.baseDir,
    fwBaseDir: args.fwBaseDir,
  });
  // Stage locally, scp to /tmp, sudo-mv into place. /etc isn't a writable scp
  // target from a non-root user.
  const localStage = `${tmpdir()}/botforge-override-${args.botName}.conf`;
  writeFileSync(localStage, content, 'utf-8');
  try {
    io.scp(localStage, `/tmp/${args.botName}-override.conf`);
    const overridePath = overrideFilePath(args.service);
    io.runRemote(
      `sudo mkdir -p $(dirname ${overridePath}) && sudo mv /tmp/${args.botName}-override.conf ${overridePath} && sudo chown root:root ${overridePath} && sudo chmod 644 ${overridePath} && sudo systemctl daemon-reload`,
    );
    // Verify systemd applied the override.
    const dropIns = io.runRemote(`systemctl show -p DropInPaths ${args.service}`, { capture: true });
    if (!dropIns.includes(overridePath)) {
      throw new Error(`systemd did not pick up override at ${overridePath}. DropInPaths: ${dropIns.trim()}`);
    }
    console.log(`  Override installed at ${overridePath}`);
  } finally {
    try {
      unlinkSync(localStage);
    } catch {
      /* best effort */
    }
  }
}

/**
 * If a canary override file exists on the server, remove it + daemon-reload so
 * the next service restart picks up the shared framework. Idempotent — if the
 * file doesn't exist, this is a no-op.
 */
function removeCanaryOverrideIfPresent(io: DeployIO, service: string): void {
  const overridePath = overrideFilePath(service);
  // `test -e` exits non-zero when missing — wrap with `||true` so we don't throw.
  const status = io.runRemote(`test -e ${overridePath} && echo EXISTS || echo MISSING`, { capture: true });
  if (status.trim() !== 'EXISTS') return;
  console.log(`  Removing existing canary override at ${overridePath}...`);
  io.runRemote(`sudo rm -f ${overridePath} && sudo systemctl daemon-reload`);
}

/**
 * Curl the bot's /api/health and verify status === healthy. If canarySha is
 * provided, also verify framework_sha equals it (case-insensitive). Mismatch
 * is treated as deploy failure — silent override-install failures get caught
 * here instead of slipping through as "looks healthy."
 */
function checkHealth(io: DeployIO, port: number, canarySha?: string): boolean {
  try {
    const healthUrl = `http://localhost:${port}/api/health`;
    const result = io.runRemote(`curl -sf ${healthUrl}`, { capture: true });
    const health = JSON.parse(result);
    if (health.status !== 'healthy') {
      console.error(`  health status: ${health.status}`);
      return false;
    }
    if (canarySha) {
      const reported = String(health.framework_sha ?? '').toLowerCase();
      const expected = canarySha.toLowerCase();
      if (reported !== expected) {
        console.error(`  framework_sha mismatch: reported=${reported}, expected=${expected}`);
        return false;
      }
    }
    return true;
  } catch (err) {
    console.error(`  health check error: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}
