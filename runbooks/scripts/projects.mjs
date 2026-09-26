#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, settings } from "./config.mjs";
import { parseHeader, projectTags } from "./index.mjs";

const listed = (dir) => readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort();
const slash = (p) => p.replaceAll("\\", "/");
const safeRelative = (p) => typeof p === "string" && p && !isAbsolute(p) && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).includes("..") && !p.split(/[\\/]/).includes("");

function defaultScanner(stage) {
  const report = join(tmpdir(), `runbook-gitleaks-${process.pid}-${Date.now()}.json`);
  try {
    const scan = spawnSync("gitleaks", ["dir", "--no-banner", "--redact=100", "--report-format", "json", "--report-path", report, stage], { encoding: "utf8", stdio: "ignore" });
    if (scan.error) throw new Error("gitleaks is required for local packs");
    if (scan.status !== 0 && scan.status !== 1) throw new Error(`gitleaks failed with exit ${scan.status}`);
    if (!existsSync(report)) {
      if (scan.status === 1) throw new Error("gitleaks found secrets but wrote no report");
      return [];
    }
    return JSON.parse(readFileSync(report, "utf8")).map((f) => ({ file: slash(f.File).replace(slash(stage) + "/", ""), line: f.StartLine }));
  } finally { rmSync(report, { force: true }); }
}

function collectFolder(dir, rel, out) {
  const full = join(dir, rel);
  if (!existsSync(full)) return;
  if (lstatSync(full).isSymbolicLink()) throw new Error(`symbolic link in companion: ${rel}`);
  if (!lstatSync(full).isDirectory()) return;
  for (const name of readdirSync(full).sort()) {
    const child = slash(posix.join(rel, name));
    const stat = lstatSync(join(dir, child));
    if (stat.isSymbolicLink()) throw new Error(`symbolic link in companion: ${child}`);
    if (stat.isDirectory()) collectFolder(dir, child, out);
    else if (stat.isFile()) out.add(child);
  }
}

function personalFindings(stage, files) {
  const out = [];
  for (const rel of files) {
    const bytes = readFileSync(join(stage, rel));
    if (bytes.includes(0)) continue;
    const lines = bytes.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(lines[i]) || /(?:[A-Za-z]:[\\/]Users[\\/]|\/home\/)[^\s/\\]+/i.test(lines[i])) {
        out.push({ file: rel, line: i + 1 });
      }
    }
  }
  return out;
}

