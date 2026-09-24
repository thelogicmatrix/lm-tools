#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const STATUS_ITEMS = [
  'model-with-reasoning',
  'project-name',
  'context-used',
  'five-hour-limit',
  'weekly-limit',
];

// Base token rates per 1M tokens. Long-context surcharges and tool fees are intentionally excluded.
// Source: https://developers.openai.com/api/docs/models/compare
// Cache writes: https://developers.openai.com/api/docs/guides/prompt-caching
export const PRICING_AS_OF = '2026-08-27';

const PRICING = {
  'gpt-5.6-sol': { input: 4, cached: 0.4, output: 20 },
  'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
};

const MODEL_ALIASES = {
  'gpt-5.6': 'gpt-5.6-sol',
};

function nonNegativeInteger(value, field) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Invalid ${field}: ${value}`);
  }
  return Math.floor(number);
}

export function estimateCost(model, usage) {
  const requestedModel = String(model || '').toLowerCase();
  const pricedModel = MODEL_ALIASES[requestedModel] || requestedModel;
  const rates = PRICING[pricedModel];
  if (!rates) {
    throw new Error(`No pricing snapshot for ${model || 'unknown model'}`);
  }

  const inputTokens = nonNegativeInteger(usage?.input_tokens, 'input_tokens');
  const cachedInputTokens = Math.min(
    inputTokens,
    nonNegativeInteger(usage?.cached_input_tokens, 'cached_input_tokens'),
  );
  const cacheWriteInputTokens = Math.min(
    inputTokens - cachedInputTokens,
    nonNegativeInteger(usage?.cache_write_input_tokens, 'cache_write_input_tokens'),
  );
  const uncachedInputTokens = inputTokens - cachedInputTokens - cacheWriteInputTokens;
  const outputTokens = nonNegativeInteger(usage?.output_tokens, 'output_tokens');

  const estimatedUsd = (
    uncachedInputTokens * rates.input
    + cachedInputTokens * rates.cached
    + cacheWriteInputTokens * rates.input * 1.25
    + outputTokens * rates.output
  ) / 1_000_000;

  return {
    requestedModel,
    pricedModel,
    costBasis: 'api-equivalent',
    billed: false,
    pricingAsOf: PRICING_AS_OF,
    inputTokens,
    uncachedInputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    estimatedUsd: Number(estimatedUsd.toFixed(6)),
  };
}

export function parseSession(content) {
  let metadata;
  let usage;

  for (const line of String(content).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === 'session_meta') metadata = event.payload;
    if (
      event.type === 'event_msg'
      && event.payload?.type === 'token_count'
      && event.payload?.info?.total_token_usage
    ) {
      usage = event.payload.info.total_token_usage;
    }
  }

  const model = metadata?.base_instructions?.provenance?.model || metadata?.model;
  return {
    cwd: metadata?.cwd,
    isSubagent: Boolean(metadata?.source?.subagent),
    model,
    usage,
  };
}

function sessionFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.name.endsWith('.jsonl')) files.push(entryPath);
    }
  };
  visit(root);
  return files;
}

function samePath(left, right) {
  if (!left || !right) return false;
  const leftResolved = path.resolve(left);
  const rightResolved = path.resolve(right);
  if (process.platform === 'win32') return leftResolved.toLowerCase() === rightResolved.toLowerCase();
  return leftResolved === rightResolved;
}

export function findLatestSession(root, cwd = process.cwd()) {
  if (!fs.existsSync(root)) throw new Error(`Codex sessions directory not found: ${root}`);

  const sessions = sessionFiles(root)
    .map((sessionPath) => {
      const parsed = parseSession(fs.readFileSync(sessionPath, 'utf8'));
      return {
        ...parsed,
        path: sessionPath,
        modified: fs.statSync(sessionPath).mtimeMs,
      };
    })
    .filter((session) => !session.isSubagent && session.model && session.usage)
    .sort((left, right) => right.modified - left.modified);

  const selected = sessions.find((session) => samePath(session.cwd, cwd));
  if (!selected) {
    throw new Error(
      `No root Codex session matching ${cwd} with token usage found under ${root}. Use --session FILE to select one explicitly.`,
    );
  }
  return selected;
}

function assignmentRange(lines, start, end, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*${escaped}\\s*=`);
  for (let index = start; index < end; index += 1) {
    if (!pattern.test(lines[index])) continue;
    return { start: index, end: index + 1, text: lines[index] };
  }
  return undefined;
}

function configuredItems(assignment) {
  const rhs = assignment.slice(assignment.indexOf('=') + 1).trim();
  let start = -1;
  let end = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < rhs.length; index += 1) {
    const char = rhs[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '#') break;
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '[') {
      if (start < 0) start = index;
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }

  const fail = () => {
    throw new Error('Existing status line must be a single-line string array; edit it manually before installing.');
  };
  if (start < 0 || end < 0 || depth !== 0 || inString) fail();
  const trailing = rhs.slice(end + 1).trim();
  if (trailing && !trailing.startsWith('#')) fail();

  let items;
  try {
    items = JSON.parse(rhs.slice(start, end + 1));
  } catch {
    fail();
  }
  if (!Array.isArray(items) || items.some((item) => typeof item !== 'string')) fail();
  return items;
}

