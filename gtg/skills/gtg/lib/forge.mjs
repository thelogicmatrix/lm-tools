// Optional forge store: a gtg project is one open milestone on a Forgejo/Gitea repo, its handoffs
// are comments on one tracking issue in that milestone. Design: references/forge-store.md.
//
// The CLI's store calls are synchronous (entries/saveEntries) and HTTP is not, so this loads every
// record once, lets the command edit the in-memory copy exactly as it edits the file store, and
// writes the difference in flush(). A separate module rather than a branch in lib/store.mjs,
// because that file must stay byte-identical in code to the projects plugin's copy.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FENCE = /```json gtg\n([\s\S]*?)\n```/;
const LABEL = 'gtg';
const PAGE = 50;
// Which milestone a record came from. A symbol so JSON.stringify never writes it, and it survives
// the in-place edits (back, rename, keep) that move the same object between shelves.
const ID = Symbol('gtg-forge-milestone');

// null = no forge configured, the file store runs exactly as before.
export function forgeConfig(root, env = process.env) {
  const p = join(root, '.gtg', 'forge.json');
  if (!existsSync(p)) return null;
  let cfg;
  try { cfg = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw new Error(`cannot parse .gtg/forge.json - ${e.message}`); }
  if (typeof cfg.api !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(cfg.repo ?? '')) {
    throw new Error('.gtg/forge.json needs "api" (the /api/v1 URL) and "repo" (owner/name)');
  }
  const token = env.FORGEJO_TOKEN || readToken(cfg, env);
  if (!token) throw new Error('.gtg/forge.json is set but there is no token: set FORGEJO_TOKEN or "tokenFile"');
  return { api: cfg.api.replace(/\/+$/, ''), repo: cfg.repo, token, store: cfg.store };
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

const describe = (rec, shelf, issue) =>
  `${rec.next ?? ''}\n\n\`\`\`json gtg\n${JSON.stringify({ ...rec, shelf, issue }, null, 2)}\n\`\`\`\n`;
const copy = (r) => ({ ...JSON.parse(JSON.stringify(r)), [ID]: r[ID] });

export async function openForge(cfg, fetchImpl = fetch) {
  if (cfg.store === 'files') return openFileForge(cfg, fetchImpl);
  // Errors name the method and path, never the headers, so the token cannot reach a transcript.
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${cfg.api}/repos/${cfg.repo}${path}`, {
      method,
      headers: { Authorization: `token ${cfg.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`forge ${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  };
  // Paged until an empty page: the server may cap `limit` below what was asked, so a short page
  // does not prove it was the last one.
  const all = async (path) => {
    const out = [];
    for (let page = 1; ; page++) {
      const batch = await call('GET', `${path}${path.includes('?') ? '&' : '?'}limit=${PAGE}&page=${page}`);
      if (!batch?.length) return out;
      out.push(...batch);
    }
  };

  const shelves = { active: [], backlog: [] };
  const meta = new Map();   // milestone id -> { issue, saved: title + description as gtg last wrote it }
  const idBySlug = new Map();
  for (const m of await all('/milestones?state=open')) {
    const hit = m.description?.match(FENCE);
    if (!hit) continue; // a milestone gtg did not write is not a gtg project
    let parsed;
    try { parsed = JSON.parse(hit[1]); } catch (e) { throw new Error(`cannot parse the gtg record in milestone "${m.title}" - ${e.message}`); }
    const { shelf, issue, ...rec } = parsed;
    rec[ID] = m.id;
    (shelves[shelf] ?? shelves.active).push(rec);
    // Compared as gtg would write it, not as the server echoes it, so a server that trims or
    // re-wraps the description does not turn every command into a PATCH of every record.
    meta.set(m.id, { issue, saved: `${m.title}\n${describe(rec, shelf, issue)}` });
    idBySlug.set(rec.slug, m.id);
  }

  let labelId;
  const ensureLabel = async () => {
    labelId ??= (await all('/labels')).find((l) => l.name === LABEL)?.id
      ?? (await call('POST', '/labels', { name: LABEL, color: '#5319e7', description: 'gtg project: comments are the handoffs' })).id;
    return labelId;
  };

  let pending = []; // handoff bodies waiting for flush: { slug, body }

  return {
    entries: (which) => shelves[which].map(copy),
    // Returns no paths: nothing touches git, so commit() gets [] and does nothing.
    save(which, items) { shelves[which] = items.map(copy); return []; },
    queueHandoff(slug, body) { pending.push({ slug, body }); },

    // Writes the difference between what was loaded and what the command left. Returns the URLs of
    // the handoff comments it posted. Safe to call twice: the second call finds nothing to do.
    async flush(verb) {
      const seen = new Set();
      for (const shelf of ['active', 'backlog']) {
        for (const rec of shelves[shelf]) {
          let id = rec[ID] ?? idBySlug.get(rec.slug);
          if (id === undefined || !meta.has(id)) {
            const ms = await call('POST', '/milestones', { title: rec.project });
            const iss = await call('POST', '/issues', {
              title: `gtg: ${rec.project}`,
              body: `Handoffs for **${rec.project}**. The latest comment is the current handoff. Resume with \`gtg ${rec.slug}\`.\nTasks are the other issues in this milestone.`,
              milestone: ms.id,
              labels: [await ensureLabel()],
            });
            id = ms.id;
            meta.set(id, { issue: iss.number, saved: '' });
          }
          rec[ID] = id;
          idBySlug.set(rec.slug, id);
          seen.add(id);
          const m = meta.get(id);
          const description = describe(rec, shelf, m.issue);
          if (m.saved !== `${rec.project}\n${description}`) {
            await call('PATCH', `/milestones/${id}`, { title: rec.project, description });
            m.saved = `${rec.project}\n${description}`;
          }
        }
      }
      for (const [id, m] of meta) {
        if (seen.has(id)) continue;
        await call('POST', `/issues/${m.issue}/comments`, { body: `Closed by \`gtg ${verb}\`.` });
        await call('PATCH', `/issues/${m.issue}`, { state: 'closed' });
        await call('PATCH', `/milestones/${id}`, { state: 'closed' });
        meta.delete(id);
      }
      // Taken before posting, so a failed post is not retried by the dispatcher's own flush: the
      // caller has already saved that body to a file.
      const todo = pending;
      pending = [];
      const urls = [];
      for (const { slug, body } of todo) {
        const issue = meta.get(idBySlug.get(slug))?.issue;
        if (!issue) throw new Error(`no tracking issue for ${slug}`);
        urls.push((await call('POST', `/issues/${issue}/comments`, { body })).html_url);
      }
      return urls;
    },

    issueOf: (rec) => meta.get(rec[ID] ?? idBySlug.get(rec.slug))?.issue ?? null,
    // ponytail: the comments endpoint has no paging, so this reads every handoff to take the last.
    // Fine for tens of checkpoints. Use `since` if a project ever runs to hundreds.
    async latestHandoff(rec) {
      const issue = this.issueOf(rec);
      if (!issue) return null;
      const comments = await call('GET', `/issues/${issue}/comments`);
      return comments.at(-1)?.body?.trim() ?? null;
    },
    // Tasks: the open issues in the milestone other than the tracking issue itself.
    async openTasks(rec) {
      const id = rec[ID] ?? idBySlug.get(rec.slug);
      if (id === undefined) return [];
      const issue = this.issueOf(rec);
      return (await all(`/issues?state=open&type=issues&milestones=${id}`))
        .filter((i) => i.number !== issue)
        .map((i) => `- #${i.number} ${i.title}`);
    },
  };
}

