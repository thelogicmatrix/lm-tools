#!/usr/bin/env node
// Classify Nathan's Forgejo repositories from metadata, never source content.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { askJev, readKey } from './lib.mjs'

const HOST = 'http://100.75.143.3:3300'
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

function hints(entries) {
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

function label(repo, answer) {
  if (repo.empty) return { category: 'empty', confidence: '' }
  const category = answer?.choice
  return Object.hasOwn(CATEGORIES, category) && Number.isFinite(answer?.confidence)
    ? { category, confidence: answer.confidence.toFixed(2) }
    : { category: 'unknown', confidence: '' }
}

if (process.argv.includes('--selftest')) {
  assert.deepEqual(hints([{ name: 'private-name.kdbx' }]), ['KeePass database'])
  assert.equal(label({ empty: true }, {}).category, 'empty')
  assert.equal(label({ empty: false }, { choice: 'made_up', confidence: 1 }).category, 'unknown')
  console.log('jevclassify selftest OK')
  process.exit(0)
}

const key = readKey()
if (!key) throw new Error('Jev key missing from OPENROUTER_API_KEY or ~/.jev.env')
const tokenFile = join(process.env.APPDATA, 'forgejo-cli', 'forgejo-cli', 'data', 'keys.json')
const token = JSON.parse(readFileSync(tokenFile, 'utf8')).hosts[new URL(HOST).host].token
if (!token) throw new Error('Forgejo CLI token missing')

async function api(route, optional = false) {
  const response = await fetch(`${HOST}/api/v1${route}`, {
    headers: { Authorization: `token ${token}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (optional && response.status === 404) return []
  if (!response.ok) throw new Error(`Forgejo API ${response.status} on ${route}`)
  return response.json()
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

for (const [i, repo] of repos.entries()) {
  console.error(`[${i + 1}/${repos.length}] reading ${repo.name}`)
  const entries = repo.empty ? [] : await api(`/repos/nathan/${encodeURIComponent(repo.name)}/contents`, true)
  repo.hints = hints(Array.isArray(entries) ? entries : [])
  const dirs = Array.isArray(entries) ? entries.filter(x => x.type === 'dir' && !x.name.startsWith('.')) : []
  if (!repo.hints.length && dirs.length === 1) {
    const nested = await api(`/repos/nathan/${encodeURIComponent(repo.name)}/contents/${encodeURIComponent(dirs[0].name)}`, true)
    repo.hints = hints(Array.isArray(nested) ? nested : [])
  }
}

const state = JSON.stringify(repos.map((r, i) => ({
  id: `r${i}`, name: r.name, description: r.description, language: r.language,
  hints: r.hints, empty: r.empty, source: r.original_url ? 'GitHub' : 'Forgejo',
})))
const questions = Object.fromEntries(repos.map((r, i) => [`r${i}`, {
  type: 'choice',
  instructions: `Classify repository r${i} by its primary purpose. Use unknown when the evidence is thin.`,
  criteria: CATEGORIES,
}]))
console.error(`[${repos.length}/${repos.length}] asking Jev`)
const { answers } = await askJev(state, questions, key)

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
  console.log(`| [${clean(repo.name)}](${HOST}/nathan/${encodeURIComponent(repo.name)}) | ${repo.original_url ? 'GitHub' : 'Forgejo'} | ${repo.private ? 'Private' : 'Public'} | ${category} | ${confidence} | ${clean(evidence)} |`)
}
