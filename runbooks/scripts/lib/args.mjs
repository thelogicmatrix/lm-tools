// lib-cli/args.mjs. Canonical in the logical-tools repo, vendored into each plugin that lists it in a
// .framework.json. Edit the canonical copy, run node scripts/sync-lib.mjs, commit both.
//
// Flags with no schema, the way gtg's verbs read them: `--name value`, `--name=value` and a bare
// `--name` (true). A token that starts with `--` is never taken as a value, so `--a --b` is two bare
// flags. A name in `boolean` never takes a value. `--name=value` always gives the string, even for a name in `boolean`. A repeated flag keeps its last value unless its
// name is in `multi`, which collects every occurrence in order. A bare `--` ends the flags. Every
// other token is a positional, in order.
// Not node:util parseArgs: that gives an undeclared option no value, so `--project Name` would read
// as `project: true` plus a positional.
const DROPPED = new Set(['__proto__', 'constructor', 'prototype']);

export function parseArgs(argv, { multi = [], boolean = [] } = {}) {
  const flags = {};
  const positionals = [];
  const many = new Set(multi);
  const bare = new Set(boolean);
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!tok.startsWith('--')) {
      positionals.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    const key = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    let value = true;
    if (eq !== -1) value = tok.slice(eq + 1);
    else if (!bare.has(key) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) value = argv[++i];
    if (!key || DROPPED.has(key)) continue;
    if (many.has(key)) {
      if (!Object.hasOwn(flags, key)) flags[key] = [];
      flags[key].push(value);
    } else {
      flags[key] = value;
    }
  }
  return { flags, positionals };
}

export const parseFlags = (argv, opts) => parseArgs(argv, opts).flags;
