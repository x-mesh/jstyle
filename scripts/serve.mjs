#!/usr/bin/env node
// Serve a folder with caching disabled and open one page in it.
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIME = JSON.parse(fs.readFileSync(new URL("./lib/mime-types.json", import.meta.url), "utf8")).types;
const WILDCARD = new Set(["0.0.0.0", "::", ""]);
export const CHOICE_PATH = "/__jstyle/choice";
export const CHOICE_FILE = "choice.json";
export const HUB_PATH = "/__jstyle/hub.json";
const HUB_PAGE = new URL("../assets/hub.html", import.meta.url);
const HUB_DEPTH = 6;
const MAX_CHOICE_BYTES = 256 * 1024;
const MAX_NOTES = 4000;
const MAX_COMMENTS = 50;
const MAX_COMMENT = 2000;

function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function listing(urlPath, directory) {
  const title = `Directory listing for ${escapeHtml(urlPath)}`;
  const items = fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1))
    .map((entry) => {
      const name = entry.name + (entry.isDirectory() ? "/" : "");
      return `<li><a href="${encodeURI(name)}">${escapeHtml(name)}</a></li>`;
    });
  return `<!DOCTYPE HTML>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n</head>\n<body>\n<h1>${title}</h1>\n<hr>\n<ul>\n${items.join("\n")}\n</ul>\n<hr>\n</body>\n</html>\n`;
}

// Map a URL path inside root; "." and ".." segments are dropped so requests
// cannot leave the served folder.
function localPath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    decoded = urlPath;
  }
  const parts = decoded.split("/").filter((part) => part && part !== "." && part !== ".." && !part.includes("\\") && !part.includes("\0"));
  return path.join(root, ...parts);
}

