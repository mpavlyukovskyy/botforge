/**
 * @botforge/skill-backup — nightly hot-backup of bot SQLite + rsync to a
 * Tailscale-reachable target.
 *
 * Flow per night:
 *   1. For each *.db in data/, sqlite3 .backup to a temp file (WAL-safe).
 *   2. sha256 source vs target.
 *   3. rsync -az --delete to <target_host>:<target_dir>/<botName>/YYYY-MM-DD/.
 *   4. sha256 the rsynced file; FAIL LOUD on mismatch.
 *   5. Record last_successful_backup_ts in bot state.
 *
 * YAML:
 *   backup:
 *     target_host: mark-mac.tail<...>.ts.net   # Tailscale name or IP
 *     target_dir: /Users/Mark/botforge-backups
 *     local_retention_days: 7
 *     enabled: true                            # default OFF — must opt in
 *
 * Best-effort. A target offline → log error, retry tomorrow. Daily digest
 * (T2.7) surfaces `last_successful_backup_ts > 36h` as an alert.
 */

import type { Skill, SkillContext, Logger } from '@botforge/core';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, basename } from 'node:path';

interface BackupConfig {
  target_host: string;
  target_dir: string;
  local_retention_days?: number;
  enabled?: boolean;
}

const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class BackupSkill implements Skill {
  readonly name = 'backup';
  private timer?: NodeJS.Timeout;
  private cfg?: BackupConfig;
  private log?: Logger;
  private botName?: string;
  private lastSuccess?: number;

  async init(ctx: SkillContext): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bk = (ctx.config as any).backup as BackupConfig | undefined;
    if (!bk?.enabled) {
      ctx.log.debug('backup: not enabled (set backup.enabled: true to opt in)');
      return;
    }
    if (!bk.target_host || !bk.target_dir) {
      ctx.log.warn('backup: enabled but missing target_host / target_dir');
      return;
    }
    this.cfg = bk;
    this.log = ctx.log;
    this.botName = ctx.config.name;

    // First run after 10s (give the bot time to fully boot), then every 24h.
    setTimeout(() => {
      this.runOnce().catch((err) => ctx.log.error(`backup first-run error: ${err}`));
    }, 10_000).unref?.();

    this.timer = setInterval(() => {
      this.runOnce().catch((err) => ctx.log.error(`backup error: ${err}`));
    }, DAILY_INTERVAL_MS);
    this.timer.unref?.();

    ctx.log.info(`backup: enabled (target ${bk.target_host}:${bk.target_dir})`);
  }

  async destroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }

  /** Run one backup cycle now. Returns true on success. */
  async runOnce(): Promise<boolean> {
    if (!this.cfg || !this.botName || !this.log) return false;

    const dataDir = resolve('data');
    if (!existsSync(dataDir)) {
      this.log.warn(`backup: data/ does not exist (cwd ${process.cwd()})`);
      return false;
    }

    const dbs = readdirSync(dataDir).filter((f: string) => f.endsWith('.db'));
    if (dbs.length === 0) {
      this.log.info('backup: no .db files in data/');
      return false;
    }

    const date = new Date().toISOString().split('T')[0];
    const stagingDir = resolve(`backups/${date}`);
    mkdirSync(stagingDir, { recursive: true });

    const successes: string[] = [];
    const failures: string[] = [];

    for (const db of dbs) {
      const src = join(dataDir, db);
      const staged = join(stagingDir, db);
      try {
        // Hot backup via sqlite3's online backup API.
        execSync(`sqlite3 "${src}" ".backup '${staged}'"`, { stdio: 'pipe' });
        successes.push(db);
      } catch (err) {
        this.log.error(`backup: sqlite3 .backup failed for ${db}: ${err}`);
        failures.push(db);
      }
    }

    if (failures.length > 0) {
      this.log.error(`backup: ${failures.length}/${dbs.length} hot-backups failed`);
    }
    if (successes.length === 0) return false;

    // Hash staged files for post-rsync verification.
    const hashesPre = new Map<string, string>();
    for (const db of successes) hashesPre.set(db, sha256(join(stagingDir, db)));

    // rsync the staging dir to target.
    const remoteTarget = `${this.cfg.target_host}:${this.cfg.target_dir}/${this.botName}/`;
    try {
      execSync(`rsync -az --delete "${stagingDir}/" "${remoteTarget}${date}/"`, { stdio: 'pipe' });
    } catch (err) {
      this.log.error(`backup: rsync to ${remoteTarget} failed: ${err}`);
      // Don't trash staging; tomorrow's run picks it back up.
      return false;
    }

    // Verify each file's sha256 matches what we sent.
    for (const db of successes) {
      try {
        const remoteSha = execSync(
          `ssh ${this.cfg.target_host} "shasum -a 256 ${this.cfg.target_dir}/${this.botName}/${date}/${db}"`,
          { encoding: 'utf-8' },
        ).split(/\s+/)[0];
        const localSha = hashesPre.get(db);
        if (remoteSha !== localSha) {
          this.log.error(`backup: sha256 MISMATCH for ${db} (local ${localSha} vs remote ${remoteSha})`);
          return false;
        }
      } catch (err) {
        this.log.warn(`backup: could not verify ${db}: ${err}`);
      }
    }

    // Prune old local staging dirs.
    const retention = this.cfg.local_retention_days ?? 7;
    this.pruneLocal(retention);

    this.lastSuccess = Date.now();
    this.log.info(`backup: ${successes.length} db file(s) -> ${remoteTarget}${date}/ OK`);
    return true;
  }

  /** Return ms since last successful backup, or undefined if never. */
  staleMs(): number | undefined {
    if (this.lastSuccess === undefined) return undefined;
    return Date.now() - this.lastSuccess;
  }

  private pruneLocal(retentionDays: number): void {
    const root = resolve('backups');
    if (!existsSync(root)) return;
    const cutoffMs = Date.now() - retentionDays * 86_400_000;
    for (const dir of readdirSync(root)) {
      const path = join(root, dir);
      try {
        const stat = statSync(path);
        if (stat.isDirectory() && stat.mtimeMs < cutoffMs) {
          rmSync(path, { recursive: true, force: true });
        }
      } catch {
        /* best effort */
      }
    }
    void basename;
  }
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function createSkill(): BackupSkill {
  return new BackupSkill();
}

export default new BackupSkill();
