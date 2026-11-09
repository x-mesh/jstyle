#!/usr/bin/env node
// Serve a folder with caching disabled and open one page in it.
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { isIP } from "node:net";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_PROJECTS } from "./lib/hubstore.mjs";
import { isAlive, removeRecord, writeRecord } from "./lib/registry.mjs";

const MIME = JSON.parse(fs.readFileSync(new URL("./lib/mime-types.json", import.meta.url), "utf8")).types;
const WILDCARD = new Set(["0.0.0.0", "::", ""]);
export const CHOICE_PATH = "/__jstyle/choice";
export const CHOICE_FILE = "choice.json";
export const HUB_PATH = "/__jstyle/hub.json";
export const ALIVE_PATH = "/__jstyle/alive";
export const PROJECTS_PATH = "/__jstyle/projects";
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
    let project = null;
    if (choice.hub) {
      if (typeof body.page !== "string" || !body.page.startsWith("/") || body.page.length > 2000) return json(400, { error: "page" });
      const at = projectAt(choice, body.page);
      if (!at) return json(400, { error: "page" });
      usedProject(choice, at.slug);
      const html = localPath(at.root, at.rest);
      if (!insideRoot(at.root, html)) return json(400, { error: "page" });
      data = readExplorerData(html);
      if (!data) return json(400, { error: "page" });
      file = path.join(path.dirname(html), CHOICE_FILE);
      page = path.relative(at.root, html).split(path.sep).join("/");
      project = at.slug;
    }
    const record = choiceRecord(data, body);
    if (!record) return json(400, { error: body.comments?.length ? "comments" : "id" });
    // Nothing picked, noted or commented: refusing it keeps --wait from ending with an empty result.
    if (record.id === null && !record.comments.length && !record.notes.trim()) return json(400, { error: "empty" });
    if (page) Object.assign(record, { project, page });
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
const DENIED = new Set(["EACCES", "EPERM"]);

function hiddenPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return true;
  }
  return decoded.split(/[\\/]/).some((part) => part.startsWith("."));
}

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

// A page that another site loads into the browser could otherwise read this
// server by pointing its own name at one of its addresses (DNS rebinding).
// On loopback only loopback names and this machine's name pass. On another
// address (--host with 0.0.0.0, a LAN or Tailscale address) a rebinding name
// must resolve in public DNS, so IP literals, single-label names (Tailscale
// MagicDNS), .local, .ts.net and this machine's name pass, and any other
// dotted name is refused.
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
function allowedHost(request) {
  const header = String(request.headers.host ?? "").toLowerCase();
  const literal = header.startsWith("[");
  const name = literal ? header.slice(1, header.indexOf("]")) : header.replace(/:\d+$/, "");
  const own = hostname().toLowerCase();
  const ownNames = [own, own.replace(/\.local$/, "")];
  if (LOOPBACK_ADDRESSES.has(request.socket.localAddress)) return ["localhost", "127.0.0.1", "::1", ...ownNames].includes(name);
  if (literal ? isIP(name) === 6 : isIP(name) === 4) return true;
  return !name.includes(".") || name.endsWith(".local") || name.endsWith(".ts.net") || ownNames.includes(name);
}

// jstyle's own endpoints are called by the page the server sent, so a request
// another site makes (a no-cors fetch, a form) is refused. Static files are not
// checked: a sandboxed candidate frame has an opaque origin, so its images and
// styles arrive as cross-site too. A request without the header (curl, the CLI) passes.
function ownRequest(request) {
  const site = request.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

function readJson(request, limit, done) {
  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size <= limit) chunks.push(chunk);
  });
  request.on("end", () => {
    if (size > limit) return done(null, "size");
    try {
      done(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      done(null, "json");
    }
  });
}

