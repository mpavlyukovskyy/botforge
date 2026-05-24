import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  shortSha,
  validateSha,
  buildOverrideFile,
  overrideFilePath,
  fwStorePath,
  decideCanaryAction,
} from './canary.js';

describe('shortSha', () => {
  it('truncates a 40-char SHA to 12 chars', () => {
    assert.equal(
      shortSha('2102ffd23dd9a93ff65813c51dc5b311e8ca41db'),
      '2102ffd23dd9',
    );
  });
  it('leaves shorter strings alone', () => {
    assert.equal(shortSha('abc'), 'abc');
  });
});

describe('validateSha', () => {
  it('accepts 40-hex', () => {
    assert.deepEqual(
      validateSha('2102ffd23dd9a93ff65813c51dc5b311e8ca41db'),
      { ok: true },
    );
  });
  it('accepts 7-hex (git short form)', () => {
    assert.deepEqual(validateSha('2102ffd'), { ok: true });
  });
  it('rejects empty', () => {
    assert.deepEqual(validateSha(''), { ok: false, reason: 'empty SHA' });
    assert.deepEqual(validateSha(undefined), { ok: false, reason: 'empty SHA' });
  });
  it('rejects too short', () => {
    const r = validateSha('abc12');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /too short/);
  });
  it('rejects garbage', () => {
    const r = validateSha('not-a-sha-at-all!@#');
    assert.equal(r.ok, false);
  });
  it('trims whitespace before length check', () => {
    assert.deepEqual(validateSha('  2102ffd  '), { ok: true });
  });
});

describe('buildOverrideFile', () => {
  const args = {
    sha: '2102ffd23dd9a93ff65813c51dc5b311e8ca41db',
    botName: 'trainer',
    baseDir: '/opt/botforge/bots',
    fwBaseDir: '/opt/botforge-fw',
  };

  it('golden output for trainer', () => {
    const expected = [
      '[Service]',
      'WorkingDirectory=/opt/botforge-fw/2102ffd23dd9',
      'ExecStart=',
      'ExecStart=/usr/bin/node packages/cli/dist/index.js dev /opt/botforge/bots/trainer.yaml',
      'Environment=BOTFORGE_FRAMEWORK_SHA=2102ffd23dd9a93ff65813c51dc5b311e8ca41db',
      '',
    ].join('\n');
    assert.equal(buildOverrideFile(args), expected);
  });

  it('property: every fleet bot produces a valid [Service] block', () => {
    for (const bot of ['kristina', 'chief-of-staff', 'trainer', 'maia', 'harry']) {
      const out = buildOverrideFile({ ...args, botName: bot });
      assert.match(out, /^\[Service\]/);
      assert.match(out, /WorkingDirectory=\/opt\/botforge-fw\//);
      assert.match(out, /ExecStart=\n/, 'must reset ExecStart before appending');
      assert.match(out, /Environment=BOTFORGE_FRAMEWORK_SHA=/);
      assert.match(out, new RegExp(`/${bot}\\.yaml$`, 'm'));
    }
  });

  it('throws on invalid SHA', () => {
    assert.throws(() => buildOverrideFile({ ...args, sha: 'bad' }), /invalid SHA/);
  });

  it('throws on bot name with shell metachars', () => {
    assert.throws(() => buildOverrideFile({ ...args, botName: 'foo;rm -rf /' }), /invalid characters/);
  });
});

describe('overrideFilePath', () => {
  it('builds the systemd drop-in path', () => {
    assert.equal(
      overrideFilePath('botforge-trainer.service'),
      '/etc/systemd/system/botforge-trainer.service.d/framework.conf',
    );
  });
});

describe('fwStorePath', () => {
  it('uses the 12-char short SHA', () => {
    assert.equal(
      fwStorePath('/opt/botforge-fw', '2102ffd23dd9a93ff65813c51dc5b311e8ca41db'),
      '/opt/botforge-fw/2102ffd23dd9',
    );
  });
});

describe('decideCanaryAction', () => {
  it('noop when neither side has a pin', () => {
    assert.deepEqual(decideCanaryAction(undefined, undefined), { kind: 'noop' });
  });
  it('add when only requested is set', () => {
    assert.deepEqual(decideCanaryAction(undefined, 'abc1234'), { kind: 'add', sha: 'abc1234' });
  });
  it('remove when only current is set (no-flag deploy on canary bot)', () => {
    assert.deepEqual(decideCanaryAction('abc1234', undefined), { kind: 'remove' });
  });
  it('noop when both sides agree', () => {
    assert.deepEqual(decideCanaryAction('abc1234', 'abc1234'), { kind: 'noop' });
  });
  it('replace when both sides differ', () => {
    assert.deepEqual(
      decideCanaryAction('abc1234', 'def5678'),
      { kind: 'replace', oldSha: 'abc1234', newSha: 'def5678' },
    );
  });
});
