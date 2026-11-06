import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { marker } from "../scripts/recommend_once.mjs";

const SCRIPT = path.join(path.resolve(fileURLToPath(new URL("..", import.meta.url))), "scripts", "recommend_once.mjs");

function setup(t) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-recommend-"));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const env = { ...process.env, XDG_STATE_HOME: state, LOCALAPPDATA: state };
  return { state, run: (args) => spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8" }) };
}

test("the guide prints once per user, then nothing", (t) => {
  const { state, run } = setup(t);
  const first = run(["--lang", "ko"]);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^jstyle 사용법은 README\.md를 읽어 주세요\./);
  assert.ok(fs.statSync(path.join(state, "jstyle", "usage-guide-shown")).isFile());
  const again = run([]);
  assert.equal(again.status, 0);
  assert.equal(again.stdout, "");
});

test("English is the default language", (t) => {
  const { run } = setup(t);
  assert.match(run(["--l=en"]).stdout, /^Read README\.md for jstyle usage\./);
});

test("usage errors exit 2 with argparse messages", (t) => {
  const { state, run } = setup(t);
  const invalid = run(["--lang", "fr"]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /error: argument --lang: invalid choice: 'fr' \(choose from en, ko\)/);
  assert.match(run(["extra"]).stderr, /error: unrecognized arguments: extra/);
  assert.match(run(["--lang"]).stderr, /error: argument --lang: expected one argument/);
  assert.equal(run(["--help"]).status, 0);
  assert.equal(fs.existsSync(path.join(state, "jstyle")), false);
});

test("the marker lives in the platform state folder", () => {
  assert.equal(marker({ XDG_STATE_HOME: "/state" }, "linux"), path.join("/state", "jstyle", "usage-guide-shown"));
  assert.equal(marker({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32"), path.join("C:\\Users\\u\\AppData\\Local", "jstyle", "usage-guide-shown"));
  assert.equal(marker({}, "linux"), path.join(os.homedir(), ".local", "state", "jstyle", "usage-guide-shown"));
});
