import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectPublicFile, checkPublic } from '../scripts/check-public.mjs';

test('public check catches private paths and secret-like values without returning values', () => {
  const fake = ['sk', 'proj', 'x'.repeat(40)].join('-');
  const findings = inspectPublicFile('.local/account.json', JSON.stringify({ token: fake }));
  assert.deepEqual(findings, ['private-or-generated-path', 'provider-secret']);
  assert(!JSON.stringify(findings).includes(fake));
  assert.deepEqual(inspectPublicFile('README.md', 'Local file: ' + '/Users/' + 'example/private.md'), ['private-home-path']);
});

test('public check includes untracked and force-tracked ignored files but does not read ignored state', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'public-check-'));
  try {
    execFileSync('git', ['init', '--quiet', root]);
    writeFileSync(path.join(root, '.gitignore'), '.env\n');
    writeFileSync(path.join(root, '.env'), ['sk', 'x'.repeat(40)].join('-'));
    writeFileSync(path.join(root, 'new.txt'), 'safe');
    assert.equal(checkPublic(root).findings.length, 0);
    execFileSync('git', ['-C', root, 'add', '-f', '.env']);
    assert(checkPublic(root).findings.some(x => x.rule === 'private-or-generated-path'));
    writeFileSync(path.join(root, 'new.txt'), ['sk', 'x'.repeat(40)].join('-'));
    assert(checkPublic(root).findings.some(x => x.path === 'new.txt' && x.rule === 'provider-secret'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
