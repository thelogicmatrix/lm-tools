#!/usr/bin/env node
// lm-tools statusline - two rows, built only from the payload Claude Code
// hands a status line command on stdin. No cache files, no side state.
//
// Row 1: model | effort | dir | context bar used% | account
// Row 2: 5h:% | 7d:% | $cost
//
// Install with /statusline-install, which copies this file next to your
// settings.json and points statusLine at the copy.

const fs = require('fs');
const path = require('path');
const os = require('os');

const RESET = '\x1b[0m';
const DIM = '\x1b[38;5;245m';   // readable grey; ANSI faint is too low-contrast
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const ORANGE = '\x1b[38;5;208m';
const ALARM = '\x1b[5;31m';     // blinking red
const SEP = ` ${DIM}|${RESET} `;

// Pressure bands, low to high. First match wins.
const BANDS = [[50, GREEN], [70, YELLOW], [80, ORANGE], [Infinity, ALARM]];
const bandColor = (pct) => BANDS.find(([ceiling]) => pct < ceiling)[1];

const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// Label for which login is driving the session. Two config dirs (say .claude
// and .claudework) give two labels without any per-machine config.
function accountLabel() {
  if (process.env.CLAUDE_STATUSLINE_ACCOUNT) return process.env.CLAUDE_STATUSLINE_ACCOUNT;
  const slug = path.basename(configDir()).replace(/^\./, '');
  return slug === 'claude' ? 'personal' : slug;
}

// Effort level is a setting, not part of the stdin payload.
function effortLabel() {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(configDir(), 'settings.json'), 'utf8'));
    const level = settings.effortLevel;
    if (!level) return null;
    return { low: 'lo', medium: 'med', high: 'hi' }[level] || level;
  } catch (e) {
    return null;   // no settings file, unreadable, or malformed
  }
}

function contextBar(cw) {
  const raw = cw?.used_percentage ?? (cw?.remaining_percentage != null ? 100 - cw.remaining_percentage : null);
  if (raw == null) return null;
  const pct = Math.max(0, Math.min(100, Math.round(raw)));
  const filled = Math.floor(pct / 10);
  return `${bandColor(pct)}${'█'.repeat(filled)}${'░'.repeat(10 - filled)} ${pct}%${RESET}`;
}

// Reset clock, e.g. " ↺ 3:05p". Epoch seconds.
function resetClock(epochSec) {
  if (typeof epochSec !== 'number' || epochSec <= 0) return '';
  const d = new Date(epochSec * 1000);
  const suffix = d.getHours() >= 12 ? 'p' : 'a';
  const hour = d.getHours() % 12 || 12;
  return ` ↺ ${hour}:${String(d.getMinutes()).padStart(2, '0')}${suffix}`;
}

function limitSegment(label, window, dim) {
  if (typeof window?.used_percentage !== 'number') return null;
  const pct = Math.ceil(window.used_percentage);
  const color = dim ? DIM : bandColor(pct);
  return `${color}${label}:${pct}%${dim ? '' : resetClock(window.resets_at)}${RESET}`;
}

function render(data) {
  const row1 = [
    `${DIM}${data.model?.display_name || 'Claude'}${RESET}`,
    effortLabel() && `${DIM}${effortLabel()}${RESET}`,
    `${DIM}${path.basename(data.workspace?.current_dir || process.cwd())}${RESET}`,
    contextBar(data.context_window),
    `${DIM}${accountLabel()}${RESET}`,
  ];

  const cost = data.cost?.total_cost_usd;
  const row2 = [
    limitSegment('5h', data.rate_limits?.five_hour, false),
    limitSegment('7d', data.rate_limits?.seven_day, true),
    typeof cost === 'number' && `${DIM}$${cost.toFixed(2)}${RESET}`,
  ];

  const join = (parts) => parts.filter(Boolean).join(SEP);
  return `${join(row1)}\n${join(row2)}`;
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      process.stdout.write(render(JSON.parse(input)));
    } catch (e) {
      // A status line must never be the reason a session looks broken.
    }
  });
}

module.exports = { render };
