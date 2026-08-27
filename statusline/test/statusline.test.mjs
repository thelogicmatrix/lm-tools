// One runnable check for the branchy parts: band colors, optional segments,
// the account label, and that a garbage payload prints nothing instead of
// crashing the session's status line.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'scripts', 'statusline.js');
const { render } = createRequire(import.meta.url)(script);

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// Full payload: every segment present.
{
  const [row1, row2] = render({
    model: { display_name: 'Opus 5' },
    workspace: { current_dir: '/home/nathan/projects/orion' },
    context_window: { used_percentage: 12 },
    cost: { total_cost_usd: 3.4567 },
    rate_limits: { five_hour: { used_percentage: 41.2 }, seven_day: { used_percentage: 8 } },
  }).split('\n');
  assert.match(strip(row1), /^Opus 5 \| (lo|med|hi|\w+ \| )?.*orion \| █░{9} 12% \| \w+$/);
  assert.equal(strip(row2), '5h:42% | 7d:8% | $3.46');   // ceil, and cost to 2dp
}

// Empty payload: row 1 still renders, row 2 collapses to nothing.
{
  const [row1, row2] = render({}).split('\n');
  assert.match(strip(row1), /^Claude \|/);
  assert.equal(row2, '');
}

// Bands: the fill color must change with pressure.
{
  const colorAt = (pct) => render({ context_window: { used_percentage: pct } })
    .split('\n')[0].match(/\x1b\[([0-9;]+)m█/)[1];
  const [low, mid, high, alarm] = [10, 60, 75, 95].map(colorAt);
  assert.deepEqual(new Set([low, mid, high, alarm]).size, 4, 'each band needs its own color');
  assert.equal(alarm, '5;31', 'the top band blinks red');
}

// Account label: env override wins, otherwise the config dir name.
{
  const label = (env) => strip(render({}, env)) && strip(
    execFileSync(process.execPath, [script], { input: '{}', env: { ...process.env, ...env } }).toString()
  ).split('\n')[0].split(' | ').pop();
  assert.equal(label({ CLAUDE_STATUSLINE_ACCOUNT: 'work' }), 'work');
  assert.equal(label({ CLAUDE_CONFIG_DIR: '/x/.claudework', CLAUDE_STATUSLINE_ACCOUNT: '' }), 'claudework');
  assert.equal(label({ CLAUDE_CONFIG_DIR: '/x/.claude', CLAUDE_STATUSLINE_ACCOUNT: '' }), 'personal');
}

// Malformed stdin: no output, no crash.
{
  const out = execFileSync(process.execPath, [script], { input: 'not json' }).toString();
  assert.equal(out, '');
}

console.log('statusline: all checks passed');
