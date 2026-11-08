#!/usr/bin/env node
// Static style check: finds kit token overrides and values written outside the
// kit tokens, so style drift is caught by a command instead of by memory.
//
//     node scripts/check.mjs web/ --json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const KIT_CSS = path.join(ROOT, "assets", "kit", "kit.css");
const STYLE_EXT = new Set([".css", ".scss", ".less"]);
const MARKUP_EXT = new Set([".html", ".htm", ".vue", ".svelte", ".astro"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt", ".svelte-kit", "target", ".jstyle"]);
// The kit's own files define --jk-* tokens on purpose; checking them would report the kit itself.
const KIT_FILES = new Set(["kit.css", "decor.css", "doc.css"]);

const HELP = `usage: jstyle check <파일 또는 폴더...> [--json] [--strict] [--kit|--no-kit] [--exclude <경로 일부>]

스타일시트와 HTML·Vue·Svelte의 <style>에서 키트 규칙을 어긴 곳을 찾습니다.

오류
  jk-override    --jk-* 토큰을 다시 정의함. 테마는 data-jk-theme으로 고릅니다.
  raw-color      키트 토큰 대신 hex·rgb·hsl 색을 직접 씀
  raw-radius     6px 이상 모서리를 --jk-radius-* 대신 px로 씀
경고
  raw-font-size  키트가 쓰는 글자 크기 목록에 없는 px 값
  raw-font       font-family를 var(--jk-font) 대신 직접 씀
  own-token      제품 스타일시트에 직접 만든 색 토큰

키트를 쓰지 않는 프로젝트에서는 토큰 정의 밖에서 색을 직접 쓴 곳만 경고합니다.
검정·흰색 투명도(그림자, 배경 막), transparent, currentColor, var()의 대체값은 허용합니다.

  --json           결과를 JSON으로 출력
  --strict         경고가 있어도 실패(종료 코드 1)
  --kit, --no-kit  키트 사용 여부를 자동 판단 대신 지정
  --exclude <값>   경로에 이 값이 들어간 파일을 건너뜀. 여러 번 쓸 수 있습니다.

종료 코드: 0 통과, 1 오류 있음(--strict면 경고 포함), 2 잘못된 인수
`;

const COLOR_RE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^()]*\)/gi;
const RADIUS_PROPS = /^(?:border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius|border-radius)$/;

function parseArgs(argv) {
  const opts = { json: false, strict: false, kit: null, exclude: [], inputs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--strict") opts.strict = true;
    else if (arg === "--kit") opts.kit = true;
    else if (arg === "--no-kit") opts.kit = false;
    else if (arg === "--exclude") {
      if (i + 1 >= argv.length) throw new Error("--exclude에 값이 필요합니다");
      opts.exclude.push(argv[++i]);
    } else if (arg.startsWith("--exclude=")) opts.exclude.push(arg.slice(10));
    else if (arg.startsWith("-")) throw new Error(`알 수 없는 선택지입니다: ${arg}`);
    else opts.inputs.push(arg);
  }
  return opts;
}

function collectFiles(inputs, exclude) {
  const files = [];
  const wanted = (file) => (STYLE_EXT.has(path.extname(file).toLowerCase()) || MARKUP_EXT.has(path.extname(file).toLowerCase()))
    && !KIT_FILES.has(path.basename(file)) && !exclude.some((part) => file.includes(part));
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(full); }
      else if (entry.isFile() && wanted(full)) files.push(full);
    }
  };
  for (const input of inputs) {
    const stat = fs.statSync(input, { throwIfNoEntry: false });
    if (!stat) throw new Error(`파일이나 폴더가 없습니다: ${input}`);
    if (stat.isDirectory()) walk(input);
    else if (exclude.some((part) => input.includes(part))) continue;
    else files.push(input);
  }
  return [...new Set(files)].sort();
}

// Returns [{css, offset}] style regions; offsets keep line numbers true to the source file.
function styleRegions(file, text) {
  if (!MARKUP_EXT.has(path.extname(file).toLowerCase())) return [{ css: text, offset: 0 }];
  const regions = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  for (let m; (m = re.exec(text));) regions.push({ css: m[1], offset: m.index + m[0].indexOf(">") + 1 });
  return regions;
}

function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
}

