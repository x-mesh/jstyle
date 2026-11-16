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
  const [finding] = checkSource(".a { color: #676b6f }", { kit, useKit: true });
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
    "vendor/kit.css": ":root { --jk-green: #0abe3a }",
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

const KIT_COPY = ":root { --jk-green: #0abe3a; --jk-ink: #242a30 } .jk-btn { height: 32px } .jk-btn-primary { color: #fff } .jk-old-thing { gap: 4px }";
const report = (args) => {
  const result = jstyle([...args, "--json"]);
  return { status: result.status, ...JSON.parse(result.stdout) };
};
const found = (r) => r.findings.map((f) => [path.basename(f.file), f.line, f.rule, f.level, f.value]);

test("a React project that imports the kit copy is a kit project, and its scripts are not read as CSS", () => {
  const dir = project({
    "src/App.jsx": `import "./kit.css";\nexport default () => <button className="jk-btn jk-btn-primary" style={{ background: "#1a73e8", borderRadius: 14 }}>저장</button>;`,
    "src/app.css": ".toolbar { background: #1a73e8 }",
    "src/kit.css": KIT_COPY,
  });
  const r = report([dir]);
  assert.equal(r.status, 1);
  assert.equal(r.kit, true);
  assert.match(r.kitBasis, /kit\.css$/);
  assert.deepEqual(found(r), [["app.css", 1, "raw-color", "error", "#1a73e8"]]);
});

test("jk classes in JSX alone make a kit project", () => {
  const dir = project({
    "src/App.jsx": `export default () => <button className="jk-btn">저장</button>;`,
    "src/app.css": ".toolbar { background: #1a73e8 }",
  });
  const r = report([dir]);
  assert.equal(r.kit, true);
  assert.match(r.kitBasis, /App\.jsx$/);
  assert.equal(r.errors, 1);
});

test("--exclude does not hide the kit copy that proves kit use", () => {
  const dir = project({ "web/vendor/kit.css": KIT_COPY, "web/app.css": ".toolbar { background: #1a73e8 }" });
  const r = report([path.join(dir, "web"), "--exclude", "vendor"]);
  assert.equal(r.kit, true);
  assert.deepEqual(found(r).map((f) => f[2]), ["raw-color"]);
});

test("another kit.css or a uikit.css link is not the kit, and the summary says how to force it", () => {
  const dir = project({
    "index.html": `<link rel="stylesheet" href="uikit.css">\n<style>.a { color: #123456 }</style>`,
    "lib/kit.css": ".grid { display: grid }",
  });
  assert.equal(report([dir]).kit, false);
  const text = jstyle([dir]);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /키트 사용 안 함.*--kit/);
});

test("a style folder alone is not detected and says so", () => {
  const dir = project({ "src/App.jsx": `<i className="jk-i" />`, "src/styles/app.css": ".a { color: #123456 }" });
  const text = jstyle([path.join(dir, "src", "styles")]);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /키트 사용 안 함.*--kit/);
});

test("a jk class that the kit does not define is an error with the nearest name", () => {
  const dir = project({
    "index.html": `<link rel="stylesheet" href="kit.css">\n<button class="jk-btn jk-btn-primery" data-jk-theme="blue">저장</button>\n<i class="jk-fx-entry-complete jk-custom jk-old-thing"></i>`,
    "app.js": [
      "el.innerHTML = `<button class=\"jk-btn jk-btn-${size} jk-bttn ${on ? \"jk-on\" : \"\"}\">`;",
      "el.classList.add(\"jk-nope\", `jk-${kind}`);",
      "el.style.setProperty(\"--jk-hue\", 160);",
    ].join("\n"),
    "Tabs.tsx": `export const Tabs = () => <div className={"jk-tabz"} id="jk-not-a-class" />;`,
    "app.css": ".jk-custom { color: var(--jk-ink) }",
    "kit.css": KIT_COPY,
  });
  const r = report([dir]);
  assert.equal(r.status, 1);
  assert.deepEqual(found(r), [
    ["Tabs.tsx", 1, "unknown-class", "error", "jk-tabz"],
    ["app.js", 1, "unknown-class", "error", "jk-bttn"],
    ["app.js", 1, "unknown-class", "error", "jk-on"],
    ["app.js", 2, "unknown-class", "error", "jk-nope"],
    ["index.html", 2, "unknown-class", "error", "jk-btn-primery"],
  ]);
  assert.match(r.findings.find((f) => f.value === "jk-btn-primery").suggestion, /jk-btn-primary/);
});

test("names in class helpers, JSX expressions, Vue bindings and interpolations are read", () => {
  const dir = project({
    "App.jsx": [
      `const a = <i className={clsx("jk-btn", on && "jk-nope", { "jk-nopf": off })} />;`,
      `const b = <i className={on ? "jk-btn" : "jk-nopg"} />;`,
      "const c = <i className={`jk-btn jk-btn-${tone} jk-zz-${tone} jk-${kind}`} />;",
      `const d = cn("jk-noph");`,
      `const e = <i className={broken ? "jk-nopi" />;`,
    ].join("\n"),
    "List.vue": `<template><li :class="['jk-btn', { 'jk-nopj': on }]"></li></template>`,
  });
  assert.deepEqual(found(report([dir])), [
    ["App.jsx", 1, "unknown-class", "error", "jk-nope"],
    ["App.jsx", 1, "unknown-class", "error", "jk-nopf"],
    ["App.jsx", 2, "unknown-class", "error", "jk-nopg"],
    ["App.jsx", 3, "unknown-class", "error", "jk-zz-${tone}"],
    ["App.jsx", 4, "unknown-class", "error", "jk-noph"],
    ["List.vue", 1, "unknown-class", "error", "jk-nopj"],
  ]);
});

