import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HELP, computeGates, pageSlug, parseArgs, parseRobots, planRun, robotsAllows } from "../scripts/eval.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CLI = path.join(ROOT, "bin", "jstyle.mjs");

function jstyle(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
}

test("plan resolves paths against the first address and keeps the mode's page cap", () => {
  const plan = planRun(parseArgs(["example.com", "/pricing", "/pricing", "--mode", "quick", "--funnel", "pricing", "--out", "out"]));
  assert.deepEqual(plan.pages.map((p) => p.url), ["https://example.com/", "https://example.com/pricing"]);
  assert.deepEqual(plan.pages.map((p) => [p.slug, p.start, p.funnel]), [["home", true, false], ["pricing", false, true]]);
  assert.deepEqual(plan.widths, [1440, 375]);
  assert.deepEqual(plan.foldWidths, { desktop: 1440, mobile: 375 });
  assert.equal(plan.heightFor[375], 812);
  assert.equal(plan.heightFor[1440], 900);

  const many = Array.from({ length: 5 }, (_, i) => `/p${i}`);
  const capped = planRun(parseArgs(["https://example.com", ...many, "--mode", "quick"]));
  assert.equal(capped.pages.length, 3);
  assert.equal(capped.droppedOverCap.length, 3);
  assert.match(capped.out, /\.jstyle[\\/]eval-example-com-\d{4}-\d{2}-\d{2}$/);
});

test("site mode sweeps the standard widths widest first and emulates phones below 768", () => {
  const plan = planRun(parseArgs(["https://example.com"]));
  assert.deepEqual(plan.widths, [1920, 1440, 1280, 1024, 768, 375, 320]);
  assert.equal(plan.phoneBelow, 768);
  assert.equal(plan.keyboard, false);
  assert.equal(planRun(parseArgs(["https://example.com", "--keyboard"])).keyboard, true);
  assert.equal(plan.heightFor[768], 900);
  assert.equal(plan.heightFor[320], 812);
});

test("bad arguments fail with usage errors", () => {
  assert.throws(() => parseArgs(["--mode", "deep"]), /--mode/);
  assert.throws(() => parseArgs(["--widths", "100"]), /200~3840/);
  assert.throws(() => parseArgs(["--pace", "-1"]), /0 이상/);
  assert.throws(() => parseArgs(["--nope"]), /알 수 없는 선택지/);
  assert.throws(() => planRun(parseArgs([])), /주소를 하나 이상/);
  assert.throws(() => planRun(parseArgs(["/pricing"])), /기준이 될 전체 주소/);
  assert.throws(() => planRun(parseArgs(["ftp://example.com"])), /http·https/);
});

test("page slugs stay readable", () => {
  assert.equal(pageSlug("https://example.com/"), "home");
  assert.equal(pageSlug("https://example.com/Pricing/Team%20Plan"), "pricing-team-20plan");
  assert.equal(pageSlug("https://example.com/search?q=a"), "search-q-a");
});

test("robots rules follow the longest matching path for the star agent", () => {
  const rules = parseRobots("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/open\nDisallow: /*.pdf$\n");
  assert.equal(robotsAllows(rules, "/"), true);
  assert.equal(robotsAllows(rules, "/private/x"), false);
  assert.equal(robotsAllows(rules, "/private/open/page"), true);
  assert.equal(robotsAllows(rules, "/docs/a.pdf"), false);
  assert.equal(robotsAllows(rules, "/docs/a.pdf.html"), true);
  assert.equal(robotsAllows(parseRobots(""), "/anything"), true);
});

test("gates count each defect once and keep probes and third parties out", () => {
  const capture = (failures, consoleItems) => ({ failures, console: consoleItems, suppressed: { console: 1, network: 0 } });
  const shared = capture(
    [{ url: "https://a.com/api", status: 500, firstParty: true }, { url: "https://cdn.x.net/t.js", status: 503, firstParty: false }],
    [
      { level: "error", source: "console", text: "boom", firstParty: true },
      { level: "error", source: "network", text: "Failed to load resource", firstParty: true },
      { level: "error", source: "console", text: "ad", firstParty: false, url: "https://ads.example/x.js" },
      { level: "warning", source: "console", text: "deprecated", firstParty: true },
    ],
  );
  const page = (url, extra = {}) => ({
    url,
    opened: true,
    funnel: url.endsWith("/pricing"),
    placeholder: [],
    widths: {
      1440: { network: shared, layout: { horizontalPageScroll: 0, layoutViewportExpanded: 0, clippedByRootCount: 0, collapsedMain: [] } },
      375: { network: shared, layout: { horizontalPageScroll: 40, layoutViewportExpanded: 0, clippedByRootCount: 0, collapsedMain: [] } },
    },
    axe: {
      desktop: { violations: [{ id: "color-contrast", impact: "serious" }], counts: {} },
      mobile: { violations: [{ id: "color-contrast", impact: "serious" }, { id: "button-name", impact: "critical" }], counts: {} },
    },
    perf: { lcpMs: 3000, cls: 0.05, inpMs: null, inpStatus: "no interaction" },
    ...extra,
  });
  const { gates, noise } = computeGates([page("https://a.com/"), page("https://a.com/pricing", { placeholder: ["lorem ipsum"] }), { url: "https://a.com/x", opened: false }], null);
  assert.equal(gates.http5xx, 1);
  assert.equal(gates.consoleErrorsFirstParty, 1);
  assert.equal(gates.internalLinks4xx, null);
  assert.equal(gates.layoutBreaks, 2);
  assert.equal(gates.placeholder, 1);
  assert.equal(gates.axeSerious, 2);
  assert.equal(gates.axeCritical, 2);
  assert.deepEqual(gates.perfOverBudget, [{ path: "/pricing", metric: "lcpMs", value: 3000, budget: 2500, kind: "funnel" }]);
  assert.equal(noise.consoleWarnings, 1);
  assert.deepEqual(noise.thirdPartyErrors, { "ads.example": 1 });

  const withLinks = computeGates([], [{ url: "https://a.com/gone", status: 404 }, { url: "https://a.com/ok", status: 200 }, { url: "https://a.com/p", status: null, skipped: "robots" }]);
  assert.equal(withLinks.gates.internalLinks4xx, 1);
});

test("the command forwards to eval with help, dry runs and usage codes", () => {
  const help = jstyle(["--help"]);
  assert.match(help.stdout, /\n {2}eval /);
  const evalHelp = jstyle(["eval", "--help"]);
  assert.equal(evalHelp.status, 0);
  assert.equal(evalHelp.stdout, HELP);
  const dry = jstyle(["eval", "https://example.com", "/about", "--dry-run", "--mode", "quick"]);
  assert.equal(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.pages[1].url, "https://example.com/about");
  assert.equal(jstyle(["eval"]).status, 2);
  assert.equal(jstyle(["eval", "--mode", "x", "https://example.com"]).status, 2);
});

test("every eval script is one expression that returns JSON without top-level await", () => {
  const dir = path.join(ROOT, "scripts", "eval");
  const names = fs.readdirSync(dir).filter((name) => name.endsWith(".js")).sort();
  assert.deepEqual(names, ["axe-run.js", "fold-check.js", "form-audit.js", "layout-detect.js", "perf-capture.js", "style-audit.js"]);
  for (const name of names) {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    assert.doesNotThrow(() => new Function(`return ${source}`), name);
    assert.ok(!/^\s*await\b/m.test(source), `${name} uses top-level await`);
  }
});
