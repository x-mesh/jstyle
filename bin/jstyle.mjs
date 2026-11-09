#!/usr/bin/env node
// jstyle command: one entry point for the skill's tools. Every subcommand runs
// the scripts next to this file, so the installed command and the skill docs
// always describe the same code.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
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
// JSTYLE_TEST_VERSION lets tests stand in an older daemon.
const VERSION = process.env.JSTYLE_TEST_VERSION || JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
// One daemon per user serves every project on this loopback port; JSTYLE_DAEMON_PORT moves it (tests use a free port).
const DAEMON_PORT = Number(process.env.JSTYLE_DAEMON_PORT) || 8765;
const DAEMON_READY_MS = 5000;

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
  daemon   모든 프로젝트를 띄우는 데몬 (보통 hub·explore·serve가 자동으로 띄움)

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
같은 포트에 jstyle hub가 떠 있으면 서버를 띄우지 않고 그 허브에서 기다립니다.
기본 주소(127.0.0.1:8765)에서는 데몬(jstyle daemon)에 붙고, 떠 있는 데몬이 없으면 분리 실행합니다.
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
  const view = { serve: null, open: true, host: "127.0.0.1", port: DAEMON_PORT, help: false, helpBuild: false };
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
  const file = path.join(root, page.split("#")[0]);
  if (explorerChoice(root, page, null)) {
    // A comparison page goes to the hub on the port, starting the daemon when there is none.
    const { hub, fellBack } = await hubFor({ host, port, idle });
    const done = hub ? await (wait ? waitOnHub(hub, { file, open }) : openOnHub(hub, file, open)) : null;
    if (done !== null) return done;
    port = await freePortFor(port, fellBack);
  } else {
    if (wait) return fail(`${path.join(root, page)}는 jstyle explore로 만든 비교 화면이 아니어서 --wait를 쓸 수 없습니다`);
    // A file goes to the daemon with its folder as a project. A bare folder stays here: on a hub its address is the project page, not a listing.
    if (page && daemonWanted(host, port)) {
      const { hub, fellBack } = await hubFor({ host, port, idle });
      const done = hub ? await openOnHub(hub, file, open, root) : null;
      if (done !== null) return done;
      port = await freePortFor(port, fellBack);
    } else {
      const shared = await sharedHub({ host, port, within: file });
      if (shared) return announceHubPage(shared, file, open);
      port = await freePortFor(port);
    }
  }
  let picked;
  const pick = new Promise((resolve) => { picked = resolve; });
  const choice = explorerChoice(root, page, picked, { once: wait });
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
같은 포트에 jstyle hub가 떠 있으면 --wait는 서버를 띄우지 않고 그 허브에서 이 비교 화면을 기다립니다.
기본 주소(127.0.0.1:8765)에서 비교 화면을 띄우면 데몬(jstyle daemon)에 그 폴더를 붙이고 주소를 알린 뒤 끝나며,
떠 있는 데몬이 없으면 분리 실행하고, 이때 --idle은 적용되지 않습니다.
비교 화면이 아닌 파일도 기본 주소에서는 그 폴더를 데몬에 붙이고 /<프로젝트>/<파일> 주소를 알린 뒤 끝납니다.
kit과 library는 기본 주소에서 데몬의 /__skill/ 아래로 열고 끝납니다. 파일 없이 폴더만 주면 이 명령이 띄웁니다.
JSTYLE_NO_DAEMON=1, 다른 --port, loopback이 아닌 --host에서는 이 명령이 서버를 띄우고, 데몬 포트가 차 있으면 빈 포트를 씁니다.
이 명령이 띄운 비교 화면은 열린 화면도 요청도 없이 --idle 분(기본 30, 0은 닫지 않음)이 지나면 서버를 닫습니다.
이 명령이 띄운 kit, library와 다른 파일은 열린 화면 신호를 보내지 않으므로 기본으로 직접 끌 때까지 둡니다.
`;

// fixedPage is set for kit and library, which always serve the jstyle folder.
async function serveCommand(argv, fixedPage = null) {
  const { parseServeArgs, serve } = await import("../scripts/serve.mjs");
  let options;
  try {
    options = parseServeArgs(argv, { host: "127.0.0.1", port: DAEMON_PORT, open: true });
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
  if (daemonWanted(options.host, options.port)) {
    // kit and library open from the daemon's own copy of the skill folder.
    const { SKILL_SLUG } = await import("../scripts/serve.mjs");
    const { hub } = await hubFor({ host: options.host, port: options.port, idle: options.idle });
    if (hub?.daemon) {
      const [file, hash] = page.split("#");
      const url = hubUrl(hub, `/${SKILL_SLUG}/${file.split("/").map(encodeURIComponent).join("/")}`) + (hash ? `#${hash}` : "");
      process.stderr.write(`${green("✓")} 떠 있는 데몬(${hub.port})에서 엽니다\n  ${url}\n`);
      if (options.open) openUrl(url);
      return 0;
    }
  }
  // The daemon port stays free for the daemon even when it is not running yet; kit and library take a free one.
  options.port = await freePortFor(options.port, daemonWanted(options.host, options.port));
  try {
    await serve({ root, page, host: options.host, port: options.port, open: options.open, registry: { kind: fixedPage.startsWith("assets/kit") ? "kit" : "library", project: "jstyle", idle: idleFor(options.idle, false) } });
  } catch (error) {
    return fail(error.message, 1);
  }
  return null;
}

