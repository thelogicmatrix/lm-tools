import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const PROGRESS_DIR = 'docs/handoffs/progress';
export const PROGRESS_VERSION = 1;
export const PROGRESS_STATES = Object.freeze([
  'pending', 'implementing', 'reviewing', 'blocked', 'done', 'skipped',
]);

const SLUG_OK = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const TASK_ID_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TASK_KEYS = new Set(['id', 'purpose']);
const RECORD_KEYS = new Set([
  'version', 'slug', 'project', 'plan', 'revision', 'stage', 'nextAction',
  'createdAt', 'updatedAt', 'tasks',
]);
const STORED_TASK_KEYS = new Set([
  'id', 'purpose', 'status', 'worker', 'role', 'model', 'effort',
  'evidence', 'note', 'updatedAt',
]);

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} must not contain control characters`);
  return value.trim();
}

function optionalText(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} must not contain control characters`);
  return value.trim();
}

export function validateProgressSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_OK.test(slug)) {
    throw new Error('slug must start with a letter or digit and match [A-Za-z0-9_-]');
  }
  return slug;
}

export function progressRelativePath(slug) {
  return `${PROGRESS_DIR}/${validateProgressSlug(slug)}.json`;
}

export function progressPath(root, slug) {
  return join(root, progressRelativePath(slug));
}

export function parseTaskDefinitions(text) {
  let input;
  try { input = JSON.parse(text); } catch (e) { throw new Error(`task definitions are not valid JSON - ${e.message}`); }
  return normalizeTaskDefinitions(input);
}

function normalizeTaskDefinitions(input) {
  if (!Array.isArray(input)) throw new Error('task definitions must be a JSON array');

  const seen = new Set();
  return input.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`task definition ${index + 1} must be an object`);
    }
    const unknown = Object.keys(raw).filter((key) => !TASK_KEYS.has(key));
    if (unknown.length) throw new Error(`task definition ${index + 1} has unknown field(s): ${unknown.join(', ')}`);
    const id = requiredText(raw.id, `task definition ${index + 1} id`);
    if (!TASK_ID_OK.test(id)) throw new Error(`task id ${JSON.stringify(id)} must match [A-Za-z0-9][A-Za-z0-9._-]*`);
    const identity = id.toLowerCase();
    if (seen.has(identity)) throw new Error(`duplicate task id ${JSON.stringify(id)} (task IDs are case-insensitive)`);
    seen.add(identity);
    return { id, purpose: requiredText(raw.purpose, `task ${id} purpose`) };
  });
}

function taskFromDefinition(definition, timestamp) {
  return {
    id: definition.id,
    purpose: definition.purpose,
    status: 'pending',
    worker: null,
    role: null,
    model: null,
    effort: null,
    evidence: null,
    note: null,
    updatedAt: timestamp,
  };
}

function writeAtomic(file, record) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, 'wx');
    writeFileSync(fd, JSON.stringify(record, null, 2) + '\n', 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) rmSync(temp);
  }
}