export function createServer({ root, page, choice = null, onActivity = null }) {
  // A hub serves many projects, so no request may end the process: an error answers 500 instead.
  return http.createServer((request, response) => {
    try {
      handle(request, response);
    } catch {
      if (response.headersSent) return response.destroy();
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      response.end("Server error\n");
    }
  });

  function handle(request, response) {
    const send = (status, headers, body = "") => {
      // Without no-store, browsers reuse an old script after an edit, which
      // leaves new sidebar entries visible but inert.
      response.writeHead(status, { "Cache-Control": "no-store", ...headers });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    const json = (status, value) => send(status, { "Content-Type": "application/json; charset=utf-8" }, JSON.stringify(value) + "\n");
    if (!allowedHost(request)) return send(403, { "Content-Type": "text/plain; charset=utf-8" }, "Host not allowed\n");
    let url;
    try {
      url = new URL(request.url, "http://localhost");
    } catch {
      return send(400, { "Content-Type": "text/plain; charset=utf-8" }, "Bad request\n");
    }
    const own = url.pathname.startsWith("/__jstyle/");
    if (own && !ownRequest(request)) return json(403, { error: "site" });
    onActivity?.();
    // Open pages call this to keep an idle server up; the pid lets `jstyle stop` check it ends a jstyle server.
    if (url.pathname === ALIVE_PATH) return send(204, { "X-Jstyle-Pid": String(process.pid) });
    if (choice && request.method === "POST" && url.pathname === CHOICE_PATH) return receiveChoice(request, choice, send);
    if (choice?.hub && request.method === "POST" && url.pathname === PROJECTS_PATH) return receiveProject(request, choice, json);
    if (choice?.hub && (request.method === "GET" || request.method === "HEAD")) {
      if (url.pathname === HUB_PATH) {
        let body;
        try {
          body = hubJson(choice, url.searchParams.get("page"));
        } catch (error) {
          return json(500, { error: String(error?.message ?? error) });
        }
        return body ? json(200, body) : json(404, { error: "page" });
      }
      if (url.pathname === "/") {
        const only = choice.projects.size === 1 ? [...choice.projects.keys()][0] : null;
        if (only) return send(302, { Location: `/${encodeURIComponent(only)}/${url.search}` });
        return send(200, { "Content-Type": "text/html; charset=utf-8" }, fs.readFileSync(HUB_PAGE));
      }
      const at = projectAt(choice, url.pathname);
      if (!at) return send(404, { "Content-Type": "text/plain; charset=utf-8" }, "File not found\n");
      usedProject(choice, at.slug);
      if (at.rest === "") return send(301, { Location: url.pathname + "/" + url.search });
      if (at.rest === "/") return send(200, { "Content-Type": "text/html; charset=utf-8" }, fs.readFileSync(HUB_PAGE));
      return serveFile(at.root, at.rest, url.pathname, true);
    }
    if (request.method !== "GET" && request.method !== "HEAD") return send(501, { "Content-Type": "text/plain" }, "Unsupported method\n");
    // The served folder rarely has an index.html, so a bare host URL opened on
    // another device would show a directory listing instead of the page.
    // The query is kept because it carries the explorer's choice token.
    if (url.pathname === "/") return send(302, { Location: withQuery("/" + page, url.search) });
    return serveFile(root, url.pathname, url.pathname);

    function serveFile(base, rest, shown, guarded = false) {
      const missing = () => send(404, { "Content-Type": "text/plain; charset=utf-8" }, "File not found\n");
      // One unreadable file must not end a server that other pages and projects share.
      try {
        const target = localPath(base, rest);
        // A hub takes any project folder, so dot files (.env, .git) and links that leave the folder stay hidden.
        if (guarded && (hiddenPath(rest) || !insideRoot(base, target))) return missing();
        let info;
        try {
          info = fs.statSync(target);
        } catch (error) {
          if (DENIED.has(error?.code)) throw error;
          return missing();
        }
        if (info.isDirectory()) {
          if (!shown.endsWith("/")) return send(301, { Location: shown + "/" + url.search });
          const index = ["index.html", "index.htm"].map((name) => path.join(target, name)).find((item) => fs.existsSync(item));
          if (!index) return send(200, { "Content-Type": "text/html; charset=utf-8" }, listing(shown, target));
          return sendFile(index);
        }
        return sendFile(target);
      } catch (error) {
        if (response.headersSent) return response.destroy();
        const status = DENIED.has(error?.code) ? 403 : 500;
        return send(status, { "Content-Type": "text/plain; charset=utf-8" }, status === 403 ? "Permission denied\n" : "Could not read the file\n");
      }
    }

    function sendFile(file) {
      const stat = fs.statSync(file);
      const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      send(200, { "Content-Type": type, "Content-Length": stat.size, "Last-Modified": stat.mtime.toUTCString() }, fs.readFileSync(file));
    }
  }
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

// A hub serves one or more project folders, each under /<slug>/, and takes
// picks for every explorer in them; the page in each post says which.
export function hubChoice(onChoice, { once = false } = {}) {
  return { token: randomBytes(16).toString("hex"), hub: true, projects: new Map(), times: new Map(), onChoice, once, closed: false, onProjects: null, onUsed: null, usedAt: 0 };
}

export function addProject(hub, root) {
  const real = fs.realpathSync(root);
  for (const [slug, known] of hub.projects) if (known === real) return slug;
  let base = hubProject(real).project.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[.-]+/, "") || "project";
  if (base.startsWith("__")) base = `p${base}`;
  let slug = base;
  for (let n = 2; hub.projects.has(slug); n += 1) slug = `${base}-${n}`;
  hub.projects.set(slug, real);
  const now = new Date().toISOString();
  hub.times.set(slug, { added: now, lastUsed: now });
  // The saved list stays small: past the limit the project used longest ago goes.
  while (hub.projects.size > MAX_PROJECTS) {
    const [oldest] = [...hub.times].filter(([name]) => name !== slug).sort((a, b) => a[1].lastUsed.localeCompare(b[1].lastUsed))[0];
    hub.projects.delete(oldest);
    hub.times.delete(oldest);
  }
  hub.onProjects?.();
  return slug;
}

// The shape addProject makes; a saved slug outside it was not written by this code.
const SLUG = /^[\p{L}\p{N}_][\p{L}\p{N}._-]*$/u;

// Puts back projects a hub saved, under the slugs they had. A folder that is
// gone or may no longer be served is left out and reported.
export function restoreProjects(hub, entries) {
  const restored = [];
  const dropped = [];
  for (const entry of entries.slice(-MAX_PROJECTS)) {
    const real = SLUG.test(entry.slug) && !entry.slug.startsWith("__") ? servableFolder(entry.root) : null;
    if (!real || hub.projects.has(entry.slug) || [...hub.projects.values()].includes(real)) {
      dropped.push(entry.root);
      continue;
    }
    hub.projects.set(entry.slug, real);
    const now = new Date().toISOString();
    hub.times.set(entry.slug, { added: typeof entry.added === "string" ? entry.added : now, lastUsed: typeof entry.lastUsed === "string" ? entry.lastUsed : now });
    restored.push(entry.slug);
  }
  return { restored, dropped };
}

export function savedProjects(hub) {
  return [...hub.projects].map(([slug, root]) => ({ slug, root, ...hub.times.get(slug) }));
}

// lastUsed decides which project goes first past the limit; saving it at most once a minute is enough.
function usedProject(hub, slug) {
  const times = hub.times.get(slug);
  if (!times) return;
  const now = Date.now();
  times.lastUsed = new Date(now).toISOString();
  if (now - hub.usedAt < 60000) return;
  hub.usedAt = now;
  hub.onUsed?.();
}

export function projectList(hub) {
  return [...hub.projects].map(([slug, root]) => ({ slug, root, ...hubProject(root) }));
}

// The first path segment names the project; rest keeps the leading slash ("" for /<slug>).
function projectAt(hub, pathname) {
  const slash = pathname.indexOf("/", 1);
  let slug = slash < 0 ? pathname.slice(1) : pathname.slice(1, slash);
  try {
    slug = decodeURIComponent(slug);
  } catch {
    return null;
  }
  const root = hub.projects.get(slug);
  return root ? { slug, root, rest: slash < 0 ? "" : pathname.slice(slash) } : null;
}

function hubJson(hub, page) {
  if (!page) {
    return {
      projects: projectList(hub).map(({ slug, root, project, location }) => {
        const entries = hubList(root);
        return { slug, base: `/${encodeURIComponent(slug)}/`, project, location, pages: new Set(entries.map((e) => e.group)).size, rounds: entries.length, open: entries.filter((e) => !e.choice || e.choice.stale).length, latest: entries[0]?.mtime ?? null };
      }),
    };
  }
  const at = projectAt(hub, page);
  if (!at) return null;
  return { slug: at.slug, base: `/${encodeURIComponent(at.slug)}/`, root: path.basename(at.root), ...hubProject(at.root), others: hub.projects.size - 1, entries: hubList(at.root) };
}

// Registering hands this server a folder to serve, so it takes the token and
// refuses folders that would expose the whole home folder or the disk.
function servableFolder(root) {
  if (typeof root !== "string" || !path.isAbsolute(root) || root.length > 4096) return null;
  let real;
  try {
    real = fs.realpathSync(root);
    if (!fs.statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  const home = fs.realpathSync(homedir());
  if (real === path.parse(real).root || real === home || home.startsWith(real + path.sep)) return null;
  return real;
}

function receiveProject(request, hub, json) {
  if (!sameToken(request.headers["x-jstyle-token"], hub.token)) return json(403, { error: "token" });
  if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(415, { error: "content-type" });
  readJson(request, 16 * 1024, (body, problem) => {
    try {
      if (!body) return json(problem === "size" ? 413 : 400, { error: problem });
      if (typeof body.remove === "string") {
        if (!hub.projects.has(body.remove)) return json(404, { error: "project" });
        if (hub.projects.size === 1) return json(409, { error: "last" });
        hub.projects.delete(body.remove);
        hub.times.delete(body.remove);
        hub.onProjects?.();
        return json(200, { ok: true, removed: body.remove });
      }
      const real = servableFolder(body.root);
      if (!real) return json(400, { error: "root" });
      const slug = addProject(hub, real);
      return json(200, { ok: true, slug, base: `/${encodeURIComponent(slug)}/` });
    } catch (error) {
      try {
        json(500, { error: String(error?.message ?? error) });
      } catch {
        // The reply already went out; the error must still not end the server.
      }
    }
  });
}

// The project a served folder belongs to: the folder that holds its .jstyle, if any.
export function projectOf(root) {
  const parts = path.resolve(root).split(path.sep);
  const at = parts.lastIndexOf(".jstyle");
  return at > 0 ? parts[at - 1] : path.basename(path.resolve(root));
}

let packageVersion = null;
function version() {
  if (packageVersion === null) {
    try {
      packageVersion = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
    } catch {
      packageVersion = "";
    }
  }
  return packageVersion;
}

// Resolves once the server listens; stays running until Ctrl+C, `jstyle stop`,
// registry.idle minutes without requests, or (registry.wait) the end of the
// process that started it.
export function serve({ root, page, host = "127.0.0.1", port = 8765, open = true, out = process.stderr, choice = null, registry = null }) {
  let touch = () => {};
  const server = createServer({ root, page, choice, onActivity: () => touch() });
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") reject(new Error(`포트 ${port}를 이미 쓰고 있습니다. jstyle ps로 떠 있는 jstyle 서버인지 보고, 그렇다면 jstyle stop ${port} 뒤 다시 실행하거나 --port로 다른 포트를 지정하세요`));
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
      process.once("SIGTERM", () => {
        server.close();
        process.exit(143);
      });
      // A closed terminal sends SIGHUP; exiting through it still removes the record.
      process.once("SIGHUP", () => {
        server.close();
        process.exit(129);
      });
      if (registry) touch = track({ server, root, page, host, local, other, out, registry });
      resolve(server);
    });
  });
}

