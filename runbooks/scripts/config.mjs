// The one place every runbooks script resolves paths and settings.
// .runbooks/ is the user tier: project root first, then ~/.runbooks. First found wins, no merging.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Spend and dedupe logs. LOCALAPPDATA on Windows, XDG-style state dir elsewhere.
export const STATE_DIR = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'claude-router')
  : join(homedir(), '.local', 'state', 'claude-router');

// Measured values the router was tuned at.
const DEFAULTS = { firesAt: 0.8, maxInject: 6, shortlist: 30 };

const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

// Git top of cwd, or cwd itself when it is not in a repo or git is unavailable.
function projectRoot(cwd) {
  try {
    const top = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (top) return resolve(top);
  } catch {}
  return resolve(cwd);
}

function rootFrom(project, cwd, home) {
  return [join(project, '.runbooks'), join(resolve(cwd), '.runbooks'), join(home, '.runbooks')].find(isDir) ?? null;
}

export function findRoot(cwd, home = homedir()) {
  return rootFrom(projectRoot(cwd), cwd, home);
}

export function loadConfig(rootDir) {
  if (!rootDir) return {};
  try {
    const c = JSON.parse(readFileSync(join(rootDir, 'config.json'), 'utf8'));
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  } catch { return {}; }
}

// Relative paths in config.json are relative to the folder holding .runbooks/.
const fromRoot = (root, p) => (isAbsolute(p) || !root ? resolve(p) : resolve(dirname(root), p));

// A relative RUNBOOKS_DIR resolves from the cwd argument, not the process cwd, which for a hook is
// wherever the harness happened to start it.
function dirFrom({ cwd, project, root, config, env, home }) {
  const candidates = [
    env.RUNBOOKS_DIR && resolve(cwd, env.RUNBOOKS_DIR),
    typeof config.dir === 'string' && config.dir && fromRoot(root, config.dir),
    join(project, 'docs', 'runbooks'),
    join(home, 'docs', 'runbooks'),
  ];
  return candidates.find((p) => p && isDir(p)) ?? null;
}

function resolveAll({ cwd = process.cwd(), env = process.env, home = homedir() } = {}) {
  const project = projectRoot(cwd);
  const root = rootFrom(project, cwd, home);
  const config = loadConfig(root);
  return { root, config, dir: dirFrom({ cwd, project, root, config, env, home }) };
}

export function resolveDir(opts) {
  return resolveAll(opts).dir;
}

// A non-numeric value in config.json falls back to the default rather than reaching the router.
const num = (v, d) => (Number.isFinite(v) ? v : d);

export function settings(opts) {
  const { root, config, dir } = resolveAll(opts);
  const firesAt = num(config.firesAt, DEFAULTS.firesAt);
  // A writeBar under firesAt would pass a purpose the router never fires on, so it falls back too.
  const writeBar = num(config.writeBar, -Infinity);
  const ledger = typeof config.ledger === 'string' && config.ledger
    ? fromRoot(root, config.ledger)
    : dir && join(dir, '.router-ledger.json');
  return {
    root,
    dir,
    firesAt,
    writeBar: writeBar >= firesAt ? writeBar : +(firesAt + 0.05).toFixed(2),
    maxInject: num(config.maxInject, DEFAULTS.maxInject),
    shortlist: num(config.shortlist, DEFAULTS.shortlist),
    ledger: ledger || null,
  };
}

const listFiles = (dir, ext) => (isDir(dir) ? readdirSync(dir).filter((f) => f.endsWith(ext)).sort() : []);

// <root>/<kind>/*.mjs whose default export is a function. A file that throws on import is skipped,
// and so is a *.test.mjs, so an extension's own tests can sit beside it without running as one.
export async function loadExtensions(root, kind) {
  if (!root) return [];
  const dir = join(root, kind);
  const out = [];
  for (const file of listFiles(dir, '.mjs').filter((f) => !f.endsWith('.test.mjs'))) {
    try {
      const mod = await import(pathToFileURL(join(dir, file)).href);
      if (typeof mod.default === 'function') out.push({ name: basename(file, '.mjs'), fn: mod.default });
    } catch {}
  }
  return out;
}

