// The two lib/store.mjs copies must not drift.
//
// gtg and projects install and version independently through the plugin cache, so a shared module
// would break on a version skew - the duplication is deliberate and documented in both files. What
// the duplication costs is that a fix applied to one copy and not the other is invisible to any
// task-scoped review: both plugins still pass their own suites while one of them quietly keeps the
// bug. So the parity is asserted here rather than remembered.
//
// Compared on CODE, not prose: the two headers differ on purpose (gtg's carries its extension-ctx
// audit, projects' carries the ponytail note), and the domain word in one comment differs
// ("parked" vs "archived"). Full-line comments and blank lines are therefore dropped, and the
// plugin's own name is normalised, because every message in the file is prefixed with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MINE = join(HERE, '..', 'skills', 'gtg', 'lib', 'store.mjs');
// Sibling plugin in the same repo. Absent when gtg is installed on its own out of the plugin
// cache, which is the one case where there is no second copy to drift from.
const THEIRS = join(HERE, '..', '..', 'projects', 'skills', 'projects', 'lib', 'store.mjs');

const code = (path, name) => readFileSync(path, 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim() && !l.trim().startsWith('//'))
  .join('\n')
  .split(`${name}:`).join('<plugin>:');

test('the gtg and projects store.mjs copies have identical code', { skip: existsSync(THEIRS) ? false : 'projects plugin not checked out beside this one' }, () => {
  assert.equal(code(MINE, 'gtg'), code(THEIRS, 'projects'),
    'lib/store.mjs has drifted between the two plugins - a fix landed in one copy and not the other');
});