function track({ server, root, page, host, local, other, out, registry }) {
  const started = Date.now();
  let last = started;
  let written = started;
  const record = {
    pid: process.pid,
    port: server.address().port,
    host,
    kind: registry.kind,
    project: registry.project ?? projectOf(root),
    root: path.resolve(root),
    page,
    url: local,
    other,
    wait: Boolean(registry.wait),
    idle: registry.idle ?? null,
    started: new Date(started).toISOString(),
    lastActivity: new Date(started).toISOString(),
    version: version(),
    ...registry.extra?.(),
  };
  try {
    writeRecord(record);
  } catch (error) {
    out.write(`! 실행 기록을 쓰지 못했습니다(jstyle ps에 보이지 않습니다): ${error.message}\n`);
  }
  // A hub rewrites its record when projects are added or removed.
  registry.refresh = () => {
    Object.assign(record, registry.extra?.(record));
    try {
      writeRecord(record);
    } catch {
      // ps then shows the older project list; the server keeps running.
    }
  };
  process.once("exit", () => removeRecord(process.pid));
  // Activity is written at most every 15 s, enough for `jstyle ps` to show idle time.
  const touch = () => {
    last = Date.now();
    if (last - written < 15000) return;
    written = last;
    record.lastActivity = new Date(last).toISOString();
    try {
      writeRecord(record);
    } catch {
      // ps then shows an older activity time; the server keeps running.
    }
  };
  // A --wait server that closes without a pick fails, so the agent does not read an empty result as success.
  const shutdown = (message) => {
    out.write(`${message}\n`);
    server.closeAllConnections();
    server.close();
    process.exit(registry.wait ? 1 : 0);
  };
  if (registry.idle > 0) {
    const limit = registry.idle * 60000;
    setInterval(() => {
      if (Date.now() - last > limit) shutdown(`${registry.idle}분 동안 요청이 없어 서버를 닫습니다`);
    }, Math.max(200, Math.min(30000, limit / 4))).unref();
  }
  if (registry.wait && registry.parent > 1) {
    // registry.parent is the process waiting on --wait; once it is gone, nobody will read the pick.
    const check = () => {
      if (!isAlive(registry.parent)) shutdown(`기다리던 프로세스 ${registry.parent}가 끝나 서버를 닫습니다`);
    };
    check();
    setInterval(check, 2000).unref();
  }
  return touch;
}

const HELP = `usage: serve.mjs [page] [--root DIR] [--host HOST] [--port PORT] [--no-open] [--idle MIN]

Serve DIR (default: the jstyle folder) with caching disabled and open page in it.
The bare root URL redirects to page, so other devices can open http://<host>:<port>/.
With --idle MIN the server closes after MIN minutes with no request (default: never).
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
    else if (arg === "--idle") options.idle = Number(value());
    else if (arg.startsWith("-")) throw new Error(`알 수 없는 옵션: ${arg}`);
    else if (options.pageGiven) throw new Error(`page는 하나만 받습니다: ${arg}`);
    else Object.assign(options, { page: arg, pageGiven: true });
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("--port는 0~65535 사이의 정수여야 합니다");
  if (options.idle !== undefined && !(options.idle >= 0)) throw new Error("--idle은 0 이상의 분이어야 합니다(0은 끄지 않음)");
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
    await serve({ ...options, root, registry: { kind: "serve", idle: options.idle ?? 0 } });
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