export function packProject({ dir, project, output, exclude = [], allowed, runScanner = defaultScanner }) {
  if (!dir || !existsSync(dir)) throw new Error("runbooks source is missing");
  if (!project || !/^[a-z0-9][a-z0-9-]*$/.test(project)) throw new Error("project slug is required");
  if (allowed && !allowed.has(project)) throw new Error(`unknown project: ${project}`);
  if (!output || !output.toLowerCase().endsWith(".zip")) throw new Error("output must be a .zip path");
  if (existsSync(output)) throw new Error(`output already exists: ${output}`);
  for (const p of exclude) if (!safeRelative(p)) throw new Error(`invalid exclusion: ${p}`);
  const all = new Set();
  const runbooks = [];
  for (const folder of ["", "retired"]) {
    const base = join(dir, folder);
    if (!existsSync(base)) continue;
    for (const name of listed(base)) {
      const rel = slash(posix.join(folder, name));
      if (lstatSync(join(dir, rel)).isSymbolicLink()) throw new Error(`symbolic link runbook: ${rel}`);
      const body = readFileSync(join(dir, rel), "utf8");
      if (!projectTags(body).includes(project)) continue;
      all.add(rel);
      runbooks.push({ rel, ...parseHeader(body), body });
      collectFolder(dir, slash(posix.join(folder, name.slice(0, -3))), all);
    }
  }
  if (!runbooks.length) throw new Error(`unknown project or no tagged runbooks: ${project}`);
  for (const path of exclude) if (![...all].some((p) => p === slash(path) || p.startsWith(slash(path) + "/"))) throw new Error(`exclusion not in pack: ${path}`);
  const omitted = [...all].filter((p) => exclude.some((e) => p === slash(e) || p.startsWith(slash(e) + "/"))).sort();
  const included = [...all].filter((p) => !omitted.includes(p)).sort();
  const selected = new Set(included);
  const links = [];
  for (const rel of included.filter((p) => p.endsWith(".md"))) {
    const body = readFileSync(join(dir, rel), "utf8");
    for (const m of body.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      const target = m[1].trim().replace(/^<|>$/g, "");
      if (!target || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith("/")) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(rel), target));
      if (!selected.has(resolved)) links.push(`${rel} -> ${resolved}`);
    }
  }
  const index = ["# Project pack: " + project, "", "## Runbooks", "", ...runbooks.filter((r) => selected.has(r.rel)).map((r) => `- ${r.rel}: ${r.purpose ?? "purpose not recorded"}${r.status ? ` (status: ${r.status})` : ""}`), "", "## Excluded", "", ...(omitted.length ? omitted.map((p) => `- ${p}`) : ["None"]), "", "## Links outside pack", "", ...(links.length ? links.map((p) => `- ${p}`) : ["None"]), ""].join("\n");
  const stage = mkdtempSync(join(tmpdir(), "runbook-pack-"));
  try {
    for (const rel of included) {
      mkdirSync(dirname(join(stage, rel)), { recursive: true });
      copyFileSync(join(dir, rel), join(stage, rel));
    }
    writeFileSync(join(stage, "README.md"), index);
    const findings = [...runScanner(stage), ...personalFindings(stage, [...included, "README.md"])];
    if (findings.length) throw new Error(`pack scan found ${findings.length} finding(s): ${findings.map((f) => `${slash(f.file)}:${f.line}`).join(", ")}`);
    mkdirSync(dirname(resolve(output)), { recursive: true });
    if (process.platform === "win32") {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory($env:RUNBOOK_PACK_STAGE, $env:RUNBOOK_PACK_OUTPUT)'], { env: { ...process.env, RUNBOOK_PACK_STAGE: stage, RUNBOOK_PACK_OUTPUT: resolve(output) }, stdio: "pipe" });
    } else {
      try { execFileSync("zip", ["-q", "-r", resolve(output), "."], { cwd: stage, stdio: "pipe" }); }
      catch (error) { if (error.code === "ENOENT") throw new Error("zip is required for local packs"); else throw error; }
    }
    return { included, excluded: omitted, links, index };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function retireProject({ dir, project, apply = false, date = localDate(), allowed }) {
  if (!dir || !existsSync(dir)) throw new Error("runbooks source is missing");
  if (!project || !/^[a-z0-9][a-z0-9-]*$/.test(project)) throw new Error("project slug is required");
  if (allowed && !allowed.has(project)) throw new Error(`unknown project: ${project}`);
  const moves = [];
  const tagRemovals = [];
  const selected = [];
  for (const name of listed(dir)) {
    const full = join(dir, name);
    if (lstatSync(full).isSymbolicLink()) throw new Error(`broken or symbolic link source: ${name}`);
    const body = readFileSync(full, "utf8");
    const tags = projectTags(body);
    if (!tags.includes(project)) continue;
    selected.push({ name, body, tags });
    if (tags.length === 1) moves.push(name);
    else tagRemovals.push(name);
  }
  if (!apply) return { moves, tagRemovals };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD");
  const retired = join(dir, "retired");
  for (const name of moves) {
    try { lstatSync(join(retired, name)); throw new Error(`retired destination collision: ${name}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const state = execFileSync("git", ["-C", dir, "status", "--porcelain", "--", `retired/${name}`], { encoding: "utf8" }).trim();
    if (state) throw new Error(`dirty destination: retired/${name}`);
  }
  for (const { name, body, tags } of selected) {
    if (tags.length === 1 && !/^\*\*(?:Type|Status):\*\*/mi.test(body)) throw new Error(`cannot add retirement status: ${name}`);
    const state = execFileSync("git", ["-C", dir, "status", "--porcelain", "--", name], { encoding: "utf8" }).trim();
    if (state) throw new Error(`dirty runbook: ${name}`);
  }
  mkdirSync(retired, { recursive: true });
  for (const { name, body, tags } of selected) {
    if (tags.length > 1) {
      const remaining = tags.filter((tag) => tag !== project).join(", ");
      writeFileSync(join(dir, name), body.replace(/^(\*\*Project:\*\*[ \t]*).*(\r?)$/mi, (_, prefix, cr) => prefix + remaining + cr));
    } else {
      const status = `**Status:** retired ${date} \u2014 ${project} project retired.`;
      const updated = /^\*\*Status:\*\*/mi.test(body)
        ? body.replace(/^\*\*Status:\*\*[^\r\n]*/mi, status)
        : body.replace(/^(\*\*Type:\*\*[^\r\n]*)(\r?\n)/mi, `$1$2${status}$2`);
      if (updated === body) throw new Error(`cannot add retirement status: ${name}`);
      writeFileSync(join(dir, name), updated);
      renameSync(join(dir, name), join(retired, name));
    }
  }
  return { moves, tagRemovals };
}

function cli() {
  const [command, ...args] = process.argv.slice(2);
  const get = (key) => args[args.indexOf(key) + 1];
  const { root, dir } = settings();
  const config = loadConfig(root);
  const allowed = Array.isArray(config.projects) ? new Set(config.projects) : undefined;
  if (command === "pack") {
    const result = packProject({ dir, project: get("--project"), output: get("--output"), exclude: args.flatMap((a, i) => a === "--exclude" ? [args[i + 1]] : []), allowed });
    console.log(`Packed ${result.included.length} files. Excluded ${result.excluded.length}. Links outside pack ${result.links.length}.`);
    for (const link of result.links) console.log(link);
  } else if (command === "retire") {
    const result = retireProject({ dir, project: get("--project"), apply: args.includes("--apply"), allowed });
    console.log(`${args.includes("--apply") ? "Applied" : "Dry run"}: ${result.moves.length} moves, ${result.tagRemovals.length} tag removals.`);
    for (const name of result.moves) console.log(`move: ${name}`);
    for (const name of result.tagRemovals) console.log(`remove tag: ${name}`);
  } else throw new Error("usage: projects.mjs pack --project <slug> --output <path.zip> [--exclude <path>] | retire --project <slug> [--apply]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
