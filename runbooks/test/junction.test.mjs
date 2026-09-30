import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// #32: the plugin cache can be reached through a junction. Node resolves the module to its real
// path while argv[1] keeps the junction path, so a URL equality entry check never ran main and
// both hooks exited 0 with no output. Each script is launched through a junction here.
const scripts = fileURLToPath(new URL("../scripts", import.meta.url));

function sandbox(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "runbooks-junction-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const link = join(root, "link");
  // "junction" needs no admin on Windows and is a plain dir symlink elsewhere.
  symlinkSync(scripts, link, "junction");
  const dir = join(root, "runbooks");
  mkdirSync(dir);
  writeFileSync(join(dir, "deploy.md"), "# Deploy\n**Type:** procedure\n**Purpose:** Ship the Acme scraper to production.\n");
  // No key anywhere, so the router takes its no-key notice and never reaches the network.
  const env = { ...process.env, HOME: root, USERPROFILE: root, LOCALAPPDATA: root, RUNBOOKS_DIR: dir, CLAUDE_CONFIG_DIR: "" };
  delete env.OPENROUTER_API_KEY;
  return { root, link, env };
}

const run = (script, args, { root, env }, input) => spawnSync(process.execPath, [script, ...args],
  { cwd: root, env, encoding: "utf8", input: JSON.stringify({ cwd: root, ...input }) });

test("router runs when launched through a junction", (t) => {
  const box = sandbox(t);
  const r = run(join(box.link, "router.mjs"), [], box, { prompt: "deploy the acme scraper to production", session_id: "junction-test" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /runbooks: fallback \(no key, 0 attempts\)/);
  assert.notEqual(r.stdout.trim(), "");
});

test("session index runs when launched through a junction", (t) => {
  const box = sandbox(t);
  const r = run(join(box.link, "index.mjs"), ["--pushed"], box, {});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /deploy — Ship the Acme scraper/);
});

test("projects CLI runs when launched through a junction", (t) => {
  const box = sandbox(t);
  const r = run(join(box.link, "projects.mjs"), [], box, {});
  assert.match(r.stderr, /usage: projects\.mjs/);
});
