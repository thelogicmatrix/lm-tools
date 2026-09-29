// jevclassify's offline test, moved out of the script's --selftest branch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ATTEMPTS } from './lib.mjs'
import { hints, label } from './jevclassify.mjs'

// The child CLI run answers from a stub and must not enter the live spend ledger.
process.env.JEV_SPEND_DISABLED = '1'
const JEVCLASSIFY = fileURLToPath(new URL('./jevclassify.mjs', import.meta.url))

test('labels, and a whole run against a stub Forgejo with a flaky and a broken repo', async () => {
  assert.deepEqual(hints([{ name: 'private-name.kdbx' }]), ['KeePass database'])
  assert.equal(label({ empty: true }, {}).category, 'empty')
  assert.equal(label({ empty: false }, { choice: 'made_up', confidence: 1 }).category, 'unknown')
  assert.equal(label({ empty: false, failed: 'HTTP 500' }, { choice: 'tool', confidence: 1 }).category, 'unknown',
    'a repo whose read failed is unknown whatever the model says')

  // The whole run against a stub Forgejo on localhost. `flaky` answers 503 twice then 200 and
  // must be retried and classified. `broken` answers 500 every time and must come out unknown
  // while the run still completes. The Jev call is replaced by `--import`, and any other host
  // throws, so nothing leaves the machine.
  const hits = {}
  const repo = (name) => ({ name, owner: { login: 'o' }, empty: false, html_url: `http://forge.example/o/${name}`, description: `${name} repo` })
  const server = http.createServer((req, res) => {
    const u = req.url
    hits[u] = (hits[u] ?? 0) + 1
    const send = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    if (u.startsWith('/api/v1/user/repos')) return send(200, [repo('flaky'), repo('broken')])
    if (u === '/api/v1/repos/o/flaky/contents') return hits[u] <= 2 ? send(503, {}) : send(200, [{ name: 'package.json', type: 'file' }])
    return send(500, {})
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const host = `127.0.0.1:${server.address().port}`
  const dir = mkdtempSync(join(tmpdir(), 'jevclassify-'))
  const keys = JSON.stringify({ hosts: { [host]: { token: 'dummy-token' } } })
  for (const d of [join(dir, 'forgejo-cli', 'forgejo-cli', 'data'), join(dir, 'forgejo-cli')]) {
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'keys.json'), keys)
  }
  const asked = []
  const mock = `const real = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('http://${host}/')) return real(url, init);
  if (!String(url).startsWith('https://openrouter.ai/')) throw new Error('unexpected host ' + url);
  const q = Object.keys(JSON.parse(init.body).questions);
  console.error('ASKED ' + q.join(','));
  return new Response(JSON.stringify({ answers: Object.fromEntries(q.map((k) => [k, { choice: 'tool', confidence: 0.9 }])), usage: { cost: 0 } }));
};`
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(mock)}`, JEVCLASSIFY], {
    env: { ...process.env, FORGEJO_URL: `http://${host}`, OPENROUTER_API_KEY: 'dummy-not-a-key', APPDATA: dir, XDG_DATA_HOME: dir },
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d; asked.push(...[...String(d).matchAll(/ASKED (.*)/g)].map((m) => m[1])) })
  const code = await new Promise((r) => child.on('close', r))
  server.close()
  rmSync(dir, { recursive: true, force: true })
  assert.equal(code, 0, `a failed repo does not end the run: ${err.slice(-400)}`)
  assert.equal(hits['/api/v1/repos/o/flaky/contents'], 3, 'the 503s are retried until the 200')
  assert.equal(hits['/api/v1/repos/o/broken/contents'], ATTEMPTS, 'a permanent 500 uses its attempts and no more')
  assert.match(out, /\| \[flaky\]\(http:\/\/forge\.example\/o\/flaky\) \| Forgejo \| Public \| tool \| 0\.90 \| flaky repo, Node package \|/)
  assert.match(out, /\| \[broken\]\([^)]*\) \| Forgejo \| Public \| unknown \|  \| broken repo, read failed: Forgejo API HTTP 500/)
  assert.deepEqual(asked, ['r1'], 'only the repo that was read (flaky, r1 after the name sort) is put to Jev')
})
