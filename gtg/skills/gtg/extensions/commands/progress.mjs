import { readFileSync } from 'node:fs';
import {
  addProgressTasks,
  initializeProgress,
  listProgress,
  parseTaskDefinitions,
  progressRelativePath,
  readProgress,
  renderProgress,
  summarizeProgress,
  updateProgress,
} from '../../lib/progress.mjs';

const USAGE = `Usage:
  gtg progress init <slug> --project <name> --plan <path> [--stage <text>] [--next-action <text>]  (task JSON array on stdin)
  gtg progress add <slug> --expected-revision <n>  (task JSON array on stdin)
  gtg progress show <slug> [--json]
  gtg progress list [--json]
  gtg progress update <slug> [<task-id>] --expected-revision <n> [--status <state>] [--worker <id>] [--role <role>] [--model <model>] [--effort <effort>] [--evidence <note>] [--note <reason>] [--stage <text>] [--next-action <text>]`;

function usage(message) {
  if (message) console.error(`gtg progress: ${message}`);
  console.error(USAGE);
  process.exitCode = 2;
}

function parseOptions(argv, allowed) {
  const values = {
    project: undefined, plan: undefined, stage: undefined, nextAction: undefined,
    expectedRevision: undefined, status: undefined, worker: undefined, role: undefined,
    model: undefined, effort: undefined, evidence: undefined, note: undefined, json: false,
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!flag.startsWith('--')) return { error: `unexpected argument ${JSON.stringify(flag)}` };
    if (!allowed.has(flag)) return { error: `unknown flag ${flag}` };
    if (seen.has(flag)) return { error: `duplicate flag ${flag}` };
    seen.add(flag);
    if (flag === '--json') { values.json = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${flag} needs a value` };
    if (flag === '--project') values.project = value;
    else if (flag === '--plan') values.plan = value;
    else if (flag === '--stage') values.stage = value;
    else if (flag === '--next-action') values.nextAction = value;
    else if (flag === '--expected-revision') values.expectedRevision = value;
    else if (flag === '--status') values.status = value;
    else if (flag === '--worker') values.worker = value;
    else if (flag === '--role') values.role = value;
    else if (flag === '--model') values.model = value;
    else if (flag === '--effort') values.effort = value;
    else if (flag === '--evidence') values.evidence = value;
    else if (flag === '--note') values.note = value;
    i += 1;
  }
  return values;
}

function init(root, argv, commit) {
  const slug = argv[0];
  if (!slug || slug.startsWith('--')) return usage('init needs a slug');
  const options = parseOptions(argv.slice(1), new Set(['--project', '--plan', '--stage', '--next-action']));
  if (options.error) return usage(options.error);
  if (!options.project) return usage('missing --project');
  if (!options.plan) return usage('missing --plan');
  const tasks = parseTaskDefinitions(readFileSync(0, 'utf8'));
  const record = initializeProgress(root, {
    slug, project: options.project, plan: options.plan,
    stage: options.stage ?? 'planned', nextAction: options.nextAction ?? '', tasks,
  });
  commit([progressRelativePath(record.slug)], `gtg progress: initialize ${record.project}`);
  console.log(`Initialized ${record.project} progress at revision ${record.revision}.`);
}

function add(root, argv, commit) {
  const slug = argv[0];
  if (!slug || slug.startsWith('--')) return usage('add needs a slug');
  const options = parseOptions(argv.slice(1), new Set(['--expected-revision']));
  if (options.error) return usage(options.error);
  if (options.expectedRevision === undefined) return usage('missing --expected-revision');
  const tasks = parseTaskDefinitions(readFileSync(0, 'utf8'));
  if (!tasks.length) return usage('add needs at least one task definition');
  const record = addProgressTasks(root, slug, options.expectedRevision, tasks);
  commit([progressRelativePath(record.slug)], `gtg progress: add tasks to ${record.project}`);
  console.log(`Added ${tasks.length} task${tasks.length === 1 ? '' : 's'} to ${record.project}; revision ${record.revision}.`);
}

function show(root, argv) {
  const slug = argv[0];
  if (!slug || slug.startsWith('--')) return usage('show needs a slug');
  const options = parseOptions(argv.slice(1), new Set(['--json']));
  if (options.error) return usage(options.error);
  const record = readProgress(root, slug);
  console.log(options.json ? JSON.stringify(record, null, 2) : renderProgress(record));
}

function list(root, argv) {
  const options = parseOptions(argv, new Set(['--json']));
  if (options.error) return usage(options.error);
  const summaries = listProgress(root).map(summarizeProgress);
  if (options.json) { console.log(JSON.stringify(summaries, null, 2)); return; }
  if (!summaries.length) { console.log('No progress records.'); return; }
  for (const item of summaries) {
    console.log(`${item.project} [${item.slug}] - ${item.stage} - ${item.completed}/${item.total} done · ${item.skipped} skipped · revision ${item.revision}`);
    console.log(`  plan: ${item.plan}`);
    console.log(`  next: ${item.nextAction || '(none)'}`);
  }
}

function update(root, argv, commit) {
  const slug = argv[0];
  if (!slug || slug.startsWith('--')) return usage('update needs a slug');
  let offset = 1;
  let taskId;
  if (argv[offset] && !argv[offset].startsWith('--')) { taskId = argv[offset]; offset += 1; }
  const options = parseOptions(argv.slice(offset), new Set([
    '--expected-revision', '--status', '--worker', '--role', '--model', '--effort',
    '--evidence', '--note', '--stage', '--next-action',
  ]));
  if (options.error) return usage(options.error);
  if (options.expectedRevision === undefined) return usage('missing --expected-revision');
  const record = updateProgress(root, slug, options.expectedRevision, {
    taskId, status: options.status, worker: options.worker, role: options.role,
    model: options.model, effort: options.effort, evidence: options.evidence,
    note: options.note, stage: options.stage, nextAction: options.nextAction,
  });
  commit([progressRelativePath(record.slug)], `gtg progress: update ${record.project} to revision ${record.revision}`);
  console.log(`Updated ${record.project} progress to revision ${record.revision}.`);
}

export default ({ root, args, commit }) => {
  const [verb, ...rest] = args ?? [];
  if (verb === 'init') return init(root, rest, commit);
  if (verb === 'add') return add(root, rest, commit);
  if (verb === 'show') return show(root, rest);
  if (verb === 'list') return list(root, rest);
  if (verb === 'update') return update(root, rest, commit);
  return usage(`unknown verb ${JSON.stringify(verb ?? '')}`);
};