function sameItems(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function nextTable(lines, start) {
  for (let index = start; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) return index;
  }
  return lines.length;
}

export function mergeCodexConfig(text, { force = false } = {}) {
  const eol = String(text).includes('\r\n') ? '\r\n' : '\n';
  const normalized = String(text).replace(/\r\n/g, '\n');
  const hadFinalNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (hadFinalNewline) lines.pop();

  const statusValue = `["${STATUS_ITEMS.join('", "')}"]`;
  const statusLine = `status_line = ${statusValue}`;
  const colorLine = 'status_line_use_colors = true';

  const dotted = assignmentRange(lines, 0, lines.length, 'tui.status_line');
  if (dotted) {
    const current = configuredItems(dotted.text);
    if (!sameItems(current, STATUS_ITEMS) && !force) {
      throw new Error(`config.toml already has a different tui.status_line: ${JSON.stringify(current)}`);
    }
    lines.splice(dotted.start, dotted.end - dotted.start, `tui.${statusLine}`);
    const colors = assignmentRange(lines, 0, lines.length, 'tui.status_line_use_colors');
    if (colors) lines.splice(colors.start, colors.end - colors.start, `tui.${colorLine}`);
    else lines.splice(dotted.start + 1, 0, `tui.${colorLine}`);
  } else {
    let tuiStart = lines.findIndex((line) => /^\s*\[tui\]\s*(?:#.*)?$/.test(line));
    if (tuiStart < 0) {
      if (lines.length && lines.at(-1) !== '') lines.push('');
      lines.push('[tui]', statusLine, colorLine);
    } else {
      let tuiEnd = nextTable(lines, tuiStart + 1);
      const currentStatus = assignmentRange(lines, tuiStart + 1, tuiEnd, 'status_line');
      if (currentStatus) {
        const current = configuredItems(currentStatus.text);
        if (!sameItems(current, STATUS_ITEMS) && !force) {
          throw new Error(`config.toml already has a different tui.status_line: ${JSON.stringify(current)}`);
        }
        lines.splice(currentStatus.start, currentStatus.end - currentStatus.start, statusLine);
      } else {
        lines.splice(tuiStart + 1, 0, statusLine);
      }

      tuiStart = lines.findIndex((line) => /^\s*\[tui\]\s*(?:#.*)?$/.test(line));
      tuiEnd = nextTable(lines, tuiStart + 1);
      const colors = assignmentRange(lines, tuiStart + 1, tuiEnd, 'status_line_use_colors');
      if (colors) lines.splice(colors.start, colors.end - colors.start, colorLine);
      else lines.splice(tuiStart + 2, 0, colorLine);
    }
  }

  const result = lines.join(eol);
  return result + (hadFinalNewline || !text ? eol : '');
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function formatTokens(tokens) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

export function writeFileAtomic(targetPath, content) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const temporary = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, targetPath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function install(args) {
  const configPath = path.resolve(option(args, '--config') || path.join(codexHome(), 'config.toml'));
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  const merged = mergeCodexConfig(existing, { force });

  if (merged === existing) {
    console.log(`Codex status line already configured in ${configPath}`);
    return;
  }
  if (dryRun) {
    console.log(`Would configure Codex status line in ${configPath}`);
    return;
  }

  writeFileAtomic(configPath, merged);
  console.log(`Configured Codex status line in ${configPath}. Restart Codex to see it.`);
}

function cost(args) {
  const explicitSession = option(args, '--session');
  const sessionsRoot = path.resolve(option(args, '--sessions') || path.join(codexHome(), 'sessions'));
  const cwd = path.resolve(option(args, '--cwd') || process.cwd());
  const json = args.includes('--json');
  const session = explicitSession
    ? { ...parseSession(fs.readFileSync(path.resolve(explicitSession), 'utf8')), path: path.resolve(explicitSession) }
    : findLatestSession(sessionsRoot, cwd);

  if (!session.model) throw new Error(`No model found in ${session.path}`);
  if (!session.usage) throw new Error(`No token usage found in ${session.path}`);
  const estimate = estimateCost(session.model, session.usage);
  const result = { ...estimate, sessionPath: session.path };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const parts = [
    `${formatTokens(result.uncachedInputTokens)} uncached in`,
    `${formatTokens(result.cachedInputTokens)} cached in`,
  ];
  if (result.cacheWriteInputTokens) parts.push(`${formatTokens(result.cacheWriteInputTokens)} cache-write in`);
  parts.push(`${formatTokens(result.outputTokens)} out`);
  console.log(`~$${result.estimatedUsd.toFixed(2)} · ${result.pricedModel} · ${parts.join(' + ')} · API-equivalent, not billed`);
}

function help() {
  console.log(`Usage:
  statusline-codex.mjs install [--config PATH] [--dry-run] [--force]
  statusline-codex.mjs cost [--session FILE | --sessions DIR] [--cwd DIR] [--json]`);
}

export function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const command = args.shift();
  if (command === 'install') return install(args);
  if (command === 'cost') return cost(args);
  if (!command || command === '--help' || command === '-h') return help();
  throw new Error(`Unknown command: ${command}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`statusline: ${error.message}`);
    process.exitCode = /already has a different/.test(error.message) ? 2 : 1;
  }
}
