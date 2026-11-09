#!/usr/bin/env node
// jstyle command: one entry point for the skill's tools. Every subcommand runs
// the scripts next to this file, so the installed command and the skill docs
// always describe the same code.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
// A --wait server serves the agent (or terminal) waiting for it: the nearest
// ancestor that is not a shell. A launching shell often exits at once
// (`nohup … &`), so it is not the one to watch, and it is read at start,
// while that shell may still be there to walk through. If the shell is gone
// before this runs, nothing is watched and the server waits for a pick.
const SHELLS = /^-?(sh|bash|zsh|dash|ksh|fish|nohup|env|timeout|setsid)$/;
function waitingProcess() {
  if (process.platform === "win32") return null;
  let pid = process.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth += 1) {
    const out = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" });
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(out.stdout ?? "");
    if (!match) return null;
    if (!SHELLS.test(path.basename(match[2]))) return pid;
    pid = Number(match[1]);
  }
  return null;
}
const LAUNCHED_BY = process.argv.includes("--wait") ? waitingProcess() : null;
const SCRIPTS = path.join(ROOT, "scripts");
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);

const color = process.stderr.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const paint = (code) => (text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const dim = paint(2);
const cyan = paint(36);
const green = paint(32);
const yellow = paint(33);
const red = paint(31);

const HELP = `jstyle ${VERSION} — 디자인 시안 비교와 화면 확인 도구

usage   jstyle <command> [options]

비교와 보기
  explore  디자인 시안 폴더를 비교 화면 한 장으로 만들고 띄웁니다
  serve    파일이나 폴더를 캐시 없는 로컬 서버로 띄웁니다
  kit      컴포넌트 키트를 엽니다
  library  패턴 라이브러리를 엽니다
  hub      여러 페이지의 비교 화면을 한 서버로 모아 띄웁니다

캡처와 자료
  shoot    화면 크기별 캡처, 연속 프레임, 녹화
  media    공개 이미지·텍스처 찾기와 받기
  image    웹용 이미지 크기와 srcset 만들기
  measure  참고 그림의 색과 배치 비율 재기

검사
  check    키트 토큰 덮어쓰기와 토큰 밖 색·모서리·글자 크기 찾기
  eval     공개된 사이트를 보기만 하며 평가 근거(캡처·배치·axe·성능) 남기기

환경
  ps       떠 있는 jstyle 서버와 주소 보기
  stop     jstyle 서버 끄기 (포트, 프로젝트 또는 all)
  doctor   Node·브라우저·설치 위치 확인
  version  버전 표시

각 명령의 옵션: jstyle <command> --help
`;

const EXPLORE_HELP = `usage: jstyle explore <inputs...> [--output FILE] [--force] [--serve|--no-serve] [--wait] [--idle MIN] [--no-open] [--host HOST] [--port PORT]

디자인 시안 폴더, HTML 파일 또는 manifest.json으로 비교 화면을 만듭니다.
터미널에서 실행하면 만든 뒤 로컬 서버로 띄워 엽니다. 파이프나 에이전트처럼
터미널이 아닌 곳에서는 만들기만 합니다. --serve와 --no-serve로 바꿀 수 있습니다.
결과 JSON 한 줄은 stdout, 안내는 stderr로 나옵니다.

띄운 비교 화면에서 안을 고르면 의견과 함께 비교 화면 옆 choice.json에 저장됩니다.
--wait는 띄운 뒤 첫 선택을 기다렸다가 고른 안을 JSON 한 줄로 stdout에 쓰고 끝납니다.
에이전트는 이 명령을 백그라운드로 실행하고, 끝나면 그 결과로 작업을 이어 갑니다.

띄운 서버는 열린 화면도 요청도 없이 30분이 지나면 닫힙니다(--idle 분, 0은 닫지 않음).
--wait 서버는 선택을 받거나, 기다리는 프로세스(셸이 아닌 가장 가까운 상위 프로세스)가
끝나면 닫힙니다. 선택 없이 닫히면 stdout에 아무것도 쓰지 않고 종료 코드 1로 끝납니다.
떠 있는 서버와 주소는 jstyle ps, 끄기는 jstyle stop입니다.

manifest 필드와 생성 옵션: jstyle explore --help-build
`;

function fail(message, code = 2) {
  process.stderr.write(`${red("✗")} ${message}\n`);
  return code;
}

function hint(label, command) {
  process.stderr.write(`${dim(label + ":")} ${cyan(command)}\n`);
}

function runScript(file, args) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, file), ...args], { stdio: "inherit" });
  if (result.error) return fail(`${file}를 실행하지 못했습니다: ${result.error.message}`, 1);
  return result.status ?? 1;
}

