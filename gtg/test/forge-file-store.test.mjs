import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'gtg', 'gtg.mjs');
const sha = (text) => createHash('sha1').update(text).digest('hex');

test('file store handoff, resume, shelf move and complete use versioned files only', async (t) => {
  const files = new Map();
  let writes = 0;
  let race = false;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    const path = decodeURIComponent(new URL(req.url, 'http://stub').pathname.replace('/api/v1/repos/o/r/contents/', ''));
    const send = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    assert.equal(req.headers.authorization, 'token tok');
    if (req.method === 'GET' && path === '/api/v1/repos/o/r') return send(200, {});
    if (req.method === 'GET' && path === 'docs/handoffs/records') {
      const names = [...files.keys()].filter((x) => x.startsWith('docs/handoffs/records/'))
        .map((x) => ({ name: x.split('/').at(-1), sha: sha(files.get(x)) }));
      return names.length ? send(200, names) : send(404, { message: 'missing directory' });
    }
    const old = files.get(path);
    if (req.method === 'GET') {
      if (!old) return send(404, { message: 'missing' });
      const snapshot = { sha: sha(old), content: Buffer.from(old).toString('base64') };
      if (race && path === 'docs/handoffs/records/alpha.json') {
        files.set(path, JSON.stringify({ ...JSON.parse(old), handoff: 'another machine wrote this' }));
      }
      return send(200, snapshot);
    }
    writes++;
    if (req.method === 'DELETE') {
      if (!old || body.sha !== sha(old)) return send(409, { message: 'stale' });
      files.delete(path); return send(200, {});
    }
    if ((req.method === 'POST' && old) || (req.method === 'PUT' && (!old || body.sha !== sha(old)))) {
      return send(409, { message: 'stale' });
    }
    const text = Buffer.from(body.content, 'base64').toString('utf8');
    files.set(path, text);
    return send(200, { content: { sha: sha(text), html_url: `http://stub/${path}` } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const root = mkdtempSync(join(tmpdir(), 'gtg-files-'));
  mkdirSync(join(root, '.gtg'));
  writeFileSync(join(root, '.gtg', 'forge.json'), JSON.stringify({
    api: `http://127.0.0.1:${server.address().port}/api/v1`, repo: 'o/r', store: 'files',
  }));
  const run = (args, input = '') => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: root,
      env: { ...process.env, GTG_HUB: root, GTG_NO_SYNC: '1', GTG_SESSION_ID: 'file-test', FORGEJO_TOKEN: 'tok' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (x) => { stdout += x; });
    child.stderr.on('data', (x) => { stderr += x; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
  const handoff = await run(['handoff', '--project', 'Alpha', '--slug', 'alpha'], '## Next Action\nShip it\n');
  assert.equal(handoff.status, 0, handoff.stderr);
  assert.match(handoff.stdout, /docs\/handoffs\/records\/alpha.json/);
  assert.match(JSON.parse(files.get('docs/handoffs/records/alpha.json')).handoff, /Ship it/);
  assert.equal(JSON.parse(files.get('docs/handoffs/records/alpha.json')).shelf, 'active');
  assert.equal([...files.keys()].length, 1);
  const beforeRead = writes;
  const resumed = await run(['resume', 'alpha']);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /Ship it/);
  assert.match(resumed.stdout, /docs\/handoffs\/records\/alpha.json/);
  assert.equal(writes, beforeRead);
  const second = await run(['handoff', '--project', 'Alpha', '--slug', 'alpha'], '## Next Action\nShip more\n');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(files.size, 1);
  assert.match(JSON.parse(files.get('docs/handoffs/records/alpha.json')).handoff, /Ship more/);
  race = true;
  const conflict = await run(['handoff', '--project', 'Alpha', '--slug', 'alpha'], '## Next Action\nStale update\n');
  race = false;
  assert.equal(conflict.status, 1);
  assert.equal(JSON.parse(files.get('docs/handoffs/records/alpha.json')).handoff, 'another machine wrote this');
  assert.equal(JSON.parse(files.get('docs/handoffs/records/alpha.json')).next, 'Ship more');
  const back = await run(['back', 'alpha', '--no-list']);
  assert.equal(back.status, 0, back.stderr);
  assert.equal(JSON.parse(files.get('docs/handoffs/records/alpha.json')).shelf, 'backlog');
  const renamed = await run(['rename', 'alpha', 'beta', '--name', 'Beta', '--no-list']);
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.equal(JSON.parse(files.get('docs/handoffs/records/alpha.json')).slug, 'beta');
  assert.equal(JSON.parse(files.get('docs/handoffs/records/alpha.json')).handoff, 'another machine wrote this');
  assert.equal(files.size, 1);
  assert.match((await run(['resume', 'beta'])).stdout, /another machine wrote this/);
  const done = await run(['complete', 'beta', '--no-list']);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(files.size, 0);
  assert.match((await run(['list'])).stdout, /No active gtg projects/);
});
