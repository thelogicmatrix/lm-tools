// The forge store, end to end: the real CLI against an in-process stub of the Forgejo/Gitea
// endpoints gtg calls. spawn, not spawnSync, because a sync child blocks the event loop the stub
// server needs to answer on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'gtg', 'gtg.mjs');
const BODY = '## Where We Stopped\nStub work.\n\n## Next Action\nWrite the next thing\n';

// Just the routes gtg uses, with the query filters it relies on.
async function stubForge() {
  const db = { milestones: [], issues: [], comments: {}, labels: [], seq: 1, auth: new Set(), fail: null, writes: 0 };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    db.auth.add(req.headers.authorization);
    if (req.method !== 'GET') db.writes++;
    const url = new URL(req.url, 'http://stub');
    const p = url.pathname.replace('/api/v1/repos/o/r', '');
    const q = url.searchParams;
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (db.fail && db.fail(req.method, p)) return send(500, { message: 'stub failure' });
    const page = (arr) => { const n = +(q.get('page') || 1); const l = +(q.get('limit') || 50); return arr.slice((n - 1) * l, n * l); };
    const key = `${req.method} ${p}`;
    let m;
    if (key === 'GET /milestones') return send(200, page(db.milestones.filter((x) => x.state === (q.get('state') || 'open'))));
    if (key === 'POST /milestones') {
      const x = { id: db.seq++, title: body.title, description: body.description ?? '', state: 'open' };
      db.milestones.push(x); return send(201, x);
    }
    if (req.method === 'PATCH' && (m = p.match(/^\/milestones\/(\d+)$/))) {
      const x = db.milestones.find((y) => y.id === +m[1]);
      Object.assign(x, body, body.description ? { description: body.description.trimEnd() } : {});
      return send(200, x);
    }
    if (key === 'GET /labels') return send(200, page(db.labels));
    if (key === 'POST /labels') { const x = { id: db.seq++, ...body }; db.labels.push(x); return send(201, x); }
    if (key === 'GET /issues') {
      return send(200, page(db.issues.filter((i) => i.state === q.get('state') && String(i.milestone) === q.get('milestones'))));
    }
    if (key === 'POST /issues') {
      const x = { number: db.seq++, title: body.title, body: body.body, state: 'open', milestone: body.milestone, labels: body.labels ?? [] };
      db.issues.push(x); db.comments[x.number] = []; return send(201, x);
    }
    if (req.method === 'PATCH' && (m = p.match(/^\/issues\/(\d+)$/))) {
      const x = db.issues.find((i) => i.number === +m[1]); Object.assign(x, body); return send(200, x);
    }
    if ((m = p.match(/^\/issues\/(\d+)\/comments$/))) {
      if (req.method === 'GET') return send(200, db.comments[m[1]]);
      const x = { id: db.seq++, body: body.body, html_url: `http://stub/o/r/issues/${m[1]}#c${db.seq}` };
      db.comments[m[1]].push(x); return send(201, x);
    }
    send(404, { message: `stub has no route for ${key}` });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  db.api = `http://127.0.0.1:${server.address().port}/api/v1`;
  db.close = () => server.close();
  return db;
}

function hub(db, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gtg-forge-'));
  mkdirSync(join(root, '.gtg'));
  writeFileSync(join(root, '.gtg', 'forge.json'), JSON.stringify({ api: db.api, repo: 'o/r', ...extra }));
  return root;
}

