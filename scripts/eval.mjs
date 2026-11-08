#!/usr/bin/env node
// Site evaluation evidence: opens pages in an isolated browser, captures folds
// and full pages per width, and runs the eval scripts. It only reads pages; it
// never clicks, types or submits, so it is safe on sites the user does not own.
//
//     node scripts/eval.mjs https://example.com --mode site
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createChrome } from "./chrome.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT_DIR = path.join(ROOT, "scripts", "eval");

const MODES = {
  quick: { widths: [375, 1440], pageCap: 3 },
  site: { widths: [320, 375, 768, 1024, 1280, 1440, 1920], pageCap: 25 },
  app: { widths: [320, 375, 768, 1024, 1280, 1440, 1920], pageCap: 25 },
};
const MOBILE_MAX_PX = 768;
const DESKTOP_FOLD = { width: 1440, height: 900 };
const MOBILE_FOLD = { width: 375, height: 812 };
const PHONE_DPR = 3;
const DEFAULT_PACE_MS = 1000;
const NETWORK_IDLE_MS = 500;
const NETWORK_IDLE_CAP_MS = 10000;
const LOAD_TIMEOUT_MS = 30000;
const CDP_TIMEOUT_MS = 60000;
const FULL_PAGE_MAX_PX = 20000;
const BUDGETS = {
  standard: { lcpMs: 4000, cls: 0.25, inpMs: 500, ttfbMs: 1800 },
  funnel: { lcpMs: 2500, cls: 0.1, inpMs: 200, ttfbMs: 800 },
};
const PLACEHOLDER_RE = /lorem ipsum|dolor sit amet|\bTODO\b|\bTBD\b|your (?:headline|title|text) here|제목을 입력하세요|내용을 입력하세요/gi;

export const HELP = `usage: jstyle eval <주소...> [--mode quick|site|app] [--out <폴더>] [선택지]

공개된 사이트를 임시 브라우저로 열고 평가 근거를 남깁니다. 보기만 합니다.
누르기·입력·제출·로그인은 하지 않으며 robots.txt의 금지 경로는 건너뜁니다.
첫 주소를 시작 페이지로 봅니다. 페이지 목록은 평가하는 사람이 정해 넘깁니다.
/pricing처럼 /로 시작하는 경로는 첫 주소를 기준으로 풉니다.

  --mode <모드>       quick(375·1440, 3쪽), site(기본, 7개 너비, 25쪽), app(site와 같음)
  --out <폴더>        저장할 곳. 기본 .jstyle/eval-<사이트>-<날짜>
  --widths <a,b,...>  너비 목록을 직접 정합니다. 768 미만은 휴대폰으로 흉내 냅니다.
  --funnel <경로,...> 전환 기준(LCP 2.5초·CLS 0.1)으로 볼 경로. 예: /pricing,/signup
  --dark              어두운 모드로 375·1440 첫 화면과 1440 axe를 더 봅니다.
  --links             같은 사이트 링크를 모아 4xx·5xx를 확인합니다. 요청 간격을 지킵니다.
  --config <파일>     잡음 거르기 JSON. 없으면 .jstyle/eval-config.json을 찾습니다.
  --no-axe            axe-core를 페이지에 넣지 않습니다.
  --pace <밀리초>     같은 사이트 요청 사이 기다림. 기본 ${DEFAULT_PACE_MS}
  --wait <밀리초>     네트워크가 잠잠해진 뒤 더 기다릴 시간. 기본 300
  --ignore-robots     robots.txt를 무시합니다. 사용자 소유 사이트에만 씁니다.
  --dry-run           브라우저 없이 실행 계획만 JSON으로 보입니다.

결과는 <폴더>/evidence.json과 캡처 PNG이며, 요약 JSON 한 줄은 stdout, 진행은 stderr로 나옵니다.
gates는 차단 조건의 단서입니다. 캡처와 원문으로 확인한 뒤 발견으로 올립니다.
INP는 조작이 없어 대개 no interaction입니다. 키보드·조작 확인은 다른 브라우저 도구로 합니다.

종료 코드: 0 근거를 남김, 1 브라우저를 열지 못함·모든 페이지를 열지 못함·도중에 연결이 끊김(그때까지 근거는 남김), 2 잘못된 인수
`;

function parseList(value, flag) {
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!items.length) throw new Error(`${flag}에 값이 필요합니다`);
  return items;
}

