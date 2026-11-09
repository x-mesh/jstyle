import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer as httpServer, request } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CHOICE_FILE, CHOICE_PATH, createServer, explorerChoice, hubProject } from "../scripts/serve.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
// Servers started by these tests record themselves; keep that out of the real ~/.jstyle.
process.env.JSTYLE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-home-"));
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
  assert.equal(JSON.parse(ok.body).waiting, true);
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
  assert.equal(JSON.parse(sent.body).waiting, false);
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
  assert.ok([143, "SIGTERM"].includes(await exit));
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
  // SIGINT ends the server and removes its record.
  child.kill("SIGINT");
  assert.ok([130, "SIGINT"].includes(await exit));
  assert.equal(fs.existsSync(path.join(dir, `${child.pid}.json`)), false);
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
  // --wait still needs its own server, so it moves off the hub's port.
  const waiter = spawn(process.execPath, [CLI, "hub", second, "--wait", "--no-open", "--port", String(port)], { env: { ...process.env, NO_COLOR: "1" } });
  t.after(() => waiter.kill("SIGKILL"));
  const moved = await waitForUrl(waiter);
  assert.notEqual(moved.port, port);
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
