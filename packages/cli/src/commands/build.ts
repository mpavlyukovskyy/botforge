import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { mkdirSync, copyFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { loadFleetConfig } from '../fleet.js';
import { shortSha, validateSha } from './canary.js';

/** Convention directories that may exist in a bot directory */
const CONVENTION_DIRS = ['tools', 'commands', 'callbacks', 'cron', 'context', 'lifecycle', 'lib'];

export interface BuildOptions {
  /** Pin the framework portion of this build to a specific git SHA. */
  frameworkVersion?: string;
}

/**
 * Read the framework's git SHA. Falls back to "unknown" outside a git checkout
 * (e.g., extracted tarball). Always returns a string suitable for the
 * FRAMEWORK_SHA file.
 */
export function currentFrameworkSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** True if `git diff --quiet` reports uncommitted changes. */
function workingTreeDirty(): boolean {
  try {
    execSync('git diff --quiet && git diff --cached --quiet', { stdio: 'pipe' });
    return false;
  } catch {
    return true;
  }
}

/**
 * Build the framework at a specific SHA in a git worktree. Returns the
 * absolute path of the worktree (which IS the canary framework artifact —
 * deploy.ts SCPs from this path).
 */
export function buildCanaryFramework(sha: string): string {
  const validation = validateSha(sha);
  if (!validation.ok) {
    throw new Error(`--framework-version: ${validation.reason}`);
  }
  // Verify the SHA is in local refs; refuse rather than do a surprise fetch.
  try {
    execSync(`git cat-file -e ${sha}^{commit}`, { stdio: 'pipe' });
  } catch {
    throw new Error(
      `--framework-version: SHA ${sha} not in local git refs. Run 'git fetch origin' first.`,
    );
  }

  const worktreePath = resolve(`.canary-worktree/${shortSha(sha)}`);
  // If a stale worktree from a prior aborted build is sitting here, clean it
  // out so 'git worktree add' doesn't refuse.
  if (existsSync(worktreePath)) {
    try {
      execSync(`git worktree remove --force "${worktreePath}"`, { stdio: 'pipe' });
    } catch {
      // Fall through; the add below will surface the real error.
    }
  }
  console.log(`  Adding git worktree at ${shortSha(sha)}...`);
  execSync(`git worktree add --detach "${worktreePath}" ${sha}`, { stdio: 'inherit' });

  // Full pnpm install inside the worktree — symlinks are exact-versioned, so
  // sharing node_modules across SHA gaps would silently break. ~200 MB per
  // canary; we accept the cost for correctness.
  console.log(`  pnpm install inside worktree...`);
  execSync('pnpm install --frozen-lockfile', { cwd: worktreePath, stdio: 'inherit' });
  console.log(`  pnpm -r build inside worktree...`);
  execSync('pnpm -r build', { cwd: worktreePath, stdio: 'inherit' });

  // Stamp the canary SHA into the worktree's core/dist so getFrameworkSha()
  // inside the canary'd bot reports the pinned SHA, not the operator's HEAD.
  writeFileSync(resolve(worktreePath, 'packages/core/dist/FRAMEWORK_SHA'), `${sha}\n`, 'utf-8');

  console.log(`✓ Canary framework built at ${worktreePath}`);
  return worktreePath;
}

export function build(botName: string, opts: BuildOptions = {}): void {
  const fleet = loadFleetConfig();
  const bot = fleet.bots[botName];
  if (!bot) {
    console.error(`Bot "${botName}" not found in fleet config`);
    process.exit(1);
  }

  console.log(`Building ${botName}...`);

  // 0. If pinning to a SHA, build the framework in a worktree first. The
  //    canary path is independent of the bot dist — deploy.ts will SCP the
  //    bot dist AND the worktree framework artifact to acemagic.
  let frameworkSha: string;
  if (opts.frameworkVersion) {
    buildCanaryFramework(opts.frameworkVersion);
    frameworkSha = opts.frameworkVersion;
  } else {
    // Guard against silent SHA mismatch: a build from a dirty working tree
    // would stamp the SHA of HEAD but ship code that differs from HEAD.
    if (workingTreeDirty()) {
      throw new Error(
        'working tree has uncommitted changes. Either commit them or pass --framework-version to pin the build to a clean SHA.',
      );
    }

    // 1. Build all workspace packages in the main checkout.
    console.log('  Compiling workspace packages...');
    execSync('pnpm -r build', { stdio: 'inherit' });

    // 1a. Stamp the framework SHA into @botforge/core's dist so getFrameworkSha()
    //     (and therefore /api/health) reports it at runtime.
    frameworkSha = currentFrameworkSha();
    const coreShaPath = resolve('packages/core/dist/FRAMEWORK_SHA');
    if (existsSync(dirname(coreShaPath))) {
      writeFileSync(coreShaPath, `${frameworkSha}\n`, 'utf-8');
    }
  }
  const sha = frameworkSha;

  // 2. Create dist directory. Clean it first — `cp -r src dist/<bot>/dir` copies
  //    INTO an existing dir (nesting lib/lib/) and leaves deleted files behind,
  //    so a stale build ships unless we start from an empty tree. (This is why
  //    deploys needed a manual `rm -rf dist/<bot>` beforehand.)
  const distDir = resolve(`dist/${botName}`);
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  // 3. Copy config
  copyFileSync(resolve(bot.config), resolve(distDir, 'config.yaml'));

  // 4. Copy prompts directory if it exists
  const configDir = dirname(resolve(bot.config));
  const promptsDir = resolve(configDir, 'prompts');
  if (existsSync(promptsDir)) {
    execSync(`cp -r "${promptsDir}" "${distDir}/prompts"`, { stdio: 'inherit' });
  }

  // 5. Copy all convention directories from bot directory
  const configName = bot.config.replace(/\.ya?ml$/, '').split('/').pop()!;
  const botDir = resolve(configDir, configName);
  if (existsSync(botDir)) {
    for (const dir of CONVENTION_DIRS) {
      const srcDir = resolve(botDir, dir);
      if (existsSync(srcDir)) {
        execSync(`cp -r "${srcDir}" "${distDir}/${dir}"`, { stdio: 'inherit' });
        console.log(`  Copied ${dir}/`);
      }
    }
  }

  // 6. Stamp FRAMEWORK_SHA into the bot dist as a deploy audit trail
  //    (the runtime SHA is read from @botforge/core's dist by getFrameworkSha()).
  writeFileSync(resolve(distDir, 'FRAMEWORK_SHA'), `${sha}\n`, 'utf-8');
  console.log(`  FRAMEWORK_SHA: ${sha === 'unknown' ? sha : sha.slice(0, 12)}`);

  console.log(`✓ Built ${botName} → dist/${botName}/`);
}
