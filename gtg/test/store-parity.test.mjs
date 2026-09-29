// The twin lib files must not drift: store.mjs in gtg and logical-projects, git.mjs in those two
// and logical-learning.
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
const REPO = join(HERE, '..', '..');
// The first copy of each set is gtg's own. The others are sibling plugins in the same repo,
// absent when gtg is installed on its own out of the plugin cache, which is the one case where
// there is no second copy to drift from. The key is the prefix every message in that copy uses.
const TWINS = [
  ['lib/store.mjs', [
    ['gtg', 'gtg/skills/gtg/lib/store.mjs'],
    ['projects', 'logical-projects/skills/logical-projects/lib/store.mjs'],
  ]],
  ['lib/git.mjs', [
    ['gtg', 'gtg/skills/gtg/lib/git.mjs'],
    ['projects', 'logical-projects/skills/logical-projects/lib/git.mjs'],
    ['learn', 'logical-learning/skills/logical-learning/lib/git.mjs'],
  ]],
];

const code = (path, name) => readFileSync(path, 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim() && !l.trim().startsWith('//'))
  .join('\n')
  .split(`${name}:`).join('<plugin>:');

for (const [file, [[mineName, mine], ...others]] of TWINS) {
  for (const [name, rel] of others) {
    const theirs = join(REPO, rel);
    test(`the gtg and ${name} ${file} copies have identical code`, { skip: existsSync(theirs) ? false : `${rel} not checked out beside gtg` }, () => {
      assert.equal(code(join(REPO, mine), mineName), code(theirs, name),
        `${file} has drifted between gtg and ${name} - a fix landed in one copy and not the other`);
    });
  }
}