// The explorer page embeds its manifest as one JSON line after "const DATA = ".
export function readExplorerData(file) {
  let html;
  try {
    html = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const start = html.indexOf("const DATA = ");
  if (start < 0) return null;
  const line = html.slice(start + "const DATA = ".length, html.indexOf("\n", start)).trim().replace(/;$/, "");
  try {
    const data = JSON.parse(line);
    return Array.isArray(data?.candidates) && data.candidates.length ? data : null;
  } catch {
    return null;
  }
}

const shortText = (value, limit) => typeof value === "string" && value.length <= limit;

// Keeps only the element fields the picker sends (frame-mesh's selection
// summary); anything else in the page's message is dropped.
function elementRef(value) {
  if (!value || typeof value !== "object" || !shortText(value.label, 300) || !shortText(value.path, 2000)) return null;
  const element = { label: value.label, path: value.path };
  if (value.size != null) {
    if (!shortText(value.size, 32)) return null;
    element.size = value.size;
  }
  if (value.text != null) {
    if (!shortText(value.text, 400)) return null;
    element.text = value.text;
  }
  if (value.parent != null) {
    if (!shortText(value.parent.label, 300) || !shortText(value.parent.path, 2000)) return null;
    element.parent = { label: value.parent.label, path: value.parent.path };
  }
  if (value.styles != null) {
    const entries = typeof value.styles === "object" && !Array.isArray(value.styles) ? Object.entries(value.styles) : null;
    if (!entries || entries.length > 32 || !entries.every(([key, style]) => shortText(key, 40) && shortText(style, 200))) return null;
    element.styles = Object.fromEntries(entries);
  }
  if (value.children != null) {
    if (!Array.isArray(value.children) || value.children.length > 11 || !value.children.every((line) => shortText(line, 300))) return null;
    element.children = value.children;
  }
  return element;
}

function candidateNumber(data, candidate) {
  const directions = data.candidates.filter((item) => !item.baseline);
  return candidate.baseline ? "baseline" : String(directions.indexOf(candidate) + 1).padStart(2, "0");
}

const COMMENT_KINDS = new Set(["keep", "change"]);

// id null sends comments without picking a direction.
function choiceRecord(data, body) {
  const candidate = body.id === null ? null : data.candidates.find((item) => item.id === body.id);
  if (candidate === undefined) return null;
  const comments = [];
  for (const comment of body.comments ?? []) {
    const target = data.candidates.find((item) => item.id === comment?.id);
    const element = elementRef(comment?.element);
    const kind = comment?.kind ?? "change";
    if (!target || !element || !COMMENT_KINDS.has(kind) || !shortText(comment.note, MAX_COMMENT) || !comment.note.trim()) return null;
    comments.push({ id: target.id, number: candidateNumber(data, target), name: target.name, kind, note: comment.note, element });
  }
  return {
    round: data.round ?? "",
    number: candidate ? candidateNumber(data, candidate) : null,
    id: candidate ? candidate.id : null,
    name: candidate ? candidate.name : null,
    baseline: Boolean(candidate?.baseline),
    notes: body.notes ?? "",
    comments,
    viewport: body.viewport ?? "",
    fingerprint: data.fingerprint ?? "",
    at: new Date().toISOString(),
  };
}

function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

function sameToken(given, token) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// choice: { token, data, file, onChoice, once } accepts one POST route for the
// explorer page. The custom token header forces a CORS preflight that this
// server never answers, so other sites cannot post to it, and the token keeps
// other devices out when the server listens on the network.
function receiveChoice(request, choice, send) {
  const json = (status, value) => send(status, { "Content-Type": "application/json; charset=utf-8" }, JSON.stringify(value) + "\n");
  if (!sameToken(request.headers["x-jstyle-token"], choice.token)) return json(403, { error: "token" });
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(415, { error: "content-type" });
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_CHOICE_BYTES) tooLarge = true;
    else chunks.push(chunk);
  });
  request.on("end", () => {
    // An unexpected error answers 500 instead of ending the server and a waiting --wait.
    try {
      handleChoice();
    } catch (error) {
      try {
        json(500, { error: String(error?.message ?? error) });
      } catch {
        // The reply already went out; the error must still not end the server.
      }
    }
  });
  function handleChoice() {
    if (tooLarge) return json(413, { error: "size" });
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return json(400, { error: "json" });
    }
    if (!body || typeof body !== "object" || (typeof body.id !== "string" && body.id !== null)) return json(400, { error: "id" });
    if (body.notes != null && (typeof body.notes !== "string" || body.notes.length > MAX_NOTES)) return json(400, { error: "notes" });
    if (body.viewport != null && typeof body.viewport !== "string") return json(400, { error: "viewport" });
    if (body.comments != null && (!Array.isArray(body.comments) || body.comments.length > MAX_COMMENTS)) return json(400, { error: "comments" });
    // A hub serves many explorers: the page names which one, and only a built explorer under the root counts.
    let { data, file } = choice;
    let page = null;
    if (choice.hub) {
      if (typeof body.page !== "string" || !body.page.startsWith("/") || body.page.length > 2000) return json(400, { error: "page" });
      const html = localPath(choice.root, body.page);
      if (!insideRoot(choice.root, html)) return json(400, { error: "page" });
      data = readExplorerData(html);
      if (!data) return json(400, { error: "page" });
      file = path.join(path.dirname(html), CHOICE_FILE);
      page = path.relative(choice.root, html).split(path.sep).join("/");
    }
    const record = choiceRecord(data, body);
    if (!record) return json(400, { error: body.comments?.length ? "comments" : "id" });
    // Nothing picked, noted or commented: refusing it keeps --wait from ending with an empty result.
    if (record.id === null && !record.comments.length && !record.notes.trim()) return json(400, { error: "empty" });
    if (page) record.page = page;
    // With once (--wait), later picks are refused so choice.json keeps what was printed.
    if (choice.closed) return json(409, { error: "closed" });
    if (choice.once) choice.closed = true;
    try {
      writeAtomic(file, JSON.stringify(record, null, 2) + "\n");
    } catch (error) {
      choice.closed = false;
      return json(500, { error: error.message });
    }
    // waiting tells the page whether an agent receives this now (--wait) or only choice.json keeps it.
    json(200, { ok: true, waiting: Boolean(choice.once) });
    choice.onChoice?.(record, file);
  }
}

// One hub entry per built explorer: what the hub page shows and what the
// explorer's page menu lists. Status comes from choice.json when its
// fingerprint still matches the page.
function hubEntry(root, html, data) {
  const rel = path.relative(root, html).split(path.sep).join("/");
  const dir = path.posix.dirname(rel);
  const roundDir = /^\d+$/.test(path.posix.basename(dir));
  const group = (roundDir ? path.posix.dirname(dir) : dir).replace(/(^|\/)explore$/, "") || ".";
  let choice = null;
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(path.dirname(html), CHOICE_FILE), "utf8"));
    choice = { id: saved.id ?? null, number: saved.number ?? null, name: saved.name ?? null, comments: Array.isArray(saved.comments) ? saved.comments.length : 0, notes: Boolean(saved.notes?.trim?.()), at: saved.at ?? null, stale: saved.fingerprint !== data.fingerprint };
  } catch {
    // No choice yet.
  }
  return {
    path: rel,
    group,
    round: data.round || (roundDir ? path.posix.basename(dir) : ""),
    project: data.project ?? "",
    brief: data.brief ?? "",
    candidates: data.candidates.map((c) => ({ name: c.name, baseline: Boolean(c.baseline), palette: Array.isArray(c.palette) ? c.palette.slice(0, 8) : [] })),
    mtime: fs.statSync(html).mtimeMs,
    choice,
  };
}