test("a class of the installed kit that the project's copy lacks names the file to copy", () => {
  const markup = `<div class="jk-btn jk-table jk-lp jk-fx-entry-complete"></div>`;
  const r = report([project({ "vendor/kit.css": KIT_COPY, "index.html": markup })]);
  assert.deepEqual(found(r), [
    ["index.html", 1, "missing-in-copy", "error", "jk-table"],
    ["index.html", 1, "missing-in-copy", "error", "jk-lp"],
  ]);
  assert.match(r.findings[0].suggestion, /kit\.css/);
  assert.match(r.findings[1].suggestion, /decor\.css/);
  assert.deepEqual(report([project({ "index.html": markup })]).findings, []);
});

test("a script given as a file is read for classes only", () => {
  const dir = project({ "src/App.jsx": `export default () => <button className="jk-btn jk-nope" style={{ background: "#1a73e8" }}>저장</button>;` });
  const r = report([path.join(dir, "src", "App.jsx")]);
  assert.equal(r.kit, true);
  assert.deepEqual(found(r), [["App.jsx", 1, "unknown-class", "error", "jk-nope"]]);
});

test("the kit page itself has no unknown class, and unknown classes are left alone without the kit", () => {
  const page = report([path.join(ROOT, "assets", "kit", "index.html")]);
  assert.equal(page.kit, true);
  assert.deepEqual(page.findings, []);
  const dir = project({ "index.html": `<button class="jk-btn-primery">저장</button>` });
  assert.deepEqual(report([dir, "--no-kit"]).findings, []);
});

test("a kit repository without the check in its own commands gets a notice that does not change the exit code", () => {
  const files = { ".git/HEAD": "ref: refs/heads/main\n", "web/index.html": `<button class="jk-btn">저장</button>` };
  const bare = project(files);
  assert.equal(report([path.join(bare, "web")]).wired, false);
  const text = jstyle([path.join(bare, "web")]);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /알림: .*jstyle check를 찾지 못했습니다/);
  assert.match(text.stdout, /검사 명령에 `jstyle check web`를 추가하세요/);

  for (const [name, body] of [["Makefile", "JSTYLE = jstyle\nstyle:\n\t$(JSTYLE) check web/\n"], ["package.json", `{"scripts":{"style":"node tools/jstyle.mjs check web"}}`], [".github/workflows/ci.yaml", "steps:\n  - run: npx --yes github:x-mesh/jstyle#v0.41.1 check web\n"]]) {
    const wired = project({ ...files, [name]: body });
    assert.equal(report([path.join(wired, "web")]).wired, true, name);
    assert.doesNotMatch(jstyle([path.join(wired, "web")]).stdout, /알림/);
  }
  const outside = project({ "web/index.html": files["web/index.html"] });
  assert.equal(report([path.join(outside, "web")]).wired, null);
  assert.equal(report([path.join(bare, "web"), "--no-kit"]).wired, null);
});

test("a product rule that changes the look of a kit class is a warning, layout is not", () => {
  const css = ".sidebar .jk-btn { height: 37px; width: 100%; margin-left: auto } .jk-btn-primary:hover, .x { background: var(--jk-ink) } .jk-btn .label { font-weight: 800 } .wrap .jk-nope { height: 2px }";
  const found = checkSource(css, { kit, useKit: true });
  assert.deepEqual(found.map((f) => [f.rule, f.level, f.prop]), [["kit-restyle", "warn", "height"], ["kit-restyle", "warn", "background"]]);
  assert.match(found[0].message, /\.jk-btn/);
  assert.deepEqual(rules(css, false), []);
});

test("spacing off the kit scale is a warning, large layout gaps and nudges are not", () => {
  const found = checkSource(".a { padding: 13px 8px; margin: -5px auto 0; gap: calc(100% - 7px) } .b { padding: 12px 56px 1px; gap: var(--jk-space-2-5) } .c { margin-top: 9px; row-gap: 0.75rem }", { kit, useKit: true });
  assert.deepEqual(found.map((f) => [f.rule, f.level, f.prop]), [["raw-spacing", "warn", "padding"], ["raw-spacing", "warn", "margin-top"]]);
  assert.match(found[0].suggestion, /var\(--jk-space-3\) \(12px\)/);
  assert.deepEqual(kit.space.map((t) => t.px), [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48]);
});

test("rem lengths are read as 16px to the rem", () => {
  assert.deepEqual(rules(".a { border-radius: 1rem } .b { border-radius: .25rem } .c { font-size: 0.93rem } .d { font-size: 0.875rem }"), ["raw-radius", "raw-font-size"]);
});

