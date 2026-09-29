// Optional forge store: each gtg project is one JSON file under docs/handoffs/records/ in a
// dedicated Forgejo/Gitea repository, record and current handoff together. Design:
// references/forge-store.md. The milestone store (a project as a milestone, handoffs as issue
// comments) was removed on 2026-09-29 (#31): nothing used it.
//
// The CLI's store calls are synchronous (entries/saveEntries) and HTTP is not, so this loads every
// record once, lets the command edit the in-memory copy exactly as it edits the file store, and
// writes the difference in flush(). A separate module rather than a branch in lib/store.mjs,
// because that file must stay byte-identical in code to the logical-projects plugin's copy.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// null = no forge configured, the file store runs exactly as before.
export function forgeConfig(root, env = process.env) {
  const p = join(root, '.gtg', 'forge.json');
  if (!existsSync(p)) return null;
  let cfg;
  try { cfg = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw new Error(`cannot parse .gtg/forge.json - ${e.message}`); }
  if (typeof cfg.api !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(cfg.repo ?? '')) {
    throw new Error('.gtg/forge.json needs "api" (the /api/v1 URL) and "repo" (owner/name)');
  }
  if (cfg.store !== 'files') throw new Error('.gtg/forge.json needs "store": "files". The milestone store was removed');
  const token = env.FORGEJO_TOKEN || readToken(cfg, env);
  if (!token) throw new Error('.gtg/forge.json is set but there is no token: set FORGEJO_TOKEN or "tokenFile"');
  return { api: cfg.api.replace(/\/+$/, ''), repo: cfg.repo, token };
}

// A bare token file, or forgejo-cli's keys.json ({ hosts: { "<host:port>": { token } } }).
function readToken(cfg, env) {
  if (typeof cfg.tokenFile !== 'string') return '';
  const path = cfg.tokenFile.replace(/\$\{(\w+)\}/g, (_, k) => env[k] ?? '');
  if (!existsSync(path)) return '';
  const text = readFileSync(path, 'utf8').trim();
  if (!text.startsWith('{')) return text;
  try { return JSON.parse(text)?.hosts?.[new URL(cfg.api).host]?.token ?? ''; } catch { return ''; }
}

// Reads are retried, writes never are: a PUT or POST that timed out may have landed, and sending it
// again would double it or trip the SHA check. 2026-09-29: with a dozen gtg processes starting at
// once (session hooks, parallel sessions) one slow GET of 15 aborted the whole read. Three tries of
// 8s each, since a healthy call takes under a second.
const RETRIES = 3;
async function send(fetchImpl, url, init) {
  const read = init.method === 'GET';
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(read ? 8000 : 15000) });
      if (!read || res.status < 500 || attempt === RETRIES) return res;
    } catch (e) {
      if (!read || attempt === RETRIES) throw e;
    }
    await new Promise((r) => setTimeout(r, 300 * attempt));
  }
}

const RECORDS = 'docs/handoffs/records/';

// Every record file in a "store": "files" repo as { name, sha, text }, from the git tree and one
// batch of blobs. 2026-09-29 (#27): the contents listing costs the server a last-commit lookup per
// entry, 525 to 618 ms of a 900 ms run at 14 records, and the tree costs about 40 ms. The blob sha
// is the sha the contents API checks on PUT and DELETE. The listing is only the fallback, for a
// truncated tree or a repo with no commit yet. Exported for hooks that only need to read the store.
export async function readFileRecords(cfg, fetchImpl = fetch) {
  const get = async (path) => {
    const res = await send(fetchImpl, `${cfg.api}/repos/${cfg.repo}${path}`, {
      method: 'GET', headers: { Authorization: `token ${cfg.token}`, Accept: 'application/json' },
    });
    if (!res.ok) res.error = `forge GET ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`;
    return res;
  };
  let files;
  const tree = await get('/git/trees/HEAD?recursive=true');
  if (tree.ok) {
    const t = await tree.json();
    if (!t.truncated) {
      files = t.tree.filter((e) => e.type === 'blob' && e.path.startsWith(RECORDS) && e.path.endsWith('.json')
        && !e.path.slice(RECORDS.length).includes('/')).map((e) => ({ name: e.path.slice(RECORDS.length), sha: e.sha }));
    }
  } else if (tree.status >= 500) throw new Error(tree.error);
  if (!files) {
    const names = await get(`/contents/${RECORDS.slice(0, -1)}`);
    if (names.status === 404) {
      const repo = await get('');
      if (!repo.ok) throw new Error(`forge GET repo ${cfg.repo} -> ${repo.status}`);
      files = [];
    } else if (!names.ok) throw new Error(names.error);
    else files = (await names.json()).filter((f) => f.name?.endsWith('.json'));
  }
  // Forgejo's GetBlobs takes a comma list of shas, 40 of them keep the URL under its ~2000 character
  // limit. A server without that route (Gitea) answers 404 and gets one GET per blob instead.
  const shas = [...new Set(files.map((f) => f.sha))];
  const content = new Map();
  const one = async (sha) => {
    const blob = await get(`/git/blobs/${sha}`);
    if (!blob.ok) throw new Error(blob.error);
    content.set(sha, (await blob.json()).content);
  };
  await Promise.all(Array.from({ length: Math.ceil(shas.length / 40) }, async (_, i) => {
    const chunk = shas.slice(i * 40, i * 40 + 40);
    const batch = await get(`/git/blobs?shas=${chunk.join(',')}`);
    if (batch.status === 404) return Promise.all(chunk.map(one));
    if (!batch.ok) throw new Error(batch.error);
    for (const b of await batch.json()) content.set(b.sha, b.content);
  }));
  return files.map((f) => {
    if (!content.has(f.sha)) throw new Error(`forge GET blob ${f.sha} for ${RECORDS}${f.name} -> missing`);
    return { name: f.name, sha: f.sha, text: Buffer.from(content.get(f.sha).replace(/\s/g, ''), 'base64').toString('utf8') };
  });
}