function parseNumber(value, flag) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${flag}는 0 이상의 정수여야 합니다: ${value}`);
  return number;
}

export function parseArgs(argv) {
  const opts = { mode: "site", out: null, widths: null, funnel: [], dark: false, links: false, config: null, axe: true, pace: DEFAULT_PACE_MS, wait: 300, robots: true, dryRun: false, help: false, urls: [] };
  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    let inline = null;
    if (arg.startsWith("--") && arg.includes("=")) [arg, inline] = [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)];
    const value = () => {
      if (inline !== null) return inline;
      if (i + 1 >= argv.length) throw new Error(`${arg}에 값이 필요합니다`);
      return argv[++i];
    };
    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--mode") {
      opts.mode = value();
      if (!MODES[opts.mode]) throw new Error(`--mode는 quick, site, app 중 하나입니다: ${opts.mode}`);
    } else if (arg === "--out") opts.out = value();
    else if (arg === "--widths") opts.widths = parseList(value(), arg).map((w) => {
      const width = parseNumber(w, arg);
      if (width < 200 || width > 3840) throw new Error(`--widths는 200~3840 사이여야 합니다: ${w}`);
      return width;
    });
    else if (arg === "--funnel") opts.funnel = parseList(value(), arg).map((p) => (p.startsWith("/") ? p : `/${p}`));
    else if (arg === "--dark") opts.dark = true;
    else if (arg === "--links") opts.links = true;
    else if (arg === "--config") opts.config = value();
    else if (arg === "--no-axe") opts.axe = false;
    else if (arg === "--pace") opts.pace = parseNumber(value(), arg);
    else if (arg === "--wait") opts.wait = parseNumber(value(), arg);
    else if (arg === "--ignore-robots") opts.robots = false;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("-")) throw new Error(`알 수 없는 선택지입니다: ${arg}`);
    else opts.urls.push(arg);
  }
  return opts;
}

function normalizeUrl(input, base) {
  let url;
  try {
    if (input.startsWith("/")) {
      if (!base) throw new Error("relative");
      url = new URL(input, base);
    } else url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error(input.startsWith("/") ? `경로 ${input} 앞에 기준이 될 전체 주소를 먼저 주세요` : `주소를 읽을 수 없습니다: ${input}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`http·https 주소만 평가합니다: ${input}`);
  url.hash = "";
  return url.href;
}

function slug(text) {
  return text.toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "page";
}

