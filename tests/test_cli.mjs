import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { createServer as httpServer, request } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { API, CHOICE_FILE, CHOICE_PATH, addProject, createServer, explorerChoice, hubChoice, hubProject } from "../scripts/serve.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
// Servers started by these tests record themselves; keep that out of the real ~/.jstyle.
process.env.JSTYLE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-home-"));
// No detached daemon unless a test asks for one with daemonEnv(); servers stay children of the test.
process.env.JSTYLE_NO_DAEMON = "1";
const CLI = path.join(ROOT, "bin", "jstyle.mjs");
// How a jstyle server ended by SIGTERM exits. Windows runs no SIGTERM handler: it ends the process at once with exit code 1.
const TERMINATED = process.platform === "win32" ? [1] : [143, "SIGTERM"];

function jstyle(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, ...options });
}

function fetch(port, method, pathname, { headers = {}, body, host = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host, port, method, path: pathname, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function buildExplorer(t, names = ["a", "b"]) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-cli-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  for (const name of names) fs.writeFileSync(path.join(folder, `${name}.html`), `<title>Direction ${name}</title><main>${name}</main>`);
  const run = jstyle(["explore", folder], { timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  return folder;
}

function waitForUrl(child) {
  let stderr = "";
  return new Promise((resolve, reject) => {
    child.stderr.on("data", (data) => {
      stderr += data;
      const match = /Serving .* at http:\/\/127\.0\.0\.1:(\d+)\/\S*\?t=([0-9a-f]+)/.exec(stderr);
      if (match) resolve({ port: Number(match[1]), token: match[2] });
    });
    child.on("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
  });
}

async function listen(page, root = ROOT) {
  const server = createServer({ root, page });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

test("the bare root redirects to the start page for GET and HEAD", async (t) => {
  for (const page of ["assets/kit/index.html", "assets/extended/index.html#effects"]) {
    const server = await listen(page);
    t.after(() => server.close());
    const { port } = server.address();
    for (const method of ["GET", "HEAD"]) {
      for (const pathname of ["/", "/?from=phone"]) {
        const response = await fetch(port, method, pathname);
        assert.equal(response.status, 302, `${method} ${pathname}`);
        const [file, hash] = page.split("#");
        const search = pathname.slice(1);
        assert.equal(response.headers.location, "/" + file + search + (hash ? "#" + hash : ""));
      }
    }
  }
});

test("other paths are served as files without caching and cannot leave the root", async (t) => {
  const server = await listen("assets/kit/index.html");
  t.after(() => server.close());
  const { port } = server.address();
  const page = await fetch(port, "GET", "/assets/style-explorer.html");
  assert.equal(page.status, 200);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal(page.headers["content-type"], "text/html");
  assert.equal((await fetch(port, "GET", "/assets/")).status, 200);
  assert.equal((await fetch(port, "GET", "/assets")).status, 301);
  assert.equal((await fetch(port, "GET", "/%2e%2e/%2e%2e/etc/passwd")).status, 404);
  assert.equal((await fetch(port, "GET", "/missing.html")).status, 404);
});

test("help, version and unknown commands follow the exit code contract", () => {
  const help = jstyle(["--help"]);
  assert.equal(help.status, 0);
  for (const name of ["explore", "serve", "shoot", "media", "image", "measure", "doctor", "update"]) assert.match(help.stdout, new RegExp(`\\n  ${name} `));
  assert.match(jstyle(["version"]).stdout, /^jstyle \S+\n$/);
  const unknown = jstyle(["explor"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /알 수 없는 명령: explor/);
  assert.match(unknown.stderr, /try: jstyle explore/);
  assert.equal(jstyle([]).status, 2);
});

// spawnSync would block the stub server below, so update runs as a child the test awaits.
function jstyleAt(cli, args, env, cwd = undefined) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, NO_COLOR: "1", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => (stdout += data));
    child.stderr.on("data", (data) => (stderr += data));
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

// An installed copy: npx skills copies the files without .git.
function installedCopy(t, version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-installed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "bin"));
  fs.copyFileSync(CLI, path.join(root, "bin", "jstyle.mjs"));
  // which only finds a command that it can run.
  fs.chmodSync(path.join(root, "bin", "jstyle.mjs"), 0o755);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
  return root;
}

async function updateServer(t, files) {
  const asked = [];
  const server = httpServer((req, res) => {
    asked.push(req.url);
    const body = files[req.url];
    res.writeHead(body === undefined ? 404 : 200).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, asked };
}

test("update refuses a git checkout before it asks for the latest version", () => {
  const run = jstyle(["update"], { env: { ...process.env, NO_COLOR: "1", JSTYLE_UPDATE_URL: "http://127.0.0.1:9" } });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /git으로 받은 폴더입니다\. 그 폴더에서 git pull을 실행하세요/);
  assert.doesNotMatch(run.stderr, /최신 버전을 확인하지 못했습니다/);
});

test("update --check compares versions and installs nothing", async (t) => {
  const root = installedCopy(t, "0.1.0");
  const cli = path.join(root, "bin", "jstyle.mjs");
  const remote = await updateServer(t, { "/package.json": JSON.stringify({ version: "0.2.0" }), "/install.sh": "exit 9" });
  const newer = await jstyleAt(cli, ["update", "--check"], { JSTYLE_UPDATE_URL: remote.url });
  assert.equal(newer.status, 0, newer.stderr);
  assert.match(newer.stdout, /현재 jstyle 0\.1\.0\n최신 jstyle 0\.2\.0\n/);
  assert.match(newer.stderr, /update: jstyle update/);
  assert.deepEqual(remote.asked, ["/package.json"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, "0.1.0");

  const same = await jstyleAt(cli, ["update", "--check"], { JSTYLE_UPDATE_URL: remote.url, JSTYLE_TEST_VERSION: "0.2.0" });
  assert.match(same.stdout, /최신 버전입니다/);

  const prerelease = await jstyleAt(cli, ["update", "--check"], { JSTYLE_UPDATE_URL: remote.url, JSTYLE_TEST_VERSION: "0.2.0-rc.1" });
  assert.match(prerelease.stderr, /update: jstyle update/);

  const offline = await jstyleAt(cli, ["update", "--check"], { JSTYLE_UPDATE_URL: "http://127.0.0.1:9" });
  assert.equal(offline.status, 1);
  assert.match(offline.stderr, /최신 버전을 확인하지 못했습니다/);
});

test("update runs main's install.sh when the version differs or with --force", { skip: process.platform === "win32" && "install.sh needs bash" }, async (t) => {
  const root = installedCopy(t, "0.1.0");
  const cli = path.join(root, "bin", "jstyle.mjs");
  const install = `printf '{"version":"0.2.0"}' > "$JSTYLE_FAKE_ROOT/package.json"\necho "installer ran from $(dirname "$0")"\n`;
  const remote = await updateServer(t, { "/package.json": JSON.stringify({ version: "0.2.0" }), "/install.sh": install });
  // A jstyle checkout in the current folder must not become the installer's source.
  const run = await jstyleAt(cli, ["update"], { JSTYLE_UPDATE_URL: remote.url, JSTYLE_FAKE_ROOT: root }, ROOT);
  assert.equal(run.status, 0, run.stderr);
  const ranFrom = /installer ran from (\S*jstyle-update-\S+)/.exec(run.stdout);
  assert.ok(ranFrom, run.stdout);
  assert.equal(fs.existsSync(ranFrom[1]), false);
  assert.match(run.stdout, /✓ jstyle 0\.1\.0 → 0\.2\.0/);
  assert.deepEqual(remote.asked, ["/package.json", "/install.sh"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, "0.2.0");

  const again = await jstyleAt(cli, ["update"], { JSTYLE_UPDATE_URL: remote.url, JSTYLE_FAKE_ROOT: root });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /최신 버전입니다/);
  assert.deepEqual(remote.asked, ["/package.json", "/install.sh", "/package.json"]);

  const forced = await jstyleAt(cli, ["update", "--force"], { JSTYLE_UPDATE_URL: remote.url, JSTYLE_FAKE_ROOT: root });
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /✓ jstyle 0\.2\.0 다시 설치/);
  assert.deepEqual(remote.asked.slice(3), ["/package.json", "/install.sh"]);
});

test("update reports an installer that fails or leaves this copy behind", { skip: process.platform === "win32" && "install.sh needs bash" }, async (t) => {
  const root = installedCopy(t, "0.1.0");
  const cli = path.join(root, "bin", "jstyle.mjs");
  const first = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-bin-"));
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-bin-"));
  t.after(() => [first, linkDir].forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
  const files = { "/package.json": JSON.stringify({ version: "0.2.0" }), "/install.sh": "exit 3\n" };
  const remote = await updateServer(t, files);
  const env = { JSTYLE_UPDATE_URL: remote.url, JSTYLE_BIN_DIR: linkDir, PATH: `${first}${path.delimiter}${linkDir}${path.delimiter}${process.env.PATH}` };
  const failed = await jstyleAt(cli, ["update"], env);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /install\.sh가 실패했습니다\(종료 코드 3\)/);

  // install.sh linked JSTYLE_BIN_DIR to the latest copy, but an older jstyle comes first on PATH.
  files["/install.sh"] = "exit 0\n";
  const latest = installedCopy(t, "0.2.0");
  fs.symlinkSync(path.join(latest, "bin", "jstyle.mjs"), path.join(linkDir, "jstyle"));
  fs.symlinkSync(cli, path.join(first, "jstyle"));
  const stale = await jstyleAt(cli, ["update"], env);
  assert.equal(stale.status, 1, stale.stdout);
  assert.ok(stale.stderr.includes(`업데이트 뒤에도 ${path.join(first, "jstyle")}는 jstyle 0.1.0입니다`), stale.stderr);
  assert.doesNotMatch(stale.stdout, /✓ jstyle 0\.1\.0 →/);

  // A wrapper script on PATH has no link to follow; its own version answer counts.
  fs.rmSync(path.join(first, "jstyle"));
  fs.writeFileSync(path.join(first, "jstyle"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(latest, "bin", "jstyle.mjs")}" "$@"\n`, { mode: 0o755 });
  const wrapped = await jstyleAt(cli, ["update"], env);
  assert.equal(wrapped.status, 0, wrapped.stderr);
  assert.match(wrapped.stdout, /최신 버전\(0\.2\.0\)을 실행하지만/);
  fs.rmSync(path.join(first, "jstyle"));

  // Without a jstyle on PATH, nothing says which copy the next command runs.
  const bash = spawnSync("which", ["bash"], { encoding: "utf8" }).stdout.trim();
  const unseen = await jstyleAt(cli, ["update"], { ...env, PATH: `${linkDir}-none${path.delimiter}${path.dirname(bash)}` });
  assert.equal(unseen.status, 1, unseen.stdout);
  assert.match(unseen.stderr, /PATH에서 jstyle을 찾지 못했습니다/);

  // The jstyle on PATH runs the latest copy, the way it does when install.sh picks ~/.claude over ~/.agents.
  const moved = await jstyleAt(cli, ["update"], env);
  assert.equal(moved.status, 0, moved.stderr);
  assert.match(moved.stdout, /jstyle는 최신 버전\(0\.2\.0\)을 실행하지만 .* 아직 jstyle 0\.1\.0입니다/);
  assert.match(moved.stderr, /check: jstyle doctor/);
});

test("update --force installs an older main", { skip: process.platform === "win32" && "install.sh needs bash" }, async (t) => {
  const root = installedCopy(t, "0.3.0");
  const cli = path.join(root, "bin", "jstyle.mjs");
  const install = `printf '{"version":"0.2.0"}' > "$JSTYLE_FAKE_ROOT/package.json"\n`;
  const remote = await updateServer(t, { "/package.json": JSON.stringify({ version: "0.2.0" }), "/install.sh": install });
  const run = await jstyleAt(cli, ["update", "--force"], { JSTYLE_UPDATE_URL: remote.url, JSTYLE_FAKE_ROOT: root });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /✓ jstyle 0\.3\.0 → 0\.2\.0/);
  assert.deepEqual(remote.asked, ["/package.json", "/install.sh"]);
});

test("update without bash names the npx command and installs nothing", async (t) => {
  const cli = path.join(installedCopy(t, "0.1.0"), "bin", "jstyle.mjs");
  const remote = await updateServer(t, { "/package.json": JSON.stringify({ version: "0.2.0" }), "/install.sh": "exit 9\n" });
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-nopath-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  // Windows takes this branch by platform; elsewhere a PATH without bash does.
  const run = await jstyleAt(cli, ["update"], { JSTYLE_UPDATE_URL: remote.url, PATH: empty });
  assert.equal(run.status, 1, run.stdout);
  assert.match(run.stderr, /install\.sh를 실행할 bash가 없습니다/);
  assert.match(run.stderr, /update: npx skills add x-mesh\/jstyle -g -s jstyle/);
  assert.deepEqual(remote.asked, ["/package.json"]);
});

test("update does not go back to an older main without --force", async (t) => {
  const files = { "/install.sh": "exit 9\n" };
  const remote = await updateServer(t, files);
  for (const [mine, main] of [["0.3.0", "0.2.0"], ["0.10.0", "0.9.0"], ["0.3.0", "0.3.0-rc.1"]]) {
    const cli = path.join(installedCopy(t, mine), "bin", "jstyle.mjs");
    files["/package.json"] = JSON.stringify({ version: main });
    for (const args of [["update"], ["update", "--check"]]) {
      const run = await jstyleAt(cli, args, { JSTYLE_UPDATE_URL: remote.url });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /main보다 새 버전입니다\. main 버전으로 내리려면 jstyle update --force/, `${mine} over ${main}`);
    }
  }
  assert.equal(remote.asked.filter((url) => url === "/install.sh").length, 0);
});

test("explore builds without serving when it is not run from a terminal", (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-cli-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, "a.html"), "<title>First</title><main>One</main>");
  fs.writeFileSync(path.join(folder, "b.html"), "<main>Two</main>");
  const run = jstyle(["explore", folder], { timeout: 30000 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.candidates, 2);
  // .native expands Windows 8.3 short names (RUNNER~1) as the builder's path resolution does.
  assert.equal(fs.realpathSync.native(result.output), fs.realpathSync.native(path.join(folder, "style-explorer.html")));
  assert.match(run.stderr, /next: jstyle serve .* --wait/);
  const again = jstyle(["explore", folder]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /--force/);
  assert.equal(jstyle(["explore", "--port", "x", folder]).status, 2);
});

test("explore --serve serves the built page and stops on SIGINT", async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-cli-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, "a.html"), "<main>One</main>");
  const child = spawn(process.execPath, [CLI, "explore", folder, "--serve", "--no-open", "--port", "0"], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => child.kill("SIGKILL"));
  let stderr = "";
  const port = await new Promise((resolve, reject) => {
    child.stderr.on("data", (data) => {
      stderr += data;
      const match = /Serving .* at http:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);
      if (match) resolve(Number(match[1]));
    });
    child.on("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
  });
  const root = await fetch(port, "GET", "/");
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, "/style-explorer.html");
  assert.equal((await fetch(port, "GET", "/style-explorer.html")).status, 200);
  const exit = new Promise((resolve) => child.on("exit", (code, signal) => resolve(code ?? signal)));
  child.kill("SIGINT");
  assert.equal(await exit, process.platform === "win32" ? "SIGINT" : 130);
});

