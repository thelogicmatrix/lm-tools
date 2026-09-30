#!/usr/bin/env node
// Copies the lib-cli files each plugin lists into that plugin, so every plugin ships whole.
// A plugin lists what it vendors in a .framework.json beside the copies: {"files": ["args.mjs"]}.
// A sync stamps the manifest with lib-cli's version, the top "## X.Y.Z" heading of
// lib-cli/CHANGELOG.md, so an installed plugin can say which lib-cli its copies came from.
//   node scripts/sync-lib.mjs          copy every listed file whose content differs, restamp
//   node scripts/sync-lib.mjs --check  change nothing, exit 1 when a copy differs or is missing,
//                                      or a manifest's stamp is not the current version
// Content is compared with CRLF read as LF. A Windows checkout with core.autocrlf rewrites line
// endings on disk while git stores the same bytes, and that must never read as drift.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib-cli/exit.mjs';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME_OK = /^[a-z0-9][a-z0-9-]*\.mjs$/;
const SKIP = new Set(['node_modules', '.git', '.superpowers']);
const lf = (s) => s.replace(/\r\n/g, '\n');
const rel = (repo, p) => relative(repo, p).split(sep).join('/');

export function plugins(repo) {
  return readdirSync(repo, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(repo, d.name, '.claude-plugin', 'plugin.json')))
    .map((d) => d.name)
    .sort();
}

function walk(dir, out) {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(d.name)) continue;
    const p = join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (d.name === '.framework.json') out.push(p);
  }
  return out;
}

export function manifests(repo) {
  return plugins(repo).flatMap((p) => walk(join(repo, p), [])).sort();
}

export function libVersion(repo) {
  const m = /^## (\d+\.\d+\.\d+)\b/m.exec(readFileSync(join(repo, 'lib-cli', 'CHANGELOG.md'), 'utf8'));
  if (!m) throw new Error('lib-cli/CHANGELOG.md has no "## X.Y.Z" heading');
  return m[1];
}

// One row per listed file, then a 'version' row for a manifest whose stamp is not the current
// version. Throws on a manifest it cannot use, naming it, so a typo never reads as in sync.
export function status(repo) {
  const rows = [];
  const found = manifests(repo);
  const version = found.length ? libVersion(repo) : null;
  for (const m of found) {
    const where = rel(repo, m);
    let files, stamp;
    try {
      ({ files, version: stamp } = JSON.parse(readFileSync(m, 'utf8')));
    } catch (e) {
      throw new Error(`${where}: not valid JSON - ${e.message}`);
    }
    if (!Array.isArray(files) || !files.length) throw new Error(`${where}: "files" must be a non-empty list`);
    for (const f of files) {
      if (typeof f !== 'string' || !NAME_OK.test(f)) throw new Error(`${where}: ${JSON.stringify(f)} is not a lib-cli file name`);
      const canonical = join(repo, 'lib-cli', f);
      if (!existsSync(canonical)) throw new Error(`${where}: lib-cli/${f} does not exist`);
      const target = join(dirname(m), f);
      const state = !existsSync(target) ? 'missing'
        : lf(readFileSync(target, 'utf8')) === lf(readFileSync(canonical, 'utf8')) ? 'same' : 'differs';
      rows.push({ canonical, target, state });
    }
    if (stamp !== version) rows.push({ canonical: join(repo, 'lib-cli', 'CHANGELOG.md'), target: m, state: 'version', version, files });
  }
  return rows;
}

const stamped = (version, files) => `{ "version": ${JSON.stringify(version)}, "files": [${files.map((f) => JSON.stringify(f)).join(', ')}] }\n`;

export function main(argv, repo = REPO) {
  const unknown = argv.find((a) => a !== '--check');
  if (unknown !== undefined) {
    console.error(`sync-lib: unknown argument ${unknown}. Usage: node scripts/sync-lib.mjs [--check]`);
    return 2;
  }
  let rows;
  try {
    rows = status(repo);
  } catch (e) {
    console.error(`sync-lib: ${e.message}`);
    return 2;
  }
  const off = rows.filter((r) => r.state !== 'same');
  const copies = rows.filter((r) => r.state !== 'version').length;
  if (argv.includes('--check')) {
    for (const r of off) {
      console.log(r.state === 'version' ? `stale stamp: ${rel(repo, r.target)} (lib-cli is ${r.version})`
        : `${r.state}: ${rel(repo, r.target)} (from ${rel(repo, r.canonical)})`);
    }
    console.log(`${copies - off.filter((r) => r.state !== 'version').length} of ${copies} vendored files match lib-cli.`);
    return off.length ? 1 : 0;
  }
  for (const r of off) {
    if (r.state === 'version') {
      writeFileSync(r.target, stamped(r.version, r.files));
      console.log(`stamped ${rel(repo, r.target)} with lib-cli ${r.version}`);
    } else {
      writeFileSync(r.target, readFileSync(r.canonical));
      console.log(`synced ${rel(repo, r.target)}`);
    }
  }
  console.log(`${copies} vendored files match lib-cli.`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