export function pageSlug(href) {
  const url = new URL(href);
  const base = url.pathname === "/" || url.pathname === "" ? "home" : slug(url.pathname);
  return url.search ? `${base}-${slug(url.search)}` : base;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function planRun(opts) {
  if (!opts.urls.length) throw new Error("평가할 주소를 하나 이상 주세요. 예: jstyle eval https://example.com");
  const mode = MODES[opts.mode];
  const base = normalizeUrl(opts.urls[0]);
  const urls = [...new Set(opts.urls.map((input) => normalizeUrl(input, base)))];
  const dropped = urls.length > mode.pageCap ? urls.slice(mode.pageCap) : [];
  const kept = urls.slice(0, mode.pageCap);
  const widths = [...new Set(opts.widths ?? mode.widths)].sort((a, b) => b - a);
  const desktop = widths.filter((w) => w >= MOBILE_MAX_PX);
  const mobile = widths.filter((w) => w < MOBILE_MAX_PX);
  const nearest = (list, target) => list.reduce((best, w) => (best === null || Math.abs(w - target) < Math.abs(best - target) ? w : best), null);
  const foldDesktop = nearest(desktop, DESKTOP_FOLD.width);
  const foldMobile = nearest(mobile, MOBILE_FOLD.width);
  const first = new URL(kept[0]);
  const out = opts.out ? path.resolve(opts.out) : null;
  const slugs = new Map();
  const pages = kept.map((href, index) => {
    let name = pageSlug(href);
    if (new URL(href).host !== first.host) name = `${slug(new URL(href).host)}-${name}`;
    const seen = slugs.get(name) || 0;
    slugs.set(name, seen + 1);
    if (seen) name = `${name}-${seen + 1}`;
    const pathname = new URL(href).pathname;
    return { url: href, slug: name, start: index === 0, funnel: opts.funnel.includes(pathname) };
  });
  return {
    mode: opts.mode,
    pages,
    droppedOverCap: dropped,
    widths,
    foldWidths: { desktop: foldDesktop, mobile: foldMobile },
    heightFor: Object.fromEntries(widths.map((w) => [w, w < MOBILE_MAX_PX ? MOBILE_FOLD.height : DESKTOP_FOLD.height])),
    phoneBelow: MOBILE_MAX_PX,
    dark: opts.dark,
    links: opts.links,
    axe: opts.axe,
    robots: opts.robots,
    paceMs: opts.pace,
    out: out ?? path.resolve(".jstyle", `eval-${slug(first.hostname)}-${today()}`),
    outGiven: Boolean(out),
  };
}

function prepareOut(plan) {
  if (plan.outGiven) {
    fs.mkdirSync(plan.out, { recursive: true });
    return plan.out;
  }
  const workdir = path.dirname(plan.out);
  const info = fs.lstatSync(workdir, { throwIfNoEntry: false });
  if (info && !info.isDirectory()) throw new Error(`${workdir}가 폴더가 아닙니다(파일이나 심볼릭 링크). --out으로 다른 곳을 정하세요`);
  fs.mkdirSync(workdir, { recursive: true });
  const ignore = path.join(workdir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n!.gitignore\n");
  let target = plan.out;
  for (let n = 2; fs.existsSync(target) && fs.readdirSync(target).length; n += 1) target = `${plan.out}-${n}`;
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function loadConfig(file) {
  const empty = { consoleIgnore: [], networkIgnore: [], axe: { ignoreRules: [], ignorePages: [] }, source: null };
  const candidate = file ? path.resolve(file) : path.resolve(".jstyle", "eval-config.json");
  if (!fs.existsSync(candidate)) {
    if (file) throw new Error(`설정 파일이 없습니다: ${candidate}`);
    return empty;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(candidate, "utf8"));
  } catch (error) {
    throw new Error(`설정 파일을 JSON으로 읽지 못했습니다: ${candidate} (${error.message})`);
  }
  const list = (value) => (Array.isArray(value) ? value.map(String) : []);
  return {
    consoleIgnore: list(raw.consoleIgnore),
    networkIgnore: list(raw.networkIgnore),
    axe: { ignoreRules: list(raw.axe?.ignoreRules), ignorePages: list(raw.axe?.ignorePages) },
    source: candidate,
  };
}

export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const line of text.split(/\r?\n/)) {
    const clean = line.replace(/#.*/, "").trim();
    const colon = clean.indexOf(":");
    if (colon < 0) continue;
    const key = clean.slice(0, colon).trim().toLowerCase();
    const value = clean.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!lastWasAgent) groups.push((current = { agents: [], allow: [], disallow: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current || !value) continue;
    if (key === "disallow") current.disallow.push(value);
    if (key === "allow") current.allow.push(value);
  }
  const star = groups.filter((g) => g.agents.includes("*"));
  return { allow: star.flatMap((g) => g.allow), disallow: star.flatMap((g) => g.disallow) };
}

export function robotsAllows(rules, pathname) {
  const toRe = (pattern) => new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
  const longest = (list) => list.filter((p) => toRe(p).test(pathname)).reduce((len, p) => Math.max(len, p.length), -1);
  return longest(rules.allow) >= longest(rules.disallow);
}

async function fetchText(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    return { status: response.status, text: response.ok ? await response.text() : "" };
  } catch (error) {
    return { status: 0, text: "", error: error.name === "AbortError" ? "timeout" : error.message };
  } finally {
    clearTimeout(timer);
  }
}

function siteBase(hostname) {
  return hostname.replace(/^www\./, "");
}

function firstParty(url, pageHost) {
  try {
    const host = new URL(url).hostname;
    const base = siteBase(pageHost);
    return host === pageHost || host === base || host.endsWith(`.${base}`);
  } catch {
    return null;
  }
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { ok, no, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        msg.error ? no(new Error(msg.error.message)) : ok(msg.result);
      } else if (msg.method) for (const fn of this.listeners) fn(msg);
    };
    ws.onclose = () => {
      for (const { no, timer } of this.pending.values()) {
        clearTimeout(timer);
        no(new Error("브라우저 연결이 끊겼습니다"));
      }
      this.pending.clear();
    };
  }

  static connect(url) {
    return new Promise((ok, no) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => no(new Error("브라우저 연결이 30초 안에 열리지 않았습니다")), 30000);
      ws.onopen = () => { clearTimeout(timer); ok(new Cdp(ws)); };
      ws.onerror = () => { clearTimeout(timer); no(new Error("브라우저에 연결하지 못했습니다")); };
    });
  }

  send(method, params = {}, sessionId) {
    return new Promise((ok, no) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        no(new Error(`CDP ${method} 요청이 ${CDP_TIMEOUT_MS / 1000}초 안에 응답하지 않았습니다`));
      }, CDP_TIMEOUT_MS);
      this.pending.set(id, { ok, no, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const scripts = new Map();
function script(name) {
  if (!scripts.has(name)) scripts.set(name, fs.readFileSync(path.join(SCRIPT_DIR, `${name}.js`), "utf8"));
  return scripts.get(name);
}

const HEAD_EXPRESSION = `JSON.stringify((() => ({
  title: document.title,
  description: document.querySelector('meta[name="description"]')?.content ?? null,
  canonical: document.querySelector('link[rel="canonical"]')?.href ?? null,
  robots: document.querySelector('meta[name="robots"]')?.content ?? null,
  lang: document.documentElement.lang || null,
  og: Object.fromEntries([...document.querySelectorAll('meta[property^="og:"]')].map(m => [m.getAttribute('property'), m.content])),
  h1: [...document.querySelectorAll('h1')].map(h => h.innerText.trim()),
  imgsMissingAlt: [...document.querySelectorAll('img')].filter(i => !i.hasAttribute('alt')).map(i => i.currentSrc || i.src).slice(0, 20),
}))())`;

const LINKS_EXPRESSION = `JSON.stringify([...new Set([...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => /^https?:/.test(h)).map(h => h.split('#')[0]))])`;

const TEXT_EXPRESSION = `document.body ? document.body.innerText : ""`;

class Page {
  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.inflight = new Set();
    this.lastNetwork = Date.now();
    this.capture = null;
    cdp.listeners.add((msg) => this.onEvent(msg));
  }

  send(method, params) {
    return this.cdp.send(method, params, this.sessionId);
  }

  onEvent(msg) {
    if (msg.sessionId !== this.sessionId) return;
    const p = msg.params;
    const c = this.capture;
    switch (msg.method) {
      case "Network.requestWillBeSent":
        this.inflight.add(p.requestId);
        this.lastNetwork = Date.now();
        if (c) c.requests.set(p.requestId, { url: p.request.url, method: p.request.method, type: p.type });
        break;
      case "Network.responseReceived":
        if (c) {
          const r = c.requests.get(p.requestId) || { url: p.response.url, type: p.type };
          Object.assign(r, { status: p.response.status, mime: p.response.mimeType, protocol: p.response.protocol });
          c.requests.set(p.requestId, r);
        }
        break;
      case "Network.loadingFinished":
        this.inflight.delete(p.requestId);
        this.lastNetwork = Date.now();
        if (c && c.requests.has(p.requestId)) c.requests.get(p.requestId).bytes = p.encodedDataLength;
        break;
      case "Network.loadingFailed":
        this.inflight.delete(p.requestId);
        this.lastNetwork = Date.now();
        if (c && c.requests.has(p.requestId)) Object.assign(c.requests.get(p.requestId), { failed: p.errorText, blocked: p.blockedReason || null, canceled: p.canceled });
        break;
      case "Runtime.consoleAPICalled":
        if (c && (p.type === "error" || p.type === "warning")) {
          c.console.push({
            level: p.type === "warning" ? "warning" : "error",
            source: "console",
            text: p.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300),
            url: p.stackTrace?.callFrames?.[0]?.url || null,
          });
        }
        break;
      case "Runtime.exceptionThrown":
        if (c) {
          const d = p.exceptionDetails;
          c.console.push({
            level: "error",
            source: "exception",
            text: (d.exception?.description || d.text || "").split("\n")[0].slice(0, 300),
            url: d.url || d.stackTrace?.callFrames?.[0]?.url || null,
          });
        }
        break;
      case "Log.entryAdded":
        if (c && (p.entry.level === "error" || p.entry.level === "warning")) {
          c.console.push({ level: p.entry.level, source: p.entry.source === "network" ? "network" : "log", text: p.entry.text.slice(0, 300), url: p.entry.url || null });
        }
        break;
      default:
    }
  }

  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }

  async evaluateJson(name) {
    const text = await this.evaluate(script(name));
    return JSON.parse(text);
  }

  async emulate(width, height, { phone, dark, ua }) {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: phone ? PHONE_DPR : 1, mobile: phone, screenWidth: width, screenHeight: height });
    await this.send("Emulation.setTouchEmulationEnabled", phone ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    await this.send("Emulation.setUserAgentOverride", phone ? { userAgent: ua.phone, platform: "Linux armv8l", userAgentMetadata: ua.phoneMetadata } : { userAgent: ua.desktop });
    await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  }

  async open(url, waitMs) {
    this.capture = { requests: new Map(), console: [] };
    let loaded;
    const done = new Promise((ok) => {
      loaded = (msg) => { if (msg.sessionId === this.sessionId && msg.method === "Page.loadEventFired") ok(true); };
      this.cdp.listeners.add(loaded);
    });
    const started = Date.now();
    let nav;
    try {
      nav = await this.send("Page.navigate", { url });
      if (nav.errorText) return { ok: false, error: nav.errorText };
      const fired = await Promise.race([done, sleep(LOAD_TIMEOUT_MS).then(() => false)]);
      const idleUntil = Date.now() + NETWORK_IDLE_CAP_MS;
      while (Date.now() < idleUntil && (this.inflight.size || Date.now() - this.lastNetwork < NETWORK_IDLE_MS)) await sleep(100);
      await this.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true");
      await sleep(waitMs);
      return { ok: true, loadEvent: fired, ms: Date.now() - started };
    } finally {
      this.cdp.listeners.delete(loaded);
    }
  }

  async screenshot(file, { full = false, dpr = 1 } = {}) {
    const params = { format: "png" };
    if (full) {
      const { cssContentSize } = await this.send("Page.getLayoutMetrics");
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: Math.ceil(cssContentSize.width), height: Math.min(Math.ceil(cssContentSize.height), FULL_PAGE_MAX_PX), scale: 1 / dpr };
    }
    const { data } = await this.send("Page.captureScreenshot", params);
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    return path.basename(file);
  }
}