test("a matrix explorer accepts a comment only for a page its direction has", async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-cli-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  for (const name of ["a-list", "a-detail", "b-list"]) fs.writeFileSync(path.join(folder, `${name}.html`), `<main>${name}</main>`);
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify({ screens: ["List", "Detail"], candidates: [
    { id: "a", name: "Table", screens: { List: { source: "a-list.html" }, Detail: { source: "a-detail.html" } } },
    { id: "b", name: "Cards", screens: { List: { source: "b-list.html" } } },
  ] }));
  const built = jstyle(["explore", path.join(folder, "manifest.json")], { timeout: 30000 });
  assert.equal(built.status, 0, built.stderr);
  const choice = explorerChoice(folder, "style-explorer.html", () => {});
  const server = createServer({ root: folder, page: "style-explorer.html", choice });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const post = (body) => fetch(port, "POST", CHOICE_PATH, { headers: { "Content-Type": "application/json", "X-Jstyle-Token": choice.token }, body: JSON.stringify(body) });
  const element = { label: "main", path: "body > main" };
  for (const comment of [{ id: "b", screen: "Detail", note: "x", element }, { id: "a", screen: "Settings", note: "x", element }, { id: "a", note: "x", element }, { id: "a", screen: 1, note: "x", element }]) {
    const refused = await post({ id: "a", comments: [comment] });
    assert.equal(refused.status, 400, JSON.stringify(comment));
    assert.equal(JSON.parse(refused.body).error, "comments");
  }
  const ok = await post({ id: "a", comments: [{ id: "b", screen: "List", kind: "keep", note: "Keep the cards", element }] });
  assert.equal(ok.status, 200, ok.body);
  const saved = JSON.parse(fs.readFileSync(path.join(folder, CHOICE_FILE), "utf8"));
  assert.equal(saved.id, "a");
  assert.equal(saved.number, "01");
  assert.deepEqual(saved.screens, ["List", "Detail"]);
  assert.deepEqual(saved.comments, [{ id: "b", number: "02", name: "Cards", screen: "List", kind: "keep", note: "Keep the cards", element }]);
});

test("a plain explorer refuses a comment that names a page", async (t) => {
  const folder = buildExplorer(t);
  const choice = explorerChoice(folder, "style-explorer.html", () => {});
  const server = createServer({ root: folder, page: "style-explorer.html", choice });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const post = (body) => fetch(port, "POST", CHOICE_PATH, { headers: { "Content-Type": "application/json", "X-Jstyle-Token": choice.token }, body: JSON.stringify(body) });
  const element = { label: "main", path: "body > main" };
  const refused = await post({ id: "candidate-1", comments: [{ id: "candidate-1", screen: "List", note: "x", element }] });
  assert.equal(refused.status, 400);
  const ok = await post({ id: "candidate-1", comments: [{ id: "candidate-1", note: "x", element }] });
  assert.equal(ok.status, 200);
  const saved = JSON.parse(fs.readFileSync(path.join(folder, CHOICE_FILE), "utf8"));
  assert.ok(!("screens" in saved));
  assert.ok(!("screen" in saved.comments[0]));
});

test("an explorer page posts the pick back only with its token and a JSON body", async (t) => {
  const folder = buildExplorer(t);
  const picks = [];
  const choice = explorerChoice(folder, "style-explorer.html", (record) => picks.push(record));
  const server = createServer({ root: folder, page: "style-explorer.html", choice });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const post = (headers, body) => fetch(port, "POST", CHOICE_PATH, { headers, body });
  const json = { "Content-Type": "application/json" };
  const auth = { ...json, "X-Jstyle-Token": choice.token };
  assert.equal((await post(json, JSON.stringify({ id: "candidate-1" }))).status, 403);
  assert.equal((await post({ ...json, "X-Jstyle-Token": "0".repeat(32) }, JSON.stringify({ id: "candidate-1" }))).status, 403);
  assert.equal((await post({ "X-Jstyle-Token": choice.token, "Content-Type": "text/plain" }, JSON.stringify({ id: "candidate-1" }))).status, 415);
  assert.equal((await post(auth, "{")).status, 400);
  assert.equal((await post(auth, JSON.stringify({ id: "missing" }))).status, 400);
  assert.equal((await post(auth, JSON.stringify({ id: "candidate-1", notes: "x".repeat(4001) }))).status, 400);
  assert.equal((await post(auth, JSON.stringify({ id: "candidate-1", notes: "x".repeat(300 * 1024) }))).status, 413);
  const element = { label: "th.col", path: "body > table > thead > tr > th:nth-of-type(2)", size: "120x32", text: "Owner", parent: { label: "tr", path: "body > table > thead > tr" }, styles: { "font-size": "12px" }, children: [] };
  for (const comments of [{}, [{ id: "missing", note: "x", element }], [{ id: "candidate-1", note: " ", element }], [{ id: "candidate-1", note: "x", element: { label: "th" } }],
    [{ id: "candidate-1", note: "x", element: { ...element, styles: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "v"])) } }],
    [{ id: "candidate-1", note: "x", kind: "love", element }],
    Array.from({ length: 51 }, () => ({ id: "candidate-1", note: "x", element }))]) {
    assert.equal((await post(auth, JSON.stringify({ id: "candidate-1", comments }))).status, 400, JSON.stringify(comments).slice(0, 80));
  }
  // A null comment used to throw inside the request handler and end the whole server.
  assert.equal((await post(auth, JSON.stringify({ id: "candidate-1", comments: [null] }))).status, 400);
  assert.equal((await fetch(port, "GET", "/style-explorer.html")).status, 200);
  // Nothing picked, noted or commented would end --wait with an empty result.
  const empty = await post(auth, JSON.stringify({ id: null }));
  assert.equal(empty.status, 400);
  assert.equal(JSON.parse(empty.body).error, "empty");
  assert.equal(fs.existsSync(path.join(folder, CHOICE_FILE)), false);
  assert.equal(picks.length, 0);
  const ok = await post(auth, JSON.stringify({ id: "candidate-2", notes: "Less padding", viewport: "mobile", comments: [{ id: "candidate-1", note: "Header too dense", element: { ...element, extra: "dropped" } }] }));
  assert.equal(ok.status, 200);
  // Without --wait nobody receives the pick right away, so the page must not say it was sent.
  assert.equal(JSON.parse(ok.body).waiting, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(folder, CHOICE_FILE), "utf8"));
  assert.deepEqual({ ...saved, at: undefined, fingerprint: undefined },
    { round: "01", number: "02", id: "candidate-2", name: "Direction b", baseline: false, notes: "Less padding", viewport: "mobile", at: undefined, fingerprint: undefined,
      comments: [{ id: "candidate-1", number: "01", name: "Direction a", kind: "change", note: "Header too dense", element }] });
  assert.match(saved.fingerprint, /^[0-9a-f]{24}$/);
  assert.deepEqual(picks, [saved]);
  // Comments can go without a picked direction.
  const only = await post(auth, JSON.stringify({ id: null, comments: [{ id: "candidate-2", kind: "keep", note: "Keep the list", element }] }));
  assert.equal(only.status, 200);
  const commentsOnly = JSON.parse(fs.readFileSync(path.join(folder, CHOICE_FILE), "utf8"));
  assert.equal(commentsOnly.id, null);
  assert.equal(commentsOnly.number, null);
  assert.deepEqual(commentsOnly.comments.map((comment) => [comment.number, comment.kind]), [["02", "keep"]]);
  assert.equal((await fetch(port, "GET", "/style-explorer.html")).status, 200);
});

test("pages other than an explorer accept no posts and no wait", async (t) => {
  const server = await listen("assets/kit/index.html");
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(port, "POST", CHOICE_PATH, { headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(response.status, 501);
  assert.equal(explorerChoice(ROOT, "assets/kit/index.html", null), null);
  assert.equal(jstyle(["kit", "--wait"]).status, 2);
  const folder = buildExplorer(t);
  const conflict = jstyle(["explore", folder, "--force", "--wait", "--no-serve"]);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /--wait/);
  const plain = path.join(folder, "plain.html");
  fs.writeFileSync(plain, "<main>Not an explorer</main>");
  const notExplorer = jstyle(["serve", plain, "--wait", "--no-open", "--port", "0"], { timeout: 10000 });
  assert.equal(notExplorer.status, 2);
  assert.match(notExplorer.stderr, /비교 화면이 아니어서/);
});

test("explore --wait prints the first pick as the last stdout line and stops", async (t) => {
  const folder = buildExplorer(t);
  const child = spawn(process.execPath, [CLI, "explore", folder, "--force", "--wait", "--no-open", "--port", "0"], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => child.kill("SIGKILL"));
  let stdout = "";
  child.stdout.on("data", (data) => { stdout += data; });
  const exit = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const { port, token } = await waitForUrl(child);
  const root = await fetch(port, "GET", `/?t=${token}`);
  assert.equal(root.headers.location, `/style-explorer.html?t=${token}`);
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": token };
  const response = await fetch(port, "POST", CHOICE_PATH, { headers, body: JSON.stringify({ id: "candidate-1", notes: "Keep the header" }) });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).waiting, 1);
  // A second pick before the server stops must not replace what --wait printed.
  const late = await fetch(port, "POST", CHOICE_PATH, { headers, body: JSON.stringify({ id: "candidate-2" }) });
  assert.equal(late.status, 409);
  assert.equal(await exit, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, CHOICE_FILE), "utf8")).id, "candidate-1");
  const lines = stdout.trim().split("\n");
  const picked = JSON.parse(lines.at(-1));
  assert.equal(picked.number, "01");
  assert.equal(picked.notes, "Keep the header");
  assert.equal(fs.realpathSync.native(picked.file), fs.realpathSync.native(path.join(folder, CHOICE_FILE)));
  assert.equal(JSON.parse(lines[0]).candidates, 2);
});

function buildPages(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-hub-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const page of ["admin", "settings"]) {
    const folder = path.join(root, page, "explore", "01");
    fs.mkdirSync(folder, { recursive: true });
    for (const name of ["a", "b"]) fs.writeFileSync(path.join(folder, `${name}.html`), `<title>${page} ${name}</title><main>${name}</main>`);
    const run = jstyle(["explore", folder], { timeout: 30000 });
    assert.equal(run.status, 0, run.stderr);
  }
  return root;
}

test("hub serves every explorer under a folder and takes picks for each page", async (t) => {
  const root = buildPages(t);
  const child = spawn(process.execPath, [CLI, "hub", root, "--wait", "--no-open", "--port", "0"], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => child.kill("SIGKILL"));
  let stdout = "";
  child.stdout.on("data", (data) => { stdout += data; });
  const exit = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const { port, token } = await waitForUrl(child);
  const slug = path.basename(root);
  // One project: the bare address goes to it, keeping the token.
  assert.equal((await fetch(port, "GET", `/?t=${token}`)).headers.location, `/${slug}/?t=${token}`);
  const page = await fetch(port, "GET", `/${slug}/`);
  assert.equal(page.status, 200);
  assert.match(page.body, /__jstyle\/hub\.json/);
  assert.equal((await fetch(port, "GET", `/${slug}`)).status, 301);
  assert.equal((await fetch(port, "GET", "/unknown/")).status, 404);
  const hub = JSON.parse((await fetch(port, "GET", `/__jstyle/hub.json?page=${encodeURIComponent(`/${slug}/`)}`)).body);
  assert.equal(hub.project, path.basename(root));
  assert.equal(hub.base, `/${slug}/`);
  assert.deepEqual(hub.entries.map((e) => [e.group, e.round, e.path, e.candidates.length, e.choice]).sort(), [
    ["admin", "01", "admin/explore/01/style-explorer.html", 2, null],
    ["settings", "01", "settings/explore/01/style-explorer.html", 2, null],
  ]);
  assert.equal((await fetch(port, "GET", `/${slug}/settings/explore/01/style-explorer.html`)).status, 200);
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": token };
  const post = (body) => fetch(port, "POST", CHOICE_PATH, { headers, body: JSON.stringify(body) });
  assert.equal((await post({ id: "candidate-1" })).status, 400);
  assert.equal((await post({ page: `/${slug}/../../etc/passwd`, id: "candidate-1" })).status, 400);
  assert.equal((await post({ page: `/${slug}/admin/explore/01/a.html`, id: "candidate-1" })).status, 400);
  assert.equal((await post({ page: "/admin/explore/01/style-explorer.html", id: "candidate-1" })).status, 400);
  const ok = await post({ page: `/${slug}/admin/explore/01/style-explorer.html`, id: "candidate-2", notes: "Keep it" });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).waiting, 1);
  assert.equal(await exit, 0);
  const picked = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(picked.page, "admin/explore/01/style-explorer.html");
  assert.equal(picked.project, slug);
  assert.equal(picked.number, "02");
  assert.equal(fs.realpathSync.native(picked.file), fs.realpathSync.native(path.join(root, "admin", "explore", "01", CHOICE_FILE)));
  assert.equal(fs.existsSync(path.join(root, "settings", "explore", "01", CHOICE_FILE)), false);
});

test("hub lists the saved status and refuses a missing folder", async (t) => {
  const root = buildPages(t);
  const child = spawn(process.execPath, [CLI, "hub", root, "--no-open", "--port", "0"], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => child.kill("SIGKILL"));
  const { port, token } = await waitForUrl(child);
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": token };
  const slug = path.basename(root);
  const sent = await fetch(port, "POST", CHOICE_PATH, { headers, body: JSON.stringify({ page: `/${slug}/settings/explore/01/style-explorer.html`, id: null, notes: "Tighter rows" }) });
  assert.equal(sent.status, 200);
  assert.equal(JSON.parse(sent.body).waiting, 0);
  const hub = JSON.parse((await fetch(port, "GET", `/__jstyle/hub.json?page=/${slug}/`)).body);
  const settings = hub.entries.find((e) => e.group === "settings");
  assert.deepEqual({ ...settings.choice, at: undefined }, { id: null, number: null, name: null, comments: 0, notes: true, at: undefined, stale: false });
  assert.equal(jstyle(["hub", path.join(root, "missing"), "--no-open"]).status, 2);
});

