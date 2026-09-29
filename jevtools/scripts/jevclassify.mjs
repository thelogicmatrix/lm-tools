#!/usr/bin/env node
// Classify your Forgejo repositories from metadata, never source content.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CONCURRENCY, askJev, fetchText, isMain, parseArgs, readKey, runPool, runSelftest } from './lib.mjs'

const HOST = (process.env.FORGEJO_URL ?? '').replace(/\/+$/, '')
const CATEGORIES = {
  game: 'A game, game prototype, game engine experiment, or game asset project',
  world: 'Fictional setting, story, lore, or worldbuilding content',
  world_tool: 'Software for simulating or managing a fictional world',
  web: 'A website or web application',
  tool: 'A general software tool, automation, plugin, or service',
  operations: 'Infrastructure, homelab, deployment, or repository operations',
  reference: 'A learning exercise, example, or third-party reference fork',
  data: 'A data archive or credential database rather than an application',
  unknown: 'The metadata does not establish a primary purpose',
}

export function hints(entries) {
  const names = new Set(entries.map(x => x.name))
  const out = []
  if (names.has('Assets') && names.has('ProjectSettings')) out.push('Unity project')
  if (entries.some(x => x.name.endsWith('.uproject'))) out.push('Unreal project')
  if (names.has('astro.config.mjs')) out.push('Astro site')
  if (names.has('package.json')) out.push('Node package')
  if (names.has('.obsidian')) out.push('Obsidian vault')
  if (entries.some(x => x.name.toLowerCase().endsWith('.kdbx'))) out.push('KeePass database')
  if (names.has('CNAME') && names.has('index.html')) out.push('static website')
  if (entries.length === 1 && names.has('README.md')) out.push('README only')
  return out
}

export function label(repo, answer) {
  if (repo.empty) return { category: 'empty', confidence: '' }
  if (repo.failed) return { category: 'unknown', confidence: '' }
  const category = answer?.choice
  return Object.hasOwn(CATEGORIES, category) && Number.isFinite(answer?.confidence)
    ? { category, confidence: answer.confidence.toFixed(2) }
    : { category: 'unknown', confidence: '' }
}

async function main(argv) {
  if (parseArgs(argv).flag('selftest')) return runSelftest(new URL('./jevclassify.test.mjs', import.meta.url))
  if (!HOST) throw new Error('Set FORGEJO_URL to your Forgejo base URL, e.g. http://forgejo.local:3000')
  const key = readKey()
  if (!key) throw new Error('Jev key missing from OPENROUTER_API_KEY or ~/.jev.env')
  // forgejo-cli keeps keys.json in the platform data dir: %APPDATA%\forgejo-cli\forgejo-cli\data on
  // Windows, $XDG_DATA_HOME/forgejo-cli (default ~/.local/share) elsewhere. The first that exists wins.
  // ponytail: macOS is not listed because its path was not checked. Add it here when someone runs there.
  const tokenFiles = [
    process.env.APPDATA && join(process.env.APPDATA, 'forgejo-cli', 'forgejo-cli', 'data', 'keys.json'),
    join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'forgejo-cli', 'keys.json'),
  ].filter(Boolean)
  const tokenFile = tokenFiles.find((f) => { try { readFileSync(f); return true } catch { return false } })
  if (!tokenFile) throw new Error(`Forgejo CLI keys.json not found. Looked in: ${tokenFiles.join(', ')}`)
  const token = JSON.parse(readFileSync(tokenFile, 'utf8')).hosts?.[new URL(HOST).host]?.token
  if (!token) throw new Error('Forgejo CLI token missing')

  // Through lib.mjs's retry, so a 429 or 5xx is asked again with backoff. A 404 on an optional read
  // is an answer (no contents), not a failure.
  async function api(route, optional = false) {
    try {
      return JSON.parse(await fetchText(`${HOST}/api/v1${route}`, { headers: { Authorization: `token ${token}` } }, 30_000))
    } catch (e) {
      if (optional && e.status === 404) return []
      throw new Error(`Forgejo API ${e.message} on ${route}`)
    }
  }

  const repos = []
  let page = 1
  while (true) {
    const batch = await api(`/user/repos?limit=50&page=${page}`)
    repos.push(...batch)
    if (batch.length < 50) break
    page++
  }
  repos.sort((a, b) => a.name.localeCompare(b.name))
  if (!repos.length) throw new Error('Forgejo returned no repositories')

  // Six reads at a time. A repo whose read still fails after the retry is marked failed, comes out
  // unknown and is not put to Jev, and the run carries on with the rest.
  await runPool(repos, async (repo, i) => {
    console.error(`[${i + 1}/${repos.length}] reading ${repo.name}`)
    const at = `/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}/contents`
    try {
      const entries = repo.empty ? [] : await api(at, true)
      repo.hints = hints(Array.isArray(entries) ? entries : [])
      const dirs = Array.isArray(entries) ? entries.filter(x => x.type === 'dir' && !x.name.startsWith('.')) : []
      if (!repo.hints.length && dirs.length === 1) {
        const nested = await api(`${at}/${encodeURIComponent(dirs[0].name)}`, true)
        repo.hints = hints(Array.isArray(nested) ? nested : [])
      }
    } catch (e) {
      repo.hints = [`read failed: ${e.message}`]
      repo.failed = e.message
    }
  }, CONCURRENCY)
  const failed = repos.filter((r) => r.failed)
  if (failed.length) console.error(`${failed.length} of ${repos.length} repos could not be read and are listed as unknown`)

  const read = [...repos.entries()].filter(([, r]) => !r.failed)
  const state = JSON.stringify(read.map(([i, r]) => ({
    id: `r${i}`, name: r.name, description: r.description, language: r.language,
    hints: r.hints, empty: r.empty, source: r.original_url ? 'GitHub' : 'Forgejo',
  })))
  const questions = Object.fromEntries(read.map(([i]) => [`r${i}`, {
    type: 'choice',
    instructions: `Classify repository r${i} by its primary purpose. Use unknown when the evidence is thin.`,
    criteria: CATEGORIES,
  }]))
  console.error(`[${repos.length}/${repos.length}] asking Jev`)
  const { answers } = read.length ? await askJev(state, questions, key) : { answers: {} }

  console.log('# Forgejo repository classification')
  console.log('')
  console.log(`Generated ${new Date().toISOString().slice(0, 10)} from Forgejo metadata. Categories are suggestions, not maintenance or quality judgments. Jev saw names, descriptions, languages, and recognized root markers only.`)
  console.log('')
  console.log('| Repository | Source | Visibility | Category | Confidence | Evidence |')
  console.log('|---|---|---|---|---:|---|')
  for (const [i, repo] of repos.entries()) {
    const { category, confidence } = label(repo, answers?.[`r${i}`])
    const evidence = [repo.description, repo.language, ...repo.hints].filter(Boolean).join(', ')
    const clean = s => String(s ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ')
    console.log(`| [${clean(repo.name)}](${repo.html_url}) | ${repo.original_url ? 'GitHub' : 'Forgejo'} | ${repo.private ? 'Private' : 'Public'} | ${category} | ${confidence} | ${clean(evidence)} |`)
  }
}

if (isMain(import.meta.url)) await main(process.argv.slice(2))
