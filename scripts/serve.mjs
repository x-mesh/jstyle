#!/usr/bin/env node
// Serve a folder with caching disabled and open one page in it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIME = JSON.parse(fs.readFileSync(new URL("./lib/mime-types.json", import.meta.url), "utf8")).types;
const WILDCARD = new Set(["0.0.0.0", "::", ""]);

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

export function createServer({ root, page }) {
  return http.createServer((request, response) => {
    const send = (status, headers, body = "") => {
      // Without no-store, browsers reuse an old script after an edit, which
      // leaves new sidebar entries visible but inert.
      response.writeHead(status, { "Cache-Control": "no-store", ...headers });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    if (request.method !== "GET" && request.method !== "HEAD") return send(501, { "Content-Type": "text/plain" }, "Unsupported method\n");
    const url = new URL(request.url, "http://localhost");
    // The served folder rarely has an index.html, so a bare host URL opened on
    // another device would show a directory listing instead of the page.
    if (url.pathname === "/") return send(302, { Location: "/" + page });
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

export function pageUrls({ host, port, page }) {
  const local = `http://${WILDCARD.has(host) ? "127.0.0.1" : host}:${port}/${page}`;
  return { local, other: WILDCARD.has(host) ? `http://${hostname()}:${port}/${page}` : null };
}

// Resolves once the server listens; stays running until Ctrl+C.
export function serve({ root, page, host = "127.0.0.1", port = 8765, open = true, out = process.stderr }) {
  const server = createServer({ root, page });
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") reject(new Error(`포트 ${port}를 이미 다른 프로그램이 쓰고 있습니다. --port로 다른 포트를 지정하세요`));
      else reject(error);
    });
    server.listen(port, WILDCARD.has(host) ? undefined : host, () => {
      const { local, other } = pageUrls({ host, port: server.address().port, page });
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
