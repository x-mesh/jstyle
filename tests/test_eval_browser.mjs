import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findChrome } from "../scripts/chrome.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = path.join(ROOT, "bin", "jstyle.mjs");
const CHROME = (() => {
  try {
    return findChrome();
  } catch {
    return null;
  }
})();

const PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>평가 시험</title><link rel="icon" href="data:,">
<style>body{margin:0;font:16px sans-serif}.wide{width:900px;height:20px;background:#ccc}
@media (prefers-color-scheme: dark){body{background:#111;color:#eee}}</style></head>
<body><main><h1>Lorem ipsum 제목</h1><div class="wide"></div>
<a href="/missing">없는 링크</a> <a href="/private/x">비공개</a> <a href="/about">소개</a>
<form><label>이메일 <input name="email"></label><button>제출</button></form></main>
<script>console.error("boom"); fetch("/api/fail")</script></body></html>`;

function serve() {
  const server = createServer((req, res) => {
    if (req.url === "/robots.txt") return res.end("User-agent: *\nDisallow: /private\n");
    if (req.url === "/api/fail") { res.writeHead(500); return res.end("fail"); }
    if (req.url === "/" || req.url === "/about") { res.setHeader("content-type", "text/html; charset=utf-8"); return res.end(PAGE); }
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

function run(args) {
  return new Promise((ok) => {
    const child = spawn(process.execPath, [CLI, "eval", ...args], { env: { ...process.env, NO_COLOR: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (status) => ok({ status, stdout, stderr }));
  });
}

test("eval records read-only evidence and gate leads for a local site", { skip: CHROME ? false : "Chrome, Chromium, or Edge is needed", timeout: 240000 }, async (t) => {
  const server = await serve();
  t.after(() => server.close());
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-eval-test-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const base = `http://127.0.0.1:${server.address().port}`;

  const result = await run([`${base}/`, "/about", "/private/a", "--mode", "quick", "--links", "--dark", "--no-axe", "--pace", "0", "--out", out]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.pages, 3);
  assert.equal(summary.opened, 2);
  assert.equal(summary.gates.http5xx, 1);
  assert.equal(summary.gates.consoleErrorsFirstParty, 1);
  assert.equal(summary.gates.internalLinks4xx, 1);
  assert.equal(summary.gates.placeholder, 2);
  assert.equal(summary.gates.layoutBreaks, 2);
  assert.equal(summary.coverage.deviceEmulation, "phone");
  assert.deepEqual(summary.coverage.robotsSkipped, [`${base}/private/a`]);

  const evidence = JSON.parse(fs.readFileSync(summary.evidence, "utf8"));
  const [home, about] = evidence.pages;
  assert.equal(home.widths[375].layout.media.dpr, 3);
  assert.equal(home.widths[375].layout.media.pointerCoarse, true);
  assert.equal(home.widths[1440].layout.media.pointerCoarse, false);
  assert.ok(home.widths[375].layout.horizontalPageScroll > 0);
  assert.equal(home.head.title, "평가 시험");
  assert.deepEqual(home.forms.forms[0].genericSubmit, ["제출"]);
  assert.equal(home.perf.inpStatus, "no interaction");
  assert.equal(home.darkScheme, true);
  assert.ok(home.style.distinct.fontSizes >= 1);
  assert.equal(about.style, undefined);
  for (const file of ["home-1440-fold.png", "home-375-fold.png", "home-1440-full.png", "home-375-full.png", "home-dark-1440-fold.png", "about-1440-fold.png"]) {
    assert.ok(fs.statSync(path.join(out, file)).size > 0, file);
  }
  assert.ok(!fs.existsSync(path.join(out, "about-375-full.png")));
  assert.deepEqual(evidence.links.map((l) => [new URL(l.url).pathname, l.status ?? l.skipped]), [["/missing", 404], ["/private/x", "robots"]]);
});

test("a cross-site iframe does not hold every later load at the network idle cap", { skip: CHROME ? false : "Chrome, Chromium, or Edge is needed", timeout: 120000 }, async (t) => {
  const frame = createServer((req, res) => { res.setHeader("content-type", "text/html"); res.end("<!doctype html><p>frame</p>"); });
  await new Promise((ok) => frame.listen(0, "127.0.0.1", ok));
  const framePort = frame.address().port;
  const site = createServer((req, res) => {
    if (req.url === "/robots.txt") return res.end("");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (req.url === "/framed") return res.end(`<!doctype html><html lang="en"><title>framed</title><iframe src="http://localhost:${framePort}/"></iframe></html>`);
    res.end('<!doctype html><html lang="en"><title>plain</title><p>plain</p></html>');
  });
  await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
  t.after(() => { frame.close(); site.close(); });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-eval-frame-"));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const base = `http://127.0.0.1:${site.address().port}`;

  const result = await run([`${base}/framed`, "/plain", "--mode", "quick", "--widths", "1440", "--no-axe", "--pace", "0", "--out", out]);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(JSON.parse(result.stdout).evidence, "utf8"));
  for (const page of evidence.pages) assert.ok(page.widths[1440].loadMs < 8000, `${page.slug} waited ${page.widths[1440].loadMs}ms`);
});