function userAgents(product, userAgent) {
  const version = (product.split("/")[1] || "131.0.0.0").split(".")[0];
  const desktop = userAgent.replace(/HeadlessChrome/g, "Chrome");
  const phone = `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Mobile Safari/537.36`;
  const phoneMetadata = { brands: [{ brand: "Chromium", version }, { brand: "Google Chrome", version }], fullVersion: `${version}.0.0.0`, platform: "Android", platformVersion: "14", architecture: "", model: "Pixel 8", mobile: true };
  return { desktop, phone, phoneMetadata };
}

function summarizeCapture(capture, pageUrl, config) {
  const pageHost = new URL(pageUrl).hostname;
  const requests = [...capture.requests.values()];
  const matches = (list, text) => list.some((needle) => text.includes(needle));
  const network = [];
  let suppressedNetwork = 0;
  for (const r of requests) {
    if (!(r.status >= 400) && !r.failed) continue;
    const item = { url: r.url, status: r.status ?? null, type: r.type || null, failed: r.failed || null, firstParty: firstParty(r.url, pageHost) };
    let pathText = r.url;
    try { pathText = new URL(r.url).pathname; } catch {}
    if (matches(config.networkIgnore, `${pathText} ${item.status ?? item.failed}`)) { suppressedNetwork += 1; continue; }
    network.push(item);
  }
  const consoleItems = [];
  let suppressedConsole = 0;
  for (const entry of capture.console) {
    if (matches(config.consoleIgnore, entry.text)) { suppressedConsole += 1; continue; }
    const party = entry.url ? firstParty(entry.url, pageHost) : null;
    consoleItems.push({ ...entry, firstParty: party ?? true, firstPartyAssumed: party === null });
  }
  return {
    requests: requests.length,
    transferKB: Math.round(requests.reduce((sum, r) => sum + (r.bytes || 0), 0) / 1024),
    insecure: requests.filter((r) => pageUrl.startsWith("https:") && r.url.startsWith("http:")).map((r) => r.url).slice(0, 10),
    failures: network,
    console: consoleItems,
    suppressed: { console: suppressedConsole, network: suppressedNetwork },
  };
}