// One JSON file contains both record and current handoff. One SHA-protected PUT changes both.
export async function openForge(cfg, fetchImpl = fetch) {
  const sourceSlug = Symbol('gtg-file-source-slug');
  const base = `${cfg.api}/repos/${cfg.repo}/contents/`;
  const records = RECORDS;
  const call = async (method, path, body) => {
    const res = await send(fetchImpl, base + path, {
      method,
      headers: { Authorization: `token ${cfg.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`forge ${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  };
  const loaded = (await readFileRecords(cfg, fetchImpl)).map((f) => {
    let rec;
    try { rec = JSON.parse(f.text); } catch (e) { throw new Error(`cannot parse ${records}${f.name} - ${e.message}`); }
    if (typeof rec.slug !== 'string' || !['active', 'backlog'].includes(rec.shelf)
      || (rec.handoff !== undefined && typeof rec.handoff !== 'string')) {
      throw new Error(`invalid gtg record at ${records}${f.name}`);
    }
    return { rec, sha: f.sha, fileSlug: f.name.slice(0, -5) };
  });
  const saved = new Map(loaded.map(({ rec, sha, fileSlug }) => [fileSlug, { rec: JSON.stringify(rec), sha }]));
  const bodyBySlug = new Map(loaded.map(({ rec, fileSlug }) => [fileSlug, rec.handoff]));
  const entry = (rec, fileSlug) => { const { handoff, ...rest } = rec; return { ...rest, file: undefined, [sourceSlug]: fileSlug }; };
  const shelves = {
    active: loaded.filter(({ rec }) => rec.shelf === 'active').map(({ rec, fileSlug }) => entry(rec, fileSlug)),
    backlog: loaded.filter(({ rec }) => rec.shelf === 'backlog').map(({ rec, fileSlug }) => entry(rec, fileSlug)),
  };
  const pending = new Map();
  let failedHandoff = false;
  return {
    entries: (which) => shelves[which].map((r) => ({ ...r })),
    save(which, items) {
      shelves[which] = items.map((r) => {
        const previous = [...shelves.active, ...shelves.backlog].find((x) => x.slug === r.slug);
        return { ...r, [sourceSlug]: r[sourceSlug] ?? previous?.[sourceSlug] };
      });
      return [];
    },
    queueHandoff(slug, body) { pending.set(slug, body); },
    locationOf: (rec) => `${records}${rec[sourceSlug] ?? rec.slug}.json`,
    async latestHandoff(rec) { return bodyBySlug.get(rec[sourceSlug] ?? rec.slug)?.trim() ?? null; },
    async flush(verb) {
      if (failedHandoff) throw new Error('handoff write failed earlier in this command');
      const urls = [];
      const seen = new Set();
      const slugs = new Set();
      for (const shelf of ['active', 'backlog']) for (const item of shelves[shelf]) {
        const rec = { ...item, shelf };
        delete rec.file;
        const slug = rec.slug;
        let fileSlug = item[sourceSlug] ?? slug;
        if (!item[sourceSlug]) for (let n = 2; saved.has(fileSlug); n++) fileSlug = `${slug}-${n}`;
        const body = pending.get(slug) ?? bodyBySlug.get(fileSlug);
        if (body !== undefined) rec.handoff = body;
        if (slugs.has(slug) || seen.has(fileSlug)) throw new Error(`duplicate gtg project ${slug}`);
        slugs.add(slug);
        seen.add(fileSlug);
        const serialized = JSON.stringify(rec);
        const old = saved.get(fileSlug);
        if (old?.rec === serialized) continue;
        const path = `${records}${encodeURIComponent(fileSlug)}.json`;
        let out;
        try {
          out = await call(old ? 'PUT' : 'POST', path, {
            content: Buffer.from(JSON.stringify(rec, null, 2) + '\n').toString('base64'),
            message: `gtg ${verb}: ${slug}`,
            ...(old ? { sha: old.sha } : {}),
          });
        } catch (e) { if (pending.has(slug)) failedHandoff = true; throw e; }
        saved.set(fileSlug, { rec: serialized, sha: out.content.sha });
        bodyBySlug.set(fileSlug, body);
        item[sourceSlug] = fileSlug;
        if (pending.has(slug)) urls.push(out.content.html_url ?? `${cfg.api.replace(/\/api\/v1$/, '')}/${cfg.repo}/src/branch/main/${path}`);
      }
      for (const [fileSlug, old] of saved) {
        if (seen.has(fileSlug)) continue;
        await call('DELETE', `${records}${encodeURIComponent(fileSlug)}.json`, { sha: old.sha, message: `gtg ${verb}: ${fileSlug}` });
        saved.delete(fileSlug);
      }
      pending.clear();
      return urls;
    },
  };
}