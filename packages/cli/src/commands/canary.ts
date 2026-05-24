/**
 * Pure helpers for the --framework-version canary deploy mechanism.
 *
 * The hard I/O lives in deploy.ts (ssh, scp, sudo, systemctl). Everything
 * here is a deterministic function — easy to unit test, no mocks needed.
 */

const SHORT_SHA_LEN = 12;

/** Truncate a 40-hex SHA to its 12-char prefix for use in dir names. */
export function shortSha(sha: string): string {
  if (sha.length < SHORT_SHA_LEN) return sha;
  return sha.slice(0, SHORT_SHA_LEN);
}

export type ShaValidation = { ok: true } | { ok: false; reason: string };

/** Validate that a string is plausibly a git SHA we can pin to. */
export function validateSha(sha: string | undefined | null): ShaValidation {
  if (!sha) return { ok: false, reason: 'empty SHA' };
  const trimmed = sha.trim();
  if (trimmed.length < 7) return { ok: false, reason: `SHA too short (${trimmed.length} chars; need ≥7)` };
  if (trimmed.length > 40) return { ok: false, reason: `SHA too long (${trimmed.length} chars; max 40)` };
  if (!/^[a-f0-9]+$/i.test(trimmed)) return { ok: false, reason: 'SHA contains non-hex characters' };
  return { ok: true };
}

export interface OverrideArgs {
  /** Full 40-char git SHA. */
  sha: string;
  /** Bot name as it appears in botforge.yaml (e.g. 'trainer'). */
  botName: string;
  /** Bot's base config path (e.g. '/opt/botforge'). */
  baseDir: string;
  /** Root path for pinned framework copies (e.g. '/opt/botforge-fw'). */
  fwBaseDir: string;
}

/**
 * Build the systemd drop-in file contents for a canary-pinned bot.
 *
 * The drop-in lives at /etc/systemd/system/botforge-<name>.service.d/framework.conf
 * and overrides the unit's WorkingDirectory + ExecStart so the bot executes
 * the canary framework instead of the shared one. BOTFORGE_FRAMEWORK_SHA
 * makes the bot's /api/health report the canary SHA via getFrameworkSha().
 *
 * Empty ExecStart= line is required by systemd to clear the inherited list
 * before appending a new one.
 */
export function buildOverrideFile(args: OverrideArgs): string {
  const validation = validateSha(args.sha);
  if (!validation.ok) {
    throw new Error(`buildOverrideFile: invalid SHA: ${validation.reason}`);
  }
  if (!args.botName.match(/^[a-zA-Z0-9_-]+$/)) {
    throw new Error(`buildOverrideFile: bot name '${args.botName}' has invalid characters`);
  }
  const sha12 = shortSha(args.sha);
  return [
    '[Service]',
    `WorkingDirectory=${args.fwBaseDir}/${sha12}`,
    'ExecStart=',
    `ExecStart=/usr/bin/node packages/cli/dist/index.js dev ${args.baseDir}/${args.botName}.yaml`,
    `Environment=BOTFORGE_FRAMEWORK_SHA=${args.sha}`,
    '',
  ].join('\n');
}

/** Drop-in path on the server, e.g. /etc/systemd/system/botforge-trainer.service.d/framework.conf */
export function overrideFilePath(service: string): string {
  return `/etc/systemd/system/${service}.d/framework.conf`;
}

/** Pinned framework store dir, e.g. /opt/botforge-fw/abc123def456 */
export function fwStorePath(fwBaseDir: string, sha: string): string {
  return `${fwBaseDir}/${shortSha(sha)}`;
}

export type CanaryAction =
  | { kind: 'noop' }
  | { kind: 'add'; sha: string }
  | { kind: 'remove' }
  | { kind: 'replace'; oldSha: string; newSha: string };

/**
 * Decide what to do given the bot's current override state and the operator's
 * requested SHA. Pure function — operator passes whatever the override file
 * currently contains (or undefined if no override exists), and a target SHA
 * (or undefined for a no-flag deploy that should remove any existing canary).
 */
export function decideCanaryAction(
  currentSha: string | undefined,
  requestedSha: string | undefined,
): CanaryAction {
  if (!currentSha && !requestedSha) return { kind: 'noop' };
  if (!currentSha && requestedSha) return { kind: 'add', sha: requestedSha };
  if (currentSha && !requestedSha) return { kind: 'remove' };
  // currentSha && requestedSha
  if (currentSha === requestedSha) return { kind: 'noop' };
  return { kind: 'replace', oldSha: currentSha!, newSha: requestedSha! };
}