test("hub names the project that holds .jstyle", () => {
  assert.equal(hubProject(path.join(path.sep, "work", "noti-mesh", ".jstyle")).project, "noti-mesh");
  assert.equal(hubProject(path.join(path.sep, "work", "drafts")).project, "drafts");
  const home = os.homedir();
  assert.deepEqual(hubProject(path.join(home, "work", "noti-mesh", ".jstyle")), { project: "noti-mesh", location: path.join("~", "work", "noti-mesh") });
});

test("hub survives a broken explorer and refuses a page reached through a link outside the folder", async (t) => {
  const root = buildPages(t);
  // A built-looking file with a broken candidate list used to throw inside the hub.json handler and end the server.
  fs.writeFileSync(path.join(root, "broken.html"), '<script>\nconst DATA = {"candidates":[null]};\n</script>');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.copyFileSync(path.join(root, "admin", "explore", "01", "style-explorer.html"), path.join(outside, "style-explorer.html"));
  let linked = true;
  try {
    fs.symlinkSync(outside, path.join(root, "link"), "dir");
  } catch {
    linked = false; // Windows without symlink rights.
  }
  const child = spawn(process.execPath, [CLI, "hub", root, "--no-open", "--port", "0"], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => child.kill("SIGKILL"));
  const { port, token } = await waitForUrl(child);
  const slug = path.basename(root);
  const listed = await fetch(port, "GET", `/__jstyle/hub.json?page=/${slug}/`);
  assert.equal(listed.status, 200);
  assert.deepEqual(JSON.parse(listed.body).entries.map((e) => e.group).sort(), ["admin", "settings"]);
  assert.equal((await fetch(port, "GET", "/__jstyle/hub.json")).status, 200);
  if (linked) {
    const headers = { "Content-Type": "application/json", "X-Jstyle-Token": token };
    const escaped = await fetch(port, "POST", CHOICE_PATH, { headers, body: JSON.stringify({ page: `/${slug}/link/style-explorer.html`, id: "candidate-1" }) });
    assert.equal(escaped.status, 400);
    assert.equal(fs.existsSync(path.join(outside, CHOICE_FILE)), false);
  }
});

test("a served page records itself, answers alive and closes when idle", async (t) => {
  const folder = buildExplorer(t);
  const child = spawn(process.execPath, [CLI, "serve", path.join(folder, "style-explorer.html"), "--no-open", "--port", "0", "--idle", "0.03"], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => child.kill("SIGKILL"));
  const exit = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const { port, token } = await waitForUrl(child);
  const records = JSON.parse(jstyle(["ps", "--json"]).stdout);
  const mine = records.find((r) => r.pid === child.pid);
  assert.ok(mine, JSON.stringify(records));
  assert.equal(mine.port, port);
  assert.equal(mine.kind, "serve");
  assert.match(mine.url, new RegExp(`\\?t=${token}$`));
  assert.equal(mine.idle, 0.03);
  const alive = await fetch(port, "GET", "/__jstyle/alive");
  assert.equal(alive.status, 204);
  assert.equal(alive.headers["x-jstyle-pid"], String(child.pid));
  assert.equal(await exit, 0);
  assert.ok(!JSON.parse(jstyle(["ps", "--json"]).stdout).some((r) => r.pid === child.pid));
});

test("stop ends a recorded server and ps drops records of ended ones", async (t) => {
  const root = buildPages(t);
  const child = spawn(process.execPath, [CLI, "hub", root, "--no-open", "--port", "0"], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => child.kill("SIGKILL"));
  const exit = new Promise((resolve) => child.on("exit", (code, signal) => resolve(code ?? signal)));
  const { port } = await waitForUrl(child);
  const hub = JSON.parse(jstyle(["ps", "--json"]).stdout).find((r) => r.pid === child.pid);
  assert.equal(hub.kind, "hub");
  assert.equal(hub.idle, 30);
  assert.equal(jstyle(["stop", "1"]).status, 1);
  const stopped = jstyle(["stop", String(port)]);
  assert.equal(stopped.status, 0, stopped.stderr);
  const ended = await exit;
  assert.ok(TERMINATED.includes(ended), String(ended));
  // A record left by a process that is gone is pruned on the next listing.
  const dir = path.join(process.env.JSTYLE_HOME, "servers");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "999999.json"), JSON.stringify({ pid: 999999, port: 1, kind: "serve", project: "gone", started: new Date().toISOString(), lastActivity: new Date().toISOString(), url: "http://127.0.0.1:1/" }));
  assert.deepEqual(JSON.parse(jstyle(["ps", "--json"]).stdout).filter((r) => r.pid === 999999 || r.pid === child.pid), []);
  assert.equal(fs.existsSync(path.join(dir, "999999.json")), false);
});

test("a --wait server outlives the shell that launched it and closes with its agent", { skip: process.platform === "win32" && "the waiting process is found with ps" }, async (t) => {
  const folder = buildExplorer(t);
  const page = path.join(folder, "style-explorer.html");
  // The agent runs a shell that starts the server with nohup … & and exits shortly after.
  const agentScript = `
    const { spawnSync } = require("node:child_process");
    const shell = spawnSync("/bin/sh", ["-c", ${JSON.stringify(`nohup "${process.execPath}" "${CLI}" serve "${page}" --wait --no-open --port 0 >/dev/null 2>&1 & echo $!; sleep 0.8`)}], { encoding: "utf8" });
    process.stdout.write(shell.stdout);
    setInterval(() => {}, 1000);`;
  const agent = spawn(process.execPath, ["-e", agentScript], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => agent.kill("SIGKILL"));
  const pid = await new Promise((resolve) => agent.stdout.once("data", (data) => resolve(Number(String(data).trim()))));
  assert.ok(pid > 0);
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  await new Promise((resolve) => setTimeout(resolve, 3500));
  assert.ok(alive(), "the --wait server closed although the agent still runs");
  agent.kill("SIGKILL");
  let gone = false;
  for (let i = 0; i < 80 && !gone; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    gone = !alive();
  }
  assert.ok(gone, "the --wait server kept running after its agent ended");
  assert.ok(!JSON.parse(jstyle(["ps", "--json"]).stdout).some((r) => r.pid === pid));
});

test("a --wait server that closes without a pick fails with empty stdout", (t) => {
  const folder = buildExplorer(t);
  const run = jstyle(["serve", path.join(folder, "style-explorer.html"), "--wait", "--no-open", "--port", "0", "--idle", "0.02"], { timeout: 20000 });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, "");
});

test("stop leaves a process that does not answer as that server, and refuses a name shared by two servers", async (t) => {
  const folder = buildExplorer(t);
  const child = spawn(process.execPath, [CLI, "serve", path.join(folder, "style-explorer.html"), "--no-open", "--port", "0"], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => child.kill("SIGKILL"));
  const exit = new Promise((resolve) => child.on("exit", (code, signal) => resolve(code ?? signal)));
  const { port } = await waitForUrl(child);
  const dir = path.join(process.env.JSTYLE_HOME, "servers");
  // A record whose pid is this test process but whose port answers as the server: stop must not signal this process.
  const fake = { pid: process.pid, port, host: "127.0.0.1", kind: "serve", project: "twin", started: new Date().toISOString(), lastActivity: new Date().toISOString(), url: `http://127.0.0.1:${port}/` };
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify(fake));
  t.after(() => fs.rmSync(path.join(dir, `${process.pid}.json`), { force: true }));
  const refused = jstyle(["stop", "twin"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /응답하지 않아/);
  assert.ok(fs.existsSync(path.join(dir, `${process.pid}.json`)), "a live process lost its record");
  // Two servers named the same: a name stops neither.
  const real = JSON.parse(fs.readFileSync(path.join(dir, `${child.pid}.json`), "utf8"));
  fs.writeFileSync(path.join(dir, `${child.pid}.json`), JSON.stringify({ ...real, project: "twin" }));
  const shared = jstyle(["stop", "twin"]);
  assert.equal(shared.status, 1);
  assert.match(shared.stderr, /2개/);
  // SIGINT ends the server and removes its record. Windows ends it without running handlers,
  // so there the record stays until the next listing prunes it.
  child.kill("SIGINT");
  const ended = await exit;
  if (process.platform !== "win32") {
    assert.ok([130, "SIGINT"].includes(ended), String(ended));
    assert.equal(fs.existsSync(path.join(dir, `${child.pid}.json`)), false);
  }
  assert.ok(!JSON.parse(jstyle(["ps", "--json"]).stdout).some((r) => r.pid === child.pid));
});

function freePort() {
  return new Promise((resolve) => {
    const probe = httpServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test("a second hub run joins the running hub, and stop lets go of one project", async (t) => {
  const first = buildPages(t);
  const second = buildPages(t);
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, "hub", first, "--no-open", "--port", String(port)], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => child.kill("SIGKILL"));
  const { token } = await waitForUrl(child);
  const joined = jstyle(["hub", second, "--no-open", "--port", String(port)], { timeout: 10000 });
  assert.equal(joined.status, 0, joined.stderr);
  const reply = JSON.parse(joined.stdout.trim());
  assert.equal(reply.hub, port);
  assert.equal(reply.project, path.basename(second));
  assert.equal(reply.url, `http://127.0.0.1:${port}/${path.basename(second)}/?t=${token}`);
  // Joining the same folder again keeps one entry.
  assert.equal(JSON.parse(jstyle(["hub", second, "--no-open", "--port", String(port)]).stdout).project, path.basename(second));
  const root = await fetch(port, "GET", "/");
  assert.equal(root.status, 200);
  const listed = JSON.parse((await fetch(port, "GET", "/__jstyle/hub.json")).body);
  assert.deepEqual(listed.projects.map((p) => [p.slug, p.pages, p.rounds, p.open]).sort(), [[path.basename(first), 2, 2, 2], [path.basename(second), 2, 2, 2]].sort());
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": token };
  const page = `/${path.basename(second)}/admin/explore/01/style-explorer.html`;
  assert.equal((await fetch(port, "GET", page)).status, 200);
  const sent = await fetch(port, "POST", CHOICE_PATH, { headers, body: JSON.stringify({ page, id: "candidate-1" }) });
  assert.equal(sent.status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(second, "admin", "explore", "01", CHOICE_FILE), "utf8")).project, path.basename(second));
  const hubRecord = () => JSON.parse(jstyle(["ps", "--json"]).stdout).find((r) => r.pid === child.pid);
  assert.equal(hubRecord().projects.length, 2);
  // serve on a page the hub already has opens it there instead of a second server.
  const served = jstyle(["serve", path.join(second, "settings", "explore", "01", "style-explorer.html"), "--no-open", "--port", String(port)], { timeout: 10000 });
  assert.equal(served.status, 0, served.stderr);
  assert.match(served.stderr, new RegExp(`/${path.basename(second)}/settings/explore/01/style-explorer\\.html\\?t=${token}`));
  // --wait joins the running hub as a waiter instead of a server on another port.
  const waiter = spawn(process.execPath, [CLI, "hub", second, "--wait", "--no-open", "--port", String(port)], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => waiter.kill("SIGKILL"));
  const joinedAs = await waitForUrl(waiter);
  assert.equal(joinedAs.port, port);
  assert.equal(joinedAs.token, token);
  // A killed child that is not reaped yet still looks alive, and its record would make the name match two servers.
  await new Promise((resolve) => {
    waiter.on("exit", resolve);
    waiter.kill("SIGKILL");
  });
  const stopped = jstyle(["stop", path.basename(second)]);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.deepEqual(hubRecord().projects.map((p) => p.slug), [path.basename(first)]);
  assert.equal((await fetch(port, "GET", page)).status, 404);
});