const HUB_HELP = `usage: jstyle hub [folder] [--host HOST] [--port PORT] [--no-open] [--wait] [--idle MIN]

folder(기본 .jstyle) 아래의 모든 style-explorer.html을 한 서버로 띄웁니다.
기본 주소(127.0.0.1:8765)에서는 데몬(jstyle daemon)에 이 폴더를 붙이고 {hub, project, url}을 쓴 뒤 바로 끝납니다.
떠 있는 데몬이 없으면 분리 실행하고, 5초 안에 준비되지 않으면 이 명령이 빈 포트에 자기 허브를 띄웁니다.
JSTYLE_NO_DAEMON=1, 다른 --port, loopback이 아닌 --host에서는 이 명령이 자기 허브를 띄웁니다.
데몬이나 떠 있는 허브에 붙으면 --idle은 적용되지 않습니다.
프로젝트는 /<프로젝트>/ 아래에 놓이고, 그 첫 화면은 페이지별 회차 목록입니다.
각 비교 화면 위쪽 막대에서 다른 페이지로 옮겨 갈 수 있습니다.
어느 비교 화면에서 고르거나 보내도 그 폴더의 choice.json에 저장됩니다.

같은 포트에 허브가 이미 떠 있으면 새 서버를 띄우지 않고 그 허브에 이 폴더를 붙인 뒤
{hub, project, url} JSON 한 줄을 쓰고 끝납니다. 허브의 / 주소는 붙은 프로젝트를 모두 보여 줍니다.
jstyle stop <프로젝트>는 허브에서 그 프로젝트만 뺍니다.
데몬은 jstyle daemon stop으로 끄며, 기다리는 에이전트가 있으면 --force가 필요합니다. jstyle ps는 프로젝트마다 대기자 수를 보입니다.
고정 포트의 허브는 붙은 프로젝트 목록을 저장해 두고, 같은 주소에서 다시 시작하면 같은 /<프로젝트>/ 주소로 되살립니다.
사라진 폴더는 시작할 때 목록에서 뺍니다. --wait와 --port 0 허브는 저장하지 않습니다.

--wait는 첫 선택을 기다렸다가 고른 안을 project, page와 함께 JSON 한 줄로 쓰고 끝납니다.
--wait는 같은 포트에 허브가 떠 있으면 그 허브에서 기다리고, 허브의 어느 탭에서 골라도 받습니다.
허브가 없으면 자기 서버를 띄우며, 포트를 다른 jstyle 서버가 쓰고 있으면 빈 포트를 씁니다.
열린 화면도 요청도 없이 --idle 분(기본 30, 0은 닫지 않음)이 지나면 서버를 닫습니다.
`;

// Serves every explorer under a folder from one server, with a hub page at /.
async function hubCommand(argv) {
  const { parseServeArgs } = await import("../scripts/serve.mjs");
  let options;
  try {
    options = parseServeArgs(argv, { host: "127.0.0.1", port: DAEMON_PORT, open: true });
  } catch (error) {
    return fail(error.message);
  }
  if (options.help) {
    process.stdout.write(HUB_HELP);
    return 0;
  }
  const root = path.resolve(options.page ?? ".jstyle");
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return fail(`폴더를 찾을 수 없습니다: ${root}. jstyle explore로 비교 화면을 먼저 만드세요`);
  const { hub: shared, fellBack } = await hubFor({ host: options.host, port: options.port, idle: options.idle });
  if (shared && !options.wait) return joinHub(shared, root, options.open);
  const joined = shared ? await waitOnHub(shared, { folder: root, open: options.open }) : null;
  if (joined !== null) return joined;
  if (options.wait || fellBack) options.port = await freePortFor(options.port, fellBack);
  return runHub(root, options);
}

