# Prevention: Source-Build-Deploy Divergence

**Incident:** Bug fix applied to `packages/core/src/error-messages.ts` (src). `dist/` never rebuilt. `FRAMEWORK_SHA` stamp claimed deployed code matched the commit. The fix never shipped.

**Root cause class:** Committed `dist/` diverged from `src/`. No gate existed to catch it.

---

## The Single Highest-Leverage Fix

**Stop committing `dist/`. Build in the deploy script, ship the artifact that was just built.**

The existing `deploy.ts` already calls `build()` before uploading. The problem is that `dist/` is also committed to git, so any operator who manually SCPs a file to acemagic, forgets to rebuild, or edits `src` without rebuilding has created silent divergence with no detection.

**Fix:** Add `dist/` to `.gitignore`. The deploy script is already the authoritative builder. Trust it.

Every other improvement in this document is secondary to this one.

---

## 1. Never Ship Stale Builds

### The problem with committing `dist/`

Committing compiled output creates two sources of truth. The rule "dist/ reflects src/" is a social contract enforced by nothing. A source edit, a manual SCP, a failed build that left partial output, or a merge conflict resolution that touched only one side — any of these silently violates the contract.

GitHub's own artifact-attestation docs describe the correct model: **build once in CI, ship that exact artifact, verify the artifact hash matches what was built.** The key property is that the artifact and the source that produced it are linked by the same workflow run, not by a file you manually copy.

### The minimal reliable pattern for this stack

```
git push
  └─ GitHub Actions: pnpm -r build
       └─ upload artifact (sha256 digest logged automatically)
            └─ deploy job: download artifact, rsync to acemagic
                 └─ health check
```

`pnpm botforge deploy <name>` already implements the local version of this: it calls `build()`, then uploads `dist/`. The gap is that `dist/` being committed means the deploy step is optional — someone can rsync from git's `dist/` instead, which may be stale.

**Minimal adoption:**

1. `echo "dist/" >> .gitignore` and `git rm -r --cached dist/`
2. Make `pnpm botforge deploy <name>` the only deploy path. No manual SCP of individual files.
3. If a file needs to be patched on the server in an emergency, commit the source change and run a full deploy. If the deploy CLI is broken, fix it. Manual SCP of compiled output is the root cause of every divergence incident.

### Build reproducibility

`tsc` is deterministic given the same source + tsconfig + node/ts version. Pin the TypeScript version in `package.json` (`"typescript": "5.x.y"` not `"^5"`). This ensures a rebuild from the same git SHA always produces the same output, making content-hash verification meaningful.

---

## 2. Build/Deploy Provenance and Verification

### The FRAMEWORK_SHA stamp is lying

`currentFrameworkSha()` in `build.ts` calls `git rev-parse HEAD`. If the working tree is dirty — which `build.ts` guards against with `workingTreeDirty()` — it throws. But the guard only covers uncommitted local changes. It does NOT catch the case where `dist/` was last built at a different commit and was subsequently committed without a rebuild.

In other words: the SHA in the stamp is "the SHA of HEAD at the time the source was edited," not "the SHA of the commit whose source was compiled."

### Content hash: make the stamp honest

A content hash of the deployed files is unforgeable — it reflects what is actually running, regardless of what git says.

**At build time, generate a manifest:**

```typescript
// packages/cli/src/commands/build.ts — add after compiling
import { createHash } from 'node:crypto';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function hashDir(dir: string): string {
  const hash = createHash('sha256');
  function walk(d: string) {
    for (const entry of readdirSync(d).sort()) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      hash.update(entry);
      hash.update(readFileSync(full));
    }
  }
  walk(dir);
  return hash.digest('hex').slice(0, 16);
}

const contentHash = hashDir(resolve('packages/core/dist'));
writeFileSync(resolve('packages/core/dist/CONTENT_HASH'), `${contentHash}\n`, 'utf-8');
```

**At startup, verify the hash matches what the build system recorded:**

The health endpoint at `/api/health` already returns `framework_sha`. Add `content_hash` to it. In CI or in the post-deploy health check, assert that `content_hash` equals the value written during the build step. A mismatch means the files on disk do not match what was built.

**Unit test that would have caught this exact incident:**

