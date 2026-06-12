/**
 * Pins node-cron 3.0.3's expression expansion for the token_refresh schedule.
 *
 * Why this exists: node-cron's step-conversion implements "a-b/n" as
 * "values in [a,b] divisible by n", so "2-57/5" silently becomes
 * 5,10,...,55 — back on the 0/5 boundaries every other Whoop cron uses,
 * and dropping the :00 tick. The schedule MUST use an explicit minute list.
 * If node-cron ever fixes range-step semantics, the mangling assertion below
 * fails on purpose — re-evaluate the workaround then.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const convert = require('node-cron/src/convert-expression');

const TRAINER_YAML = join(dirname(fileURLToPath(import.meta.url)), '../../trainer.yaml');
const EXPECTED_MINUTES = '2,7,12,17,22,27,32,37,42,47,52,57';

function minutesOf(expr) {
  // convert() returns "second minute hour dom month dow"
  return convert(expr).split(' ')[1];
}

describe('token_refresh cron expression', () => {
  it('the explicit minute list expands to exactly the 12 offset minutes', () => {
    expect(minutesOf(`${EXPECTED_MINUTES} * * * *`)).toBe(EXPECTED_MINUTES);
  });

  it('node-cron still mangles range-step syntax (the reason the list is explicit)', () => {
    expect(minutesOf('2-57/5 * * * *')).toBe('5,10,15,20,25,30,35,40,45,50,55');
  });

  it('trainer.yaml uses the explicit list and contains no range-step minute syntax', () => {
    const yaml = readFileSync(TRAINER_YAML, 'utf8');
    expect(yaml).toContain(`"${EXPECTED_MINUTES} * * * *"`);
    const withoutComments = yaml.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
    expect(withoutComments).not.toMatch(/\d+-\d+\/\d+/);
  });
});