test("the hub takes folders only with its token and refuses requests from other sites", async (t) => {
  const root = buildPages(t);
  const child = spawn(process.execPath, [CLI, "hub", root, "--no-open", "--port", "0"], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => child.kill("SIGKILL"));
  const { port, token } = await waitForUrl(child);
  const register = (body, token_ = token) => fetch(port, "POST", "/__jstyle/projects", { headers: { "Content-Type": "application/json", "X-Jstyle-Token": token_ }, body: JSON.stringify(body) });
  assert.equal((await register({ root }, "wrong")).status, 403);
  for (const bad of [path.parse(root).root, os.homedir(), path.dirname(os.homedir()), "relative/path", path.join(root, "missing")]) {
    assert.equal((await register({ root: bad })).status, 400, bad);
  }
  assert.equal((await register({ remove: path.basename(root) })).status, 409);
  // A page on another site pointing its name at 127.0.0.1 is refused; loopback names pass.
  assert.equal((await fetch(port, "GET", `/${path.basename(root)}/`, { headers: { Host: `evil.example:${port}` } })).status, 403);
  assert.equal((await fetch(port, "GET", `/${path.basename(root)}/`, { headers: { Host: `localhost:${port}` } })).status, 200);
  // jstyle's own endpoints refuse a request another site makes; the page's own requests pass.
  assert.equal((await fetch(port, "GET", "/__jstyle/alive", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await fetch(port, "GET", "/__jstyle/alive", { headers: { "Sec-Fetch-Site": "same-origin" } })).status, 204);
  // Static files stay readable from a sandboxed candidate frame, whose requests are cross-site.
  assert.equal((await fetch(port, "GET", `/${path.basename(root)}/admin/explore/01/a.html`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 200);
});

// A LAN address of this machine; link-local addresses are left out because they may not route back here.
const LAN_ADDRESS = Object.values(os.networkInterfaces()).flat().find((a) => a?.family === "IPv4" && !a.internal && !a.address.startsWith("169.254."))?.address;

function waitForServing(child) {
  let stderr = "";
  return new Promise((resolve, reject) => {
    child.stderr.on("data", (data) => {
      stderr += data;
      const match = /Serving .* at http:\/\/([^:/\s]+):(\d+)\/\S*\?t=([0-9a-f]+)/.exec(stderr);
      if (match) resolve({ host: match[1], port: Number(match[2]), token: match[3] });
    });
    child.on("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
  });
}

test("a hub answers 403 for a file it cannot read and keeps serving", { skip: process.platform === "win32" || process.getuid?.() === 0, timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-locked-"));
  const locked = path.join(root, "locked.txt");
  const shut = path.join(root, "shut");
  let child = null;
  // One hook in a fixed order: removing the folder fails until the modes are back, and a failed hook skips the ones after it.
  t.after(() => {
    child?.kill("SIGKILL");
    fs.chmodSync(locked, 0o600);
    fs.chmodSync(shut, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.writeFileSync(locked, "secret");
  fs.mkdirSync(shut);
  fs.chmodSync(locked, 0o000);
  fs.chmodSync(shut, 0o000);
  child = spawn(process.execPath, [CLI, "hub", root, "--no-open", "--port", "0"], { env: { ...process.env, NO_COLOR: "1" } });
  const { port } = await waitForUrl(child);
  const slug = path.basename(root);
  assert.equal((await fetch(port, "GET", `/${slug}/locked.txt`)).status, 403);
  assert.equal((await fetch(port, "GET", `/${slug}/shut/`)).status, 403);
  assert.equal((await fetch(port, "GET", "/__jstyle/alive")).status, 204);
});

test("a hub hides dot files and links that leave the project", { timeout: 30000 }, async (t) => {
  const root = buildPages(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  fs.writeFileSync(path.join(root, ".env"), "TOKEN=1");
  fs.mkdirSync(path.join(root, ".cache"));
  fs.writeFileSync(path.join(root, ".cache", "a.txt"), "cached");
  fs.symlinkSync(outside, path.join(root, "away"));
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "secret.txt"));
  const child = spawn(process.execPath, [CLI, "hub", root, "--no-open", "--port", "0"], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => child.kill("SIGKILL"));
  const { port } = await waitForUrl(child);
  const slug = path.basename(root);
  for (const hidden of [".env", ".cache/a.txt", "away/secret.txt", "secret.txt"]) {
    assert.equal((await fetch(port, "GET", `/${slug}/${hidden}`)).status, 404, hidden);
  }
  assert.equal((await fetch(port, "GET", `/${slug}/admin/explore/01/a.html`)).status, 200);
});

test("a hub on a LAN address is not shared; another project starts its own server", { skip: !LAN_ADDRESS && "no LAN address", timeout: 30000 }, async (t) => {
  const first = buildPages(t);
  const second = buildPages(t);
  const port = await freePort();
  const lan = spawn(process.execPath, [CLI, "hub", first, "--no-open", "--host", LAN_ADDRESS, "--port", String(port)], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => lan.kill("SIGKILL"));
  await waitForServing(lan);
  const own = spawn(process.execPath, [CLI, "hub", second, "--no-open", "--port", String(port)], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => own.kill("SIGKILL"));
  const started = await waitForServing(own);
  assert.equal(started.host, "127.0.0.1");
  assert.equal(started.port, port);
});

test("a request on a LAN address must name an IP, a single-label, .local or .ts.net host", { skip: !LAN_ADDRESS && "no LAN address", timeout: 30000 }, async (t) => {
  const root = buildPages(t);
  const child = spawn(process.execPath, [CLI, "hub", root, "--no-open", "--host", "0.0.0.0", "--port", "0"], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => child.kill("SIGKILL"));
  const { port } = await waitForUrl(child);
  const page = `/${path.basename(root)}/admin/explore/01/a.html`;
  const at = (name) => fetch(port, "GET", page, { host: LAN_ADDRESS, headers: { Host: `${name}:${port}` } }).then((r) => r.status);
  assert.equal(await at("evil.example"), 403);
  assert.equal(await at("rebind.attacker.example.com"), 403);
  for (const name of ["mac-studio-t", LAN_ADDRESS, "foo.tail1234.ts.net", "studio.local", os.hostname(), "[fe80::1]"]) assert.equal(await at(name), 200, name);
  // Loopback keeps its own rule.
  assert.equal((await fetch(port, "GET", page, { headers: { Host: `mac-studio-t:${port}` } })).status, 403);
});

test("removing the project a hub started with points its record at a remaining project", { timeout: 30000 }, async (t) => {
  const first = buildPages(t);
  const second = buildPages(t);
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, "hub", first, "--no-open", "--port", String(port)], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => child.kill("SIGKILL"));
  await waitForUrl(child);
  assert.equal(jstyle(["hub", second, "--no-open", "--port", String(port)]).status, 0);
  const stopped = jstyle(["stop", path.basename(first)]);
  assert.equal(stopped.status, 0, stopped.stderr);
  const record = JSON.parse(jstyle(["ps", "--json"]).stdout).find((r) => r.pid === child.pid);
  assert.equal(record.project, path.basename(second));
  assert.equal(record.root, fs.realpathSync(second));
  assert.equal(new URL(record.url).pathname, `/${path.basename(second)}/`);
  assert.equal((await fetch(port, "GET", new URL(record.url).pathname)).status, 200);
});

const hubStore = (port, label = "127.0.0.1") => path.join(process.env.JSTYLE_HOME, "hubs", `${label}-${port}.json`);

function rawRequest(port, text) {
  return new Promise((resolve) => {
    let reply = "";
    const socket = net.connect(port, "127.0.0.1", () => socket.end(text));
    socket.on("data", (data) => { reply += data; });
    socket.on("close", () => resolve(reply.split("\r\n")[0]));
    socket.on("error", () => resolve(reply.split("\r\n")[0]));
  });
}

test("a hub keeps its projects and their addresses across restarts and drops folders that are gone", { timeout: 60000 }, async (t) => {
  const first = buildPages(t);
  const twin = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-twin-"));
  t.after(() => fs.rmSync(twin, { recursive: true, force: true }));
  // A second folder with the same name gets <name>-2; that address must survive a restart.
  const second = path.join(twin, path.basename(first));
  fs.cpSync(first, second, { recursive: true });
  const gone = buildPages(t);
  const goneReal = fs.realpathSync(gone);
  const port = await freePort();
  const name = path.basename(first);
  let child = spawn(process.execPath, [CLI, "hub", first, "--no-open", "--port", String(port)], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => child.kill("SIGKILL"));
  await waitForUrl(child);
  assert.equal(JSON.parse(jstyle(["hub", second, "--no-open", "--port", String(port)]).stdout).project, `${name}-2`);
  assert.equal(jstyle(["hub", gone, "--no-open", "--port", String(port)]).status, 0);
  const saved = JSON.parse(fs.readFileSync(hubStore(port), "utf8"));
  assert.equal(saved.schema, 1);
  assert.deepEqual(saved.projects.map((p) => [p.slug, p.root]), [[name, fs.realpathSync(first)], [`${name}-2`, fs.realpathSync(second)], [path.basename(gone), goneReal]]);
  // Windows has no POSIX modes; the file lives in the user's profile there.
  if (process.platform !== "win32") assert.equal(fs.statSync(hubStore(port)).mode & 0o777, 0o600);
  await new Promise((resolve) => {
    child.on("exit", resolve);
    child.kill("SIGKILL");
  });
  fs.rmSync(gone, { recursive: true, force: true });
  // Started again from the second folder only, the hub brings the first one back and keeps both addresses.
  child = spawn(process.execPath, [CLI, "hub", second, "--no-open", "--port", String(port)], { env: { ...process.env, NO_COLOR: "1" } });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  await waitForUrl(child);
  const listed = JSON.parse((await fetch(port, "GET", "/__jstyle/hub.json")).body);
  assert.deepEqual(listed.projects.map((p) => p.slug), [name, `${name}-2`]);
  assert.equal((await fetch(port, "GET", `/${name}-2/admin/explore/01/style-explorer.html`)).status, 200);
  assert.equal((await fetch(port, "GET", `/${name}/admin/explore/01/style-explorer.html`)).status, 200);
  assert.ok(stderr.includes(goneReal), stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(hubStore(port), "utf8")).projects.map((p) => p.slug), [name, `${name}-2`]);
  // Letting go of a project also takes it out of the saved list.
  assert.equal(jstyle(["stop", `${name}-2`]).status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(hubStore(port), "utf8")).projects.map((p) => p.slug), [name]);
});

test("a --wait hub and a hub on a random port save no project list", { timeout: 30000 }, async (t) => {
  const root = buildPages(t);
  const random = spawn(process.execPath, [CLI, "hub", root, "--no-open", "--port", "0"], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => random.kill("SIGKILL"));
  const { port } = await waitForUrl(random);
  const port2 = await freePort();
  const waiter = spawn(process.execPath, [CLI, "hub", root, "--wait", "--no-open", "--port", String(port2)], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => waiter.kill("SIGKILL"));
  const waiting = await waitForUrl(waiter);
  assert.equal(fs.existsSync(hubStore(port)), false);
  assert.equal(fs.existsSync(hubStore(waiting.port)), false);
});

test("a request a server cannot parse is answered and does not end it", { timeout: 30000 }, async (t) => {
  const root = buildPages(t);
  const hub = spawn(process.execPath, [CLI, "hub", root, "--no-open", "--port", "0"], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => hub.kill("SIGKILL"));
  const { port } = await waitForUrl(hub);
  const folder = buildExplorer(t);
  const served = spawn(process.execPath, [CLI, "serve", path.join(folder, "style-explorer.html"), "--no-open", "--port", "0"], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => served.kill("SIGKILL"));
  const plain = await waitForUrl(served);
  for (const at of [port, plain.port]) {
    assert.match(await rawRequest(at, `GET //[ HTTP/1.1\r\nHost: 127.0.0.1:${at}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 400/);
    assert.equal((await fetch(at, "GET", "/__jstyle/alive")).status, 204);
  }
});

test("restoring saved projects skips bad slugs, unservable folders and repeats, and a full list lets the oldest go", async (t) => {
  const { addProject, hubChoice, restoreProjects, savedProjects } = await import("../scripts/serve.mjs");
  const { MAX_PROJECTS, readHubStore } = await import("../scripts/lib/hubstore.mjs");
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-restore-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const folder = (name) => {
    const dir = path.join(parent, name);
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync(dir);
  };
  const hub = hubChoice(() => {});
  const kept = folder("kept");
  const { restored, dropped } = restoreProjects(hub, [
    { slug: "kept", root: kept, added: "2026-01-01T00:00:00.000Z", lastUsed: "2026-01-02T00:00:00.000Z" },
    { slug: "__jstyle", root: folder("own") },
    { slug: "../up", root: folder("up") },
    { slug: "home", root: os.homedir() },
    { slug: "missing", root: path.join(parent, "missing") },
    { slug: "again", root: kept },
    { slug: "kept", root: folder("other") },
  ]);
  assert.deepEqual(restored, ["kept"]);
  assert.equal(dropped.length, 6);
  assert.deepEqual(savedProjects(hub), [{ slug: "kept", root: kept, added: "2026-01-01T00:00:00.000Z", lastUsed: "2026-01-02T00:00:00.000Z" }]);
  // A long folder name makes a long slug, and that slug must come back too.
  const longName = "l".repeat(120);
  const longHub = hubChoice(() => {});
  const longSlug = addProject(longHub, folder(longName));
  assert.deepEqual(restoreProjects(hubChoice(() => {}), savedProjects(longHub)).restored, [longSlug]);
  for (let n = 0; n < MAX_PROJECTS; n += 1) addProject(hub, folder(`p${n}`));
  assert.equal(hub.projects.size, MAX_PROJECTS);
  assert.equal(hub.projects.has("kept"), false);
  // A file this code did not write is refused as a whole, so the hub does not overwrite it unread.
  const broken = path.join(parent, "broken.json");
  fs.writeFileSync(broken, "{not json");
  assert.throws(() => readHubStore(broken), /broken\.json/);
  assert.deepEqual(readHubStore(path.join(parent, "none.json")), []);
});

test("each address keeps its own project list file", async () => {
  const { hubStoreFile } = await import("../scripts/lib/hubstore.mjs");
  const name = (host) => path.basename(hubStoreFile(host, 8765));
  assert.deepEqual(["127.0.0.1", "::1", "localhost", "0.0.0.0", "::", "192.168.1.9"].map(name), ["127.0.0.1-8765.json", "ip6-loopback-8765.json", "localhost-8765.json", "any-8765.json", "any-8765.json", "192.168.1.9-8765.json"]);
});

test("a hub that cannot take its port leaves a broken project list where it is", { timeout: 30000 }, async (t) => {
  const root = buildPages(t);
  // Another program holds the port, so this run fails with EADDRINUSE and must not touch the list.
  const holder = httpServer();
  await new Promise((resolve) => holder.listen(0, "127.0.0.1", resolve));
  t.after(() => holder.close());
  const { port } = holder.address();
  fs.mkdirSync(path.dirname(hubStore(port)), { recursive: true });
  fs.writeFileSync(hubStore(port), "{not json");
  const run = jstyle(["hub", root, "--no-open", "--port", String(port)], { timeout: 10000 });
  assert.equal(run.status, 1, run.stderr);
  assert.equal(fs.readFileSync(hubStore(port), "utf8"), "{not json");
  assert.equal(fs.existsSync(`${hubStore(port)}.broken`), false);
});

test("a pick for a page the hub refuses does not count as using its project", async (t) => {
  const { addProject, hubChoice } = await import("../scripts/serve.mjs");
  const root = buildPages(t);
  const hub = hubChoice(() => {});
  const slug = addProject(hub, root);
  hub.times.get(slug).lastUsed = "2000-01-01T00:00:00.000Z";
  const server = createServer({ root, page: "", choice: hub });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": hub.token };
  const refused = await fetch(server.address().port, "POST", CHOICE_PATH, { headers, body: JSON.stringify({ page: `/${slug}/admin/explore/01/a.html`, id: "candidate-1" }) });
  assert.equal(refused.status, 400);
  assert.equal(hub.times.get(slug).lastUsed, "2000-01-01T00:00:00.000Z");
});

test("a pick counts as using its project and saves the list", async (t) => {
  const { addProject, hubChoice, savedProjects } = await import("../scripts/serve.mjs");
  const root = buildPages(t);
  const hub = hubChoice(() => {});
  const slug = addProject(hub, root);
  hub.times.get(slug).lastUsed = "2000-01-01T00:00:00.000Z";
  let saves = 0;
  hub.onUsed = () => { saves += 1; };
  const server = createServer({ root, page: "", choice: hub });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": hub.token };
  const before = Date.now();
  const picked = await fetch(server.address().port, "POST", CHOICE_PATH, { headers, body: JSON.stringify({ page: `/${slug}/admin/explore/01/style-explorer.html`, id: "candidate-1" }) });
  assert.equal(picked.status, 200);
  assert.ok(Date.parse(savedProjects(hub)[0].lastUsed) >= before);
  assert.equal(saves, 1);
});

test("a saved slug longer than any folder name makes is not restored", async (t) => {
  const { hubChoice, restoreProjects } = await import("../scripts/serve.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-slug-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(restoreProjects(hubChoice(() => {}), [{ slug: "s".repeat(5000), root: fs.realpathSync(dir) }]).restored, []);
});

test("joining a full hub names the project that had to go, on both sides", { timeout: 120000 }, async (t) => {
  const { MAX_PROJECTS } = await import("../scripts/lib/hubstore.mjs");
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-full-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const folder = (name) => {
    const dir = path.join(parent, name);
    fs.mkdirSync(dir);
    return dir;
  };
  const hub = spawn(process.execPath, [CLI, "hub", folder("p00"), "--no-open", "--port", "0"], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => hub.kill("SIGKILL"));
  let hubErr = "";
  hub.stderr.on("data", (data) => { hubErr += data; });
  const { port, token } = await waitForUrl(hub);
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": token };
  for (let n = 1; n < MAX_PROJECTS; n += 1) {
    const reply = await fetch(port, "POST", "/__jstyle/projects", { headers, body: JSON.stringify({ root: folder(`p${String(n).padStart(2, "0")}`) }) });
    assert.equal(reply.status, 200);
  }
  const full = await fetch(port, "POST", "/__jstyle/projects", { headers, body: JSON.stringify({ root: folder("extra") }) });
  assert.deepEqual(JSON.parse(full.body).evicted, ["p00"]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.match(hubErr, /p00/);
  // The CLI that joins tells its user too.
  const joined = jstyle(["hub", folder("late"), "--no-open", "--port", String(port)]);
  assert.equal(joined.status, 0, joined.stderr);
  assert.deepEqual(JSON.parse(joined.stdout).evicted, ["p01"]);
  assert.match(joined.stderr, /p01/);
});

async function hasIpv6Loopback() {
  const probe = httpServer();
  return new Promise((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(0, "::1", () => probe.close(() => resolve(true)));
  });
}

test("a second hub run joins a hub on ::1 through ::1", { timeout: 30000 }, async (t) => {
  if (!(await hasIpv6Loopback())) return t.skip("no IPv6 loopback");
  const first = buildPages(t);
  const second = buildPages(t);
  const port = await freePort();
  const hub = spawn(process.execPath, [CLI, "hub", first, "--no-open", "--host", "::1", "--port", String(port)], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => hub.kill("SIGKILL"));
  await new Promise((resolve, reject) => {
    let stderr = "";
    hub.stderr.on("data", (data) => {
      stderr += data;
      if (/Serving .* at http:\/\/\[::1\]:\d+\//.test(stderr)) resolve();
    });
    hub.on("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
  });
  const joined = jstyle(["hub", second, "--no-open", "--port", String(port)], { timeout: 10000 });
  assert.equal(joined.status, 0, joined.stderr);
  assert.match(JSON.parse(joined.stdout).url, new RegExp(`^http://\\[::1\\]:${port}/`));
  assert.equal((await fetch(port, "GET", `/${path.basename(second)}/`, { host: "::1" })).status, 200);
});

for (const [label, text] of [["cannot be parsed", "{not json"], ["has another shape", JSON.stringify({ schema: 2, projects: [] })]]) {
  test(`a hub whose saved list ${label} sets it aside as .broken and still starts`, { timeout: 30000 }, async (t) => {
    const root = buildPages(t);
    const port = await freePort();
    fs.mkdirSync(path.dirname(hubStore(port)), { recursive: true });
    fs.writeFileSync(hubStore(port), text);
    const hub = spawn(process.execPath, [CLI, "hub", root, "--no-open", "--port", String(port)], { env: { ...process.env, NO_COLOR: "1" } });
    t.after(() => hub.kill("SIGKILL"));
    let stderr = "";
    hub.stderr.on("data", (data) => { stderr += data; });
    await waitForUrl(hub);
    // The list is set aside right after the address line, once the port is held.
    for (let n = 0; n < 50 && !fs.existsSync(`${hubStore(port)}.broken`); n += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.readFileSync(`${hubStore(port)}.broken`, "utf8"), text);
    assert.deepEqual(JSON.parse(fs.readFileSync(hubStore(port), "utf8")).projects.map((p) => p.slug), [path.basename(root)]);
    assert.match(stderr, /\.broken/);
    assert.equal((await fetch(port, "GET", `/${path.basename(root)}/`)).status, 200);
  });
}

test("an error inside a request answers 500 and the server keeps answering", async (t) => {
  let thrown = false;
  const server = createServer({
    root: ROOT,
    page: "SKILL.md",
    onActivity: () => {
      if (thrown) return;
      thrown = true;
      throw new Error("boom");
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  assert.equal((await fetch(port, "GET", "/SKILL.md")).status, 500);
  assert.equal((await fetch(port, "GET", "/SKILL.md")).status, 200);
});

test("adding a project whose list cannot be saved fails and changes nothing, even past the limit", async (t) => {
  const { addProject, hubChoice } = await import("../scripts/serve.mjs");
  const folders = Array.from({ length: 51 }, () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-cli-"));
    t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
    return folder;
  });
  const hub = hubChoice(() => {});
  const slugs = folders.slice(0, 50).map((folder) => addProject(hub, folder));
  const times = structuredClone([...hub.times]);
  const server = createServer({ root: folders[0], page: "", choice: hub });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": hub.token };
  const { id } = JSON.parse((await fetch(port, "POST", "/__jstyle/waiters", { headers, body: JSON.stringify({ project: slugs[0], page: null }) })).body);
  let evicted = null;
  hub.onEvicted = (names) => { evicted = names; };
  hub.onProjects = () => false;
  const reply = await fetch(port, "POST", "/__jstyle/projects", { headers, body: JSON.stringify({ root: folders[50] }) });
  assert.equal(reply.status, 500);
  assert.equal(JSON.parse(reply.body).error, "save");
  assert.deepEqual([...hub.projects.keys()], slugs);
  assert.deepEqual([...hub.times], times);
  assert.equal(evicted, null);
  assert.ok(hub.waiters.has(id), "the waiter of the project that would have gone was dropped");
});

test("removing a project whose list cannot be saved fails and keeps the project", async (t) => {
  const { addProject, hubChoice } = await import("../scripts/serve.mjs");
  const first = buildPages(t);
  const second = buildPages(t);
  const hub = hubChoice(() => {});
  const slugs = [addProject(hub, first), addProject(hub, second)];
  hub.onProjects = () => false;
  const server = createServer({ root: first, page: "", choice: hub });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": hub.token };
  const reply = await fetch(server.address().port, "POST", "/__jstyle/projects", { headers, body: JSON.stringify({ remove: slugs[0] }) });
  assert.equal(reply.status, 500);
  assert.equal(JSON.parse(reply.body).error, "save");
  assert.deepEqual([...hub.projects.keys()], slugs);
  assert.ok(hub.times.has(slugs[0]));
});

test("a long folder name with a supplementary-plane letter at the cut makes a whole slug", async (t) => {
  const { hubChoice } = await import("../scripts/serve.mjs");
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-emoji-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  // 244 ASCII letters and U+20000, a letter outside the BMP: 248 bytes on disk, and its two UTF-16 halves sit across the 245th unit.
  const dir = path.join(parent, `${"a".repeat(244)}\u{20000}`);
  fs.mkdirSync(dir);
  const hub = hubChoice(() => {});
  const server = createServer({ root: parent, page: "", choice: hub });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": hub.token };
  const reply = await fetch(server.address().port, "POST", "/__jstyle/projects", { headers, body: JSON.stringify({ root: dir }) });
  assert.equal(reply.status, 200, reply.body);
  const { slug } = JSON.parse(reply.body);
  assert.equal(slug.isWellFormed(), true);
});

async function hubInProcess(t, roots, options = {}) {
  const picks = [];
  const hub = hubChoice((record, file) => picks.push({ record, file }), options);
  const slugs = roots.map((root) => addProject(hub, root));
  const server = createServer({ root: roots[0], page: "", choice: hub });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address();
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": hub.token };
  const register = (body, extra = {}) => fetch(port, "POST", "/__jstyle/waiters", { headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const poll = (id, wait = 0) => fetch(port, "GET", `/__jstyle/waiters/${id}?wait=${wait}`, { headers });
  const pick = (page, id = "candidate-1") => fetch(port, "POST", CHOICE_PATH, { headers, body: JSON.stringify({ page, id }) });
  return { port, hub, slugs, headers, register, poll, pick, picks };
}

test("hub waiters: a page's waiters get its pick before project waiters, and all of them get it", { timeout: 30000 }, async (t) => {
  const root = buildPages(t);
  const { slugs: [slug], register, poll, pick } = await hubInProcess(t, [root]);
  const admin = "admin/explore/01/style-explorer.html";
  const settings = "settings/explore/01/style-explorer.html";
  const join = async (page) => JSON.parse((await register({ project: slug, page, pid: null })).body);
  const first = await join(admin);
  assert.equal(first.project, slug);
  assert.equal(first.page, admin);
  assert.match(first.url, new RegExp(`/${slug}/admin/explore/01/style-explorer\\.html\\?t=[0-9a-f]+$`));
  const second = await join(admin);
  const whole = await join(null);
  assert.equal(JSON.parse((await pick(`/${slug}/${admin}`, "candidate-2")).body).waiting, 2);
  for (const waiter of [first, second]) {
    const got = await poll(waiter.id);
    assert.equal(got.status, 200);
    const body = JSON.parse(got.body);
    assert.equal(body.page, admin);
    assert.equal(body.project, slug);
    assert.equal(body.record.number, "02");
    assert.equal(fs.realpathSync(body.file), fs.realpathSync(path.join(root, "admin", "explore", "01", CHOICE_FILE)));
  }
  assert.equal((await poll(whole.id)).status, 204);
  // No waiter on settings: the project waiter takes it.
  assert.equal(JSON.parse((await pick(`/${slug}/${settings}`)).body).waiting, 1);
  assert.equal(JSON.parse((await poll(whole.id)).body).page, settings);
  // Everyone received and left; the next pick is only saved.
  assert.equal(JSON.parse((await pick(`/${slug}/${settings}`)).body).waiting, 0);
  assert.equal((await poll(first.id)).status, 410);
});

test("hub waiters: a poll that is waiting gets the pick at once, and registration is checked", { timeout: 30000 }, async (t) => {
  const root = buildPages(t);
  const { slugs: [slug], register, poll, pick, port } = await hubInProcess(t, [root]);
  const page = "admin/explore/01/style-explorer.html";
  assert.equal((await register({ project: slug, page }, { "X-Jstyle-Token": "wrong" })).status, 403);
  assert.equal((await register({ project: "nope", page })).status, 400);
  assert.equal((await register({ project: slug, page: "admin/explore/01/a.html" })).status, 400);
  assert.equal((await register({ project: slug, page: "../../etc/passwd" })).status, 400);
  assert.equal((await register({ project: slug, page, pid: "x" })).status, 400);
  assert.equal((await register({ project: slug, page }, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await fetch(port, "GET", "/__jstyle/waiters/unknown?wait=0", { headers: { "X-Jstyle-Token": "wrong" } })).status, 403);
  const { id } = JSON.parse((await register({ project: slug, page })).body);
  const started = Date.now();
  const waiting = poll(id, 20);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(JSON.parse((await pick(`/${slug}/${page}`)).body).waiting, 1);
  const got = await waiting;
  assert.equal(got.status, 200);
  assert.ok(Date.now() - started < 5000, "the held poll should answer when the pick arrives");
  // A poll with nothing to give answers 204 after its wait.
  const { id: next } = JSON.parse((await register({ project: slug, page: null })).body);
  const before = Date.now();
  assert.equal((await poll(next, 1)).status, 204);
  assert.ok(Date.now() - before >= 900, "a poll with nothing to give is held for its wait");
});

test("hub waiters go away on DELETE, when their process ends, or after the poll gap", { timeout: 30000 }, async (t) => {
  const root = buildPages(t);
  const { slugs: [slug], register, poll, pick, port, headers } = await hubInProcess(t, [root], { waiterTtl: 400 });
  const page = "admin/explore/01/style-explorer.html";
  const join = async (pid = null) => JSON.parse((await register({ project: slug, page, pid })).body).id;
  const removed = await join();
  assert.equal((await fetch(port, "DELETE", `/__jstyle/waiters/${removed}`, { headers })).status, 200);
  const gone = await poll(removed);
  assert.equal(gone.status, 410);
  assert.equal(JSON.parse(gone.body).reason, "deleted");
  const short = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100)"]);
  const shortExit = new Promise((resolve) => short.on("exit", resolve));
  const orphan = await join(short.pid);
  const idle = await join();
  await shortExit;
  // The sweep runs every 2 seconds.
  await new Promise((resolve) => setTimeout(resolve, 2600));
  const ended = await poll(orphan);
  assert.equal(ended.status, 410);
  assert.equal(JSON.parse(ended.body).reason, "process");
  const expired = await poll(idle);
  assert.equal(expired.status, 410);
  assert.equal(JSON.parse(expired.body).reason, "expired");
  assert.equal(JSON.parse((await pick(`/${slug}/${page}`)).body).waiting, 0);
});

// Reads the address line and the waiter id together: both can arrive in one chunk.
function waitForWaiter(child) {
  let stderr = "";
  return new Promise((resolve, reject) => {
    child.stderr.on("data", (data) => {
      stderr += data;
      const url = /Serving .* at http:\/\/127\.0\.0\.1:(\d+)\/\S*\?t=([0-9a-f]+)/.exec(stderr);
      const id = /대기자 ([0-9a-f]{16,})/.exec(stderr);
      if (url && id) resolve({ port: Number(url[1]), token: url[2], id: id[1] });
    });
    child.on("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
  });
}

test("--wait joins a running hub as a waiter and prints the pick made in the shared tab", { timeout: 60000 }, async (t) => {
  const root = buildPages(t);
  const port = await freePort();
  const hub = spawn(process.execPath, [CLI, "hub", root, "--no-open", "--port", String(port)], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => hub.kill("SIGKILL"));
  const { token } = await waitForUrl(hub);
  const slug = path.basename(root);
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": token };
  const run = (args) => {
    const child = spawn(process.execPath, [CLI, ...args, "--wait", "--no-open", "--port", String(port)], { env: { ...process.env, NO_COLOR: "1" } });
    t.after(() => child.kill("SIGKILL"));
    let stdout = "";
    child.stdout.on("data", (data) => { stdout += data; });
    const exit = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
    return { child, exit, stdout: () => stdout };
  };
  const waiters = async () => JSON.parse((await fetch(port, "GET", "/__jstyle/hub.json")).body).projects.find((p) => p.slug === slug).waiters;
  const page = run(["serve", path.join(root, "admin", "explore", "01", "style-explorer.html")]);
  const seen = await waitForWaiter(page.child);
  assert.equal(seen.port, port);
  assert.equal(seen.token, token);
  assert.equal(JSON.parse(jstyle(["ps", "--json"]).stdout).length, 1, "the waiter must not start a server");
  assert.equal(await waiters(), 1);
  // A page that is not a comparison page is refused before the hub takes its folder.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-plain-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.writeFileSync(path.join(other, "plain.html"), "<main>plain</main>");
  const refused = jstyle(["serve", path.join(other, "plain.html"), "--wait", "--no-open", "--port", String(port)], { timeout: 10000 });
  assert.notEqual(refused.status, 0);
  assert.equal(refused.stdout, "");
  assert.deepEqual(JSON.parse((await fetch(port, "GET", "/__jstyle/hub.json")).body).projects.map((p) => p.slug), [slug]);
  const sent = await fetch(port, "POST", CHOICE_PATH, { headers, body: JSON.stringify({ page: `/${slug}/admin/explore/01/style-explorer.html`, id: "candidate-2" }) });
  assert.equal(JSON.parse(sent.body).waiting, 1);
  assert.equal(await page.exit, 0);
  const picked = JSON.parse(page.stdout().trim().split("\n").at(-1));
  assert.equal(picked.id, "candidate-2");
  assert.equal(picked.page, "admin/explore/01/style-explorer.html");
  assert.equal(picked.project, slug);
  assert.equal(fs.realpathSync(picked.file), fs.realpathSync(path.join(root, "admin", "explore", "01", CHOICE_FILE)));
  // hub --wait waits on the whole project.
  const whole = run(["hub", root]);
  await waitForWaiter(whole.child);
  await fetch(port, "POST", CHOICE_PATH, { headers, body: JSON.stringify({ page: `/${slug}/settings/explore/01/style-explorer.html`, id: "candidate-1" }) });
  assert.equal(await whole.exit, 0);
  assert.equal(JSON.parse(whole.stdout().trim().split("\n").at(-1)).page, "settings/explore/01/style-explorer.html");
  assert.equal(await waiters(), 0);
});

test("a hub waiter exits 1 with empty stdout when it is removed or the hub goes away, and leaves on SIGTERM", { skip: process.platform === "win32" && "signals end the process without handlers on Windows", timeout: 60000 }, async (t) => {
  const root = buildPages(t);
  const port = await freePort();
  const hub = spawn(process.execPath, [CLI, "hub", root, "--no-open", "--port", String(port)], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => hub.kill("SIGKILL"));
  const { token } = await waitForUrl(hub);
  const slug = path.basename(root);
  const run = () => {
    const child = spawn(process.execPath, [CLI, "hub", root, "--wait", "--no-open", "--port", String(port)], { env: { ...process.env, NO_COLOR: "1" } });
    t.after(() => child.kill("SIGKILL"));
    let stdout = "";
    child.stdout.on("data", (data) => { stdout += data; });
    const exit = new Promise((resolve) => child.on("exit", (code, signal) => resolve(code ?? signal)));
    return { child, exit, stdout: () => stdout };
  };
  const waiters = async () => JSON.parse((await fetch(port, "GET", "/__jstyle/hub.json")).body).projects.find((p) => p.slug === slug).waiters;
  const removed = run();
  const { id } = await waitForWaiter(removed.child);
  assert.equal((await fetch(port, "DELETE", `/__jstyle/waiters/${id}`, { headers: { "X-Jstyle-Token": token } })).status, 200);
  assert.equal(await removed.exit, 1);
  assert.equal(removed.stdout(), "");
  const left = run();
  await waitForWaiter(left.child);
  assert.equal(await waiters(), 1);
  left.child.kill("SIGTERM");
  assert.equal(await left.exit, 143);
  assert.equal(await waiters(), 0);
  const orphaned = run();
  await waitForWaiter(orphaned.child);
  hub.kill("SIGTERM");
  assert.equal(await orphaned.exit, 1);
  assert.equal(orphaned.stdout(), "");
});

test("hub waiters: a hub takes at most 200 waiters", { timeout: 60000 }, async (t) => {
  const root = buildPages(t);
  const { slugs: [slug], register } = await hubInProcess(t, [root]);
  for (let i = 0; i < 200; i += 1) assert.equal((await register({ project: slug, page: null })).status, 200, `waiter ${i}`);
  const over = await register({ project: slug, page: null });
  assert.equal(over.status, 429);
  assert.equal(JSON.parse(over.body).error, "waiters");
});

test("--wait starts its own server when the running hub refuses the page's folder", { timeout: 60000 }, async (t) => {
  const root = buildPages(t);
  // The explorer's folder is HOME here, which a hub never serves.
  const home = buildExplorer(t);
  const env = { ...process.env, NO_COLOR: "1", HOME: home, USERPROFILE: home };
  const port = await freePort();
  const hub = spawn(process.execPath, [CLI, "hub", root, "--no-open", "--port", String(port)], { env });
  t.after(() => hub.kill("SIGKILL"));
  await waitForUrl(hub);
  const waiter = spawn(process.execPath, [CLI, "serve", path.join(home, "style-explorer.html"), "--wait", "--no-open", "--port", String(port)], { env });
  t.after(() => waiter.kill("SIGKILL"));
  let stdout = "";
  let stderr = "";
  waiter.stdout.on("data", (data) => { stdout += data; });
  waiter.stderr.on("data", (data) => { stderr += data; });
  const exit = new Promise((resolve) => waiter.on("exit", (code) => resolve(code)));
  const own = await waitForUrl(waiter);
  assert.notEqual(own.port, port);
  assert.match(stderr, /허브/);
  const sent = await fetch(own.port, "POST", CHOICE_PATH, { headers: { "Content-Type": "application/json", "X-Jstyle-Token": own.token }, body: JSON.stringify({ id: "candidate-1" }) });
  assert.equal(sent.status, 200);
  assert.equal(await exit, 0);
  assert.equal(JSON.parse(stdout.trim().split("\n").at(-1)).id, "candidate-1");
});

test("hub waiters on a project that leaves to keep the list at 50 get 410", { timeout: 60000 }, async (t) => {
  const root = buildPages(t);
  const { slugs: [slug], register, poll, headers, port } = await hubInProcess(t, [root]);
  const { id } = JSON.parse((await register({ project: slug, page: null })).body);
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-many-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const held = poll(id, 20);
  let evicted = [];
  for (let i = 0; i < 50; i += 1) {
    const folder = path.join(parent, `p${i}`);
    fs.mkdirSync(folder);
    const reply = JSON.parse((await fetch(port, "POST", "/__jstyle/projects", { headers, body: JSON.stringify({ root: folder }) })).body);
    evicted = evicted.concat(reply.evicted ?? []);
  }
  assert.deepEqual(evicted, [slug]);
  const answer = await held;
  assert.equal(answer.status, 410);
  assert.equal(JSON.parse(answer.body).reason, "evicted");
});

test("a --wait that loses its hub connection removes its waiter on the way out", { timeout: 30000 }, async (t) => {
  const root = buildExplorer(t);
  const token = "f".repeat(32);
  const deleted = [];
  // A hub that registers and deletes but drops every poll, so the run ends on connection errors while the hub still answers.
  const fake = httpServer((request, response) => {
    const reply = (status, value) => {
      response.writeHead(status, { "Content-Type": "application/json", "X-Jstyle-Pid": String(process.pid) });
      response.end(JSON.stringify(value));
    };
    if (request.url === "/__jstyle/alive") return reply(204, {});
    if (request.method === "POST" && request.url === "/__jstyle/projects") return reply(200, { ok: true, slug: "fake", base: "/fake/" });
    if (request.method === "POST" && request.url === "/__jstyle/waiters") return reply(200, { id: "a".repeat(24), project: "fake", page: "style-explorer.html", url: `http://127.0.0.1:${fake.address().port}/fake/style-explorer.html?t=${token}` });
    if (request.method === "DELETE") {
      deleted.push(request.url);
      return reply(200, { ok: true });
    }
    request.socket.destroy();
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    fake.closeAllConnections();
    fake.close();
  });
  const { port } = fake.address();
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  const dir = path.join(process.env.JSTYLE_HOME, "servers");
  fs.mkdirSync(dir, { recursive: true });
  const recordFile = path.join(dir, `${process.pid}.json`);
  t.after(() => fs.rmSync(recordFile, { force: true }));
  fs.writeFileSync(recordFile, JSON.stringify({ pid: process.pid, port, host: "127.0.0.1", kind: "hub", wait: false, token, projects: [{ slug: "fake", root }], version, project: "fake", root, url: `http://127.0.0.1:${port}/`, started: new Date().toISOString(), lastActivity: new Date().toISOString() }));
  const run = spawn(process.execPath, [CLI, "serve", path.join(root, "style-explorer.html"), "--wait", "--no-open", "--port", String(port)], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => run.kill("SIGKILL"));
  let stdout = "";
  run.stdout.on("data", (data) => { stdout += data; });
  const code = await new Promise((resolve) => run.on("exit", resolve));
  assert.equal(code, 1);
  assert.equal(stdout, "");
  assert.deepEqual(deleted, [`/__jstyle/waiters/${"a".repeat(24)}`]);
});

test("--wait starts its own server when the running hub has no room for another waiter", { timeout: 60000 }, async (t) => {
  const root = buildPages(t);
  const port = await freePort();
  const hub = spawn(process.execPath, [CLI, "hub", root, "--no-open", "--port", String(port)], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => hub.kill("SIGKILL"));
  const { token } = await waitForUrl(hub);
  const slug = path.basename(root);
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": token };
  for (let i = 0; i < 200; i += 1) {
    assert.equal((await fetch(port, "POST", "/__jstyle/waiters", { headers, body: JSON.stringify({ project: slug, page: null }) })).status, 200);
  }
  const waiter = spawn(process.execPath, [CLI, "serve", path.join(root, "admin", "explore", "01", "style-explorer.html"), "--wait", "--no-open", "--port", String(port)], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => waiter.kill("SIGKILL"));
  let stdout = "";
  let stderr = "";
  waiter.stdout.on("data", (data) => { stdout += data; });
  waiter.stderr.on("data", (data) => { stderr += data; });
  const exit = new Promise((resolve) => waiter.on("exit", (code) => resolve(code)));
  const own = await waitForUrl(waiter);
  assert.notEqual(own.port, port);
  assert.match(stderr, /기다릴 수 없습니다\(waiters\)/);
  const sent = await fetch(own.port, "POST", CHOICE_PATH, { headers: { "Content-Type": "application/json", "X-Jstyle-Token": own.token }, body: JSON.stringify({ id: "candidate-2" }) });
  assert.equal(sent.status, 200);
  assert.equal(await exit, 0);
  assert.equal(JSON.parse(stdout.trim().split("\n").at(-1)).id, "candidate-2");
});

test("hub waiters end with a project that leaves, and stay when the removal cannot be saved", { timeout: 30000 }, async (t) => {
  const first = buildPages(t);
  const second = buildPages(t);
  const { hub, slugs, register, poll, headers, port } = await hubInProcess(t, [first, second]);
  const remove = (slug) => fetch(port, "POST", "/__jstyle/projects", { headers, body: JSON.stringify({ remove: slug }) });
  const kept = JSON.parse((await register({ project: slugs[1], page: null })).body).id;
  hub.onProjects = () => false;
  const refused = await remove(slugs[1]);
  assert.equal(refused.status, 500);
  assert.equal(JSON.parse(refused.body).error, "save");
  assert.equal((await poll(kept)).status, 204, "a removal that was undone keeps its waiters");
  hub.onProjects = null;
  const leaving = JSON.parse((await register({ project: slugs[0], page: null })).body).id;
  const held = poll(leaving, 10);
  assert.equal((await remove(slugs[0])).status, 200);
  const answer = await held;
  assert.equal(answer.status, 410);
  assert.equal(JSON.parse(answer.body).reason, "project");
  assert.equal((await poll(kept)).status, 204);
});

// Daemon tests run a detached daemon on a free port. It outlives the CLI that
// started it, so every test kills it by pid and the file sweeps what is left.

function daemonEnv(port, extra = {}) {
  const env = { ...process.env, NO_COLOR: "1", JSTYLE_DAEMON_PORT: String(port) };
  delete env.JSTYLE_NO_DAEMON;
  return { ...env, ...extra };
}

function daemonRecords(env) {
  return JSON.parse(spawnSync(process.execPath, [CLI, "ps", "--json"], { encoding: "utf8", env }).stdout).filter((r) => r.daemon);
}

function killDaemons(port = null) {
  const dir = path.join(process.env.JSTYLE_HOME, "servers");
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (record.daemon && (port === null || record.port === port)) process.kill(record.pid, "SIGKILL");
    } catch {
      // Gone already.
    }
  }
}
after(() => killDaemons());

function runAsync(t, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    t.after(() => child.kill("SIGKILL"));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

test("hub starts a daemon on the daemon port, returns, and later runs share it", { timeout: 60000 }, async (t) => {
  const port = await freePort();
  t.after(() => killDaemons(port));
  const env = daemonEnv(port);
  const first = buildPages(t);
  const second = buildPages(t);
  const started = jstyle(["hub", first, "--no-open"], { env, timeout: 15000 });
  assert.equal(started.status, 0, started.stderr);
  const reply = JSON.parse(started.stdout.trim());
  assert.equal(reply.hub, port);
  assert.equal(reply.project, path.basename(first));
  const [daemon, ...others] = daemonRecords(env);
  assert.equal(others.length, 0);
  assert.equal(daemon.port, port);
  assert.equal(daemon.host, "127.0.0.1");
  assert.equal(daemon.kind, "hub");
  const joined = jstyle(["hub", second, "--no-open"], { env, timeout: 15000 });
  assert.equal(joined.status, 0, joined.stderr);
  assert.equal(JSON.parse(joined.stdout.trim()).hub, port);
  assert.deepEqual(daemonRecords(env).map((r) => [r.pid, r.projects.length]), [[daemon.pid, 2]]);
  assert.match(jstyle(["ps"], { env }).stdout, new RegExp(`${port}\\s+daemon`));
  const log = path.join(process.env.JSTYLE_HOME, "daemon", "daemon.log");
  assert.match(fs.readFileSync(log, "utf8"), /Serving/);
  if (process.platform !== "win32") assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  // A comparison page outside the daemon's projects joins its folder and opens there.
  const outside = buildExplorer(t);
  const opened = jstyle(["serve", path.join(outside, "style-explorer.html"), "--no-open"], { env, timeout: 15000 });
  assert.equal(opened.status, 0, opened.stderr);
  assert.match(opened.stderr, new RegExp(`127\\.0\\.0\\.1:${port}/${path.basename(outside)}/style-explorer\\.html\\?t=${daemon.token}`));
  assert.equal(daemonRecords(env)[0].projects.length, 3);
  assert.equal(jstyle(["stop", path.basename(outside)], { env }).status, 0);
  // --wait becomes a waiter on the daemon.
  const waiter = spawn(process.execPath, [CLI, "serve", path.join(second, "admin", "explore", "01", "style-explorer.html"), "--wait", "--no-open"], { env });
  t.after(() => waiter.kill("SIGKILL"));
  let stdout = "";
  waiter.stdout.on("data", (data) => { stdout += data; });
  const exit = new Promise((resolve) => waiter.on("exit", (code) => resolve(code)));
  assert.equal((await waitForWaiter(waiter)).port, port);
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": daemon.token };
  await fetch(port, "POST", CHOICE_PATH, { headers, body: JSON.stringify({ page: `/${path.basename(second)}/admin/explore/01/style-explorer.html`, id: "candidate-1" }) });
  assert.equal(await exit, 0);
  assert.equal(JSON.parse(stdout.trim().split("\n").at(-1)).id, "candidate-1");
  // Taking every project out keeps the daemon; stopping its port ends it.
  for (const root of [first, second]) assert.equal(jstyle(["stop", path.basename(root)], { env }).status, 0);
  assert.deepEqual(daemonRecords(env).map((r) => [r.pid, r.projects.length]), [[daemon.pid, 0]]);
  assert.equal((await fetch(port, "GET", "/")).status, 200);
  assert.equal(jstyle(["stop", String(port)], { env }).status, 0);
  assert.deepEqual(daemonRecords(env), []);
});

test("two runs that start a daemon at once end up on one daemon", { timeout: 60000 }, async (t) => {
  const port = await freePort();
  t.after(() => killDaemons(port));
  const env = daemonEnv(port);
  const roots = [buildPages(t), buildPages(t)];
  const runs = await Promise.all(roots.map((root) => runAsync(t, ["hub", root, "--no-open"], env)));
  for (const run of runs) assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(runs.map((run) => JSON.parse(run.stdout.trim()).hub), [port, port]);
  const daemons = daemonRecords(env);
  assert.equal(daemons.length, 1);
  assert.deepEqual(daemons[0].projects.map((p) => p.slug).sort(), roots.map((root) => path.basename(root)).sort());
});

test("no daemon with JSTYLE_NO_DAEMON, another --port or a non-loopback --host", { timeout: 60000 }, async (t) => {
  const port = await freePort();
  t.after(() => killDaemons(port));
  const root = buildPages(t);
  const foreground = async (args, env) => {
    const child = spawn(process.execPath, [CLI, "hub", root, "--no-open", ...args], { env });
    t.after(() => child.kill("SIGKILL"));
    const seen = await waitForUrl(child);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("exit", resolve));
    return seen;
  };
  assert.equal((await foreground([], daemonEnv(port, { JSTYLE_NO_DAEMON: "1" }))).port, port);
  const other = await freePort();
  assert.equal((await foreground(["--port", String(other)], daemonEnv(port))).port, other);
  assert.equal((await foreground(["--host", "0.0.0.0"], daemonEnv(port))).port, port);
  assert.deepEqual(daemonRecords(daemonEnv(port)), []);
});

test("--wait serves on its own free port when something else holds the daemon port", { timeout: 60000 }, async (t) => {
  const port = await freePort();
  t.after(() => killDaemons(port));
  const squatter = httpServer((request, response) => response.end("not jstyle"));
  await new Promise((resolve) => squatter.listen(port, "127.0.0.1", resolve));
  t.after(() => squatter.close());
  const folder = buildExplorer(t);
  const env = daemonEnv(port);
  const waiter = spawn(process.execPath, [CLI, "serve", path.join(folder, "style-explorer.html"), "--wait", "--no-open"], { env });
  t.after(() => waiter.kill("SIGKILL"));
  let stdout = "";
  let stderr = "";
  waiter.stdout.on("data", (data) => { stdout += data; });
  waiter.stderr.on("data", (data) => { stderr += data; });
  const exit = new Promise((resolve) => waiter.on("exit", (code) => resolve(code)));
  const own = await waitForUrl(waiter);
  assert.notEqual(own.port, port);
  assert.match(stderr, /데몬을 쓰지 않습니다/);
  await fetch(own.port, "POST", CHOICE_PATH, { headers: { "Content-Type": "application/json", "X-Jstyle-Token": own.token }, body: JSON.stringify({ id: "candidate-1" }) });
  assert.equal(await exit, 0);
  assert.equal(JSON.parse(stdout.trim().split("\n").at(-1)).id, "candidate-1");
  assert.deepEqual(daemonRecords(env), []);
});

function servedPort(t, args, env) {
  const child = spawn(process.execPath, [CLI, ...args], { env });
  t.after(() => child.kill("SIGKILL"));
  let stderr = "";
  return new Promise((resolve, reject) => {
    child.stderr.on("data", (data) => {
      stderr += data;
      const match = /Serving .* at http:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);
      if (match) resolve(Number(match[1]));
    });
    child.on("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
  });
}

test("a hub moves off the daemon port when a kit run without the daemon holds it", { timeout: 60000 }, async (t) => {
  const port = await freePort();
  t.after(() => killDaemons(port));
  const env = daemonEnv(port);
  const root = buildPages(t);
  const started = jstyle(["hub", root, "--no-open"], { env, timeout: 15000 });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout.trim()).hub, port);
  assert.equal(jstyle(["stop", String(port)], { env }).status, 0);
  // A kit run without the daemon holds the port until it is stopped; a hub then takes a free port instead of failing.
  assert.equal(await servedPort(t, ["kit", "--no-open"], daemonEnv(port, { JSTYLE_NO_DAEMON: "1" })), port);
  assert.notEqual(await servedPort(t, ["hub", buildPages(t), "--no-open"], env), port);
  assert.deepEqual(daemonRecords(env), []);
});

test("jstyle daemon refuses --root", () => {
  const refused = jstyle(["daemon", "--root", os.tmpdir()], { env: daemonEnv(1) });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /daemon은 폴더/);
});

test("a daemon stays up while a waiter is registered and idles out after it leaves", { timeout: 60000 }, async (t) => {
  const port = await freePort();
  const env = daemonEnv(port);
  const root = buildPages(t);
  // Foreground here, so the test owns the process; --idle 0.03 is under 2 seconds, far under the 60-second waiter gap.
  const daemon = spawn(process.execPath, [CLI, "daemon", "--port", String(port), "--idle", "0.03"], { env });
  t.after(() => daemon.kill("SIGKILL"));
  const exit = new Promise((resolve) => daemon.on("exit", (code) => resolve(code)));
  const { token } = await waitForUrl(daemon);
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": token };
  const { slug } = JSON.parse((await fetch(port, "POST", "/__jstyle/projects", { headers, body: JSON.stringify({ root }) })).body);
  const { id } = JSON.parse((await fetch(port, "POST", "/__jstyle/waiters", { headers, body: JSON.stringify({ project: slug, page: null }) })).body);
  await new Promise((resolve) => setTimeout(resolve, 3500));
  assert.equal(daemon.exitCode, null, "the daemon idled out with a waiter registered");
  assert.equal((await fetch(port, "DELETE", `/__jstyle/waiters/${id}`, { headers })).status, 200);
  assert.equal(await exit, 0);
  assert.deepEqual(daemonRecords(env), []);
});

// An older daemon on the daemon port, run in the foreground so the test owns it.
async function oldDaemon(t, port, extra = {}) {
  const env = daemonEnv(port, { JSTYLE_TEST_VERSION: "0.0.1", ...extra });
  const child = spawn(process.execPath, [CLI, "daemon", "--port", String(port)], { env });
  t.after(() => child.kill("SIGKILL"));
  const exit = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const { token } = await waitForUrl(child);
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": token };
  const join = async (root) => JSON.parse((await fetch(port, "POST", "/__jstyle/projects", { headers, body: JSON.stringify({ root }) })).body).slug;
  const wait = async (slug) => JSON.parse((await fetch(port, "POST", "/__jstyle/waiters", { headers, body: JSON.stringify({ project: slug, page: null }) })).body).id;
  return { child, exit, token, headers, join, wait };
}

test("a daemon of another version with no waiter hands over to a new daemon with its projects", { timeout: 60000 }, async (t) => {
  const port = await freePort();
  t.after(() => killDaemons(port));
  const env = daemonEnv(port);
  const old = await oldDaemon(t, port);
  const first = buildPages(t);
  const slug = await old.join(first);
  const second = buildPages(t);
  const run = jstyle(["hub", second, "--no-open"], { env, timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout.trim()).hub, port);
  assert.equal(await old.exit, 0);
  const [daemon, ...more] = daemonRecords(env);
  assert.equal(more.length, 0);
  assert.notEqual(daemon.pid, old.child.pid);
  assert.notEqual(daemon.version, "0.0.1");
  assert.equal(daemon.api, API);
  assert.deepEqual(daemon.projects.map((p) => p.slug).sort(), [slug, path.basename(second)].sort());
  // Tabs opened on the old daemon keep its token, so their picks still save.
  assert.equal(daemon.token, old.token);
  const pick = await fetch(port, "POST", CHOICE_PATH, { headers: old.headers, body: JSON.stringify({ page: `/${slug}/admin/explore/01/style-explorer.html`, id: "candidate-1" }) });
  assert.equal(pick.status, 200, pick.body);
});

test("a daemon of another version with a waiter stays until the waiter ends and is used while its api matches", { timeout: 60000 }, async (t) => {
  const port = await freePort();
  t.after(() => killDaemons(port));
  const env = daemonEnv(port);
  const old = await oldDaemon(t, port);
  const slug = await old.join(buildPages(t));
  const id = await old.wait(slug);
  const second = buildPages(t);
  const run = jstyle(["hub", second, "--no-open"], { env, timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /대기자 1/);
  assert.equal(old.child.exitCode, null);
  assert.deepEqual(daemonRecords(env).map((r) => [r.pid, r.projects.length]), [[old.child.pid, 2]]);
  // Once its last waiter leaves, the old daemon ends on its own.
  assert.equal((await fetch(port, "DELETE", `/__jstyle/waiters/${id}`, { headers: old.headers })).status, 200);
  assert.equal(await old.exit, 0);
  const next = jstyle(["hub", buildPages(t), "--no-open"], { env, timeout: 20000 });
  assert.equal(next.status, 0, next.stderr);
  const [daemon] = daemonRecords(env);
  assert.notEqual(daemon.version, "0.0.1");
  assert.equal(daemon.projects.length, 3);
});

test("a daemon of another api with a waiter makes the run serve by itself", { timeout: 60000 }, async (t) => {
  const port = await freePort();
  t.after(() => killDaemons(port));
  const old = await oldDaemon(t, port, { JSTYLE_TEST_API: "99" });
  await old.wait(await old.join(buildPages(t)));
  const own = spawn(process.execPath, [CLI, "hub", buildPages(t), "--no-open"], { env: daemonEnv(port) });
  t.after(() => own.kill("SIGKILL"));
  let stderr = "";
  own.stderr.on("data", (data) => { stderr += data; });
  const seen = await waitForUrl(own);
  assert.notEqual(seen.port, port);
  assert.match(stderr, /데몬을 쓰지 않습니다/);
  assert.equal(old.child.exitCode, null);
});

test("a hub from before the daemon on the daemon port is taken over with its token and addresses", { timeout: 60000 }, async (t) => {
  const port = await freePort();
  t.after(() => killDaemons(port));
  const env = daemonEnv(port);
  const first = buildPages(t);
  const second = buildPages(t);
  const plain = daemonEnv(port, { JSTYLE_NO_DAEMON: "1" });
  const hub = spawn(process.execPath, [CLI, "hub", first, "--no-open"], { env: plain });
  t.after(() => hub.kill("SIGKILL"));
  const hubExit = new Promise((resolve) => hub.on("exit", (code, signal) => resolve(code ?? signal)));
  const { token } = await waitForUrl(hub);
  assert.equal(jstyle(["hub", second, "--no-open"], { env: plain }).status, 0);
  const third = buildPages(t);
  const run = jstyle(["hub", third, "--no-open"], { env, timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
  const hubEnded = await hubExit;
  assert.ok(TERMINATED.includes(hubEnded), String(hubEnded));
  const [daemon] = daemonRecords(env);
  assert.equal(daemon.token, token);
  assert.deepEqual(daemon.projects.map((p) => p.slug), [first, second, third].map((root) => path.basename(root)));
  // An open tab goes on with the same token and address.
  const slug = path.basename(first);
  assert.equal((await fetch(port, "GET", `/__jstyle/hub.json?page=${encodeURIComponent(`/${slug}/`)}`)).status, 200);
  const sent = await fetch(port, "POST", CHOICE_PATH, { headers: { "Content-Type": "application/json", "X-Jstyle-Token": token }, body: JSON.stringify({ page: `/${slug}/admin/explore/01/style-explorer.html`, id: "candidate-1" }) });
  assert.equal(sent.status, 200, sent.body);
});

test("a hub from before the daemon on ::1 is used, not taken over, so its tabs keep their address", { timeout: 60000 }, async (t) => {
  const probe = net.createServer();
  const ipv6 = await new Promise((resolve) => probe.once("error", () => resolve(false)).listen(0, "::1", () => probe.close(() => resolve(true))));
  if (!ipv6) return t.skip("no ::1 on this machine");
  const port = await freePort();
  t.after(() => killDaemons(port));
  const env = daemonEnv(port);
  const first = buildPages(t);
  const hub = spawn(process.execPath, [CLI, "hub", first, "--no-open", "--host", "::1"], { env: daemonEnv(port, { JSTYLE_NO_DAEMON: "1" }) });
  t.after(() => hub.kill("SIGKILL"));
  const token = await new Promise((resolve, reject) => {
    let stderr = "";
    hub.stderr.on("data", (data) => {
      stderr += data;
      const match = /Serving .*\?t=([0-9a-f]+)/.exec(stderr);
      if (match) resolve(match[1]);
    });
    hub.on("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
  });
  const second = buildPages(t);
  const run = jstyle(["hub", second, "--no-open"], { env, timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout.trim()).hub, port);
  assert.equal(hub.exitCode, null, "the ::1 hub was stopped");
  assert.deepEqual(daemonRecords(env), []);
  const slug = path.basename(first);
  const sent = await fetch(port, "POST", CHOICE_PATH, { host: "::1", headers: { "Content-Type": "application/json", "X-Jstyle-Token": token }, body: JSON.stringify({ page: `/${slug}/admin/explore/01/style-explorer.html`, id: "candidate-1" }) });
  assert.equal(sent.status, 200, sent.body);
});

test("a hub from before the daemon with an agent waiting on it is used, not taken over", { timeout: 60000 }, async (t) => {
  const port = await freePort();
  t.after(() => killDaemons(port));
  const env = daemonEnv(port);
  const first = buildPages(t);
  const hub = spawn(process.execPath, [CLI, "hub", first, "--no-open"], { env: daemonEnv(port, { JSTYLE_NO_DAEMON: "1" }) });
  t.after(() => hub.kill("SIGKILL"));
  const { token } = await waitForUrl(hub);
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": token };
  assert.equal((await fetch(port, "POST", "/__jstyle/waiters", { headers, body: JSON.stringify({ project: path.basename(first), page: null }) })).status, 200);
  const run = jstyle(["hub", buildPages(t), "--no-open"], { env, timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /대기자 1개/);
  assert.equal(hub.exitCode, null, "a hub with a waiting agent was stopped");
  assert.deepEqual(daemonRecords(env), []);
});

test("kit, library and any served file open on the daemon under their own addresses", { timeout: 60000 }, async (t) => {
  const port = await freePort();
  t.after(() => killDaemons(port));
  const env = daemonEnv(port);
  const kit = jstyle(["kit", "--no-open"], { env, timeout: 15000 });
  assert.equal(kit.status, 0, kit.stderr);
  const kitUrl = new URL(/http:\/\/\S+/.exec(kit.stderr)[0]);
  assert.equal(Number(kitUrl.port), port);
  assert.equal(kitUrl.pathname, "/__skill/assets/kit/index.html");
  assert.equal((await fetch(port, "GET", kitUrl.pathname)).status, 200);
  const library = jstyle(["library", "cards", "--no-open"], { env, timeout: 15000 });
  assert.equal(library.status, 0, library.stderr);
  assert.match(library.stderr, new RegExp(`127\\.0\\.0\\.1:${port}/__skill/assets/extended/index\\.html\\?t=[0-9a-f]+#cards`));
  assert.equal((await fetch(port, "GET", new URL(/http:\/\/\S+/.exec(library.stderr)[0]).pathname)).status, 200);
  // Only what kit and library pages link to is served from the skill folder.
  assert.equal((await fetch(port, "GET", "/__skill/.gitignore")).status, 404);
  assert.equal((await fetch(port, "GET", "/__skill/package.json")).status, 404);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-plain-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, "plain.html"), "<main>plain</main>");
  const served = jstyle(["serve", path.join(folder, "plain.html"), "--no-open"], { env, timeout: 15000 });
  assert.equal(served.status, 0, served.stderr);
  const slug = path.basename(folder);
  assert.match(served.stderr, new RegExp(`127\\.0\\.0\\.1:${port}/${slug}/plain\\.html\\?t=`));
  assert.equal((await fetch(port, "GET", `/${slug}/plain.html`)).status, 200);
  const [daemon, ...others] = daemonRecords(env);
  assert.equal(others.length, 0);
  assert.deepEqual(daemon.projects.map((p) => p.slug), [slug]);
  const listed = JSON.parse((await fetch(port, "GET", "/__jstyle/hub.json")).body);
  assert.deepEqual(listed.projects.map((p) => p.slug), [slug]);
  // Without the daemon, kit serves from the command as before.
  assert.equal(await servedPort(t, ["kit", "--no-open"], daemonEnv(port, { JSTYLE_NO_DAEMON: "1", JSTYLE_DAEMON_PORT: String(await freePort()) })) > 0, true);
});

test("a daemon that steps down after its waiters leaves its token to the next daemon", { timeout: 60000 }, async (t) => {
  const port = await freePort();
  t.after(() => killDaemons(port));
  const env = daemonEnv(port);
  const old = await oldDaemon(t, port);
  const slug = await old.join(buildPages(t));
  const id = await old.wait(slug);
  assert.equal(jstyle(["hub", buildPages(t), "--no-open"], { env, timeout: 20000 }).status, 0);
  assert.equal((await fetch(port, "DELETE", `/__jstyle/waiters/${id}`, { headers: old.headers })).status, 200);
  assert.equal(await old.exit, 0);
  // A daemon on another port must not take the token left for this one.
  const other = await freePort();
  t.after(() => killDaemons(other));
  const otherEnv = daemonEnv(other);
  assert.equal(jstyle(["hub", buildPages(t), "--no-open"], { env: otherEnv, timeout: 20000 }).status, 0);
  assert.notEqual(daemonRecords(otherEnv).find((r) => r.port === other).token, old.token, "a daemon on another port took the token");
  assert.equal(jstyle(["hub", buildPages(t), "--no-open"], { env, timeout: 20000 }).status, 0);
  const daemon = daemonRecords(env).find((r) => r.port === port);
  assert.notEqual(daemon.pid, old.child.pid);
  assert.equal(daemon.token, old.token, "a tab opened on the old daemon would get 403");
  assert.deepEqual(fs.readdirSync(path.join(process.env.JSTYLE_HOME, "daemon")).filter((name) => name.startsWith("token")), [], "the handed-over token stays on disk");
  const sent = await fetch(port, "POST", CHOICE_PATH, { headers: old.headers, body: JSON.stringify({ page: `/${slug}/admin/explore/01/style-explorer.html`, id: "candidate-1" }) });
  assert.equal(sent.status, 200, sent.body);
});

test("ps lists the daemon's projects with their waiters, and the daemon is not stopped under a waiter without --force", { timeout: 60000 }, async (t) => {
  const port = await freePort();
  t.after(() => killDaemons(port));
  const env = daemonEnv(port);
  const root = buildPages(t);
  assert.equal(jstyle(["hub", root, "--no-open"], { env, timeout: 15000 }).status, 0);
  const [daemon] = daemonRecords(env);
  const slug = path.basename(root);
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": daemon.token };
  assert.equal((await fetch(port, "POST", "/__jstyle/waiters", { headers, body: JSON.stringify({ project: slug, page: null }) })).status, 200);
  const listed = jstyle(["ps"], { env }).stdout;
  assert.match(listed, new RegExp(`${slug}\\s+대기자 1`));
  assert.deepEqual(JSON.parse(jstyle(["ps", "--json"], { env }).stdout).find((r) => r.daemon).projects.map((p) => [p.slug, p.waiters]), [[slug, 1]]);
  for (const args of [["stop", String(port)], ["daemon", "stop"]]) {
    const refused = jstyle(args, { env });
    assert.equal(refused.status, 1, args.join(" "));
    assert.match(refused.stderr, /--force/);
    assert.equal(daemonRecords(env).length, 1);
  }
  const forced = jstyle(["daemon", "stop", "--force"], { env });
  assert.equal(forced.status, 0, forced.stderr);
  assert.deepEqual(daemonRecords(env), []);
  assert.equal(jstyle(["daemon", "stop"], { env }).status, 1);
});

test("a daemon of this version but another api is replaced, so kit gets the paths it expects", { timeout: 60000 }, async (t) => {
  const port = await freePort();
  t.after(() => killDaemons(port));
  const env = daemonEnv(port);
  const old = await oldDaemon(t, port, { JSTYLE_TEST_VERSION: "", JSTYLE_TEST_API: "1" });
  assert.equal(daemonRecords(env)[0].version, JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
  const kit = jstyle(["kit", "--no-open"], { env, timeout: 20000 });
  assert.equal(kit.status, 0, kit.stderr);
  assert.equal(await old.exit, 0);
  const [daemon] = daemonRecords(env);
  assert.notEqual(daemon.pid, old.child.pid);
  assert.equal(daemon.api, API);
});

test("stop asks for --force when it cannot tell whether a daemon has waiters", { timeout: 30000 }, async (t) => {
  // A daemon that answers alive as itself but whose hub.json fails.
  const script = 'const http=require("http");const s=http.createServer((q,r)=>{if(q.url==="/__jstyle/alive"){r.writeHead(204,{"X-Jstyle-Pid":String(process.pid)});return r.end();}r.writeHead(500);r.end();});s.listen(0,"127.0.0.1",()=>console.log(s.address().port));';
  const child = spawn(process.execPath, ["-e", script]);
  t.after(() => child.kill("SIGKILL"));
  const exit = new Promise((resolve) => child.on("exit", (code, signal) => resolve(code ?? signal)));
  const port = await new Promise((resolve) => child.stdout.once("data", (data) => resolve(Number(String(data).trim()))));
  const dir = path.join(process.env.JSTYLE_HOME, "servers");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${child.pid}.json`);
  t.after(() => fs.rmSync(file, { force: true }));
  const now = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({ pid: child.pid, port, host: "127.0.0.1", kind: "hub", daemon: true, wait: false, token: "f".repeat(32), projects: [], version: "0.0.0", api: API, project: "daemon", url: `http://127.0.0.1:${port}/`, started: now, lastActivity: now }));
  const env = daemonEnv(port);
  for (const args of [["stop", String(port)], ["daemon", "stop"]]) {
    const refused = jstyle(args, { env });
    assert.equal(refused.status, 1, args.join(" "));
    assert.match(refused.stderr, /--force/);
    assert.equal(child.exitCode, null);
  }
  assert.equal(jstyle(["stop", String(port), "--force"], { env }).status, 0);
  const ended = await exit;
  assert.ok(TERMINATED.includes(ended), String(ended));
});

test("a folder joined for one plain file stays out of the daemon's saved list", { timeout: 60000 }, async (t) => {
  const port = await freePort();
  t.after(() => killDaemons(port));
  const env = daemonEnv(port);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-plain-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, "plain.html"), "<main>plain</main>");
  assert.equal(jstyle(["serve", path.join(folder, "plain.html"), "--no-open"], { env, timeout: 15000 }).status, 0);
  const pages = buildPages(t);
  assert.equal(jstyle(["hub", pages, "--no-open"], { env, timeout: 15000 }).status, 0);
  assert.deepEqual(daemonRecords(env)[0].projects.map((p) => p.slug).sort(), [path.basename(folder), path.basename(pages)].sort());
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.JSTYLE_HOME, "hubs", `127.0.0.1-${port}.json`), "utf8"));
  assert.deepEqual(saved.projects.map((p) => p.slug), [path.basename(pages)]);
});

test("a borrowed folder stays borrowed when a join, a keep or a removal cannot be saved", async (t) => {
  const { joinProject, savedProjects } = await import("../scripts/serve.mjs");
  const [kept, borrowed, refused] = [buildPages(t), buildPages(t), buildPages(t)];
  const hub = hubChoice(() => {}, { daemon: true });
  joinProject(hub, kept);
  const { slug } = joinProject(hub, borrowed, { keep: false });
  assert.deepEqual(savedProjects(hub).map((p) => p.slug), [path.basename(kept)]);
  hub.onProjects = () => false;
  // A new borrowed folder that cannot be saved leaves nothing behind.
  assert.equal(joinProject(hub, refused, { keep: false }).saved, false);
  assert.equal([...hub.projects.values()].includes(fs.realpathSync(refused)), false);
  // Keeping the borrowed folder fails, so it stays borrowed.
  assert.equal(joinProject(hub, borrowed).saved, false);
  assert.ok(hub.transient.has(slug));
  // Removing it fails and is undone, still borrowed.
  const server = createServer({ root: kept, page: "", choice: hub });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const headers = { "Content-Type": "application/json", "X-Jstyle-Token": hub.token };
  assert.equal((await fetch(server.address().port, "POST", "/__jstyle/projects", { headers, body: JSON.stringify({ remove: slug }) })).status, 500);
  assert.ok(hub.projects.has(slug));
  assert.ok(hub.transient.has(slug), "an undone removal turned a borrowed folder into a kept one");
  hub.onProjects = null;
  assert.deepEqual(savedProjects(hub).map((p) => p.slug), [path.basename(kept)]);
});

function limitFolders(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-limit-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return (name) => {
    const dir = path.join(parent, name);
    fs.mkdirSync(dir);
    return dir;
  };
}

test("a borrowed folder never pushes a kept project out: 50 kept projects stay when one more folder is borrowed", async (t) => {
  const { joinProject, savedProjects } = await import("../scripts/serve.mjs");
  const folder = limitFolders(t);
  const hub = hubChoice(() => {}, { daemon: true });
  for (let i = 0; i < 50; i += 1) joinProject(hub, folder(`kept${i}`));
  const { slug, evicted, saved } = joinProject(hub, folder("borrowed"), { keep: false });
  assert.equal(saved, true);
  assert.deepEqual(evicted, []);
  assert.ok(hub.projects.has(slug));
  assert.equal(savedProjects(hub).length, 50);
});

test("a daemon serves from the skill folder only the files kit and library pages link to", async (t) => {
  const { SKILL_SLUG } = await import("../scripts/serve.mjs");
  const hub = hubChoice(() => {}, { daemon: true });
  const server = createServer({ root: os.tmpdir(), page: "", choice: hub });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const status = async (rest) => (await fetch(server.address().port, "GET", `/${SKILL_SLUG}${rest}`)).status;
  for (const shown of ["/assets/kit/index.html", "/assets/extended/index.html", "/references/extended/components.md", "/README.local.md"]) {
    assert.equal(await status(shown), 200, shown);
  }
  for (const hidden of ["", "/", "/package.json", "/SKILL.md", "/bin/jstyle.mjs", "/scripts/serve.mjs", "/tests/test_cli.mjs", "/assets%2f..%2fpackage.json", "/assets/%2e%2e/bin/jstyle.mjs"]) {
    assert.equal(await status(hidden), 404, hidden);
  }
});

test("keeping a borrowed folder in a hub with 50 kept projects drops the oldest kept one, or nothing when that cannot be saved", async (t) => {
  const { joinProject, savedProjects } = await import("../scripts/serve.mjs");
  const folder = limitFolders(t);
  const hub = hubChoice(() => {}, { daemon: true });
  for (let i = 0; i < 50; i += 1) joinProject(hub, folder(`kept${i}`));
  hub.times.get("kept7").lastUsed = new Date(0).toISOString();
  const borrowed = folder("borrowed");
  const { slug } = joinProject(hub, borrowed, { keep: false });
  hub.times.get(slug).lastUsed = new Date(1).toISOString();
  hub.onProjects = () => false;
  assert.equal(joinProject(hub, borrowed).saved, false);
  assert.ok(hub.projects.has("kept7"), "an undone keep left the oldest kept project out");
  assert.ok(hub.transient.has(slug));
  assert.equal(hub.times.get(slug).lastUsed, new Date(1).toISOString(), "an undone keep changed lastUsed");
  hub.onProjects = null;
  const before = Date.now();
  const kept = joinProject(hub, borrowed);
  assert.deepEqual(kept, { slug, evicted: ["kept7"], saved: true });
  // Keeping it is a use, so the next kept join does not drop it first.
  assert.ok(Date.parse(hub.times.get(slug).lastUsed) >= before);
  assert.equal(hub.transient.has(slug), false);
  assert.equal(savedProjects(hub).length, 50);
  assert.ok(savedProjects(hub).some((p) => p.slug === slug));
});

test("borrowed folders have their own limit of 50, and the oldest borrowed one goes", async (t) => {
  const { joinProject, savedProjects } = await import("../scripts/serve.mjs");
  const folder = limitFolders(t);
  const hub = hubChoice(() => {}, { daemon: true });
  joinProject(hub, folder("kept"));
  // The kept project is the one used longest ago, so the use order alone would drop it.
  hub.times.get("kept").lastUsed = new Date(0).toISOString();
  const slugs = [];
  for (let i = 0; i < 50; i += 1) slugs.push(joinProject(hub, folder(`borrowed${i}`), { keep: false }).slug);
  const { evicted } = joinProject(hub, folder("borrowed50"), { keep: false });
  assert.deepEqual(evicted, [slugs[0]]);
  assert.equal(hub.transient.size, 50);
  assert.deepEqual(savedProjects(hub).map((p) => p.slug), ["kept"]);
});

test("jstyle daemon stop refuses arguments it does not take", () => {
  for (const extra of ["--bogus", "8765", "now"]) {
    const refused = jstyle(["daemon", "stop", extra], { env: daemonEnv(1) });
    assert.equal(refused.status, 2, extra);
  }
  assert.equal(jstyle(["daemon", "stop", "--help"], { env: daemonEnv(1) }).status, 0);
});