function splitExploreArgs(argv) {
  const build = [];
  const view = { serve: null, open: true, host: "127.0.0.1", port: 8765, help: false, helpBuild: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      if (index + 1 >= argv.length) throw new Error(`${arg}에 값이 필요합니다`);
      return argv[++index];
    };
    if (arg === "--serve") view.serve = true;
    else if (arg === "--wait") view.wait = true;
    else if (arg === "--idle") view.idle = Number(value());
    else if (arg === "--no-serve") view.serve = false;
    else if (arg === "--no-open") view.open = false;
    else if (arg === "--host") view.host = value();
    else if (arg === "--port") view.port = Number(value());
    else if (arg === "-h" || arg === "--help") view.help = true;
    else if (arg === "--help-build") view.helpBuild = true;
    else build.push(arg);
  }
  if (!Number.isInteger(view.port) || view.port < 0 || view.port > 65535) throw new Error("--port는 0~65535 사이의 정수여야 합니다");
  if (view.wait && view.serve === false) throw new Error("--wait는 --no-serve와 함께 쓸 수 없습니다");
  if (view.idle !== undefined && !(view.idle >= 0)) throw new Error("--idle은 0 이상의 분이어야 합니다(0은 끄지 않음)");
  if (view.wait) view.serve = true;
  return [build, view];
}

async function explore(argv) {
  let build;
  let view;
  try {
    [build, view] = splitExploreArgs(argv);
  } catch (error) {
    return fail(error.message);
  }
  if (view.help) {
    process.stdout.write(EXPLORE_HELP);
    return 0;
  }
  const builder = await import("../scripts/build_explorer.mjs");
  if (view.helpBuild) return builder.main(["--help"], { prog: "jstyle explore", command: "jstyle explore" });
  let built = null;
  const code = builder.main(build, { prog: "jstyle explore", command: "jstyle explore", onBuilt: (result) => { built = result; } });
  if (code !== 0 || !built) return code;
  process.stderr.write(`${green("✓")} 비교 화면 ${built.candidates}개 안 ${dim(`(${built.bytes} bytes)`)}\n  ${built.output}\n`);
  const shouldServe = view.serve ?? Boolean(process.stdout.isTTY && process.stdin.isTTY);
  if (!shouldServe) {
    hint("next", `jstyle serve ${JSON.stringify(built.output)} --wait`);
    return 0;
  }
  return serveExplorer({ root: path.dirname(built.output), page: path.basename(built.output), host: view.host, port: view.port, open: view.open, wait: Boolean(view.wait), idle: view.idle, kind: "explore" });
}

// Serves a page; an explorer page also accepts the picked direction. With wait,
// the first pick is printed as one JSON line and the server stops.
// A comparison page or hub that someone browses closes after this many idle
// minutes; open pages ping it. A --wait server waits for its agent instead, and
// pages without the ping (kit, library, any other file) stay until stopped.
const DEFAULT_IDLE = 30;
const idleFor = (idle, pinged) => idle ?? (pinged ? DEFAULT_IDLE : 0);

