// Process files stay in .jstyle task folders while final output goes where the user points.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createProject, startServer, which } from "./curate-fixture.mjs";
import { findBrowser, writeSolidPng } from "./png-fixture.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SHOOT = path.join(ROOT, "scripts", "shoot.mjs");
const EXPLORER = path.join(ROOT, "scripts", "build_explorer.mjs");
const PREP = path.join(ROOT, "scripts", "prep-image.mjs");
const GIT = which("git");
const BROWSER = findBrowser();

function project(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-workdir-한국어 #%-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function node(args, options) {
  return spawnSync(process.execPath, args, { encoding: "utf8", ...options });
}

const ok = (result) => assert.equal(result.status, 0, result.stdout + result.stderr);
const isFile = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() ?? false;

test("gitignore covers only process files and tasks stay separate", { skip: GIT ? false : "Git is required" }, (t) => {
  const dir = project(t);
  ok(spawnSync(GIT, ["init", "-q"], { cwd: dir, encoding: "utf8" }));
  const root = path.join(dir, ".jstyle");
  const first = path.join(root, "alpha");
  const second = path.join(root, "beta");
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), "*\n!.gitignore\n");
  fs.writeFileSync(path.join(first, "page.png"), "first");
  fs.writeFileSync(path.join(second, "page.png"), "second");
  ok(spawnSync(GIT, ["check-ignore", "-q", ".jstyle/alpha/page.png"], { cwd: dir, encoding: "utf8" }));
  const status = spawnSync(GIT, ["status", "--porcelain", "--untracked-files=all"], { cwd: dir, encoding: "utf8" });
  ok(status);
  assert.equal(status.stdout, "?? .jstyle/.gitignore\n");
  assert.equal(fs.readFileSync(path.join(first, "page.png"), "utf8"), "first");
  assert.equal(fs.readFileSync(path.join(second, "page.png"), "utf8"), "second");
  assert.ok(fs.readFileSync(path.join(ROOT, "references", "workdir.md"), "utf8").includes("*\n!.gitignore\n"));
});

test("shoot explicit root preserves shared assets and output paths", { skip: BROWSER ? false : "a local browser is required" }, (t) => {
  const dir = project(t);
  fs.mkdirSync(path.join(dir, "pages"));
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "assets/shared.css"), "body { color: rgb(1, 2, 3); }");
  const page = path.join(dir, "pages/page.html");
  fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><title>작업 공간</title>
<link rel="stylesheet" href="../assets/shared.css"></head><body><h1>테스트 페이지</h1><script>
if (getComputedStyle(document.body).color !== 'rgb(1, 2, 3)') console.error('SHARED_ASSET_MISSING');
</script></body></html>`);
  const work = path.join(dir, ".jstyle", "캡처 작업");
  const candidate = path.join(work, "explore/candidate.html");
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  const outsideFile = dir + "-outside.html";
  fs.writeFileSync(outsideFile, "outside fixture");
  t.after(() => fs.rmSync(outsideFile, { force: true }));
  fs.writeFileSync(path.join(work, ".env"), "synthetic");
  fs.writeFileSync(path.join(work, "credentials.json"), "synthetic");
  fs.symlinkSync(outsideFile, path.join(work, "escape.txt"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git/config"), "synthetic");
  fs.writeFileSync(candidate, `<!doctype html><html><head><meta charset="utf-8"><title>안</title>
<link rel="stylesheet" href="../../../assets/shared.css"></head><body>비교할 페이지<script type="module">
if (getComputedStyle(document.body).color !== 'rgb(1, 2, 3)') console.error('SHARED_ASSET_MISSING');
const root = encodeURI('/.jstyle/캡처 작업');
for (const path of [\`\${root}/.env\`, \`\${root}/credentials.json\`, \`\${root}/escape.txt\`, '/.git/config']) {
  if ((await fetch(path)).status !== 404) console.error('WORKSPACE_SECRET_LEAK ' + path);
}
console.error('CANDIDATE_LOADED');
</script></body></html>`);
  const env = { ...process.env, CHROME_PATH: BROWSER };
  const shoot = (args, cwd) => node([SHOOT, ...args], { cwd, env, timeout: 90000 });
  ok(shoot([`${page},${candidate}`, "--root", dir, "--out", path.join(work, "shots")], work));
  assert.ok(isFile(path.join(work, "shots/page.png")));
  assert.ok(isFile(path.join(work, "shots/candidate.png")));
  const report = fs.readFileSync(path.join(work, "shots/report.json"), "utf8");
  assert.ok(!report.includes("SHARED_ASSET_MISSING"));
  assert.ok(!report.includes("WORKSPACE_SECRET_LEAK"));
  assert.ok(report.includes("CANDIDATE_LOADED"));
  assert.equal(fs.existsSync(path.join(dir, "shots")), false);
  const explicit = path.join(dir, "formal-evidence");
  ok(shoot([page, "--root", dir, "--out", explicit], work));
  assert.ok(isFile(path.join(explicit, "page.png")));
  ok(shoot([page, "--out", path.join(dir, "default-shots")], dir));
  assert.ok(fs.readFileSync(path.join(dir, "default-shots/report.json"), "utf8").includes("SHARED_ASSET_MISSING"));
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  let result = shoot([page, "--root", outside, "--out", path.join(work, "other-shots")], work);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stderr.includes("로컬 대상이 --root 밖에 있습니다"));
  result = shoot([`${page},${outsideFile}`, "--root", dir, "--out", path.join(work, "mixed-shots")], work);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stderr.includes("로컬 대상이 --root 밖에 있습니다"));
  for (const broad of [os.tmpdir(), path.parse(dir).root]) {
    result = shoot([page, "--root", broad, "--out", path.join(work, "broad-shots")], work);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stderr.includes("범위가 너무 넓습니다"), broad);
  }
});