function withLockFile(lock, description, action) {
  mkdirSync(dirname(lock), { recursive: true });
  let fd;
  try {
    fd = openSync(lock, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n');
  } catch (e) {
    if (fd !== undefined) {
      try { closeSync(fd); } finally { rmSync(lock, { force: true }); }
    }
    if (e?.code === 'EEXIST') throw new Error(`${description} is locked; retry after the active writer finishes`);
    throw e;
  }
  try {
    return action();
  } finally {
    try { closeSync(fd); } finally { rmSync(lock, { force: true }); }
  }
}

export function withProgressLock(root, slug, action) {
  validateProgressSlug(slug);
  const file = progressPath(root, slug);
  return withLockFile(`${file}.lock`, `progress for ${slug}`, () => action(file));
}

function checkKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} has unknown field(s): ${unknown.join(', ')}`);
}

function nullableText(value, label) {
  if (value === null) return null;
  return requiredText(value, label);
}

function validTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
  return value;
}

export function validateProgressRecord(raw, expectedSlug) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('record must be an object');
    checkKeys(raw, RECORD_KEYS, 'record');
    if (raw.version !== PROGRESS_VERSION) throw new Error(`version must be ${PROGRESS_VERSION}`);
    const slug = validateProgressSlug(raw.slug);
    if (expectedSlug !== undefined && slug !== expectedSlug) {
      throw new Error(`record slug ${JSON.stringify(slug)} does not match filename slug ${JSON.stringify(expectedSlug)}`);
    }
    const project = requiredText(raw.project, 'project');
    const plan = requiredText(raw.plan, 'plan');
    if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) throw new Error('revision must be a positive integer');
    const stage = requiredText(raw.stage, 'stage');
    const nextAction = optionalText(raw.nextAction, 'nextAction');
    const createdAt = validTimestamp(raw.createdAt, 'createdAt');
    const updatedAt = validTimestamp(raw.updatedAt, 'updatedAt');
    if (!Array.isArray(raw.tasks)) throw new Error('tasks must be an array');
    const seen = new Set();
    const tasks = raw.tasks.map((task, index) => {
      if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error(`task ${index + 1} must be an object`);
      checkKeys(task, STORED_TASK_KEYS, `task ${index + 1}`);
      const id = requiredText(task.id, `task ${index + 1} id`);
      if (!TASK_ID_OK.test(id)) throw new Error(`task id ${JSON.stringify(id)} is unsafe`);
      const identity = id.toLowerCase();
      if (seen.has(identity)) throw new Error(`duplicate task id ${JSON.stringify(id)} (task IDs are case-insensitive)`);
      seen.add(identity);
      if (!PROGRESS_STATES.includes(task.status)) throw new Error(`task ${id} has unknown status ${JSON.stringify(task.status)}`);
      const evidence = nullableText(task.evidence, `task ${id} evidence`);
      const note = nullableText(task.note, `task ${id} note`);
      if (task.status === 'done' && !evidence) throw new Error(`task ${id} status done requires evidence`);
      if ((task.status === 'blocked' || task.status === 'skipped') && !note) {
        throw new Error(`task ${id} status ${task.status} requires a note`);
      }
      return {
        id,
        purpose: requiredText(task.purpose, `task ${id} purpose`),
        status: task.status,
        worker: nullableText(task.worker, `task ${id} worker`),
        role: nullableText(task.role, `task ${id} role`),
        model: nullableText(task.model, `task ${id} model`),
        effort: nullableText(task.effort, `task ${id} effort`),
        evidence,
        note,
        updatedAt: validTimestamp(task.updatedAt, `task ${id} updatedAt`),
      };
    });
    return {
      version: raw.version, slug, project, plan, revision: raw.revision, stage,
      nextAction, createdAt, updatedAt, tasks,
    };
  } catch (e) {
    throw new Error(`invalid progress record${expectedSlug ? ` for ${expectedSlug}` : ''} - ${e.message}`);
  }
}

export function readProgress(root, slug, { optional = false } = {}) {
  const file = progressPath(root, slug);
  if (!existsSync(file)) {
    if (optional) return null;
    throw new Error(`no progress record for ${slug}`);
  }
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    throw new Error(`cannot parse ${progressRelativePath(slug)} - ${e.message}`);
  }
  return validateProgressRecord(raw, slug);
}

function existingProgressSlugs(root) {
  const dir = join(root, PROGRESS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
}

export function listProgress(root) {
  const slugs = existingProgressSlugs(root).sort();
  const seen = new Set();
  return slugs.map((slug) => {
    const identity = slug.toLowerCase();
    if (seen.has(identity)) throw new Error(`progress slugs collide case-insensitively on ${JSON.stringify(slug)}`);
    seen.add(identity);
    return readProgress(root, slug);
  });
}

export function initializeProgress(root, { slug, project, plan, stage = 'planned', nextAction = '', tasks }) {
  validateProgressSlug(slug);
  const cleanTasks = Array.isArray(tasks)
    ? normalizeTaskDefinitions(tasks)
    : parseTaskDefinitions(String(tasks ?? ''));
  const projectName = requiredText(project, 'project');
  const planPath = requiredText(plan, 'plan');
  const stageName = requiredText(stage, 'stage');
  const cleanNextAction = optionalText(nextAction, 'next action');

  const directoryLock = join(root, PROGRESS_DIR, '.init.lock');
  return withLockFile(directoryLock, 'progress initialization', () => {
    const collision = existingProgressSlugs(root).find((candidate) => candidate.toLowerCase() === slug.toLowerCase());
    if (collision) throw new Error(`progress already exists for ${collision}; init will not overwrite it (slugs are case-insensitive)`);
    const file = progressPath(root, slug);
    const timestamp = new Date().toISOString();
    const record = {
      version: PROGRESS_VERSION,
      slug,
      project: projectName,
      plan: planPath,
      revision: 1,
      stage: stageName,
      nextAction: cleanNextAction,
      createdAt: timestamp,
      updatedAt: timestamp,
      tasks: cleanTasks.map((task) => taskFromDefinition(task, timestamp)),
    };
    writeAtomic(file, record);
    return record;
  });
}

function requireExpectedRevision(value) {
  const revision = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('expected revision must be a positive integer');
  return revision;
}

function checkRevision(record, expectedRevision) {
  const expected = requireExpectedRevision(expectedRevision);
  if (record.revision !== expected) {
    throw new Error(`revision conflict for ${record.slug}: expected ${expected}, current ${record.revision}`);
  }
}

export function updateProgress(root, slug, expectedRevision, changes) {
  validateProgressSlug(slug);
  requireExpectedRevision(expectedRevision);
  return withProgressLock(root, slug, (file) => {
    const record = readProgress(root, slug);
    checkRevision(record, expectedRevision);
    const hasProjectChange = changes.stage !== undefined || changes.nextAction !== undefined;
    const taskFields = ['status', 'worker', 'role', 'model', 'effort', 'evidence', 'note'];
    const hasTaskChange = taskFields.some((field) => changes[field] !== undefined);
    if (!hasProjectChange && !hasTaskChange) throw new Error('at least one update field is required');
    if (!changes.taskId && hasTaskChange) throw new Error('task fields require a task id');

    const timestamp = new Date().toISOString();
    if (changes.stage !== undefined) record.stage = requiredText(changes.stage, 'stage');
    if (changes.nextAction !== undefined) {
      record.nextAction = optionalText(changes.nextAction, 'next action');
    }
    if (changes.taskId) {
      const task = record.tasks.find((candidate) => candidate.id === changes.taskId);
      if (!task) throw new Error(`unknown task id ${JSON.stringify(changes.taskId)}`);
      if (changes.status !== undefined && !PROGRESS_STATES.includes(changes.status)) {
        throw new Error(`unknown status ${JSON.stringify(changes.status)}; expected ${PROGRESS_STATES.join(', ')}`);
      }
      const incomingNote = changes.note === undefined ? undefined : requiredText(changes.note, 'note');
      if (changes.status === 'done' && !(changes.evidence ?? task.evidence)) {
        throw new Error('status done requires an evidence note via --evidence');
      }
      if ((changes.status === 'blocked' || changes.status === 'skipped') && !incomingNote) {
        throw new Error(`status ${changes.status} requires a reason via --note`);
      }
      if ((task.status === 'done' || task.status === 'skipped')
          && changes.status !== undefined && changes.status !== task.status && !incomingNote) {
        throw new Error(`reopening a ${task.status} task requires a reason via --note`);
      }
      if (changes.status !== undefined) task.status = changes.status;
      for (const field of ['worker', 'role', 'model', 'effort', 'evidence']) {
        if (changes[field] !== undefined) task[field] = requiredText(changes[field], field);
      }
      if (incomingNote !== undefined) task.note = incomingNote;
      task.updatedAt = timestamp;
    }
    record.revision += 1;
    record.updatedAt = timestamp;
    writeAtomic(file, record);
    return record;
  });
}

export function addProgressTasks(root, slug, expectedRevision, definitions) {
  validateProgressSlug(slug);
  requireExpectedRevision(expectedRevision);
  const cleanDefinitions = normalizeTaskDefinitions(definitions);
  return withProgressLock(root, slug, (file) => {
    const record = readProgress(root, slug);
    checkRevision(record, expectedRevision);
    const existing = new Set(record.tasks.map((task) => task.id.toLowerCase()));
    for (const definition of cleanDefinitions) {
      if (existing.has(definition.id.toLowerCase())) throw new Error(`task id ${JSON.stringify(definition.id)} already exists`);
      existing.add(definition.id.toLowerCase());
    }
    const timestamp = new Date().toISOString();
    record.tasks.push(...cleanDefinitions.map((definition) => taskFromDefinition(definition, timestamp)));
    record.revision += 1;
    record.updatedAt = timestamp;
    writeAtomic(file, record);
    return record;
  });
}

export function summarizeProgress(record) {
  const completed = record.tasks.filter((task) => task.status === 'done').length;
  const skipped = record.tasks.filter((task) => task.status === 'skipped').length;
  return {
    slug: record.slug,
    project: record.project,
    plan: record.plan,
    stage: record.stage,
    revision: record.revision,
    completed,
    total: record.tasks.length,
    skipped,
    nextAction: record.nextAction,
  };
}

export function renderProgress(record) {
  const summary = summarizeProgress(record);
  const lines = [
    `${record.project} [${record.slug}] - revision ${record.revision}`,
    `Plan: ${record.plan}`,
    `Stage: ${record.stage}`,
    `Completed: ${summary.completed}/${summary.total} · skipped: ${summary.skipped}`,
  ];
  const active = record.tasks.filter((task) => ['implementing', 'reviewing'].includes(task.status));
  if (active.length) {
    lines.push('In-progress records (worker references are historical; live status is not checked):');
    for (const task of active) {
      const details = [task.worker, task.role, task.model && task.effort ? `${task.model}/${task.effort}` : task.model || task.effort]
        .filter(Boolean).join(' · ');
      lines.push(`- ${task.id}: ${task.status}${details ? ` · ${details}` : ''} - ${task.purpose}`);
    }
  }
  const blockers = record.tasks.filter((task) => task.status === 'blocked');
  if (blockers.length) {
    lines.push('Blockers:');
    for (const task of blockers) lines.push(`- ${task.id}: ${task.note}`);
  }
  lines.push(`Next action: ${record.nextAction || '(none)'}`);
  return lines.join('\n');
}

export function renderProgressTaskList(record) {
  return record.tasks.map((task) => `- [${task.status}] ${task.id}: ${task.purpose}`).join('\n');
}