// An explorer built with --output can have any name, so the hub looks for the
// embedded data marker; only the head of each file is read to decide.
function looksLikeExplorer(file) {
  let handle;
  try {
    handle = fs.openSync(file, "r");
    const head = Buffer.alloc(128 * 1024);
    const read = fs.readSync(handle, head, 0, head.length, 0);
    return head.subarray(0, read).includes("const DATA = ");
  } catch {
    return false;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
}

// The hub says whose drafts these are: the folder that holds .jstyle, or the served folder itself.
export function hubProject(root) {
  const dir = path.basename(root) === ".jstyle" ? path.dirname(root) : root;
  const home = homedir();
  return { project: path.basename(dir), location: dir === home || dir.startsWith(home + path.sep) ? "~" + dir.slice(home.length) : dir };
}

// A file reached through a link outside the hub folder is not part of the hub, even if it is an explorer.
function insideRoot(root, file) {
  try {
    const top = fs.realpathSync(root);
    const real = fs.realpathSync(file);
    return real === top || real.startsWith(top + path.sep);
  } catch {
    return false;
  }
}

// The hub page polls every few seconds; an unchanged explorer is not read again.
const explorerCache = new Map();
function cachedExplorer(file) {
  const stat = fs.statSync(file);
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = explorerCache.get(file);
  if (hit?.key === key) return hit.data;
  const data = looksLikeExplorer(file) ? readExplorerData(file) : null;
  explorerCache.set(file, { key, data });
  return data;
}

export function hubList(root) {
  const entries = [];
  const walk = (dir, depth) => {
    if (depth > HUB_DEPTH) return;
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name === "node_modules" || item.name.startsWith(".")) continue;
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full, depth + 1);
      else if (item.name.toLowerCase().endsWith(".html")) {
        // One broken or vanishing page (a round deleted mid-walk) must not fail the list or the server.
        try {
          const data = cachedExplorer(full);
          if (data) entries.push(hubEntry(root, full, data));
        } catch {
          // Skipped.
        }
      }
    }
  };
  walk(root, 0);
  return entries.sort((a, b) => b.mtime - a.mtime);
}