// Runs a hub in this process: for a folder (jstyle hub), or with no folder as the daemon.
async function runHub(root, options, { daemon = false, token } = {}) {
  const { serve, hubChoice, addProject, projectList, restoreProjects, savedProjects } = await import("../scripts/serve.mjs");
  const { hubStoreFile, readHubStore, writeHubStore } = await import("../scripts/lib/hubstore.mjs");
  let picked;
  const pick = new Promise((resolve) => { picked = resolve; });
  const choice = hubChoice((record, file) => picked({ record, file }), { once: Boolean(options.wait), daemon, token });
  choice.onEvicted = (evicted) => process.stderr.write(`${yellow("!")} 프로젝트가 상한을 넘어 가장 오래 쓰지 않은 ${evicted.join(", ")}를 뺐습니다\n`);
  // A hub on a fixed port keeps its projects for the next start there; --wait and a random port are one-off.
  const store = !options.wait && options.port ? hubStoreFile(options.host, options.port) : null;
  let unreadable = null;
  if (store) {
    let saved = [];
    try {
      saved = readHubStore(store);
    } catch (error) {
      unreadable = error;
    }
    const { restored, dropped } = restoreProjects(choice, saved);
    if (restored.length) process.stderr.write(`${dim(`저장된 프로젝트 ${restored.length}개를 다시 붙였습니다: ${restored.join(", ")}`)}\n`);
    for (const gone of dropped) process.stderr.write(`${dim(`사라졌거나 띄울 수 없는 폴더를 목록에서 뺐습니다: ${gone}`)}\n`);
  }
  const slug = root ? addProject(choice, root) : null;
  // The record names the first remaining project, so ps and stop never point at a project the hub let go of.
  const hubExtra = (record) => {
    const projects = projectList(choice);
    const [first] = projects;
    const extra = { token: choice.token, projects: projects.map(({ slug, root }) => ({ slug, root })), ...(daemon ? { daemon: true } : {}) };
    // The daemon's address is its bare root, which lists whatever projects it has.
    if (daemon || !record || record.projects?.[0]?.slug === first.slug) return extra;
    const url = new URL(record.url);
    url.pathname = `/${encodeURIComponent(first.slug)}/`;
    return { ...extra, project: first.project, root: first.root, url: url.href };
  };
  const registry = { kind: "hub", wait: Boolean(options.wait), idle: idleFor(options.idle, !options.wait), parent: LAUNCHED_BY, extra: hubExtra, busy: () => choice.waiters.size > 0, ...(daemon ? { project: "daemon" } : {}) };
  // Nothing is saved until this process holds the port, so a start that fails leaves the list of the hub that holds it.
  let saving = false;
  // Returns false when the list could not be written, so a removal can be undone.
  const save = () => {
    if (!saving) return true;
    try {
      writeHubStore(store, savedProjects(choice));
      return true;
    } catch (error) {
      process.stderr.write(`${yellow("!")} 프로젝트 목록을 저장하지 못했습니다(다음에 다시 시작하면 이 목록이 없습니다): ${error.message}\n`);
      return false;
    }
  };
  choice.onProjects = () => {
    registry.refresh?.();
    return save();
  };
  choice.onUsed = save;
  let server;
  try {
    server = await serve({ root: root ?? daemonFolder(), page: slug ? `${encodeURIComponent(slug)}/` : "", host: options.host, port: options.port, open: options.open, choice, registry });
  } catch (error) {
    return fail(error.message, 1);
  }
  // The token a stepped-down daemon left is used now; a daemon that lost the port race leaves it for the winner.
  if (daemon) fs.rmSync(handedTokenFile(), { force: true });
  if (store) {
    // Only now, holding the port, may this run set aside a list it could not read.
    let broken = null;
    if (unreadable) {
      process.stderr.write(`${yellow("!")} ${unreadable.message}. 이 목록은 ${store}.broken으로 옮기고 새로 시작합니다\n`);
      try {
        broken = fs.readFileSync(store);
      } catch {
        // Gone already; the save below writes a new list.
      }
    }
    saving = true;
    save();
    // The new list replaces the old one in one rename before .broken appears, so a reader never finds the list missing or half old.
    if (broken) {
      try {
        fs.writeFileSync(`${store}.broken`, broken, { mode: 0o600 });
      } catch {
        // Only the copy for reading later is lost.
      }
    }
  }
  // A newer CLI's handoff ends the daemon once it has no waiter; the saved list carries its projects over.
  if (daemon) {
    choice.onRetire = () => {
      save();
      // A daemon that steps down after its waiters has no run to pass the token to; the next daemon reads it here.
      try {
        const file = handedTokenFile();
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(`${file}.${process.pid}.tmp`, choice.token, { mode: 0o600 });
        fs.renameSync(`${file}.${process.pid}.tmp`, file);
      } catch (error) {
        process.stderr.write(`! 토큰을 남기지 못했습니다(다음 데몬은 새 토큰을 씁니다): ${error.message}\n`);
      }
      process.stderr.write("새 버전 jstyle에 자리를 넘기고 데몬을 끝냅니다\n");
      setTimeout(() => {
        server.closeAllConnections();
        server.close();
        process.exit(0);
      }, 300);
    };
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

const DAEMON_HELP = `usage: jstyle daemon [--port PORT] [--idle MIN]
       jstyle daemon stop [--force]

모든 프로젝트를 127.0.0.1:<port>(기본 8765, JSTYLE_DAEMON_PORT) 한 서버로 띄우는 데몬입니다.
보통은 직접 실행하지 않습니다. hub, explore --serve, 비교 화면 serve가 필요할 때 분리 실행합니다.
프로젝트 목록은 hubs/127.0.0.1-<port>.json에서 되살리고, 출력은 daemon/daemon.log에 남습니다.
대기자도 열린 화면도 요청도 없이 --idle 분(기본 30, 0은 닫지 않음)이 지나면 끝납니다.
jstyle stop <프로젝트>는 그 프로젝트만 빼고, jstyle stop <port>와 jstyle daemon stop은 데몬을 끕니다.
대기자가 있으면 --force 없이는 끄지 않습니다. kit, library는 /__skill/ 아래에서 엽니다.
새 버전 jstyle이 교체를 요청하면, 대기자가 없을 때 목록을 남기고 끝납니다. 대기자가 있으면 그들이 끝난 뒤에 끝납니다.
데몬 이전에 127.0.0.1의 이 포트에 띄운 허브는 끄고 같은 토큰과 주소로 넘겨받습니다. 대기자가 있는 허브와 ::1, localhost의 허브는 끄지 않고 그대로 씁니다.
`;

function handedTokenFile() {
  return path.join(daemonFolder(), "token");
}

// Agents waiting on a daemon, from its hub.json; 0 when it does not answer.
async function daemonWaiters(record) {
  const reply = await requestJson(record, "GET", "/__jstyle/hub.json", null, 1500);
  return reply.status === 200 ? (reply.body?.projects ?? []).reduce((sum, p) => sum + (p.waiters || 0), 0) : 0;
}

async function daemonCommand(argv) {
  if (argv[0] === "stop") {
    const { listRecords } = await import("../scripts/lib/registry.mjs");
    if (!listRecords().some((r) => r.daemon && r.port === DAEMON_PORT)) return fail(`${DAEMON_PORT} 포트에 떠 있는 데몬이 없습니다`, 1);
    return stopCommand([String(DAEMON_PORT), ...argv.slice(1).filter((arg) => arg === "--force")]);
  }
  const { parseServeArgs } = await import("../scripts/serve.mjs");
  let options;
  try {
    options = parseServeArgs(argv, { host: "127.0.0.1", port: DAEMON_PORT, open: false });
  } catch (error) {
    return fail(error.message);
  }
  if (options.help) {
    process.stdout.write(DAEMON_HELP);
    return 0;
  }
  if (options.pageGiven || options.root || options.wait || options.host !== "127.0.0.1") return fail("daemon은 폴더, --wait, --host를 받지 않습니다. 127.0.0.1에서만 띄웁니다");
  fs.mkdirSync(daemonFolder(), { recursive: true, mode: 0o700 });
  // A daemon that takes over a hub keeps its token, so tabs open on that hub go on working. It comes in the
  // environment, not argv, because other users on this machine can read a process's argv.
  let adopted = process.env.JSTYLE_ADOPT_TOKEN;
  delete process.env.JSTYLE_ADOPT_TOKEN;
  if (!adopted) {
    try {
      adopted = fs.readFileSync(handedTokenFile(), "utf8").trim();
    } catch {
      // No daemon stepped down for this one.
    }
  }
  return runHub(null, { ...options, open: false }, { daemon: true, token: /^[0-9a-f]{32}$/.test(adopted ?? "") ? adopted : undefined });
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

// A hub that runs on this port for this user, without --wait, takes more projects instead of a second server.
async function sharedHub({ host, port, within = null }) {
  if (!LOOPBACK_HOSTS.has(host) || !port) return null;
  const { listRecords } = await import("../scripts/lib/registry.mjs");
  const hub = listRecords().find((r) => joinable(r) && r.port === port);
  if (!hub) return null;
  if (within && !hub.projects.some((p) => isInside(p.root, within))) return null;
  if (hub.version !== VERSION) {
    process.stderr.write(`${yellow("!")} ${port}에 jstyle ${hub.version || "?"} 허브가 떠 있어 쓰지 않습니다. jstyle stop ${port} 뒤 다시 실행하세요\n`);
    return null;
  }
  return (await answersAs(hub)) ? hub : null;
}

// Joining and leaving talk to the hub on its own loopback address, so only a hub listening on loopback can be shared.
function joinable(record) {
  return record.kind === "hub" && !record.wait && Boolean(record.token) && Array.isArray(record.projects) && LOOPBACK_HOSTS.has(record.host);
}

function isInside(root, file) {
  let real;
  try {
    real = fs.realpathSync(file);
  } catch {
    return false;
  }
  const rel = path.relative(root, real);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Without a hub to wait on, --wait starts its own server; when a jstyle server
// that takes no waiters holds the port, it takes any free one.
async function freePortFor(port, always = false) {
  if (!port || always) return 0;
  const { listRecords } = await import("../scripts/lib/registry.mjs");
  return listRecords().some((r) => r.port === port) ? 0 : port;
}

function daemonFolder() {
  const home = process.env.JSTYLE_HOME || path.join(os.homedir(), ".jstyle");
  return path.join(home, "daemon");
}

// The daemon is used unless the user opts out or asks for another address or port.
function daemonWanted(host, port) {
  return !process.env.JSTYLE_NO_DAEMON && (host === "127.0.0.1" || host === "localhost") && port === DAEMON_PORT;
}

// The hub to use on this port: a running one, or a daemon started now.
// fellBack means the daemon could not start, so the caller serves on a free port.
async function hubFor({ host, port, idle }) {
  const found = await runningOrNewHub({ host, port });
  if (found.hub && idle !== undefined) process.stderr.write(`${dim(`--idle은 떠 있는 허브(${port})에는 적용되지 않습니다. 그 허브의 설정을 따릅니다`)}\n`);
  return found;
}

async function runningOrNewHub({ host, port }) {
  if (!daemonWanted(host, port)) return { hub: await sharedHub({ host, port }), fellBack: false };
  const { listRecords } = await import("../scripts/lib/registry.mjs");
  const here = listRecords().filter((r) => r.port === port);
  const hub = here.find((r) => joinable(r) && r.host === "127.0.0.1");
  // The daemon binds 127.0.0.1 only, so tabs opened on a ::1 or localhost hub could not reach it; such a hub is used, not taken over.
  const other = hub ? null : here.find((r) => joinable(r));
  if (other) {
    if (other.version !== VERSION) return fallBack(`${other.host}:${port}에 jstyle ${other.version || "?"} 허브가 떠 있습니다`);
    return (await answersAs(other)) ? { hub: other, fellBack: false } : fallBack(`${port}의 허브가 jstyle 서버로 응답하지 않습니다`);
  }
  if (hub?.daemon && hub.version === VERSION) return (await answersAs(hub)) ? { hub, fellBack: false } : fallBack(`${port}의 데몬이 응답하지 않습니다`);
  if (hub?.daemon) return replaceDaemon(hub, port);
  if (hub) return adoptHub(hub, port);
  // Another jstyle server (a --wait server, a kit run without the daemon) keeps the port.
  if (here.length) return fallBack(`다른 jstyle 서버가 ${port} 포트를 쓰고 있습니다`);
  return startOrFallBack(port);
}

function fallBack(reason) {
  process.stderr.write(`${yellow("!")} 데몬을 쓰지 않습니다: ${reason}. 이 명령의 서버를 빈 포트로 띄웁니다\n`);
  return { hub: null, fellBack: true };
}

async function startOrFallBack(port, env = {}) {
  const started = await startDaemon(port, env);
  return started.hub ? { hub: started.hub, fellBack: false } : fallBack(started.reason);
}

// Waits until a server's process is gone or its port no longer answers as it.
async function ended(record) {
  const { isAlive } = await import("../scripts/lib/registry.mjs");
  for (let i = 0; i < 50; i += 1) {
    if (!isAlive(record.pid) || !(await answersAs(record, 300))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// A daemon of another version is asked to make way. With agents waiting on it
// it stays; this run then uses it while the HTTP shape (api) is the same.
async function replaceDaemon(old, port) {
  const { API } = await import("../scripts/serve.mjs");
  const name = `${port}의 jstyle ${old.version || "?"} 데몬`;
  if (!(await answersAs(old))) return fallBack(`${name}이 응답하지 않습니다`);
  const reply = await postJson(old, "/__jstyle/daemon/handoff", {});
  if (reply.status === 200) {
    if (!(await ended(old))) return fallBack(`${name}이 교체 요청 뒤에도 끝나지 않았습니다`);
    process.stderr.write(`${dim(`${name}을 jstyle ${VERSION} 데몬으로 바꿉니다`)}\n`);
    // The new daemon keeps the old token, so tabs opened on the old one still save their picks.
    return startOrFallBack(port, { JSTYLE_ADOPT_TOKEN: old.token });
  }
  const waiters = reply.body?.waiters;
  if (reply.status === 409 && old.api === API) {
    process.stderr.write(`${yellow("!")} ${name}에 대기자 ${waiters}개가 있어 그대로 씁니다. 대기자가 모두 끝나면 그 데몬이 물러나고 다음 실행이 jstyle ${VERSION} 데몬을 띄웁니다\n`);
    return { hub: old, fellBack: false };
  }
  if (reply.status === 409) return fallBack(`${name}에 대기자 ${waiters}개가 있고, 주고받는 방식(api ${old.api ?? "?"})이 이 명령(api ${API})과 다릅니다`);
  return fallBack(`${name}이 교체 요청을 받지 않았습니다(${reply.body?.error ?? (reply.status || "연결 실패")})`);
}

// A hub from before the daemon on the daemon port: its projects go to the
// daemon's list under the same slugs, it is stopped like jstyle stop does,
// and the daemon starts with its token, so its open tabs keep working.
async function adoptHub(old, port) {
  const { hubStoreFile, readHubStore, writeHubStore } = await import("../scripts/lib/hubstore.mjs");
  if (!(await answersAs(old))) return fallBack(`${port}의 허브가 jstyle 서버로 응답하지 않습니다`);
  // Stopping a hub cuts off agents waiting on it, and it cannot take a handoff, so a busy hub is left running.
  const listed = await requestJson(old, "GET", "/__jstyle/hub.json");
  const waiters = (listed.body?.projects ?? []).reduce((sum, p) => sum + (p.waiters || 0), 0);
  if (waiters) {
    if (old.version !== VERSION) return fallBack(`${port}의 jstyle ${old.version || "?"} 허브에 대기자 ${waiters}개가 있습니다`);
    process.stderr.write(`${yellow("!")} ${port}의 허브에 대기자 ${waiters}개가 있어 데몬으로 넘겨받지 않고 그대로 씁니다\n`);
    return { hub: old, fellBack: false };
  }
  const store = hubStoreFile("127.0.0.1", port);
  let saved = [];
  try {
    saved = readHubStore(store);
  } catch {
    // The hub's record is the list to keep.
  }
  const now = new Date().toISOString();
  const projects = old.projects.map(({ slug, root }) => {
    const known = saved.find((p) => p.slug === slug && p.root === root);
    return { slug, root, added: known?.added ?? now, lastUsed: known?.lastUsed ?? now };
  });
  try {
    writeHubStore(store, projects);
  } catch (error) {
    return fallBack(`${port}의 허브 목록을 옮기지 못했습니다(${error.message})`);
  }
  try {
    process.kill(old.pid, "SIGTERM");
  } catch {
    // Ended on its own meanwhile.
  }
  if (!(await ended(old))) return fallBack(`${port}의 허브(프로세스 ${old.pid})가 끝나지 않았습니다`);
  process.stderr.write(`${dim(`${port}의 허브와 프로젝트 ${projects.length}개를 데몬으로 넘겨받습니다`)}\n`);
  return startOrFallBack(port, { JSTYLE_ADOPT_TOKEN: old.token });
}

// Starts `jstyle daemon` detached, logging to daemon/daemon.log, and waits until
// a hub of this version answers on the port. When two runs start one each, the
// one that opens the port wins and the other exits; either run then finds the winner.
async function startDaemon(port, extraEnv = {}) {
  const { listRecords } = await import("../scripts/lib/registry.mjs");
  const dir = daemonFolder();
  const log = path.join(dir, "daemon.log");
  let child;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if ((fs.statSync(log, { throwIfNoEntry: false })?.size ?? 0) > 1024 * 1024) fs.renameSync(log, `${log}.1`);
    // The log holds the address line with the token, so it stays private.
    const fd = fs.openSync(log, "a", 0o600);
    fs.chmodSync(log, 0o600);
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), "daemon", "--port", String(port)], { detached: true, stdio: ["ignore", fd, fd], windowsHide: true, env: { ...process.env, ...extraEnv, NO_COLOR: "1" } });
    fs.closeSync(fd);
  } catch (error) {
    return { reason: `띄우지 못했습니다(${error.message})` };
  }
  let exitedAt = 0;
  child.on("exit", () => { exitedAt = Date.now(); });
  child.on("error", () => { exitedAt = Date.now(); });
  child.unref();
  const deadline = Date.now() + DAEMON_READY_MS;
  while (Date.now() < deadline) {
    const hub = listRecords().find((r) => joinable(r) && r.port === port && r.version === VERSION);
    if (hub && (await answersAs(hub, 500))) return { hub };
    // A daemon that exited a second ago and left no hub behind will not come.
    if (exitedAt && Date.now() - exitedAt > 1000) return { reason: `데몬이 준비되기 전에 끝났습니다(${log})` };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // A daemon that opens the port after this run has moved on would sit beside this run's own server.
  if (!exitedAt) child.kill();
  return { reason: `${DAEMON_READY_MS / 1000}초 안에 준비되지 않았습니다(${log})` };
}

// A comparison page on a hub: join its folder like jstyle hub does, then print the page's address.
async function openOnHub(hub, file, open, projectRoot = hubFolderFor(hub, file)) {
  const joined = await postJson(hub, "/__jstyle/projects", { root: projectRoot });
  if (joined.status !== 200) {
    process.stderr.write(`${yellow("!")} 떠 있는 허브(${hub.port})에 ${projectRoot}를 붙이지 못했습니다(${joined.body?.error ?? (joined.status || "연결 실패")}). 이 명령의 서버로 띄웁니다\n`);
    return null;
  }
  const rel = path.relative(fs.realpathSync(projectRoot), fs.realpathSync(file)).split(path.sep).map(encodeURIComponent).join("/");
  const url = hubUrl(hub, `/${encodeURIComponent(joined.body.slug)}/${rel}`);
  process.stderr.write(`${green("✓")} 떠 있는 허브(${hub.port})에서 엽니다\n  ${url}\n`);
  if (open) openUrl(url);
  return 0;
}

// The address a recorded server answers on: a wildcard server also answers on 127.0.0.1.
function reachHost(record) {
  return record.host === "0.0.0.0" || record.host === "::" || !record.host ? "127.0.0.1" : record.host;
}

function postJson(record, pathname, body) {
  return requestJson(record, "POST", pathname, body);
}

function requestJson(record, method, pathname, body = null, timeout = 3000) {
  return new Promise((resolve) => {
    const data = body === null ? "" : JSON.stringify(body);
    const headers = { "X-Jstyle-Token": record.token, ...(body === null ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }) };
    const request = http.request({ host: reachHost(record), port: record.port, path: pathname, method, timeout, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          // Reported by status.
        }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve({ status: 0, body: null }));
    request.end(data);
  });
}

function hubUrl(hub, pathname) {
  const host = reachHost(hub);
  return `http://${host.includes(":") ? `[${host}]` : host}:${hub.port}${pathname}?t=${hub.token}`;
}

function openUrl(url) {
  const [command, args] = { darwin: ["open", [url]], win32: ["cmd", ["/c", "start", "", url]] }[process.platform] ?? ["xdg-open", [url]];
  spawnSync(command, args, { stdio: "ignore", timeout: 5000 });
}

async function joinHub(hub, root, open) {
  const reply = await postJson(hub, "/__jstyle/projects", { root });
  if (reply.status !== 200) return fail(`떠 있는 허브(${hub.port})에 폴더를 붙이지 못했습니다(${reply.body?.error ?? reply.status}): ${root}`, 1);
  const url = hubUrl(hub, reply.body.base);
  const evicted = reply.body.evicted ?? [];
  process.stdout.write(JSON.stringify({ hub: hub.port, project: reply.body.slug, url, ...(evicted.length ? { evicted } : {}) }) + "\n");
  process.stderr.write(`${green("✓")} 떠 있는 허브(${hub.port})에 프로젝트 ${reply.body.slug} 추가\n  ${url}\n`);
  if (evicted.length) process.stderr.write(`${yellow("!")} 허브의 프로젝트가 상한을 넘어 가장 오래 쓰지 않은 ${evicted.join(", ")}를 뺐습니다\n`);
  if (open) openUrl(url);
  return 0;
}

// The hub folder a page belongs to: a project the hub already serves, else
// the .jstyle folder above the page, else the page's own folder.
function hubFolderFor(hub, file) {
  const known = hub.projects.find((p) => isInside(p.root, file));
  if (known) return known.root;
  const parts = fs.realpathSync(file).split(path.sep);
  const at = parts.lastIndexOf(".jstyle");
  return at > 0 ? parts.slice(0, at + 1).join(path.sep) : path.dirname(fs.realpathSync(file));
}

// --wait on a running hub: join the project, register a waiter and long-poll
// until a pick arrives from any tab of the hub. stdout and exit codes match a
// --wait server: the pick as one JSON line and 0, or empty stdout and 1.
// Returns null when the hub does not take this wait, so the caller starts its own server.
async function waitOnHub(hub, { folder = null, file = null, open }) {
  const projectRoot = file ? hubFolderFor(hub, file) : folder;
  const notTaken = (what, reply) => {
    process.stderr.write(`${yellow("!")} 떠 있는 허브(${hub.port})${what}(${reply.body?.error ?? (reply.status || "연결 실패")}). 이 명령의 서버로 띄워 기다립니다\n`);
    return null;
  };
  const joined = await postJson(hub, "/__jstyle/projects", { root: projectRoot });
  if (joined.status !== 200) return notTaken(`에 ${projectRoot}를 붙이지 못했습니다`, joined);
  const page = file ? path.relative(fs.realpathSync(projectRoot), fs.realpathSync(file)).split(path.sep).join("/") : null;
  const registered = await postJson(hub, "/__jstyle/waiters", { project: joined.body.slug, page, pid: LAUNCHED_BY });
  if (registered.status !== 200) return notTaken("에서 기다릴 수 없습니다", registered);
  const { id, url } = registered.body;
  // Leaving tells the hub not to hand a later pick to this ended run; a hub that is gone has nothing to forget.
  const forget = () => requestJson(hub, "DELETE", `/__jstyle/waiters/${id}`, null, 2000);
  const leave = (code) => {
    forget().finally(() => process.exit(code));
  };
  process.once("SIGINT", () => leave(130));
  process.once("SIGTERM", () => leave(143));
  process.once("SIGHUP", () => leave(129));
  process.stderr.write(`Serving ${projectRoot} at ${url} (떠 있는 허브 ${hub.port})\n`);
  process.stderr.write(`${dim("wait:")} ${file ? "비교 화면에서" : "어느 비교 화면에서든"} 고르거나 보내면 끝납니다 (대기자 ${id})\n`);
  if (open) openUrl(url);
  let failures = 0;
  for (;;) {
    const reply = await requestJson(hub, "GET", `/__jstyle/waiters/${id}?wait=25`, null, 35000);
    if (reply.status === 204) {
      failures = 0;
      continue;
    }
    if (reply.status === 200 && reply.body?.record) {
      const { record, file: saved } = reply.body;
      process.stdout.write(JSON.stringify({ ...record, file: saved }) + "\n");
      const label = record.id === null ? `고른 안 없이 의견 ${record.comments.length}개` : `고른 안: ${record.baseline ? "기존 화면" : record.number} ${record.name}`;
      process.stderr.write(`${green("✓")} ${record.page} · ${label}\n  ${saved}\n`);
      return 0;
    }
    if (reply.status === 0) {
      // One failed poll can be a reset connection; a second means the hub is gone.
      failures += 1;
      if (failures < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      process.stderr.write(`${red("✗")} 허브(${hub.port})에 연결할 수 없어 기다리기를 끝냅니다\n`);
      await forget();
      return 1;
    }
    process.stderr.write(`${red("✗")} 허브(${hub.port})가 이 대기자를 정리했습니다(${reply.body?.reason ?? reply.status})\n`);
    if (reply.status !== 410) await forget();
    return 1;
  }
}

function announceHubPage(hub, file, open) {
  const project = hub.projects.find((p) => isInside(p.root, file));
  const rel = path.relative(project.root, fs.realpathSync(file)).split(path.sep).map(encodeURIComponent).join("/");
  const url = hubUrl(hub, `/${encodeURIComponent(project.slug)}/${rel}`);
  process.stderr.write(`${green("✓")} 떠 있는 허브(${hub.port})에서 엽니다\n  ${url}\n`);
  if (open) openUrl(url);
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
  // A daemon reports its live waiters per project; its record only knows the projects.
  for (const r of records) {
    if (!r.daemon || !joinable(r)) continue;
    const reply = await requestJson(r, "GET", "/__jstyle/hub.json", null, 1500);
    if (reply.status !== 200) continue;
    const waiting = new Map((reply.body?.projects ?? []).map((p) => [p.slug, p.waiters ?? 0]));
    r.projects = r.projects.map((p) => ({ ...p, waiters: waiting.get(p.slug) ?? 0 }));
  }
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
    const name = Array.isArray(r.projects) ? r.projects.map((p) => p.slug).join(", ") : r.project ?? "";
    process.stdout.write(`${cyan(String(r.port).padEnd(6))}${String(r.daemon ? "daemon" : r.kind ?? "?").padEnd(8)}${name}  ${dim(`${ago(r.started)} 전 시작 · 마지막 요청 ${ago(r.lastActivity)} 전 · ${idle}`)}\n`);
    const home = process.env.HOME || "";
    const short = (dir) => (home && dir?.startsWith(home + path.sep) ? "~" + dir.slice(home.length) : dir ?? "");
    if (r.daemon) {
      const width = Math.max(0, ...r.projects.map((p) => p.slug.length));
      const lines = r.projects.map((p) => `      ${p.slug.padEnd(width)}  ${(p.waiters ? `대기자 ${p.waiters}` : "").padEnd(8)}${dim(short(p.root))}\n`);
      process.stdout.write(`      ${r.url}\n${lines.join("")}`);
      continue;
    }
    const where = Array.isArray(r.projects) ? r.projects.map((p) => short(p.root)) : [short(r.root)];
    process.stdout.write(`      ${r.url}\n${where.map((dir) => `      ${dim(dir)}\n`).join("")}`);
  }
  return 0;
}

const STOP_HELP = `usage: jstyle stop <port|project|all> [--force]

jstyle 서버를 끕니다. 포트 번호, 프로젝트 이름(jstyle ps에 보이는 이름) 또는 all을 받습니다.
끄기 전에 그 포트가 기록된 jstyle 서버인지 확인합니다.
데몬에서 프로젝트 이름을 주면 그 프로젝트만 뺍니다. 데몬 자체는 기다리는 에이전트(대기자)가 있으면
--force 없이는 끄지 않습니다. jstyle daemon stop [--force]도 같습니다.
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
  const holds = (r) => (Array.isArray(r.projects) ? r.projects.some((p) => p.slug === target) : r.project === target);
  const records = listRecords().filter((r) => target === "all" || String(r.port) === target || (!byPort && holds(r)));
  if (!records.length) return fail(`끌 jstyle 서버가 없습니다: ${target}. jstyle ps로 확인하세요`, 1);
  // Folders in different places can share a name; a name that matches several servers ends none of them.
  if (!byPort && records.length > 1) return fail(`${target} 이름의 서버가 ${records.length}개입니다(포트 ${records.map((r) => r.port).join(", ")}). jstyle stop <포트>로 하나씩 끄세요`, 1);
  let stopped = 0;
  for (const r of records) {
    // A hub that serves other projects too only lets go of this one.
    if (target !== "all" && String(r.port) !== target && joinable(r) && (r.daemon || r.projects.length > 1) && (await answersAs(r))) {
      const reply = await postJson(r, "/__jstyle/projects", { remove: target });
      if (reply.status === 200) {
        stopped += 1;
        process.stderr.write(`${green("✓")} ${r.port} 허브에서 프로젝트 ${target} 제외\n`);
      } else {
        // The other projects keep the hub; a failed removal never ends it.
        process.stderr.write(`${yellow("!")} ${r.port} 허브에서 프로젝트 ${target}를 빼지 못했습니다(${reply.body?.error ?? reply.status}). 허브를 끄려면 jstyle stop ${r.port}\n`);
      }
      continue;
    }
    // Ending the daemon under a waiting agent fails that agent's --wait; it takes --force.
    if (r.daemon && !argv.includes("--force") && (await answersAs(r))) {
      const waiters = await daemonWaiters(r);
      if (waiters) {
        process.stderr.write(`${yellow("!")} ${r.port} 데몬에 대기자 ${waiters}개가 기다리고 있어 끄지 않았습니다. 그래도 끄려면 --force를 붙입니다\n`);
        continue;
      }
    }
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
    case "daemon":
      return daemonCommand(rest);
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
