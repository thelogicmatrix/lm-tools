// Retry-safe forge writes (#28): a write whose answer was lost, a write that never landed, a
// concurrent edit in another session, and a DELETE of a record already gone. The real CLI runs
// against a stub of the Forgejo contents API that checks the sha the way Forgejo does. A lost
// answer is a dropped connection after the stub applied the write: fetch rejects exactly as it
// does on a timeout, so both take the same path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'gtg', 'gtg.mjs');
const PATH = 'docs/handoffs/records/alpha.json';
const sha = (text) => createHash('sha1').update(text).digest('hex');
const file = (rec) => JSON.stringify(rec, null, 2) + '\n';
// Key order as gtg writes it, handoff last, so an unchanged record round-trips without a write.
const ALPHA = { slug: 'alpha', project: 'Alpha', shelf: 'active', next: 'Ship it', updated: '2026-09-28T10:00:00+00:00', sessions: 1, handoff: '## Next Action\nShip it\n' };
// What another session's handoff leaves in the record.
const THEIRS = { ...ALPHA, next: 'Their next', updated: '2026-09-28T12:00:00+00:00', sessions: 2, handoff: '## Next Action\nTheir next\n' };

// onWrite(method, path, stub) runs before each write is applied. It may edit stub.files (another
// session) and may return 'drop-before' (the write never lands) or 'drop-after' (it lands and the
// answer is lost).
async function stubStore(t, initial = {}) {
  const stub = { files: new Map(Object.entries(initial)), commits: 0, attempts: [], onWrite: null };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, 'http://stub');
    const p = decodeURIComponent(url.pathname.replace('/api/v1/repos/o/r', ''));
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const { files } = stub;
    if (req.method === 'GET' && p === '/git/trees/HEAD') {
      return send(200, { truncated: false, tree: [...files].map(([path, text]) => ({ path, type: 'blob', sha: sha(text) })) });
    }
    if (req.method === 'GET' && p === '/git/blobs') {
      return send(200, url.searchParams.get('shas').split(',').map((want) => {
        const text = [...files.values()].find((x) => sha(x) === want);
        return { sha: want, encoding: 'base64', content: Buffer.from(text).toString('base64') };
      }));
    }
    const path = p.replace('/contents/', '');
    if (req.method === 'GET') {
      const now = files.get(path);
      return now ? send(200, { sha: sha(now), content: Buffer.from(now).toString('base64'), html_url: `http://stub/${path}` })
        : send(404, { message: 'not found' });
    }
    stub.attempts.push(req.method);
    const fate = stub.onWrite?.(req.method, path, stub);
    if (fate === 'drop-before') return req.socket.destroy();
    const old = files.get(path);
    let status = 200; let out = {};
    if (req.method === 'DELETE') {
      if (!old) status = 404;
      else if (body.sha !== sha(old)) status = 409;
      else { files.delete(path); stub.commits++; }
    } else if (req.method === 'POST' && old) status = 422;
    else if (req.method === 'PUT' && (!old || body.sha !== sha(old))) status = 409;
    else {
      const text = Buffer.from(body.content, 'base64').toString('utf8');
      files.set(path, text); stub.commits++;
      out = { content: { sha: sha(text), html_url: `http://stub/${path}` } };
    }
    if (status !== 200) out = { message: status === 404 ? 'not found' : 'sha does not match' };
    if (fate === 'drop-after') return req.socket.destroy();
    send(status, out);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  stub.root = mkdtempSync(join(tmpdir(), 'gtg-write-'));
  mkdirSync(join(stub.root, '.gtg'));
  writeFileSync(join(stub.root, '.gtg', 'forge.json'), JSON.stringify({
    api: `http://127.0.0.1:${server.address().port}/api/v1`, repo: 'o/r', store: 'files',
  }));
  stub.run = (args, input = '') => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: stub.root,
      env: { ...process.env, GTG_HUB: stub.root, GTG_NO_SYNC: '1', GTG_SESSION_ID: 'write-test', FORGEJO_TOKEN: 'tok' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (x) => { stdout += x; });
    child.stderr.on('data', (x) => { stderr += x; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
  stub.record = () => JSON.parse(stub.files.get(PATH));
  return stub;
}
// Runs fn on the first write only.
const first = (fn) => { let done = false; return (...args) => { if (done) return undefined; done = true; return fn(...args); }; };
const theirHandoffLands = first((m, p, s) => { s.files.set(PATH, file(THEIRS)); });
const handoff = (stub, next) => stub.run(['handoff', '--project', 'Alpha', '--slug', 'alpha'], `## Next Action\n${next}\n`);
const savedBody = (stub) => readFileSync(join(stub.root, 'docs', 'handoffs', 'current', 'alpha.md'), 'utf8');

test('a PUT whose answer was lost after the server applied it succeeds without a resend: one commit', async (t) => {
  const stub = await stubStore(t, { [PATH]: file(ALPHA) });
  stub.onWrite = first(() => 'drop-after');
  const r = await handoff(stub, 'Ship more');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(stub.attempts, ['PUT']);
  assert.equal(stub.commits, 1);
  assert.match(stub.record().handoff, /Ship more/);
});

test('a POST whose answer was lost after the server applied it succeeds without a resend: one commit', async (t) => {
  const stub = await stubStore(t);
  stub.onWrite = first(() => 'drop-after');
  const r = await handoff(stub, 'First');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(stub.attempts, ['POST']);
  assert.equal(stub.commits, 1);
  assert.match(stub.record().handoff, /First/);
});

test('a write that never landed is read back, found unchanged, and sent once more', async (t) => {
  const stub = await stubStore(t, { [PATH]: file(ALPHA) });
  stub.onWrite = first(() => 'drop-before');
  const r = await handoff(stub, 'Ship more');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(stub.attempts, ['PUT', 'PUT']);
  assert.equal(stub.commits, 1);
  assert.match(stub.record().handoff, /Ship more/);
});

test('a write that never lands is sent at most twice, and the handoff body is kept on disk', async (t) => {
  const stub = await stubStore(t, { [PATH]: file(ALPHA) });
  stub.onWrite = () => 'drop-before';
  const r = await handoff(stub, 'Ship more');
  assert.equal(r.status, 1);
  assert.deepEqual(stub.attempts, ['PUT', 'PUT']);
  assert.equal(stub.commits, 0);
  assert.match(savedBody(stub), /Ship more/);
});

test('a concurrent edit to other fields is re-read and the edit re-applied once on top of it', async (t) => {
  const stub = await stubStore(t, { [PATH]: file(ALPHA) });
  stub.onWrite = theirHandoffLands; // between this command's read and its write
  const r = await stub.run(['back', 'alpha', '--no-list']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(stub.attempts, ['PUT', 'PUT'], 'one rejected PUT, one re-applied PUT');
  assert.equal(stub.commits, 1);
  const rec = stub.record();
  assert.equal(rec.shelf, 'backlog', 'our edit');
  assert.equal(rec.handoff, THEIRS.handoff, 'their edit survives');
  assert.equal(rec.next, THEIRS.next);
  assert.equal(rec.sessions, 2);
  assert.ok(rec.updated > THEIRS.updated, 'the later timestamp wins');
});

test('a concurrent edit to the same field is a clear error, their record is kept and our body saved', async (t) => {
  const stub = await stubStore(t, { [PATH]: file(ALPHA) });
  stub.onWrite = first((m, p, s) => { s.files.set(PATH, file(THEIRS)); });
  const r = await handoff(stub, 'Mine');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /alpha changed in another session .*handoff/);
  assert.deepEqual(stub.attempts, ['PUT']);
  assert.equal(stub.record().handoff, THEIRS.handoff);
  assert.match(savedBody(stub), /Mine/);
});

test('a record that changes again during the re-apply is a clear error after one re-apply', async (t) => {
  const stub = await stubStore(t, { [PATH]: file(ALPHA) });
  let n = 0;
  stub.onWrite = (m, p, s) => { n++; s.files.set(PATH, file({ ...THEIRS, sessions: 1 + n, handoff: `edit ${n}\n` })); };
  const r = await stub.run(['back', 'alpha', '--no-list']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /alpha changed in another session/);
  assert.deepEqual(stub.attempts, ['PUT', 'PUT']);
  assert.equal(stub.record().shelf, 'active');
});

test('DELETE of a record another session already deleted is success', async (t) => {
  const stub = await stubStore(t, { [PATH]: file(ALPHA) });
  stub.onWrite = (m, p, s) => { s.files.delete(PATH); };
  const r = await stub.run(['complete', 'alpha', '--no-list']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(stub.attempts, ['DELETE']);
  assert.equal(stub.files.size, 0);
});

test('a DELETE whose answer was lost is success, and one of a record changed since the read is refused', async (t) => {
  const lost = await stubStore(t, { [PATH]: file(ALPHA) });
  lost.onWrite = first(() => 'drop-after');
  const r = await lost.run(['complete', 'alpha', '--no-list']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lost.attempts, ['DELETE']);
  assert.equal(lost.commits, 1);

  const changed = await stubStore(t, { [PATH]: file(ALPHA) });
  changed.onWrite = first((m, p, s) => { s.files.set(PATH, file(THEIRS)); });
  const refused = await changed.run(['complete', 'alpha', '--no-list']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /alpha changed in another session/);
  assert.equal(changed.record().handoff, THEIRS.handoff, 'their handoff is not deleted');
  assert.equal(existsSync(join(changed.root, 'docs')), false);
});

test('a re-applied handoff is written once, and the flush after it finds nothing left to write', async (t) => {
  const stub = await stubStore(t, { [PATH]: file(ALPHA) });
  stub.onWrite = first((m, p, s) => { s.files.set(PATH, file({ ...ALPHA, eta: '2h' })); });
  const r = await handoff(stub, 'Mine');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(stub.attempts, ['PUT', 'PUT'], 'handoff flushes twice, the second one writes nothing');
  const rec = stub.record();
  assert.equal(rec.eta, '2h', 'their field survives');
  assert.match(rec.handoff, /Mine/);
});