export function createServer({ root, page, choice = null }) {
  return http.createServer((request, response) => {
    const send = (status, headers, body = "") => {
      // Without no-store, browsers reuse an old script after an edit, which
      // leaves new sidebar entries visible but inert.
      response.writeHead(status, { "Cache-Control": "no-store", ...headers });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    const url = new URL(request.url, "http://localhost");
    if (choice && request.method === "POST" && url.pathname === CHOICE_PATH) return receiveChoice(request, choice, send);
    if (choice?.hub && (request.method === "GET" || request.method === "HEAD")) {
      if (url.pathname === "/") return send(200, { "Content-Type": "text/html; charset=utf-8" }, fs.readFileSync(HUB_PAGE));
      if (url.pathname === HUB_PATH) {
        let body;
        try {
          body = JSON.stringify({ root: path.basename(choice.root), ...hubProject(choice.root), entries: hubList(choice.root) }) + "\n";
        } catch (error) {
          return send(500, { "Content-Type": "application/json; charset=utf-8" }, JSON.stringify({ error: String(error?.message ?? error) }) + "\n");
        }
        return send(200, { "Content-Type": "application/json; charset=utf-8" }, body);
      }
    }
    if (request.method !== "GET" && request.method !== "HEAD") return send(501, { "Content-Type": "text/plain" }, "Unsupported method\n");
    // The served folder rarely has an index.html, so a bare host URL opened on
    // another device would show a directory listing instead of the page.
    // The query is kept because it carries the explorer's choice token.
    if (url.pathname === "/") return send(302, { Location: withQuery("/" + page, url.search) });
    const target = localPath(root, url.pathname);
    let info;
    try {
      info = fs.statSync(target);
    } catch {
      return send(404, { "Content-Type": "text/plain; charset=utf-8" }, "File not found\n");
    }
    if (info.isDirectory()) {
      if (!url.pathname.endsWith("/")) return send(301, { Location: url.pathname + "/" + url.search });
      const index = ["index.html", "index.htm"].map((name) => path.join(target, name)).find((item) => fs.existsSync(item));
      if (!index) return send(200, { "Content-Type": "text/html; charset=utf-8" }, listing(url.pathname, target));
      return sendFile(index);
    }
    return sendFile(target);

    function sendFile(file) {
      const stat = fs.statSync(file);
      const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      send(200, { "Content-Type": type, "Content-Length": stat.size, "Last-Modified": stat.mtime.toUTCString() }, fs.readFileSync(file));
    }
  });
}

function openBrowser(url) {
  const [command, args] = {
    darwin: ["open", [url]],
    win32: ["cmd", ["/c", "start", "", url]],
  }[process.platform] ?? ["xdg-open", [url]];
  // A missing opener is not an error: the printed URL still works.
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}

function withQuery(target, search) {
  if (!search) return target;
  const hash = target.indexOf("#");
  return hash < 0 ? target + search : target.slice(0, hash) + search + target.slice(hash);
}

export function pageUrls({ host, port, page, search = "" }) {
  const local = withQuery(`http://${WILDCARD.has(host) ? "127.0.0.1" : host}:${port}/${page}`, search);
  return { local, other: WILDCARD.has(host) ? withQuery(`http://${hostname()}:${port}/${page}`, search) : null };
}

// With choices, an explorer page can post the picked direction back; it is
// written to choice.json next to the page and passed to onChoice.
export function explorerChoice(root, page, onChoice, { once = false } = {}) {
  const file = path.join(root, page.split("#")[0]);
  const data = readExplorerData(file);
  if (!data) return null;
  return { token: randomBytes(16).toString("hex"), data, file: path.join(path.dirname(file), CHOICE_FILE), onChoice, once, closed: false };
}

// A hub takes picks for every explorer under root; the page in each post says which.
export function hubChoice(root, onChoice, { once = false } = {}) {
  return { token: randomBytes(16).toString("hex"), hub: true, root, onChoice, once, closed: false };
}

// Resolves once the server listens; stays running until Ctrl+C.
export function serve({ root, page, host = "127.0.0.1", port = 8765, open = true, out = process.stderr, choice = null }) {
  const server = createServer({ root, page, choice });
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") reject(new Error(`포트 ${port}를 이미 다른 프로그램이 쓰고 있습니다. --port로 다른 포트를 지정하세요`));
      else reject(error);
    });
    server.listen(port, WILDCARD.has(host) ? undefined : host, () => {
      const { local, other } = pageUrls({ host, port: server.address().port, page, search: choice ? `?t=${choice.token}` : "" });
      out.write(`Serving ${root} at ${local} (Ctrl+C to stop)\n`);
      if (other) out.write(`Other devices: ${other}\n`);
      if (open) setTimeout(() => openBrowser(local), 300);
      process.once("SIGINT", () => {
        server.close();
        process.exit(130);
      });
      resolve(server);
    });
  });
}

const HELP = `usage: serve.mjs [page] [--root DIR] [--host HOST] [--port PORT] [--no-open]

Serve DIR (default: the jstyle folder) with caching disabled and open page in it.
The bare root URL redirects to page, so other devices can open http://<host>:<port>/.
`;

export function parseServeArgs(argv, defaults) {
  const options = { ...defaults };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      if (index + 1 >= argv.length) throw new Error(`${arg}에 값이 필요합니다`);
      return argv[++index];
    };
    if (arg === "-h" || arg === "--help") options.help = true;
    else if (arg === "--root") options.root = value();
    else if (arg === "--host") options.host = value();
    else if (arg === "--port") options.port = Number(value());
    else if (arg === "--no-open") options.open = false;
    else if (arg === "--wait") options.wait = true;
    else if (arg.startsWith("-")) throw new Error(`알 수 없는 옵션: ${arg}`);
    else if (options.pageGiven) throw new Error(`page는 하나만 받습니다: ${arg}`);
    else Object.assign(options, { page: arg, pageGiven: true });
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("--port는 0~65535 사이의 정수여야 합니다");
  return options;
}

export const SKILL_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function main() {
  let options;
  try {
    options = parseServeArgs(process.argv.slice(2), { root: SKILL_ROOT, page: "assets/extended/index.html", host: "127.0.0.1", port: 8765, open: true });
  } catch (error) {
    process.stderr.write(`${HELP}\nserve.mjs: error: ${error.message}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.wait) {
    process.stderr.write("serve.mjs: error: --wait는 jstyle serve나 jstyle explore에서 쓰세요\n");
    return 2;
  }
  const root = path.resolve(options.root);
  if (!fs.statSync(path.join(root, options.page.split("#")[0]), { throwIfNoEntry: false })?.isFile()) {
    process.stderr.write(`serve.mjs: error: ${options.page} does not exist under ${root}\n`);
    return 2;
  }
  try {
    await serve({ ...options, root });
  } catch (error) {
    process.stderr.write(`serve.mjs: error: ${error.message}\n`);
    return 1;
  }
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = await main();
  if (code !== null) process.exitCode = code;
}
