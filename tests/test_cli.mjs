import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CHOICE_FILE, CHOICE_PATH, createServer, explorerChoice } from "../scripts/serve.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = path.join(ROOT, "bin", "jstyle.mjs");

function jstyle(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, ...options });
}

function fetch(port, method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: pathname, headers }, (response) => {
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
  for (const name of ["explore", "serve", "shoot", "media", "image", "measure", "doctor"]) assert.match(help.stdout, new RegExp(`\\n  ${name} `));
  assert.match(jstyle(["version"]).stdout, /^jstyle \S+\n$/);
  const unknown = jstyle(["explor"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /알 수 없는 명령: explor/);
  assert.match(unknown.stderr, /try: jstyle explore/);
  assert.equal(jstyle([]).status, 2);
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
  assert.equal(JSON.parse(ok.body).waiting, false);
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
  assert.equal(JSON.parse(response.body).waiting, true);
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