// One JSON file contains both record and current handoff. One SHA-protected PUT changes both.
async function openFileForge(cfg, fetchImpl) {
  const sourceSlug = Symbol('gtg-file-source-slug');
  const base = `${cfg.api}/repos/${cfg.repo}/contents/`;
  const records = 'docs/handoffs/records/';
  const call = async (method, path, body, missing = false) => {
    const res = await fetchImpl(base + path, {
      method,
      headers: { Authorization: `token ${cfg.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (missing && res.status === 404) return null;
    if (!res.ok) throw new Error(`forge ${method} ${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : res.json();
  };
  const read = async (path, missing = false) => {
    const file = await call('GET', path, undefined, missing);
    return file && { sha: file.sha, text: Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf8') };
  };
  const names = await call('GET', records.slice(0, -1), undefined, true);
  if (!names) {
    const repo = await fetchImpl(`${cfg.api}/repos/${cfg.repo}`, {
      headers: { Authorization: `token ${cfg.token}` }, signal: AbortSignal.timeout(15000),
    });
    if (!repo.ok) throw new Error(`forge GET repo ${cfg.repo} -> ${repo.status}`);
  }
  const files = (names ?? []).filter((f) => f.name?.endsWith('.json'));
  const loaded = await Promise.all(files.map(async (f) => {
    const data = await read(records + encodeURIComponent(f.name));
    let rec;
    try { rec = JSON.parse(data.text); } catch (e) { throw new Error(`cannot parse ${records}${f.name} - ${e.message}`); }
    if (typeof rec.slug !== 'string' || !['active', 'backlog'].includes(rec.shelf)
      || (rec.handoff !== undefined && typeof rec.handoff !== 'string')) {
      throw new Error(`invalid gtg record at ${records}${f.name}`);
    }
    return { rec, sha: data.sha, fileSlug: f.name.slice(0, -5) };
  }));
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
    async openTasks() { return []; },
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