```typescript
// packages/core/src/error-messages.test.ts
import { classifyError, renderError } from './error-messages.js';

test('credit balance error classifies as SPEND_CAP, not UNKNOWN', () => {
  const err = new Error('Your credit balance is too low');
  expect(classifyError(err)).toBe('SPEND_CAP');
});

test('renderError for SPEND_CAP contains budget copy', () => {
  expect(renderError('SPEND_CAP')).toMatch(/budget/i);
});
```

This test runs against `src/`, not `dist/`. If the test passes but the fix never gets compiled and deployed, the health check content hash mismatch catches it. Both layers are needed.

---

## 3. Deploy Gates

Gates that would have prevented this incident, in order of impact.

### Gate 1: Build must succeed before upload (already implemented)

`deploy.ts` calls `build()` before `scp()`. If `pnpm botforge deploy` is the only deploy path, this gate already runs. The problem is it is not the only deploy path.

**Fix:** Make it so. Document that manual SCP is prohibited. Remove any convenience scripts that scp individual files from dist.

### Gate 2: Working tree clean check (already implemented for core)

`build.ts` throws if the working tree is dirty. This is correct. It is however bypassed if someone builds with `--framework-version` (pinned SHA) or if `dist/` edits are the only dirty files.

**Extend:** After `pnpm -r build`, verify that `packages/core/dist/FRAMEWORK_SHA` equals `git rev-parse HEAD`. If not, the build step silently failed or was skipped.

```typescript
// in build() after execSync('pnpm -r build')
const builtSha = readFileSync('packages/core/dist/FRAMEWORK_SHA', 'utf-8').trim();
const headSha  = currentFrameworkSha();
if (builtSha !== headSha) {
  throw new Error(
    `FRAMEWORK_SHA mismatch after build: dist says ${builtSha}, HEAD is ${headSha}. ` +
    `The build step did not recompile core. Check packages/core tsconfig and build script.`
  );
}
```

### Gate 3: Pre-push hook — tests must pass before git push

This prevents a class of "the fix is in src but broken" incidents. For botforge, the most important test is that error classification behaves correctly.

```bash
# .husky/pre-push
#!/bin/sh
pnpm -r test --run
```

Combined with the unit test above, this catches the fix being wrong before it gets deployed.

### Gate 4: GitHub Actions deploy workflow

The minimal GitHub Actions workflow that enforces the full pipeline:

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - run: pnpm -r test --run          # tests run against src

      - run: pnpm -r build               # compile src to dist

      - name: Verify build SHA matches HEAD
        run: |
          BUILT=$(cat packages/core/dist/FRAMEWORK_SHA | tr -d '\n')
          HEAD=$(git rev-parse HEAD)
          if [ "$BUILT" != "$HEAD" ]; then
            echo "FRAMEWORK_SHA mismatch: built=$BUILT head=$HEAD"
            exit 1
          fi

      - name: Upload dist artifact
        uses: actions/upload-artifact@v4
        with:
          name: dist-${{ github.sha }}
          path: dist/
          # GitHub automatically computes and validates a SHA256 digest

      - name: Deploy to acemagic
        run: |
          # download-artifact validates the digest automatically
          # rsync the verified dist/ to acemagic
          rsync -az --delete dist/ ${{ secrets.ACEMAGIC_USER }}@${{ secrets.ACEMAGIC_HOST }}:/opt/botforge/bots/
        env:
          SSH_PRIVATE_KEY: ${{ secrets.ACEMAGIC_SSH_KEY }}
```

The `upload-artifact` / `download-artifact` actions automatically verify a SHA256 digest of the artifact between jobs. This is GitHub's built-in artifact provenance, available for free since 2024.

### Gate 5: Makefile / justfile staleness check (lightweight alternative)

If GitHub Actions feels like too much for a quick fix, a Makefile can enforce build freshness locally:

```makefile
# Makefile at botforge root
CORE_SRC := $(shell find packages/core/src -name '*.ts')
CORE_DIST := packages/core/dist/index.js

$(CORE_DIST): $(CORE_SRC)
	pnpm -r build
	@echo "Build complete"

.PHONY: deploy
deploy: $(CORE_DIST)
	pnpm botforge deploy $(BOT)

