// Shared isolated Chrome lifecycle; callers own their CDP transport and signal handlers.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export function findChrome() {
  const env = process.env.CHROME_PATH;
  if (env && existsSync(env)) return env;
  const candidates = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
    win32: [
      `${process.env["PROGRAMFILES"]}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["LOCALAPPDATA"]}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env["PROGRAMFILES"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ],
  }[process.platform];
  for (const c of candidates || []) if (c && existsSync(c)) return c;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
    const r = spawnSync(process.platform === "win32" ? "where.exe" : "which", [name], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  }
  throw new Error("Chrome, Chromium, Edge를 찾지 못했습니다. 하나를 설치하거나 CHROME_PATH에 경로를 지정하세요.");
}

export function createChrome({ timeoutMs = ms => ms, prefix = "jstyle-browser-", label = "browser" } = {}) {
  const chromePath = findChrome();
  let profile, chrome, handedOff;
  // 처음 띄운 프로세스가 실제 브라우저가 아닐 수 있습니다. 일부 버전은 다른 프로세스에 브라우저를 넘기고 끝납니다.
  // 그래서 먼저 브라우저가 스스로 끝나게 한 뒤, 이번 임시 폴더 이름으로 남은 프로세스를 찾습니다.
  function closeBrowser(ws) {
    return new Promise((ok) => {
      const socket = ws, timer = setTimeout(() => ok(false), 3000);
      socket.onerror = null; socket.onclose = () => { clearTimeout(timer); ok(true); };
      try { socket.send(JSON.stringify({ id: 2147483647, method: "Browser.close" })); } catch { clearTimeout(timer); ok(false); }
    });
  }
  function profileProcesses() {
    const name = basename(profile);
    if (process.platform === "win32") {
      const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${name}') } | ForEach-Object { $_.ProcessId }`;
      const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 20000, windowsHide: true });
      return (r.stdout || "").split(/\s+/).map(Number).filter((pid) => pid && pid !== process.pid);
    }
    const r = spawnSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", timeout: 10000 });
    return (r.stdout || "").split("\n").filter((line) => line.includes(name)).map((line) => Number(line.trim().split(/\s+/)[0])).filter((pid) => pid && pid !== process.pid);
  }
  function killProfileProcesses() {
    // 첫 확인 뒤에 생긴 자식 프로세스도 닫아야 하므로 두 번 찾습니다.
    for (let pass = 0; pass < 2; pass++) {
      const pids = profileProcesses(); if (!pids.length) return;
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  }
  function removeProfile(closed) {
    if (!profile) return;
    const remove = (maxRetries) => rmSync(profile, { recursive: true, force: true, maxRetries, retryDelay: 100 });
    try {
      // 실제 브라우저가 처음 프로세스와 다르면 연결이 끊겨도 프로세스는 끝나지 않았을 수 있고 종료 이벤트도 기다릴 수 없으므로, 폴더 이름으로 찾아 정리합니다.
      if (!closed || handedOff) killProfileProcesses();
      try { remove(5); } catch { killProfileProcesses(); remove(10); }
    } catch (error) { console.error(`${label}: 임시 폴더를 지우지 못했습니다(${error.code || error.message}). 나중에 직접 지우세요: ${profile}`); }
    profile = undefined;
  }
  async function stopChrome(ws) {
    const closed = ws?.readyState === WebSocket.OPEN ? await closeBrowser(ws) : false;
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) await new Promise((ok) => {
      const timer = setTimeout(() => { chrome.kill("SIGKILL"); ok(); }, 3000);
      chrome.once("close", () => { clearTimeout(timer); ok(); }); chrome.kill();
    });
    removeProfile(closed);
  }
  async function launchChrome() {
    profile = mkdtempSync(join(tmpdir(), prefix)); handedOff = false;
    chrome = spawn(chromePath, ["--headless=new", "--enable-unsafe-swiftshader", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
      "--no-default-browser-check", "--use-mock-keychain", "--password-store=basic", "--hide-scrollbars", "--mute-audio", "--disable-extensions", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
    const portFile = join(profile, "DevToolsActivePort");
    const fromPortFile = () => {
      try {
        const [port, path] = readFileSync(portFile, "utf8").split("\n").map((line) => line.trim());
        return /^\d+$/.test(port) && path?.startsWith("/devtools/browser/") ? `ws://127.0.0.1:${port}${path}` : null;
      } catch { return null; }
    };
    return new Promise((ok, no) => {
      let buf = "", exited;
      const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs(45000));
      const poll = setInterval(() => { const url = fromPortFile(); if (url) finish(null, url); }, 100);
      const onData = (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) finish(null, m[1]); };
      const onError = (e) => finish(e);
      // 브라우저가 이미 다른 프로세스로 넘어갔고 포트 파일이 나중에 생길 수 있으므로, 바로 실패로 처리하지 않습니다.
      const onExit = () => { handedOff = true; exited = setTimeout(() => finish(new Error("브라우저가 일찍 끝났습니다")), timeoutMs(10000)); };
      function finish(error, url) {
        clearTimeout(timer); clearTimeout(exited); clearInterval(poll);
        chrome.stderr.off("data", onData); chrome.off("error", onError); chrome.off("exit", onExit);
        error ? no(error) : ok(url);
      }
      chrome.stderr.on("data", onData); chrome.once("error", onError); chrome.once("exit", onExit);
    });
  }
  return {
    launch: launchChrome,
    stop: stopChrome,
    tempFile(name) { return join(profile, name); },
    dispose() {
      try { chrome?.kill(); } catch {}
      removeProfile(false);
    },
  };
}
