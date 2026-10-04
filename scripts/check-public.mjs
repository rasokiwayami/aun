import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function inspectPublicFile(name, content) {
  const findings = [];
  if (/^(?:\.local|vendor|node_modules|bin|dist)(?:\/|$)|(?:^|\/)\.env(?:\.|$)/.test(name)) findings.push('private-or-generated-path');
  const rules = [
    ['private-home-path', /\/(?:Users|home)\/[A-Za-z0-9_.-]+\//],
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['provider-secret', /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/],
    ['credential-value', /["'](?:access_token|refresh_token|id_token)["']\s*:\s*["'][A-Za-z0-9_.-]{24,}["']/],
  ];
  for (const [rule, pattern] of rules) if (pattern.test(content)) findings.push(rule);
  return findings;
}

export function checkPublic(root) {
  const names = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
  const findings = [];
  for (const name of names) {
    const filename = path.join(root, name);
    const stat = lstatSync(filename);
    if (!stat.isFile()) { findings.push({ path: name, rule: 'non-regular-file' }); continue; }
    if (stat.size > 1_000_000) { findings.push({ path: name, rule: 'unexpected-large-file' }); continue; }
    for (const rule of inspectPublicFile(name, readFileSync(filename, 'utf8'))) findings.push({ path: name, rule });
  }
  return { files: names.length, findings };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkPublic(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.findings.length ? 1 : 0;
}