let server;
before(async () => {
  server = await startServer();
});
after(() => server.close());

test("curate defaults to task workdir and honors explicit paths", (t) => {
  const p = createProject(t, server);
  const work = path.join(p.cwd, ".jstyle", "자료 작업");
  fs.mkdirSync(work, { recursive: true });
  const search = ["search", "wood", "--kind", "texture", "--limit", "1"];
  p.runCli(search, { fixture: true, cwd: work });
  assert.ok(isFile(path.join(work, ".curate-cache.json")));
  p.runCli(["fetch", p.base + "/image"], { cwd: work });
  assert.ok(fs.readdirSync(path.join(work, "assets")).some((name) => name.endsWith(".png")));
  assert.equal(fs.existsSync(path.join(p.cwd, "assets")), false);
  const explicit = path.join(p.cwd, "formal-assets");
  p.runCli(["fetch", p.base + "/image", "--dir", explicit], { cwd: work });
  assert.ok(fs.readdirSync(explicit).some((name) => name.endsWith(".png")));
  const cache = path.join(p.cwd, "formal-cache.json");
  p.runCli([...search, "--cache", cache], { fixture: true, cwd: work });
  assert.ok(isFile(cache));
  const shared = path.join(p.cwd, ".curate-cache.json");
  p.runCli(search, { fixture: true, cwd: p.cwd });
  const other = path.join(p.cwd, ".jstyle", "다른 이미지 작업");
  fs.mkdirSync(other, { recursive: true });
  let result = p.runCli([...search, "--dir", path.join(p.cwd, "assets")], { fixture: true, cwd: other });
  assert.equal(JSON.parse(result.stdout).cache, shared);
  const local = path.join(other, ".curate-cache.json");
  result = p.runCli([...search, "--dir", path.join(p.cwd, "assets"), "--cache", local], { fixture: true, cwd: other });
  assert.equal(JSON.parse(result.stdout).cache, local);
});

test("explorer stays with candidates and explicit output", (t) => {
  const dir = project(t);
  const work = path.join(dir, ".jstyle", "비교 작업");
  const candidates = path.join(work, "explore");
  fs.mkdirSync(candidates, { recursive: true });
  fs.writeFileSync(path.join(candidates, "a.html"), '<!doctype html><html><head><meta charset="utf-8"><title>안 A</title></head><body>A</body></html>');
  ok(node([EXPLORER, "explore"], { cwd: work, timeout: 30000 }));
  assert.ok(isFile(path.join(candidates, "style-explorer.html")));
  assert.equal(fs.existsSync(path.join(work, "style-explorer.html")), false);
  const explicit = path.join(dir, "delivery", "comparison.html");
  fs.mkdirSync(path.dirname(explicit));
  ok(node([EXPLORER, "explore", "--output", explicit], { cwd: work, timeout: 30000 }));
  assert.ok(isFile(explicit));
  const other = path.join(dir, ".jstyle", "다른 작업");
  fs.mkdirSync(path.join(other, "explore"), { recursive: true });
  fs.writeFileSync(path.join(other, "explore/b.html"), '<!doctype html><html><head><meta charset="utf-8"><title>안 B</title></head><body>B</body></html>');
  ok(node([EXPLORER, "explore"], { cwd: other, timeout: 30000 }));
  assert.ok(isFile(path.join(candidates, "style-explorer.html")));
  assert.ok(isFile(path.join(other, "explore/style-explorer.html")));
  assert.ok(fs.readFileSync(path.join(candidates, "style-explorer.html"), "utf8").includes("안 A"));
});

test("prep final assets and srcset use project root", { skip: BROWSER ? false : "a local browser is required" }, (t) => {
  const dir = project(t);
  const source = path.join(dir, ".jstyle", "이미지 작업", "assets/source.png");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  writeSolidPng(source, 256, 256, [120, 80, 40]);
  const output = path.join(dir, "assets/web");
  const result = node([PREP, source, "--widths", "64,128,256", "--out", output], { cwd: dir, env: { ...process.env, CHROME_PATH: BROWSER }, timeout: 90000 });
  ok(result);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.errors, []);
  assert.ok(payload.files[0].outputs.length >= 2);
  const html = payload.files[0].html;
  const src = html.split('src="')[1].split('"')[0];
  const srcset = html.split('srcset="')[1].split('"')[0];
  const urls = srcset.split(", ").map((item) => item.slice(0, item.lastIndexOf(" ")));
  assert.ok(urls.length >= 2);
  for (const url of [src, ...urls]) {
    assert.ok(!/^(\/|file:|http:|https:)/.test(url), url);
    assert.ok(!url.startsWith("../"), url);
    assert.ok(!url.includes(".jstyle"), url);
    assert.ok(isFile(path.join(dir, decodeURIComponent(url))), url);
  }
});