.PHONY: clean
clean:
	rm -rf dist/ packages/*/dist/
```

`make deploy BOT=kristina` will rebuild `packages/core/dist/` only if any `src/` `.ts` file is newer than the current dist output — make's timestamp-based staleness check. This is the same principle IDEs and compilers use.

---

## 4. Drift Detection

Drift detection catches divergence AFTER it has happened — useful for alerting when manual SCPs or out-of-band changes have changed the server's deployed files.

### Checksum manifest approach

After deploy, write a manifest of every deployed file's SHA256 to a known location on acemagic AND commit that same manifest to git.

```bash
# scripts/generate-manifest.sh
#!/bin/bash
# Run after build, before deploy
find dist/ -type f | sort | while read f; do
  sha256sum "$f"
done > dist/MANIFEST.sha256
```

Post-deploy cron on acemagic (runs every 15 minutes):

```bash
#!/bin/bash
# /opt/botforge/scripts/drift-check.sh

REMOTE_MANIFEST=/opt/botforge/bots/MANIFEST.sha256
GIT_MANIFEST=$(curl -sf "https://raw.githubusercontent.com/OWNER/botforge/main/dist/MANIFEST.sha256")

REMOTE_HASH=$(sha256sum "$REMOTE_MANIFEST" | awk '{print $1}')
GIT_HASH=$(echo "$GIT_MANIFEST" | sha256sum | awk '{print $1}')

if [ "$REMOTE_HASH" != "$GIT_HASH" ]; then
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="${TELEGRAM_CHAT_ID}" \
    -d text="BOTFORGE DRIFT DETECTED: deployed manifest does not match git main. Manual SCP suspected."
fi
```

Note: this approach requires `dist/` to remain in git (or the manifest to be committed separately). If `dist/` is gitignored (the recommended fix), the manifest approach changes: the "expected" manifest is instead the one generated during the CI build job and stored as a build artifact.

### rsync --dry-run diff

Simpler, no manifest file needed. From the Mac or from acemagic:

```bash
# What would change if we deployed right now?
rsync -avz --dry-run dist/kristina/ acemagic:/opt/botforge/bots/kristina/
```

If this reports files to transfer, the deployed code is stale. Can be run manually before any investigation, or wired into a GitHub Actions workflow that runs on a schedule and posts to Telegram if drift is detected.

### FRAMEWORK_SHA cron check

Already partially implemented: `/opt/botforge/packages/core/dist/FRAMEWORK_SHA` is written at build time. A cron that SSHes to acemagic and compares this value to `git ls-remote origin HEAD` would catch SHA drift:

```bash
#!/bin/bash
# scripts/sha-drift-check.sh (run from Mac via cron or GitHub Actions schedule)

DEPLOYED=$(ssh acemagic "cat /opt/botforge/packages/core/dist/FRAMEWORK_SHA" | tr -d '\n')
GIT_HEAD=$(git ls-remote origin HEAD | awk '{print $1}')

if [ "${DEPLOYED:0:40}" != "${GIT_HEAD:0:40}" ]; then
  echo "DRIFT: deployed=$DEPLOYED git_head=$GIT_HEAD"
  # send Telegram alert
fi
```

This catches the case where the source was changed and pushed but the deploy was never run. It does NOT catch the case where dist/ was manually edited without a source change (which is why content hash is also needed).

---

## 5. Single-Box Deploy Reliability

### Atomic swap (already implemented)

`deploy.ts` already uses the `.new` / `.old` pattern:

```
mkdir remoteDir.new
scp dist/* → remoteDir.new/
mv remoteDir → remoteDir.old   (atomic on same filesystem)
mv remoteDir.new → remoteDir   (atomic on same filesystem)
systemctl restart
health check → if fail, mv remoteDir → remoteDir.failed; mv remoteDir.old → remoteDir
```

This is correct. The weakness is that `mv` is not a single atomic `rename()` syscall when the source and destination are different names in the same directory — it is two renames. For a systemd service that reads files at startup (not on every request), this is fine.

### Capistrano-style releases for rollback depth

The current `.old` approach keeps exactly one previous release. For more rollback depth, use a timestamped releases directory:

```bash
# On acemagic: /opt/botforge/releases/<timestamp>/
# /opt/botforge/current -> /opt/botforge/releases/<latest-timestamp>/ (symlink)
# Systemd unit file uses /opt/botforge/current/kristina/config.yaml

RELEASE_DIR="/opt/botforge/releases/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$RELEASE_DIR"
rsync -a dist/kristina/ "$RELEASE_DIR/kristina/"
ln -sfn "$RELEASE_DIR" /opt/botforge/current
sudo systemctl restart botforge-kristina

# Keep last 5 releases
ls -dt /opt/botforge/releases/*/ | tail -n +6 | xargs rm -rf
```

Rollback becomes:

```bash
# List releases
ls -lt /opt/botforge/releases/

