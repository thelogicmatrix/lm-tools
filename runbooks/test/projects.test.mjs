import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { packProject, retireProject } from "../scripts/projects.mjs";

const tar = process.platform === "win32" ? "C:/Windows/System32/tar.exe" : "tar";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "runbook-pack-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "runbooks");
  mkdirSync(join(dir, "retired"), { recursive: true });
  mkdirSync(join(dir, "acme"));
  writeFileSync(join(dir, "acme.md"), "# Acme\n**Type:** reference\n**Project:** acme\n**Purpose:** Current work.\n\n[Other](other.md)\n");
  writeFileSync(join(dir, "retired", "old.md"), "---\nname: old\n---\n**Status:** retired 2026-09-01 \u2014 done\n**Project:** acme\n");
  writeFileSync(join(dir, "acme", "notes.txt"), "safe notes\n");
  writeFileSync(join(dir, "acme", "notes.md"), "[outside](../other.md)\n");
  writeFileSync(join(dir, "acme", "hidden.txt"), "hidden companion\n");
  writeFileSync(join(dir, "acme", "omit.txt"), "omit\n");
  writeFileSync(join(dir, "other.md"), "# Other\n**Project:** other\n");
  return { root, dir, output: join(root, "pack.zip") };
}

test("pack includes live, retired, companion, index and reports exclusions and links", (t) => {
  const f = fixture(t);
  if (process.platform !== "win32" && spawnSync("zip", ["-v"], { stdio: "ignore" }).error?.code === "ENOENT") {
    assert.throws(() => packProject({ dir: f.dir, project: "acme", output: f.output, runScanner: () => [] }), /zip is required for local packs/);
    return;
  }
  const result = packProject({ dir: f.dir, project: "acme", output: f.output, exclude: ["acme/omit.txt"], runScanner: (stage) => {
    if (process.platform === "win32") execFileSync("C:/Windows/System32/attrib.exe", ["+H", join(stage, "acme", "hidden.txt")]);
    return [];
  } });
  assert.deepEqual(result.excluded, ["acme/omit.txt"]);
  assert.deepEqual(result.links, ["acme.md -> other.md", "acme/notes.md -> other.md"]);
  const listing = process.platform === "win32"
    ? execFileSync(tar, ["-tf", f.output], { encoding: "utf8" })
    : execFileSync("unzip", ["-Z1", f.output], { encoding: "utf8" });
  for (const name of ["README.md", "acme.md", "retired/old.md", "acme/notes.txt", "acme/hidden.txt"]) assert.match(listing, new RegExp(name.replace(".", "\\.")));
  assert.doesNotMatch(listing, /omit\.txt|other\.md/);
  assert.match(result.index, /purpose not recorded/i);
  assert.match(result.index, /acme\/omit\.txt/);
  const readme = process.platform === "win32"
    ? execFileSync(tar, ["-xOf", f.output, "README.md"], { encoding: "utf8" })
    : execFileSync("unzip", ["-p", f.output, "README.md"], { encoding: "utf8" });
  assert.match(readme, /retired\/old\.md: purpose not recorded/);
  assert.throws(() => packProject({ dir: f.dir, project: "acme", output: f.output, runScanner: () => [] }), /already exists/);
});

test("pack rejects unknown projects and companion symlinks", (t) => {
  const f = fixture(t);
  assert.throws(() => packProject({ dir: f.dir, project: "unknown", output: f.output, allowed: new Set(["acme"]), runScanner: () => [] }), /unknown project/);
  assert.throws(() => packProject({ dir: f.dir, project: "unknown", output: f.output, runScanner: () => [] }), /unknown project/);
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "outside.txt"), "outside\n");
  symlinkSync(outside, join(f.dir, "acme", "escape"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => packProject({ dir: f.dir, project: "acme", output: f.output, runScanner: () => [] }), /symbolic link/);
  assert.equal(existsSync(f.output), false);
});