async function serveExplorer({ root, page, host, port, open, wait, idle, kind = "serve" }) {
  const { serve, explorerChoice } = await import("../scripts/serve.mjs");
  let picked;
  const pick = new Promise((resolve) => { picked = resolve; });
  const choice = explorerChoice(root, page, picked, { once: wait });
  if (wait && !choice) return fail(`${path.join(root, page)}는 jstyle explore로 만든 비교 화면이 아니어서 --wait를 쓸 수 없습니다`);
  let server;
  try {
    server = await serve({ root, page, host, port, open, choice, registry: { kind, wait, idle: idleFor(idle, !wait && Boolean(choice)), parent: LAUNCHED_BY } });
  } catch (error) {
    return fail(error.message, 1);
  }
  if (!wait) return null;
  process.stderr.write(`${dim("wait:")} 비교 화면에서 안을 고르면 끝납니다\n`);
  const record = await pick;
  process.stdout.write(JSON.stringify({ ...record, file: choice.file }) + "\n");
  const label = record.id === null ? `고른 안 없이 의견 ${record.comments.length}개` : `고른 안: ${record.baseline ? "기존 화면" : record.number} ${record.name}`;
  process.stderr.write(`${green("✓")} ${label}\n  ${choice.file}\n`);
  // Let the 200 response reach the page before the sockets are closed.
  await new Promise((resolve) => setTimeout(resolve, 200));
  server.closeAllConnections();
  server.close();
  return 0;
}

const SERVE_HELP = `usage: jstyle serve <file|folder> [--root DIR] [--host HOST] [--port PORT] [--no-open] [--wait] [--idle MIN]
       jstyle kit [--host HOST] [--port PORT] [--no-open]
       jstyle library [section] [--host HOST] [--port PORT] [--no-open]

serve는 파일이 있는 폴더를 띄우고 그 파일을 엽니다. --root를 주면 그 폴더 기준의 page를 엽니다.
library의 section은 effects, cards, landing, product-ui 같은 구역 이름입니다.
주소만 입력해도 이 페이지로 이동하므로 다른 기기에서도 http://<host>:<port>/ 로 열 수 있습니다.
jstyle explore로 만든 비교 화면을 띄우면 고른 안이 그 옆 choice.json에 저장됩니다.
--wait는 첫 선택을 기다렸다가 고른 안을 JSON 한 줄로 쓰고 끝납니다.
비교 화면은 열린 화면도 요청도 없이 --idle 분(기본 30, 0은 닫지 않음)이 지나면 서버를 닫습니다.
열린 화면 신호를 보내지 않는 kit, library와 다른 파일은 기본으로 직접 끌 때까지 둡니다.
`;

