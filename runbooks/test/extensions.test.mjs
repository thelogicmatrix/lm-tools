import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runNudges, runLintExtensions, summarize } from "../scripts/index.mjs";
import { loadExtensions } from "../scripts/config.mjs";

const INDEX = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "index.mjs");
const ext = (name, fn) => ({ name, fn });

test("runNudges keeps a string and drops null, a throw and a nudge past the deadline", async () => {
  const started = Date.now();
  const out = await runNudges(
    [
      ext("a", () => "a"),
      ext("none", () => null),
      ext("boom", () => { throw new Error("boom"); }),
      ext("hang", () => new Promise(() => {})),
    ],
    {},
    50
  );
  assert.deepEqual(out, ["a"]);
  assert.ok(Date.now() - started < 1000, "the deadline, not the hung nudge, ends the wait");
});

test("runNudges passes ctx through and keeps an async nudge that beats the deadline", async () => {
  const ctx = { root: "r", dir: "d", entries: [{ slug: "x" }] };
  const out = await runNudges([ext("n", async (c) => `${c.dir} ${c.entries.length}`)], ctx, 50);
  assert.deepEqual(out, ["d 1"]);
});

test("runNudges holds the extension imports to the same deadline", async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "runbooks-imports-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const nudges = join(root, "nudges");
  mkdirSync(nudges);
  writeFileSync(join(nudges, "a.mjs"), 'export default () => "a";\n');
  assert.deepEqual(await runNudges(loadExtensions(root, "nudges"), {}, 1000), ["a"]);
  // A module whose top-level await outlasts the deadline. unref, so the test process can still exit.
  writeFileSync(join(nudges, "slow.mjs"), 'await new Promise((r) => setTimeout(r, 5000).unref());\nexport default () => "slow";\n');
  const started = Date.now();
  assert.deepEqual(await runNudges(loadExtensions(root, "nudges"), {}, 100), []);
  assert.ok(Date.now() - started < 1000, "the deadline, not the slow import, ends the wait");
});

test("runLintExtensions flattens rule arrays, ignores a non-array and drops a throw", () => {
  const file = { slug: "x", text: "# X\n", header: { type: null } };
  const seen = [];
  const out = runLintExtensions(
    [
      ext("one", (f) => { seen.push(f); return ["x: one"]; }),
      ext("two", () => ["x: two", "x: three"]),
      ext("string", () => "x: not a list"),
      ext("boom", () => { throw new Error("boom"); }),
    ],
    file
  );
  assert.deepEqual(out, ["x: one", "x: two", "x: three"]);
  assert.equal(seen[0], file);
});

test("summarize appends nudge lines after the tails, exactly as the old nudges argument did", () => {
  const entries = [{ slug: "gpu-driver-crashes", type: "postmortem", purpose: "p", status: null }];
  const out = summarize(entries, ["first nudge", "second nudge"]).hookSpecificOutput.additionalContext;
  assert.equal(out, "Postmortems, read before re-proposing their subject: gpu-driver-crashes.\nfirst nudge\nsecond nudge");
});

// End to end through the hook: stdin carries cwd, the folder resolves from it, and a
// .runbooks/nudges extension lands in the output. HOME and USERPROFILE point at the fixture so
// the machine's own ~/docs/runbooks and ~/.runbooks are never picked up.
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "runbooks-index-")));
  const project = join(base, "project");
  mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "-q", project]);
  const env = { ...process.env, HOME: base, USERPROFILE: base, RUNBOOKS_DIR: "" };
  const run = (...args) =>
    spawnSync(process.execPath, [INDEX, ...args], { input: JSON.stringify({ cwd: project }), env, encoding: "utf8" });
  return { base, project, env, run };
}

test("the hook appends a nudge extension's line and gives it the entries", () => {
  const f = fixture();
  mkdirSync(join(f.project, "docs", "runbooks"), { recursive: true });
  writeFileSync(join(f.project, "docs", "runbooks", "old-thing.md"), "# Old\n**Type:** postmortem\n**Purpose:** p.\n");
  mkdirSync(join(f.project, ".runbooks", "nudges"), { recursive: true });
  writeFileSync(join(f.project, ".runbooks", "nudges", "count.mjs"), "export default (ctx) => `saw ${ctx.entries.length}`;\n");
  const r = f.run();
  rmSync(f.base, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    JSON.parse(r.stdout).hookSpecificOutput.additionalContext,
    "Postmortems, read before re-proposing their subject: old-thing.\nsaw 1"
  );
});

test("the hook prints nothing and exits 0 when no runbooks folder resolves", () => {
  const f = fixture();
  const r = f.run();
  rmSync(f.base, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
});

test("the hook does not hang on a stdin pipe that is never closed", async () => {
  const f = fixture();
  mkdirSync(join(f.project, "docs", "runbooks"), { recursive: true });
  writeFileSync(join(f.project, "docs", "runbooks", "old-thing.md"), "# Old\n**Type:** postmortem\n**Purpose:** p.\n");
  // stdin stays open and empty, so the hook falls back to its own cwd, which is the project.
  const child = spawn(process.execPath, [INDEX], { cwd: f.project, env: f.env });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const killer = setTimeout(() => child.kill(), 5000);
  const code = await new Promise((r) => child.on("exit", r));
  clearTimeout(killer);
  child.stdin.destroy();
  rmSync(f.base, { recursive: true, force: true });
  assert.equal(code, 0, "killed at 5 s means the stdin read blocked");
  assert.match(out, /old-thing/);
});