test("scanner and personal data findings abort without showing matched values", (t) => {
  const f = fixture(t);
  assert.throws(() => packProject({ dir: f.dir, project: "acme", output: f.output, runScanner: () => [{ file: "acme.md", line: 2, match: "TOP_SECRET" }] }), (e) => /acme\.md:2/.test(e.message) && !e.message.includes("TOP_SECRET"));
  assert.equal(existsSync(f.output), false);
  writeFileSync(join(f.dir, "acme", "notes.txt"), "contact person@example.invalid\n");
  assert.throws(() => packProject({ dir: f.dir, project: "acme", output: f.output, runScanner: () => [] }), (e) => /acme\/notes\.txt:1/.test(e.message) && !e.message.includes("person@example.invalid"));
  assert.equal(existsSync(f.output), false);
});

function retirementFixture(t) {
  const f = fixture(t);
  writeFileSync(join(f.dir, "exclusive.md"), "# Exclusive\n**Type:** reference\n**Project:** acme\n**Purpose:** Only Acme.\n");
  writeFileSync(join(f.dir, "shared.md"), "# Shared\n**Type:** reference\n**Project:** acme, other\n**Purpose:** Shared.\n");
  execFileSync("git", ["init", "-q", f.dir]);
  execFileSync("git", ["-C", f.dir, "add", "exclusive.md", "shared.md", "acme.md", "retired/old.md", "other.md"]);
  execFileSync("git", ["-C", f.dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
  return f;
}

test("retirement dry run and apply preserve shared and historical tags", (t) => {
  const f = retirementFixture(t);
  const before = readFileSync(join(f.dir, "exclusive.md"), "utf8");
  const preview = retireProject({ dir: f.dir, project: "acme", date: "2026-09-26" });
  assert.deepEqual(preview.moves, ["acme.md", "exclusive.md"]);
  assert.deepEqual(preview.tagRemovals, ["shared.md"]);
  assert.equal(readFileSync(join(f.dir, "exclusive.md"), "utf8"), before);
  retireProject({ dir: f.dir, project: "acme", apply: true, date: "2026-09-26" });
  assert.equal(existsSync(join(f.dir, "exclusive.md")), false);
  assert.match(readFileSync(join(f.dir, "retired", "exclusive.md"), "utf8"), /\*\*Status:\*\* retired 2026-09-26 \u2014/);
  assert.match(readFileSync(join(f.dir, "shared.md"), "utf8"), /\*\*Project:\*\* other/);
  assert.doesNotMatch(readFileSync(join(f.dir, "shared.md"), "utf8"), /acme/);
  assert.match(readFileSync(join(f.dir, "retired", "old.md"), "utf8"), /\*\*Project:\*\* acme/);
  assert.equal(existsSync(join(f.dir, "acme")), true);
});

test("retirement refuses dirty files and destination collisions before editing", (t) => {
  const f = retirementFixture(t);
  writeFileSync(join(f.dir, "shared.md"), readFileSync(join(f.dir, "shared.md"), "utf8") + "dirty\n");
  assert.throws(() => retireProject({ dir: f.dir, project: "acme", apply: true, date: "2026-09-26" }), /dirty/);
  assert.equal(existsSync(join(f.dir, "exclusive.md")), true);
  execFileSync("git", ["-C", f.dir, "restore", "shared.md"]);
  writeFileSync(join(f.dir, "retired", "exclusive.md"), "collision\n");
  assert.throws(() => retireProject({ dir: f.dir, project: "acme", apply: true, date: "2026-09-26" }), /collision/);
  assert.equal(existsSync(join(f.dir, "exclusive.md")), true);
});

test("retirement refuses a locally deleted tracked destination", (t) => {
  const f = retirementFixture(t);
  const destination = join(f.dir, "retired", "exclusive.md");
  writeFileSync(destination, "prior history\n");
  execFileSync("git", ["-C", f.dir, "add", "retired/exclusive.md"]);
  execFileSync("git", ["-C", f.dir, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "prior retired file"]);
  rmSync(destination);
  assert.throws(() => retireProject({ dir: f.dir, project: "acme", apply: true, date: "2026-09-26" }), /dirty destination/);
  assert.equal(existsSync(join(f.dir, "exclusive.md")), true);
});
