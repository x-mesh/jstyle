import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "../scripts/serve.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = path.join(ROOT, "bin", "jstyle.mjs");

function jstyle(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, ...options });
}

function fetch(port, method, pathname) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: pathname }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
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
        assert.equal(response.headers.location, "/" + page);
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
  assert.equal(fs.realpathSync(result.output), fs.realpathSync(path.join(folder, "style-explorer.html")));
  assert.match(run.stderr, /next: jstyle serve /);
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