test("style attributes in markup are checked, kit slots and the kit page\u0027s own inline values are not", () => {
  const dir = project({
    "kit.css": KIT_COPY,
    "index.html": [
      `<b class="jk-btn" style="background:#1a73e8; border-radius: 14px; --jk-hue:160; --c:#f6ae00">저장</b>`,
      `<i style="background:#3a3d41"></i><i style="border-radius:12px"></i>`,
      `<i :style="{ color: \u0027#123456\u0027 }"></i>`,
    ].join("\n"),
  });
  assert.deepEqual(found(report([dir])), [
    ["index.html", 1, "raw-color", "error", "#1a73e8"],
    ["index.html", 1, "raw-radius", "error", "14px"],
  ]);
  const drawing = project({ "kit.css": KIT_COPY, "index.html": `<i class="jk-btn"></i><svg viewBox="0 0 8 8"><rect style="fill:#1a73e8" width="8" height="8"/></svg>` });
  assert.deepEqual(report([drawing]).findings, []);
  const page = project(Object.fromEntries(["index.html", "kit.css", "decor.css"].map((name) => [name, fs.readFileSync(path.join(ROOT, "assets", "kit", name), "utf8")])));
  assert.deepEqual(report([page]).findings, []);
});

test("--tokens holds a project without the kit to its own tokens", () => {
  const dir = project({
    "tokens.css": ":root { --brand: #1a7f37; --radius-m: 8px; --font-size-body: 14px }",
    "app.css": ".a { color: #1a7f37; border-radius: 10px; font-size: 15px } .b { color: var(--brand); border-radius: var(--radius-m); font-size: 14px }",
    "bad.css": ":root { --brand: oklch(60% 0.1 150) }",
  });
  const app = path.join(dir, "app.css");
  assert.deepEqual(found(report([app])).map((f) => [f[2], f[3]]), [["raw-color", "warn"]]);
  const r = report([app, "--tokens", path.join(dir, "tokens.css")]);
  assert.equal(r.status, 1);
  assert.deepEqual(found(r).map((f) => [f[2], f[3]]), [["raw-color", "error"], ["raw-radius", "error"], ["raw-font-size", "warn"]]);
  assert.match(r.findings[0].suggestion, /같은 값의 토큰: var\(--brand\)/);
  assert.equal(jstyle([app, "--tokens", path.join(dir, "bad.css")]).status, 2);
  assert.equal(jstyle([app, "--tokens", path.join(dir, "none.css")]).status, 2);
});

test("a token that the kit or the project's copy does not have is an error", () => {
  const css = ".a { padding: var(--jk-space-2-5); color: var(--jk-inkk); margin: var(--jk-nope, 4px); background: hsl(var(--jk-hue) 60% 90%) }";
  assert.deepEqual(checkSource(css, { kit, useKit: true }).map((f) => [f.rule, f.level, f.prop]), [["unknown-token", "error", "color"]]);
  assert.match(checkSource(css, { kit, useKit: true })[0].suggestion, /--jk-ink\b/);
  assert.deepEqual(rules(css, false), []);
  const old = report([project({ "vendor/kit.css": KIT_COPY, "index.html": `<i class="jk-btn"></i>`, "app.css": ".a { padding: var(--jk-space-2-5); color: var(--jk-ink) }" })]);
  assert.deepEqual(found(old).map((f) => [f[0], f[2], f[3]]), [["app.css", "missing-in-copy", "error"]]);
  assert.match(old.findings[0].suggestion, /kit\.css/);
});

test("a kit copy whose token values differ from the installed kit is one warning", () => {
  const kitCss = fs.readFileSync(path.join(ROOT, "assets", "kit", "kit.css"), "utf8");
  const markup = `<button class="jk-btn">저장</button>`;
  const changed = report([project({ "vendor/kit.css": kitCss.replace("--jk-green: #0abe3a", "--jk-green: #1a73e8"), "index.html": markup })]);
  assert.equal(changed.status, 0);
  assert.deepEqual(found(changed).map((f) => [f[0], f[2], f[3]]), [["kit.css", "copy-differs", "warn"]]);
  assert.match(changed.findings[0].message, /--jk-green/);
  assert.deepEqual(report([project({ "vendor/kit.css": kitCss, "index.html": markup })]).findings, []);
});

test("text output shows five warnings of a rule and counts the rest", () => {
  const dir = project({ "app.css": Array.from({ length: 7 }, (_, i) => `.a${i} { color: var(--jk-ink); font-size: 19px }`).join("\n") });
  const text = jstyle([dir, "--kit"]).stdout;
  assert.equal(text.match(/raw-font-size  /g).length, 5);
  assert.match(text, /raw-font-size: 2건 더/);
  assert.match(text, /오류 0개, 경고 7개/);
  assert.equal(report([dir, "--kit"]).findings.length, 7);
});

test("bad arguments exit 2 with usage", () => {
  assert.equal(jstyle([]).status, 2);
  assert.equal(jstyle(["--nope", "x"]).status, 2);
  assert.match(jstyle(["--help"]).stdout, /jk-override/);
});
