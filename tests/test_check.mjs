import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkSource, declarations, loadKitTokens } from "../scripts/check.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = path.join(ROOT, "bin", "jstyle.mjs");
const kit = loadKitTokens();
const rules = (css, useKit = true) => checkSource(css, { kit, useKit }).map((f) => f.rule);

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-check-"));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}
const jstyle = (args) => spawnSync(process.execPath, [CLI, "check", ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

test("declarations keep selectors and ignore ';' inside strings, comments and url()", () => {
  const found = declarations(`/* a{color:red} */ .a { background: url("data:x;y"); color: var(--jk-ink) } @media (x) { .b { & .c { gap: 4px } } }`);
  assert.deepEqual(found.map((d) => [d.selector, d.prop]), [[".a", "background"], [".a", "color"], ["& .c", "gap"]]);
});

test("a kit token override is an error, the kit's own definitions are not read", () => {
  assert.deepEqual(rules(":root { --jk-primary: #13a34a; --jk-radius: 4px }"), ["jk-override", "jk-override"]);
  assert.deepEqual(rules(":root { --jk-primary: #13a34a }", false), []);
});

test("raw colors are errors with the kit token of the same value suggested", () => {
  const [finding] = checkSource(".a { color: #6e7276 }", { kit, useKit: true });
  assert.equal(finding.rule, "raw-color");
  assert.equal(finding.level, "error");
  assert.match(finding.suggestion, /같은 값의 토큰: var\(--jk-/);
  assert.deepEqual(rules(".a { color: rgb(94 104 108) }"), ["raw-color"]);
});

test("neutral alpha, var() fallbacks, transparent and currentColor are allowed", () => {
  assert.deepEqual(rules(".a { box-shadow: 0 1px 2px #0000001a; background: rgba(0, 0, 0, .4); color: var(--jk-ink, #222); border-color: transparent; fill: currentColor }"), []);
  assert.deepEqual(rules(".a { box-shadow: 0 1px 2px #173d2208 }"), ["raw-color"]);
});

test("radius from 6px is an error, smaller and token radii are not", () => {
  assert.deepEqual(rules(".a { border-radius: 4px } .b { border-radius: var(--jk-radius-s) } .c { border-radius: 14px 2px }"), ["raw-radius"]);
});

test("font sizes outside the kit's scale and own font stacks are warnings", () => {
  const found = checkSource(".a { font-size: 13.5px } .b { font-size: 19px } .c { font-family: Inter, sans-serif } .d { font-family: ui-monospace, Menlo }", { kit, useKit: true });
  assert.deepEqual(found.map((f) => [f.rule, f.level]), [["raw-font-size", "warn"], ["raw-font", "warn"]]);
});

test("own color tokens are warnings in kit projects and allowed elsewhere", () => {
  assert.deepEqual(rules(":root { --brand: #1a7f37 } .a { color: var(--brand) }"), ["own-token"]);
  assert.deepEqual(rules(":root { --brand: #1a7f37 } .a { color: var(--brand) }", false), []);
  assert.deepEqual(rules(".a { color: #1a7f37 }", false), ["raw-color"]);
});

test("jstyle check finds overrides in <style> with true line numbers and fails", () => {
  const dir = project({
    "index.html": `<link rel="stylesheet" href="vendor/kit.css">\n<style>\n:root {\n  --jk-primary: #13a34a;\n}\n</style>`,
    "vendor/kit.css": ":root { --jk-primary: #0abe3a }",
    "node_modules/x/a.css": ".a { color: #123456 }",
  });
  const result = jstyle([dir, "--json"]);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.kit, true);
  assert.equal(report.files, 1);
  assert.deepEqual(report.findings.map((f) => [path.basename(f.file), f.line, f.rule]), [["index.html", 4, "jk-override"]]);
});

test("warnings pass unless --strict, and a clean file passes", () => {
  const dir = project({ "app.css": ".a { color: var(--jk-ink); font-size: 19px }" });
  assert.equal(jstyle([dir, "--kit"]).status, 0);
  assert.equal(jstyle([dir, "--kit", "--strict"]).status, 1);
  assert.match(jstyle([dir, "--kit"]).stdout, /오류 0개, 경고 1개/);
});

test("bad arguments exit 2 with usage", () => {
  assert.equal(jstyle([]).status, 2);
  assert.equal(jstyle(["--nope", "x"]).status, 2);
  assert.match(jstyle(["--help"]).stdout, /jk-override/);
});