// Walks a stylesheet and yields declarations with their selector stack.
// Handles nesting, strings, and ';' inside parentheses such as data: URLs.
export function declarations(source) {
  const css = blankComments(source);
  const out = [];
  const stack = [];
  let start = 0, depth = 0, quote = null;
  const flush = (end) => {
    const raw = css.slice(start, end);
    const colon = raw.indexOf(":");
    if (stack.length && colon > 0) {
      const lead = raw.length - raw.trimStart().length;
      const prop = raw.slice(0, colon).trim();
      if (/^(?:--|\$)?[-\w]+$/.test(prop)) out.push({ prop: prop.toLowerCase(), value: raw.slice(colon + 1).trim(), index: start + lead, selector: stack.at(-1) });
    } else if (!stack.length && colon > 0 && raw.trim().startsWith("$")) {
      const lead = raw.length - raw.trimStart().length;
      out.push({ prop: raw.slice(0, colon).trim(), value: raw.slice(colon + 1).trim(), index: start + lead, selector: "" });
    }
  };
  for (let i = 0; i < css.length; i += 1) {
    const c = css[i];
    if (quote) { if (c === "\\") i += 1; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth += 1;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth) continue;
    else if (c === "{") { stack.push(css.slice(start, i).trim()); start = i + 1; }
    else if (c === ";") { flush(i); start = i + 1; }
    else if (c === "}") { flush(i); stack.pop(); start = i + 1; }
  }
  return out;
}

const hexOf = (value) => {
  let h = value.toLowerCase().replace("#", "");
  if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join("");
  return h.length === 6 || h.length === 8 ? h : null;
};
const rgbOf = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));

export function loadKitTokens(file = KIT_CSS) {
  const colors = [], radius = [], text = [], sizes = new Set();
  for (const d of declarations(fs.readFileSync(file, "utf8"))) {
    // The kit writes component font sizes as px, so its used sizes are the scale products must stay on.
    const size = d.prop === "font-size" && /^(\d+(?:\.\d+)?)px$/.exec(d.value);
    if (size) sizes.add(+size[1]);
    if (d.selector !== ":root" || !d.prop.startsWith("--jk-")) continue;
    const name = d.prop;
    const hex = /^#[0-9a-f]{3,8}$/i.test(d.value) ? hexOf(d.value) : null;
    // Palette (--jk-p-*), chart (--jk-c1..8) and accent tokens are internal or decorative; suggest role tokens.
    if (hex && hex.length === 6 && !/^--jk-(?:p-|c\d|accent-|cta-)/.test(name)) colors.push({ name, hex });
    const px = /^(\d+(?:\.\d+)?)px$/.exec(d.value);
    if (px && name.startsWith("--jk-radius")) radius.push({ name, px: +px[1] });
    if (px && name.startsWith("--jk-text-")) { text.push({ name, px: +px[1] }); sizes.add(+px[1]); }
  }
  return { colors, radius, text, sizes: [...sizes].sort((a, b) => a - b) };
}

function nearestColor(hex, kit) {
  const [r, g, b] = rgbOf(hex);
  let best = null;
  for (const t of kit.colors) {
    const [r2, g2, b2] = rgbOf(t.hex);
    const d = Math.hypot(r - r2, g - g2, b - b2);
    if (!best || d < best.d) best = { ...t, d };
  }
  return best;
}
const nearestPx = (px, list) => list.reduce((best, t) => (!best || Math.abs(t.px - px) < Math.abs(best.px - px) ? t : best), null);

// Black or white with alpha (shadows, backdrops) is allowed by the kit guide; the kit has no token for it.
function isNeutralAlpha(color) {
  const hex = color.startsWith("#") ? hexOf(color) : null;
  if (hex) return /^(?:000000|ffffff)/.test(hex) && hex.length === 8;
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*[,/]\s*[\d.]+%?\s*\)$/i.exec(color);
  return !!m && ((m[1] === "0" && m[2] === "0" && m[3] === "0") || (m[1] === "255" && m[2] === "255" && m[3] === "255"));
}

// Colors inside var(--x, <fallback>) are fallbacks, not choices.
function stripVarFallbacks(value) {
  let out = value, prev;
  do { prev = out; out = out.replace(/var\(\s*--[\w-]+\s*,[^()]*(?:\([^()]*\)[^()]*)*\)/gi, "var()"); } while (out !== prev);
  return out;
}