// fixedPage is set for kit and library, which always serve the jstyle folder.
async function serveCommand(argv, fixedPage = null) {
  const { parseServeArgs, serve } = await import("../scripts/serve.mjs");
  let options;
  try {
    options = parseServeArgs(argv, { host: "127.0.0.1", port: 8765, open: true });
  } catch (error) {
    return fail(error.message);
  }
  if (options.help) {
    process.stdout.write(SERVE_HELP);
    return 0;
  }
  let root;
  let page;
  if (fixedPage) {
    if (options.wait) return fail("--wait는 jstyle explore로 만든 비교 화면에만 쓸 수 있습니다");
    root = ROOT;
    page = fixedPage + (options.pageGiven ? "#" + options.page.replace(/^#/, "") : "");
  } else if (options.root) {
    root = path.resolve(options.root);
    page = options.page ?? "";
  } else {
    if (!options.pageGiven) return fail("띄울 파일이나 폴더를 주세요. 예: jstyle serve explore/style-explorer.html");
    const target = path.resolve(options.page);
    const info = fs.statSync(target, { throwIfNoEntry: false });
    if (!info) return fail(`찾을 수 없습니다: ${target}`);
    [root, page] = info.isDirectory() ? [target, ""] : [path.dirname(target), path.basename(target)];
  }
  if (page && !fs.statSync(path.join(root, page.split("#")[0]), { throwIfNoEntry: false })?.isFile()) {
    return fail(`${page.split("#")[0]}가 ${root}에 없습니다`);
  }
  if (!fixedPage) return serveExplorer({ root, page, host: options.host, port: options.port, open: options.open, wait: Boolean(options.wait), idle: options.idle });
  try {
    await serve({ root, page, host: options.host, port: options.port, open: options.open, registry: { kind: fixedPage.startsWith("assets/kit") ? "kit" : "library", project: "jstyle", idle: idleFor(options.idle, false) } });
  } catch (error) {
    return fail(error.message, 1);
  }
  return null;
}

const HUB_HELP = `usage: jstyle hub [folder] [--host HOST] [--port PORT] [--no-open] [--wait] [--idle MIN]

folder(기본 .jstyle) 아래의 모든 style-explorer.html을 한 서버로 띄웁니다.
첫 화면은 페이지별 회차 목록이고, 각 비교 화면 위쪽 막대에서 다른 페이지로 옮겨 갈 수 있습니다.
어느 비교 화면에서 고르거나 보내도 그 폴더의 choice.json에 저장됩니다.
--wait는 첫 선택을 기다렸다가 고른 안을 page 경로와 함께 JSON 한 줄로 쓰고 끝납니다.
열린 화면도 요청도 없이 --idle 분(기본 30, 0은 닫지 않음)이 지나면 서버를 닫습니다.
`;

// Serves every explorer under a folder from one server, with a hub page at /.
async function hubCommand(argv) {
  const { parseServeArgs, serve, hubChoice } = await import("../scripts/serve.mjs");
  let options;
  try {
    options = parseServeArgs(argv, { host: "127.0.0.1", port: 8765, open: true });
  } catch (error) {
    return fail(error.message);
  }
  if (options.help) {
    process.stdout.write(HUB_HELP);
    return 0;
  }
  const root = path.resolve(options.page ?? ".jstyle");
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return fail(`폴더를 찾을 수 없습니다: ${root}. jstyle explore로 비교 화면을 먼저 만드세요`);
  let picked;
  const pick = new Promise((resolve) => { picked = resolve; });
  const choice = hubChoice(root, (record, file) => picked({ record, file }), { once: Boolean(options.wait) });
  let server;
  try {
    server = await serve({ root, page: "", host: options.host, port: options.port, open: options.open, choice, registry: { kind: "hub", wait: Boolean(options.wait), idle: idleFor(options.idle, !options.wait), parent: LAUNCHED_BY } });
  } catch (error) {
    return fail(error.message, 1);
  }
  if (!options.wait) return null;
  process.stderr.write(`${dim("wait:")} 어느 비교 화면에서든 고르거나 보내면 끝납니다\n`);
  const { record, file } = await pick;
  process.stdout.write(JSON.stringify({ ...record, file }) + "\n");
  const label = record.id === null ? `고른 안 없이 의견 ${record.comments.length}개` : `고른 안: ${record.baseline ? "기존 화면" : record.number} ${record.name}`;
  process.stderr.write(`${green("✓")} ${record.page} · ${label}\n  ${file}\n`);
  await new Promise((resolve) => setTimeout(resolve, 200));
  server.closeAllConnections();
  server.close();
  return 0;
}

function ago(iso) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return minutes < 1 ? "방금" : minutes < 60 ? `${minutes}분` : `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

const PS_HELP = `usage: jstyle ps [--json]

떠 있는 jstyle 서버를 보여 줍니다. 주소에는 고르기와 의견 전송에 필요한 토큰이 들어 있습니다.
끝난 서버의 기록은 이때 정리됩니다.
`;

async function psCommand(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(PS_HELP);
    return 0;
  }
  const { listRecords } = await import("../scripts/lib/registry.mjs");
  const records = listRecords();
  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(records) + "\n");
    return 0;
  }
  if (!records.length) {
    process.stdout.write("떠 있는 jstyle 서버가 없습니다\n");
    return 0;
  }
  for (const r of records) {
    const idle = r.idle > 0 ? `${r.idle}분 유휴 시 종료` : r.wait ? "선택을 받으면 종료" : "직접 끌 때까지";
    process.stdout.write(`${cyan(String(r.port).padEnd(6))}${String(r.kind ?? "?").padEnd(8)}${r.project ?? ""}  ${dim(`${ago(r.started)} 전 시작 · 마지막 요청 ${ago(r.lastActivity)} 전 · ${idle}`)}\n`);
    const home = process.env.HOME || "";
    const where = home && r.root?.startsWith(home + path.sep) ? "~" + r.root.slice(home.length) : r.root;
    process.stdout.write(`      ${r.url}\n      ${dim(where ?? "")}\n`);
  }
  return 0;
}

const STOP_HELP = `usage: jstyle stop <port|project|all>

jstyle 서버를 끕니다. 포트 번호, 프로젝트 이름(jstyle ps에 보이는 이름) 또는 all을 받습니다.
끄기 전에 그 포트가 기록된 jstyle 서버인지 확인합니다.
`;

// Asks the port which process answers, so a reused pid never ends another program.
function answersAs(record, timeout = 3000) {
  return new Promise((resolve) => {
    const host = record.host === "0.0.0.0" || record.host === "::" ? "127.0.0.1" : record.host;
    const request = http.request({ host, port: record.port, path: "/__jstyle/alive", method: "GET", timeout }, (response) => {
      response.resume();
      resolve(response.headers["x-jstyle-pid"] === String(record.pid));
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
    request.end();
  });
}

async function stopCommand(argv) {
  const target = argv.find((arg) => !arg.startsWith("-"));
  if (argv.includes("-h") || argv.includes("--help") || !target) {
    process.stdout.write(STOP_HELP);
    return target ? 0 : 2;
  }
  const { listRecords, removeRecord, isAlive } = await import("../scripts/lib/registry.mjs");
  const byPort = target === "all" || /^\d+$/.test(target);
  const records = listRecords().filter((r) => target === "all" || String(r.port) === target || (!byPort && r.project === target));
  if (!records.length) return fail(`끌 jstyle 서버가 없습니다: ${target}. jstyle ps로 확인하세요`, 1);
  // Folders in different places can share a name; a name that matches several servers ends none of them.
  if (!byPort && records.length > 1) return fail(`${target} 이름의 서버가 ${records.length}개입니다(포트 ${records.map((r) => r.port).join(", ")}). jstyle stop <포트>로 하나씩 끄세요`, 1);
  let stopped = 0;
  for (const r of records) {
    if (!(await answersAs(r))) {
      // A server that is busy or paused keeps its record, so ps can still show it.
      if (isAlive(r.pid)) {
        process.stderr.write(`${yellow("!")} ${r.port}: 프로세스 ${r.pid}가 jstyle 서버로 응답하지 않아 건드리지 않았습니다\n`);
      } else {
        removeRecord(r.pid);
        process.stderr.write(`${dim("·")} ${r.port}: 이미 끝난 서버의 기록을 지웠습니다\n`);
      }
      continue;
    }
    try {
      process.kill(r.pid, "SIGTERM");
    } catch {
      // Ended on its own meanwhile.
    }
    // An ended server stays visible to kill(pid, 0) until its parent reaps it, so a port that stopped answering also counts.
    let ended = false;
    for (let i = 0; i < 30 && !ended; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      ended = !isAlive(r.pid) || !(await answersAs(r, 300));
    }
    if (!ended) {
      process.stderr.write(`${yellow("!")} ${r.port}: 종료 신호를 보냈지만 프로세스 ${r.pid}가 아직 살아 있습니다\n`);
      continue;
    }
    removeRecord(r.pid);
    stopped += 1;
    process.stderr.write(`${green("✓")} ${r.port} ${r.kind} ${r.project} 종료\n`);
  }
  return stopped === records.length ? 0 : 1;
}

function doctor(argv) {
  const json = argv.includes("--json");
  const checks = [];
  const add = (name, state, detail, fix) => checks.push({ name, state, detail, ...(fix ? { fix } : {}) });
  add("node", NODE_MAJOR >= 22 ? "ok" : "fail", process.version, NODE_MAJOR >= 22 ? null : "Node 22 이상을 설치하세요");
  try {
    const chrome = spawnSync(process.execPath, ["--input-type=module", "-e", `import { findChrome } from ${JSON.stringify(new URL("../scripts/chrome.mjs", import.meta.url).href)}; console.log(findChrome());`], { encoding: "utf8" });
    if (chrome.status === 0) add("browser", "ok", chrome.stdout.trim());
    else add("browser", "warn", "Chrome·Chromium·Edge 없음", "shoot·image·eval에 필요합니다. 설치하거나 CHROME_PATH를 지정하세요");
  } catch (error) {
    add("browser", "warn", error.message);
  }
  const which = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["jstyle"], { encoding: "utf8" });
  const onPath = which.status === 0 ? which.stdout.trim().split(/\r?\n/)[0] : null;
  let pathState = "warn";
  let pathDetail = "PATH에 jstyle 없음";
  let pathFix = "저장소의 install.sh로 설치하거나 node bin/jstyle.mjs를 쓰세요";
  if (onPath) {
    let real = onPath;
    try {
      real = fs.realpathSync(onPath);
    } catch {
      // A broken link still names the installed command.
    }
    const same = path.resolve(path.dirname(real), "..") === ROOT;
    pathState = same ? "ok" : "warn";
    pathDetail = same ? onPath : `${onPath} (다른 설치본)`;
    pathFix = same ? null : `이 폴더의 jstyle ${VERSION}과 다를 수 있습니다. jstyle version으로 비교하세요`;
  }
  add("command", pathState, pathDetail, pathFix);
  add("skill", "ok", `${ROOT} (jstyle ${VERSION})`);
  const failed = checks.some((check) => check.state === "fail");
  if (json) {
    process.stdout.write(JSON.stringify({ ok: !failed, checks }) + "\n");
    return failed ? 1 : 0;
  }
  const symbol = { ok: green("✓"), warn: yellow("!"), fail: red("✗") };
  for (const check of [...checks].sort((a, b) => ["fail", "warn", "ok"].indexOf(a.state) - ["fail", "warn", "ok"].indexOf(b.state))) {
    process.stdout.write(`${symbol[check.state]} ${check.name.padEnd(8)} ${check.detail}\n`);
    if (check.fix) process.stdout.write(`  ${dim("fix:")} ${check.fix}\n`);
  }
  return failed ? 1 : 0;
}

async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(HELP);
      return command === undefined ? 2 : 0;
    case "-v":
    case "--version":
    case "version":
      process.stdout.write(`jstyle ${VERSION}\n`);
      return 0;
    case "explore":
      return explore(rest);
    case "serve":
      return serveCommand(rest);
    case "kit":
      return serveCommand(rest, "assets/kit/index.html");
    case "library":
      return serveCommand(rest, "assets/extended/index.html");
    case "hub":
      return hubCommand(rest);
    case "shoot":
      return runScript("shoot.mjs", rest);
    case "media":
      return runScript("curate-media.mjs", rest);
    case "image":
      return runScript("prep-image.mjs", rest);
    case "measure":
      return runScript("measure_reference.mjs", rest);
    case "check":
      return runScript("check.mjs", rest);
    case "eval":
      return runScript("eval.mjs", rest);
    case "ps":
      return psCommand(rest);
    case "stop":
      return stopCommand(rest);
    case "doctor":
      return doctor(rest);
    default: {
      const names = ["explore", "hub", "ps", "stop", "serve", "kit", "library", "shoot", "media", "image", "measure", "check", "eval", "doctor", "version"];
      const near = names.find((name) => name.startsWith(command.slice(0, 2)));
      fail(`알 수 없는 명령: ${command}`);
      if (near) hint("try", `jstyle ${near}`);
      hint("help", "jstyle --help");
      return 2;
    }
  }
}

if (NODE_MAJOR < 22) {
  process.stderr.write(`jstyle에는 Node 22 이상이 필요합니다. 지금은 ${process.version}입니다\n`);
  process.exitCode = 1;
} else {
  const code = await main(process.argv.slice(2));
  if (code !== null) process.exitCode = code;
}