function placeholderHits(text) {
  const hits = [];
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const start = Math.max(0, match.index - 40);
    hits.push(text.slice(start, match.index + match[0].length + 40).replace(/\s+/g, " ").trim());
    if (hits.length >= 5) break;
  }
  return hits;
}

function filterAxe(axe, pathname, config) {
  if (!axe || axe.error) return axe;
  if (config.axe.ignorePages.some((p) => pathname.startsWith(p))) return { ...axe, suppressedPage: true, violations: [], counts: { critical: 0, serious: 0, moderate: 0, minor: 0 } };
  const ignored = new Set(config.axe.ignoreRules);
  const violations = axe.violations.filter((v) => !ignored.has(v.id));
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of violations) counts[v.impact] = (counts[v.impact] || 0) + 1;
  return { ...axe, violations, counts, suppressedRules: axe.violations.length - violations.length };
}

export function computeGates(pages, linkResults) {
  const gates = { placeholder: 0, http5xx: 0, consoleErrorsFirstParty: 0, internalLinks4xx: linkResults ? 0 : null, layoutBreaks: 0, axeCritical: 0, axeSerious: 0, perfOverBudget: [] };
  const noise = { consoleWarnings: 0, thirdPartyErrors: {}, suppressed: { console: 0, network: 0, axeRules: 0 } };
  const seenConsole = new Set();
  const seenFailures = new Set();
  for (const page of pages) {
    if (!page.opened) continue;
    gates.placeholder += page.placeholder?.length ? 1 : 0;
    for (const run of Object.values(page.widths)) {
      if (!run.network) continue;
      noise.suppressed.console += run.network.suppressed.console;
      noise.suppressed.network += run.network.suppressed.network;
      for (const f of run.network.failures) {
        const key = `${f.url} ${f.status}`;
        if (seenFailures.has(key)) continue;
        seenFailures.add(key);
        if (f.firstParty && f.status >= 500) gates.http5xx += 1;
      }
      for (const entry of run.network.console) {
        const key = `${entry.level} ${entry.source} ${entry.text}`;
        if (seenConsole.has(key)) continue;
        seenConsole.add(key);
        if (entry.level === "warning") noise.consoleWarnings += 1;
        else if (entry.source === "network") continue;
        else if (entry.firstParty) gates.consoleErrorsFirstParty += 1;
        else {
          let origin = "unknown";
          try { origin = new URL(entry.url).hostname; } catch {}
          noise.thirdPartyErrors[origin] = (noise.thirdPartyErrors[origin] || 0) + 1;
        }
      }
      const l = run.layout;
      if (l && (l.horizontalPageScroll > 0 || l.layoutViewportExpanded > 0 || l.clippedByRootCount > 0 || l.collapsedMain?.length > 0)) gates.layoutBreaks += 1;
    }
    const axeRuns = [page.axe?.desktop, page.axe?.mobile, page.axe?.dark].filter((a) => a && !a.error);
    const rules = new Map();
    for (const a of axeRuns) {
      noise.suppressed.axeRules += a.suppressedRules || 0;
      for (const v of a.violations) rules.set(v.id, v.impact);
    }
    for (const impact of rules.values()) {
      if (impact === "critical") gates.axeCritical += 1;
      if (impact === "serious") gates.axeSerious += 1;
    }
    if (page.perf && !page.perf.error) {
      const budget = BUDGETS[page.funnel ? "funnel" : "standard"];
      const over = (metric, value, limit) => { if (value !== null && value !== undefined && value > limit) gates.perfOverBudget.push({ path: new URL(page.url).pathname, metric, value, budget: limit, kind: page.funnel ? "funnel" : "standard" }); };
      over("lcpMs", page.perf.lcpMs, budget.lcpMs);
      over("cls", page.perf.cls, budget.cls);
      if (page.perf.inpStatus === "measured" || page.perf.inpStatus === "first input only") over("inpMs", page.perf.inpMs, budget.inpMs);
    }
  }
  if (linkResults) gates.internalLinks4xx = linkResults.filter((r) => r.status >= 400 && r.status < 500).length;
  return { gates, noise };
}