export function checkSource(source, { kit, useKit, lineOf = null }) {
  const findings = [];
  const add = (d, level, rule, message, suggestion) => findings.push({ level, rule, index: d.index, prop: d.prop, value: d.value, message, ...(suggestion ? { suggestion } : {}) });
  for (const d of declarations(source)) {
    const isToken = d.prop.startsWith("--") || d.prop.startsWith("$");
    if (d.prop.startsWith("--jk-")) {
      if (useKit) add(d, "error", "jk-override", `키트 토큰 ${d.prop}를 다시 정의했습니다. 키트 페이지와 색·모양이 달라집니다.`, "이 줄을 지우고, 주색을 바꿔야 하면 data-jk-theme으로 테마를 고르세요.");
      continue;
    }
    const value = stripVarFallbacks(d.value);
    const colors = value.match(COLOR_RE) || [];
    for (const color of colors) {
      if (isNeutralAlpha(color)) continue;
      const hex = color.startsWith("#") ? hexOf(color) : null;
      if (isToken) {
        if (useKit) {
          const near = hex ? nearestColor(hex, kit) : null;
          add(d, "warn", "own-token", `제품에서 색 토큰 ${d.prop}를 직접 만들었습니다(${color}).`, near ? `키트 토큰을 쓰세요. 가장 가까운 값: var(${near.name}) ${"#" + near.hex}` : "키트 토큰을 쓰세요.");
        }
        continue;
      }
      if (!useKit) { add(d, "warn", "raw-color", `${d.prop}에 색 ${color}를 직접 썼습니다.`, "프로젝트의 색 토큰(CSS 변수)을 쓰세요."); continue; }
      const near = hex ? nearestColor(hex, kit) : null;
      const exact = near && near.d === 0 && hex.length === 6;
      add(d, "error", "raw-color", `${d.prop}에 색 ${color}를 직접 썼습니다.`, near ? `${exact ? "같은 값의 토큰" : "가장 가까운 키트 토큰"}: var(${near.name}) ${"#" + near.hex}` : "키트 색 토큰(--jk-*)을 쓰세요.");
    }
    if (!useKit || isToken) continue;
    if (RADIUS_PROPS.test(d.prop)) {
      for (const m of value.matchAll(/(\d+(?:\.\d+)?)px/g)) {
        const px = +m[1];
        if (px < 6) continue;
        const near = nearestPx(px, kit.radius);
        add(d, "error", "raw-radius", `${d.prop}에 ${px}px 모서리를 직접 썼습니다.`, near ? `var(${near.name}) (${near.px}px)` : "--jk-radius-* 토큰을 쓰세요.");
      }
    }
    if (d.prop === "font-size" || d.prop === "font") {
      const m = /(?:^|\s)(\d+(?:\.\d+)?)px\b/.exec(value);
      if (m && !kit.sizes.includes(+m[1])) {
        const near = kit.sizes.reduce((best, px) => (best === null || Math.abs(px - m[1]) < Math.abs(best - m[1]) ? px : best), null);
        add(d, "warn", "raw-font-size", `${d.prop}의 ${m[1]}px는 키트가 쓰는 글자 크기가 아닙니다.`, near !== null ? `가장 가까운 키트 크기: ${near}px` : undefined);
      }
    }
    if (d.prop === "font-family" && !/var\(--jk-font\)|^(?:inherit|initial|unset|revert)$/i.test(value) && !/mono|courier|consolas|menlo/i.test(value)) {
      add(d, "warn", "raw-font", `font-family를 직접 정했습니다: ${d.value.slice(0, 60)}`, "var(--jk-font)를 쓰세요. 코드용 고정폭 글꼴은 허용합니다.");
    }
  }
  return findings;
}

function lineCol(text, index) {
  let line = 1, last = -1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) { line += 1; last = i; }
  return { line, col: index - last };
}

function usesKit(files) {
  return files.some((file) => /kit\.css|var\(--jk-|--jk-[\w-]+\s*:|class=["'][^"']*\bjk-/.test(fs.readFileSync(file, "utf8")));
}

export function run(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) { stderr.write(`check: ${error.message}\n${HELP}`); return 2; }
  if (opts.help) { stdout.write(HELP); return 0; }
  if (!opts.inputs.length) { stderr.write(`check: 검사할 파일이나 폴더가 필요합니다.\n${HELP}`); return 2; }
  let files;
  try { files = collectFiles(opts.inputs, opts.exclude); } catch (error) { stderr.write(`check: ${error.message}\n`); return 2; }
  const useKit = opts.kit ?? usesKit(files);
  const kit = loadKitTokens();
  const results = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const region of styleRegions(file, text)) {
      for (const f of checkSource(region.css, { kit, useKit })) {
        const { line, col } = lineCol(text, region.offset + f.index);
        const { index, ...rest } = f;
        results.push({ file, line, col, ...rest });
      }
    }
  }
  const errors = results.filter((r) => r.level === "error").length;
  const warns = results.length - errors;
  if (opts.json) {
    stdout.write(JSON.stringify({ kit: useKit, files: files.length, errors, warnings: warns, findings: results }) + "\n");
  } else {
    for (const r of results) {
      stdout.write(`${r.file}:${r.line}:${r.col}  ${r.level === "error" ? "오류" : "경고"}  ${r.rule}  ${r.message}\n`);
      if (r.suggestion) stdout.write(`    → ${r.suggestion}\n`);
    }
    stdout.write(`${files.length}개 파일, 키트 ${useKit ? "사용" : "사용 안 함"}: 오류 ${errors}개, 경고 ${warns}개\n`);
  }
  return errors || (opts.strict && warns) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = run(process.argv.slice(2));