function gtg(root, args, { input = '', env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: root,
      env: { ...process.env, GTG_HUB: root, GTG_NO_SYNC: '1', GTG_SESSION_ID: 'forge-test', GIT_CEILING_DIRECTORIES: tmpdir(), FORGEJO_TOKEN: 'tok', ...env },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

const record = (ms) => JSON.parse(ms.description.match(/```json gtg\n([\s\S]*?)\n```/)[1]);
const handoff = (root, body = BODY) => gtg(root, ['handoff', '--project', 'Alpha', '--slug', 'alpha'], { input: body });

test('handoff creates one milestone, one labelled tracking issue and a comment, and writes no files', async (t) => {
  const db = await stubForge(); t.after(db.close);
  const root = hub(db);
  const r = await handoff(root);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RESUME: "gtg alpha"/);
  assert.match(r.stdout, /http:\/\/stub\/o\/r\/issues\/\d+#c/);

  assert.equal(db.milestones.length, 1);
  const [ms] = db.milestones;
  assert.equal(ms.title, 'Alpha');
  assert.match(ms.description, /^Write the next thing\n/);
  const rec = record(ms);
  assert.equal(rec.slug, 'alpha');
  assert.equal(rec.shelf, 'active');
  assert.equal(rec.sessions, 1);
  assert.equal(rec.file, undefined);
  const [issue] = db.issues;
  assert.equal(rec.issue, issue.number);
  assert.equal(issue.milestone, ms.id);
  assert.deepEqual(issue.labels, [db.labels.find((l) => l.name === 'gtg').id]);
  assert.equal(db.comments[issue.number].length, 1);
  assert.match(db.comments[issue.number][0].body, /^# Handoff: Alpha/);
  assert.equal(existsSync(join(root, 'docs')), false, 'the file store must stay untouched');
  assert.deepEqual([...db.auth], ['token tok']);
});

test('a second handoff updates the same milestone, resume prints the latest comment and the open task issues', async (t) => {
  const db = await stubForge(); t.after(db.close);
  const root = hub(db);
  assert.equal((await handoff(root)).status, 0);
  assert.equal((await handoff(root, BODY.replace('Write the next thing', 'Ship it'))).status, 0);
  assert.equal(db.milestones.length, 1);
  assert.equal(db.issues.length, 1);
  assert.equal(record(db.milestones[0]).sessions, 2);
  const tracking = db.issues[0].number;
  assert.equal(db.comments[tracking].length, 2);

  // A task is an ordinary issue in the milestone, filed however agents file issues.
  db.issues.push({ number: 99, title: 'Fix the widget', state: 'open', milestone: db.milestones[0].id });
  db.issues.push({ number: 98, title: 'Closed task', state: 'closed', milestone: db.milestones[0].id });

  const writes = db.writes;
  const r = await gtg(root, ['resume', 'alpha']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`RESUME: "Alpha" - handoff of .* \\(tracking issue #${tracking}\\)`));
  assert.match(r.stdout, /## Next Action\nShip it/);
  assert.doesNotMatch(r.stdout, /Write the next thing/);
  assert.match(r.stdout, /Open issues in this milestone:\n- #99 Fix the widget/);
  assert.doesNotMatch(r.stdout, /Closed task/);

  const list = await gtg(root, ['list']);
  assert.match(list.stdout, /1 active gtg project:/);
  assert.match(list.stdout, /Alpha s2/);
  assert.match(list.stdout, /→ Ship it/);
  // The stub trims what it stores, as a server may, so this also proves the change check compares
  // records rather than the server's echo of them.
  assert.equal(db.writes, writes, 'resume and list must not write');
});

test('back and active move the shelf inside one open milestone, complete closes milestone and issue', async (t) => {
  const db = await stubForge(); t.after(db.close);
  const root = hub(db);
  assert.equal((await handoff(root)).status, 0);

  assert.equal((await gtg(root, ['back', 'alpha', '--no-list'])).status, 0);
  assert.equal(record(db.milestones[0]).shelf, 'backlog');
  assert.equal(db.milestones[0].state, 'open');
  assert.match((await gtg(root, ['list'])).stdout, /No active gtg projects\. \(\+1 backlogged/);
  assert.match((await gtg(root, ['backlog'])).stdout, /b1\. Alpha/);

  assert.equal((await gtg(root, ['active', 'alpha', '--no-list'])).status, 0);
  assert.equal(record(db.milestones[0]).shelf, 'active');

  const done = await gtg(root, ['complete', 'alpha', '--no-list']);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(db.milestones[0].state, 'closed');
  assert.equal(db.issues[0].state, 'closed');
  assert.match(db.comments[db.issues[0].number].at(-1).body, /Closed by `gtg complete`/);
  assert.match((await gtg(root, ['list'])).stdout, /No active gtg projects\./);
});

test('rename keeps the milestone and moves its title and slug', async (t) => {
  const db = await stubForge(); t.after(db.close);
  const root = hub(db);
  assert.equal((await handoff(root)).status, 0);
  const r = await gtg(root, ['rename', 'alpha', 'beta', '--name', 'Beta', '--no-list']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(db.milestones.length, 1);
  assert.equal(db.milestones[0].state, 'open');
  assert.equal(db.milestones[0].title, 'Beta');
  assert.equal(record(db.milestones[0]).slug, 'beta');
  assert.deepEqual(record(db.milestones[0]).aka, ['Alpha']);
});

test('a milestone gtg did not write is ignored, and a read-only command writes nothing', async (t) => {
  const db = await stubForge(); t.after(db.close);
  db.milestones.push({ id: 500, title: 'v2.0 release', description: 'Ship it', state: 'open' });
  const root = hub(db);
  const r = await gtg(root, ['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No active gtg projects\./);
  assert.equal(db.milestones[0].description, 'Ship it');
  assert.equal(db.milestones.length, 1);
});

test('a failed comment post saves the handoff body to a file and exits 1', async (t) => {
  const db = await stubForge(); t.after(db.close);
  db.fail = (method, p) => method === 'POST' && /\/comments$/.test(p);
  const root = hub(db);
  const r = await handoff(root);
  assert.equal(r.status, 1);
  assert.equal(r.stderr.match(/forge write failed/g)?.length, 1, r.stderr);
  assert.doesNotMatch(r.stderr, /tok/, 'the token never reaches output');
  assert.match(readFileSync(join(root, 'docs/handoffs/current/alpha.md'), 'utf8'), /## Next Action\nWrite the next thing/);
});

test('config without a token is refused, a token file is read, and history commands are refused', async (t) => {
  const db = await stubForge(); t.after(db.close);
  const root = hub(db);
  const none = await gtg(root, ['list'], { env: { FORGEJO_TOKEN: '' } });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /no token/);

  // forgejo-cli's keys.json shape, keyed by the api's host.
  const keys = join(root, 'keys.json');
  writeFileSync(keys, JSON.stringify({ hosts: { [new URL(db.api).host]: { type: 'Application', token: 'fromfile' } } }));
  const fileRoot = hub(db, { tokenFile: '${GTG_TEST_KEYS}' });
  const ok = await gtg(fileRoot, ['list'], { env: { FORGEJO_TOKEN: '', GTG_TEST_KEYS: keys } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(db.auth.has('token fromfile'));

  for (const cmd of ['log', 'undo', 'stats', 'report']) {
    const r = await gtg(root, [cmd]);
    assert.equal(r.status, 2, cmd);
    assert.match(r.stderr, /not available on the forge store/, cmd);
  }
});