# Point current at any previous release
ln -sfn /opt/botforge/releases/20260525-143012 /opt/botforge/current
sudo systemctl restart botforge-kristina
```

The `ln -sfn` (GNU ln, `-f` force + `-n` no-dereference) swap is the atomic operation. On a single filesystem, this is one `rename()` syscall — users either see old or new, never a partial state.

For a single box with 3 bots, 5 releases is plenty. Storage cost is negligible.

### Minimal version to adopt now

The minimal high-value version, ranked:

1. Add `dist/` to `.gitignore`. One line. Eliminates the root cause class.
2. Add the SHA-after-build verification in `build.ts` (5 lines). Catches compiler silently skipping core.
3. Add the unit test for `classifyError`. Catches logic regressions against src.
4. Add `rsync --dry-run` to the deploy health check output. Makes drift visible at deploy time.
5. Capistrano-style releases (symlink + timestamped dirs). Do this when you want 5-release rollback depth.
6. GitHub Actions deploy workflow. Do this when manual deploy reliability is not good enough.

---

## Priority Matrix

| Change | Prevents This Incident | Effort | Impact |
|---|---|---|---|
| `dist/` in `.gitignore` + build-on-deploy only | YES (root cause) | 30 min | Highest |
| SHA verify after build in `build.ts` | YES (secondary) | 15 min | High |
| Unit test for `classifyError` | YES (would have caught in test) | 20 min | High |
| Content hash in health endpoint | Partial | 1 hr | Medium |
| GitHub Actions deploy workflow | Partial | 2 hr | Medium |
| Capistrano-style releases | No (rollback depth only) | 2 hr | Medium |
| Drift detection cron | No (detection, not prevention) | 1 hr | Low-Medium |

---

## What to Do This Week

**Day 1 (30 minutes total):**

```bash
# 1. Add dist to gitignore
echo "dist/" >> /Users/Mark/Documents/dev/botforge/.gitignore
git rm -r --cached dist/
git commit -m "chore: stop tracking dist/ — build-on-deploy only"

# 2. Verify deploy still works
pnpm botforge deploy kristina
```

**Day 1 (continued, 30 minutes):**

Add to `packages/core/src/error-messages.test.ts` (or wherever error classification tests live):

```typescript
test('spend cap error classifies correctly', () => {
  expect(classifyError(new Error('credit balance is too low'))).toBe('SPEND_CAP');
  expect(renderError('SPEND_CAP')).not.toMatch(/couldn't process/i);
});
```

**Day 2 (15 minutes):**

Add the post-build SHA verification to `build.ts`. After `execSync('pnpm -r build')`:

```typescript
const builtSha = readFileSync(coreShaPath, 'utf-8').trim();
if (builtSha !== frameworkSha) {
  throw new Error(`Post-build FRAMEWORK_SHA mismatch: expected ${frameworkSha}, got ${builtSha}`);
}
```

**Later (when you want CI):**

Wire the GitHub Actions deploy workflow. The upload-artifact / download-artifact SHA256 verification is built-in and free.

---

Sources:
- [pnpm deploy docs](https://pnpm.io/cli/deploy)
- [GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
- [GitHub upload-artifact action](https://github.com/actions/upload-artifact)
- [Atomic symlink swap — Deployer](https://deployer.org/blog/atomic-symlinks)
- [Atomic deployments without tears](https://nystudio107.com/blog/executing-atomic-deployments)
- [Deploying to a server via SSH and Rsync in a Github Action](https://zellwk.com/blog/github-actions-deploy/)
- [Drift Detection in GitOps Workflows](https://bugfree.ai/knowledge-hub/drift-detection-in-gitops-workflows)
- [PM2 Capistrano-like deployments](https://pm2.keymetrics.io/docs/tutorials/capistrano-like-deployments)
- [Building production-ready artifacts from pnpm monorepo](https://github.com/orgs/pnpm/discussions/4478)