async function run(plan, opts, log) {
  const config = loadConfig(opts.config);
  const out = prepareOut(plan);
  const robots = new Map();
  const skipped = [];
  const lastRequest = new Map();
  const pace = async (href) => {
    const origin = new URL(href).origin;
    const wait = (lastRequest.get(origin) || 0) + plan.paceMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest.set(origin, Date.now());
  };
  const allowed = async (href) => {
    if (!plan.robots) return true;
    const { origin, pathname } = new URL(href);
    if (!robots.has(origin)) {
      await pace(href);
      const r = await fetchText(`${origin}/robots.txt`);
      robots.set(origin, r.status === 200 ? parseRobots(r.text) : { allow: [], disallow: [] });
    }
    return robotsAllows(robots.get(origin), pathname);
  };

  const browser = createChrome({ prefix: "jstyle-eval-", label: "eval" });
  const cleanupOnSignal = () => { browser.dispose(); process.exit(130); };
  process.once("SIGINT", cleanupOnSignal);
  process.once("SIGTERM", cleanupOnSignal);
  let cdp;
  try {
    const wsUrl = await browser.launch();
    cdp = await Cdp.connect(wsUrl);
  } catch (error) {
    browser.dispose();
    throw new Error(`브라우저를 열지 못했습니다: ${error.message === "timeout" ? "45초 안에 시작하지 못했습니다" : error.message}`);
  }

  const file = path.join(out, "evidence.json");
  const save = () => fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n");
  const evidence = { tool: "jstyle eval", createdAt: new Date().toISOString(), mode: plan.mode, widths: plan.widths, foldWidths: plan.foldWidths, config: config.source, pages: [], links: null };
  try {
    const version = await cdp.send("Browser.getVersion");
    const ua = userAgents(version.product, version.userAgent);
    evidence.browser = version.product;
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const page = new Page(cdp, sessionId);
    for (const domain of ["Page", "Runtime", "Log", "Network"]) await page.send(`${domain}.enable`);
    await page.send("Network.setCacheDisabled", { cacheDisabled: true });

    const collected = new Set();
    const quick = plan.mode === "quick";
    for (const info of plan.pages) {
      const record = { ...info, opened: false, widths: {}, files: [], axe: {}, notes: [] };
      evidence.pages.push(record);
      if (!(await allowed(info.url))) {
        record.notes.push("robots.txt가 막은 경로라 열지 않았습니다");
        skipped.push(info.url);
        log(`- ${info.url} robots.txt 금지, 건너뜀`);
        continue;
      }
      const deep = !quick || info.start;
      const pathname = new URL(info.url).pathname;
      for (const width of plan.widths) try {
        const height = plan.heightFor[width];
        const phone = width < plan.phoneBelow;
        const fold = width === plan.foldWidths.desktop || width === plan.foldWidths.mobile;
        const desktopFold = width === plan.foldWidths.desktop;
        await page.emulate(width, height, { phone, dark: false, ua });
        await pace(info.url);
        log(`· ${info.slug} ${width}×${height}${phone ? " 휴대폰" : ""}`);
        const opened = await page.open(info.url, opts.wait);
        if (!opened.ok) {
          record.notes.push(`${width}px에서 열지 못했습니다: ${opened.error}`);
          continue;
        }
        record.opened = true;
        const entry = { phone, height, loadMs: opened.ms, loadEvent: opened.loadEvent };
        record.widths[width] = entry;
        if (desktopFold) record.perf = await page.evaluateJson("perf-capture").catch((error) => ({ error: error.message }));
        entry.network = summarizeCapture(page.capture, info.url, config);
        entry.layout = await page.evaluateJson("layout-detect").catch((error) => ({ error: error.message }));
        if (!fold) continue;
        await page.evaluate("window.scrollTo(0, 0), true");
        entry.fold = await page.evaluateJson("fold-check").catch((error) => ({ error: error.message }));
        record.files.push(await page.screenshot(path.join(out, `${info.slug}-${width}-fold.png`)));
        if (desktopFold) {
          record.finalUrl = await page.evaluate("location.href");
          record.head = JSON.parse(await page.evaluate(HEAD_EXPRESSION));
          record.placeholder = placeholderHits(await page.evaluate(TEXT_EXPRESSION));
          record.forms = await page.evaluateJson("form-audit").catch((error) => ({ error: error.message }));
          if (deep) record.style = await page.evaluateJson("style-audit").catch((error) => ({ error: error.message }));
          if (plan.links) for (const href of JSON.parse(await page.evaluate(LINKS_EXPRESSION))) if (firstParty(href, new URL(info.url).hostname)) collected.add(href);
        }
        if (plan.axe && deep) record.axe[desktopFold ? "desktop" : "mobile"] = filterAxe(await page.evaluateJson("axe-run").catch((error) => ({ error: error.message })), pathname, config);
        if (deep || (desktopFold && quick)) record.files.push(await page.screenshot(path.join(out, `${info.slug}-${width}-full.png`), { full: true, dpr: phone ? PHONE_DPR : 1 }));
      } catch (error) {
        if (cdp.ws.readyState !== WebSocket.OPEN) throw error;
        record.notes.push(`${width}px에서 멈췄습니다: ${error.message}`);
        log(`! ${info.slug} ${width}px: ${error.message}`);
      }
      if (plan.dark && record.opened) {
        for (const width of [plan.foldWidths.desktop, plan.foldWidths.mobile].filter(Boolean)) try {
          const phone = width < plan.phoneBelow;
          await page.emulate(width, plan.heightFor[width], { phone, dark: true, ua });
          await pace(info.url);
          log(`· ${info.slug} ${width} 어두운 모드`);
          const opened = await page.open(info.url, opts.wait);
          if (!opened.ok) continue;
          record.darkScheme = await page.evaluate("matchMedia('(prefers-color-scheme: dark)').matches");
          record.files.push(await page.screenshot(path.join(out, `${info.slug}-dark-${width}-fold.png`)));
          if (plan.axe && deep && width === plan.foldWidths.desktop) record.axe.dark = filterAxe(await page.evaluateJson("axe-run").catch((error) => ({ error: error.message })), pathname, config);
        } catch (error) {
          if (cdp.ws.readyState !== WebSocket.OPEN) throw error;
          record.notes.push(`어두운 모드 ${width}px에서 멈췄습니다: ${error.message}`);
        }
      }
      save();
    }

    if (plan.links) {
      const visited = new Set(plan.pages.map((p) => p.url));
      const targets = [...collected].filter((href) => !visited.has(href));
      evidence.links = [];
      log(`· 링크 ${targets.length}개 확인`);
      for (const href of targets) {
        if (!(await allowed(href))) { evidence.links.push({ url: href, status: null, skipped: "robots" }); continue; }
        await pace(href);
        const r = await fetchText(href);
        evidence.links.push({ url: href, status: r.status || null, ...(r.error ? { error: r.error } : {}) });
      }
    }
  } catch (error) {
    evidence.aborted = error.message;
    log(`! 중단: ${error.message}. 그때까지의 근거는 evidence.json에 남깁니다`);
  } finally {
    await browser.stop(cdp.ws);
    process.off("SIGINT", cleanupOnSignal);
    process.off("SIGTERM", cleanupOnSignal);
  }

  const { gates, noise } = computeGates(evidence.pages, evidence.links);
  const mobileRun = evidence.pages.flatMap((p) => Object.values(p.widths)).find((w) => w.phone && w.layout && !w.layout.error);
  evidence.gates = gates;
  evidence.noise = noise;
  evidence.coverage = {
    deviceEmulation: mobileRun ? (mobileRun.layout.media?.pointerCoarse ? "phone" : "width-only resize") : "no phone width",
    throttling: "none",
    dark: plan.dark ? "tested" : "not tested",
    axe: plan.axe ? (evidence.pages.some((p) => p.axe.desktop?.error) ? "error on some pages" : "ok") : "off",
    links: plan.links ? "checked" : "not checked",
    robotsSkipped: skipped,
    droppedOverCap: plan.droppedOverCap,
    keyboard: "not tested (use another browser tool)",
    inp: "no interaction (use another browser tool)",
  };
  save();
  return { out, evidence: file, ...(evidence.aborted ? { aborted: evidence.aborted } : {}), opened: evidence.pages.filter((p) => p.opened).length, pages: evidence.pages.length, gates, noise, coverage: evidence.coverage };
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    stderr.write(`eval: ${error.message}\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    stdout.write(HELP);
    return 0;
  }
  let plan;
  try {
    plan = planRun(opts);
  } catch (error) {
    stderr.write(`eval: ${error.message}\n`);
    return 2;
  }
  if (plan.droppedOverCap.length) stderr.write(`eval: ${plan.mode} 모드는 ${MODES[plan.mode].pageCap}쪽까지입니다. ${plan.droppedOverCap.length}개 주소를 뺐습니다\n`);
  if (opts.dryRun) {
    stdout.write(JSON.stringify({ dryRun: true, ...plan }) + "\n");
    return 0;
  }
  try {
    const result = await run(plan, opts, (line) => stderr.write(`${line}\n`));
    stdout.write(JSON.stringify(result) + "\n");
    return result.opened && !result.aborted ? 0 : 1;
  } catch (error) {
    stderr.write(`eval: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
