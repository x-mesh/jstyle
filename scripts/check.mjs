#!/usr/bin/env node
// Static style check: finds kit token overrides, values written outside the kit
// tokens and jk classes the kit does not define, so style drift is caught by a
// command instead of by memory.
//
//     node scripts/check.mjs web/ --json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const KIT_DIR = path.join(ROOT, "assets", "kit");
const KIT_CSS = path.join(KIT_DIR, "kit.css");
const STYLE_EXT = new Set([".css", ".scss", ".less"]);
const MARKUP_EXT = new Set([".html", ".htm", ".vue", ".svelte", ".astro"]);
// Scripts are read for class names and kit use only; parsing them as CSS would report object literals as declarations.
const SCRIPT_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".nuxt", ".svelte-kit", "target", ".jstyle"]);
// The kit's own files define --jk-* tokens on purpose; checking them would report the kit itself.
const KIT_FILES = new Set(["kit.css", "decor.css", "doc.css"]);

const HELP = `usage: jstyle check <파일 또는 폴더...> [--json] [--strict] [--kit|--no-kit] [--tokens <파일>] [--exclude <경로 일부>]

스타일시트와 HTML·Vue·Svelte의 <style>에서 키트 규칙을 어긴 곳을 찾고,
마크업의 style 속성도 같은 규칙으로 읽고, 마크업과 js·jsx·ts·tsx의 class·className·classList에서 키트에 없는 jk- 클래스를 찾습니다.
스타일만 있는 폴더가 아니라 마크업과 스크립트가 함께 있는 폴더를 줍니다.

오류
  jk-override    --jk-* 토큰을 다시 정의함. 테마는 data-jk-theme으로 고릅니다.
  raw-color      키트 토큰 대신 hex·rgb·hsl 색을 직접 씀
  raw-radius     6px 이상 모서리를 --jk-radius-* 대신 px·rem으로 씀
  unknown-class  키트와 검사한 스타일시트 어디에도 없는 jk- 클래스. jk-btn-\${size}처럼 조합한 이름은 맞는 클래스가 하나도 없을 때 잡습니다.
  missing-in-copy  설치된 키트에는 있지만 검사 폴더의 키트 사본에는 없는 jk- 클래스나 --jk- 토큰. decor.css 사본이 읽는 토큰을 kit.css 사본이 정하지 않은 경우도 여기에 나옵니다.
  unknown-token  키트 어디에도 없는 --jk- 토큰을 var()로 읽음
경고
  raw-font-size  키트가 쓰는 글자 크기 목록에 없는 px·rem 값
  raw-font       font-family를 var(--jk-font) 대신 직접 씀
  own-token      제품 스타일시트에 직접 만든 색 토큰
  raw-spacing    안쪽·바깥 여백과 gap에 간격 척도(--jk-space-*, 2~48px)에 없는 값을 씀. 48px보다 큰 값과 음수, calc()는 보지 않습니다.
  kit-restyle    제품 스타일시트가 키트 클래스의 높이·안쪽 여백·글자·색·테두리·그림자를 바꿈. 너비와 바깥 여백 같은 배치는 보지 않습니다.
  copy-differs   검사 폴더의 키트 사본에서 --jk- 토큰 값이 설치된 키트와 다름
같은 규칙의 경고는 다섯 건까지 적고 나머지는 개수로 적습니다. 전체는 --json에 있습니다.

키트 사용은 검사 폴더의 kit.css 사본, --jk- 토큰, jk- 클래스로 판단하고 근거를 요약 줄에 적습니다.
키트를 쓰지 않는 프로젝트에서는 토큰 정의 밖에서 색을 직접 쓴 곳만 경고합니다.
--tokens로 프로젝트의 토큰 파일을 주면 그 파일의 색·모서리·글자 크기 토큰을 기준으로 삼아, 직접 쓴 색과 모서리를 오류로 봅니다.
style 속성에서는 --로 시작하는 값(컴포넌트가 읽는 자리)과 키트 페이지가 인라인으로 쓰는 값을 허용합니다.
키트를 쓰는 저장소의 지침 파일·Makefile·package.json·pre-commit·CI에 jstyle check가 없으면 알림을 적습니다.
검정·흰색 투명도(그림자, 배경 막), transparent, currentColor, var()의 대체값은 허용합니다.

  --json           결과를 JSON으로 출력
  --strict         경고가 있어도 실패(종료 코드 1)
  --kit, --no-kit  키트 사용 여부를 자동 판단 대신 지정
  --tokens <파일>  키트를 쓰지 않는 프로젝트의 토큰 파일(CSS 변수). 여러 번 쓸 수 있습니다. 색은 hex 값만 읽습니다.
  --exclude <값>   경로에 이 값이 들어간 파일을 건너뜀. 여러 번 쓸 수 있습니다. 키트 사본은 건너뛰어도 키트 사용의 근거로 봅니다.

종료 코드: 0 통과, 1 오류 있음(--strict면 경고 포함), 2 잘못된 인수
`;

const COLOR_RE = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^()]*\)/gi;
const RADIUS_PROPS = /^(?:border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius|border-radius)$/;

function parseArgs(argv) {
  const opts = { json: false, strict: false, kit: null, exclude: [], tokens: [], inputs: [] };
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
    else if (arg === "--tokens") {
      if (i + 1 >= argv.length) throw new Error("--tokens에 파일이 필요합니다");
      opts.tokens.push(argv[++i]);
    } else if (arg.startsWith("--tokens=")) opts.tokens.push(arg.slice(9));
    else if (arg.startsWith("-")) throw new Error(`알 수 없는 선택지입니다: ${arg}`);
    else opts.inputs.push(arg);
  }
  return opts;
}

// files are checked as styles, scripts only for class names, kitCopies only as proof and as a class list.
function collectFiles(inputs, exclude) {
  const files = [], scripts = [], kitCopies = [];
  const ext = (file) => path.extname(file).toLowerCase();
  const excluded = (file) => exclude.some((part) => file.includes(part));
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(full); }
      else if (!entry.isFile()) continue;
      // Before --exclude: the documented "--exclude vendor" would otherwise hide the copy in vendor/.
      else if (KIT_FILES.has(entry.name)) kitCopies.push(full);
      else if (excluded(full)) continue;
      else if (SCRIPT_EXT.has(ext(full))) scripts.push(full);
      else if (STYLE_EXT.has(ext(full)) || MARKUP_EXT.has(ext(full))) files.push(full);
    }
  };
  for (const input of inputs) {
    const stat = fs.statSync(input, { throwIfNoEntry: false });
    if (!stat) throw new Error(`파일이나 폴더가 없습니다: ${input}`);
    if (stat.isDirectory()) walk(input);
    else if (excluded(input)) continue;
    else (SCRIPT_EXT.has(ext(input)) ? scripts : files).push(input);
  }
  const unique = (list) => [...new Set(list)].sort();
  return { files: unique(files), scripts: unique(scripts), kitCopies: unique(kitCopies) };
}

// Returns [{css, offset}] style regions; offsets keep line numbers true to the source file.
function styleRegions(file, text) {
  if (!MARKUP_EXT.has(path.extname(file).toLowerCase())) return [{ css: text, offset: 0 }];
  const regions = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  for (let m; (m = re.exec(text));) regions.push({ css: m[1], offset: m.index + m[0].indexOf(">") + 1 });
  // Drawings carry their own colors; the screen check leaves svg out for the same reason.
  const drawings = [...text.matchAll(/<svg\b[\s\S]*?<\/svg>/gi)].map((m) => [m.index, m.index + m[0].length]);
  for (const m of text.matchAll(INLINE_STYLE)) {
    if (drawings.some(([from, to]) => m.index > from && m.index < to)) continue;
    const value = m[1] ?? m[2];
    // A binding or template expression is not a declaration list.
    if (/[{}$]/.test(value)) continue;
    regions.push({ css: `*{${value}}`, offset: m.index + m[0].length - 1 - value.length - 2, inline: true });
  }
  return regions;
}

export const tokenNames = (css) => new Set(css.match(/--jk-[\w-]+/g) ?? []);
const declaredTokens = (css) => new Set(declarations(css).filter((d) => d.prop.startsWith("--jk-")).map((d) => d.prop));
const TOKEN_READ = /var\(\s*(--jk-[\w-]+)\s*\)/g;
const INLINE_STYLE = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const inlineKey = (prop, value) => `${prop}:${value.replace(/\s+/g, " ").trim().toLowerCase()}`;

function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'\\])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
}

// <!-- --> in markup, blanked to the same length so offsets hold. A script or style element is stepped over
// whole, so "<!--" inside a script string does not open a comment.
// The lookahead keeps a custom element such as <script-panel> from passing for a script element.
const MARKUP_COMMENT = /<(script|style)(?=[\s>/])[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi;
const blankMarkupComments = (text) => text.replace(MARKUP_COMMENT, (part) => (part.startsWith("<!--") ? part.replace(/[^\n]/g, " ") : part));

// The text that class names and style attributes are read from.
// Script comments stay in: without parsing JavaScript a comment cannot be told from a string or a regex
// that holds // or /*, and blanking the wrong one hides real class names. A class written in a script
// comment is therefore read like code, which reports more and never passes a kit project as one without the kit.
function withoutComments(file, text) {
  return MARKUP_EXT.has(path.extname(file).toLowerCase()) ? blankMarkupComments(text) : text;
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

// rem is read against the browser default; the kit does not set a root font size.
const ROOT_FONT_PX = 16;
const toPx = (number, unit) => Math.round((unit === "rem" ? +number * ROOT_FONT_PX : +number) * 100) / 100;
const written = (number, unit) => (unit === "rem" ? `${number}rem(${toPx(number, unit)}px)` : `${number}px`);
// Properties that make a component look the way it does. Width, margin and position place it and stay out.
const LOOK_PROPS = /^(?:(?:min-|max-)?height$|padding(?:-|$)|font(?:-|$)|line-height$|letter-spacing$|color$|background(?:-|$)|border(?:-|$)|box-shadow$|outline(?:-|$)|opacity$)/;

// The kit class that a rule styles: one in the last compound of any selector in the list.
function kitSubject(selector, classes) {
  for (const part of selector.split(",")) {
    const subject = part.trim().split(/[\s>+~]+/).pop();
    for (const m of subject.matchAll(/\.(jk-[a-z0-9-]+)/g)) if (classes.has(m[1])) return m[1];
  }
  return null;
}

const SPACING_PROPS = /^(?:padding|margin)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?$|^(?:row-|column-)?gap$/;
// Below this a length is a hairline nudge, not a step of the scale.
const SMALLEST_SPACING_PX = 2;

// Positive lengths written bare: not negative and not inside calc() or another function.
function bareLengths(value) {
  let flat = value, before;
  do { before = flat; flat = flat.replace(/\([^()]*\)/g, ""); } while (flat !== before);
  return [...flat.matchAll(/(?<![\w.-])(\d*\.?\d+)(px|rem)\b/g)].map((m) => ({ px: toPx(m[1], m[2]), text: written(m[1], m[2]) }));
}

const hexOf = (value) => {
  let h = value.toLowerCase().replace("#", "");
  if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join("");
  return h.length === 6 || h.length === 8 ? h : null;
};
const rgbOf = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));

export function loadKitTokens(file = KIT_CSS) {
  const colors = [], radius = [], text = [], space = [], sizes = new Set();
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
    if (px && name.startsWith("--jk-space-")) space.push({ name, px: +px[1] });
  }
  // The page that products copy markup from: a style attribute written there is the kit's own value.
  const inline = new Set();
  for (const m of kitFile("index.html").matchAll(INLINE_STYLE)) for (const d of declarations(`*{${m[1] ?? m[2]}}`)) inline.add(inlineKey(d.prop, d.value));
  const classes = new Set(["kit.css", "decor.css"].flatMap((name) => selectorClasses(kitFile(name))));
  // Every --jk- name the kit writes or reads, with the file to copy it from. Slots such as --jk-hue are only read.
  const tokens = new Map();
  for (const name of ["kit.css", "decor.css", "kit.js"]) for (const token of tokenNames(kitFile(name))) if (!tokens.has(token)) tokens.set(token, name);
  // The names the kit sets a value for. A slot that markup fills (--jk-hue) is read but never set.
  const declared = new Map();
  for (const name of ["kit.css", "decor.css"]) for (const token of declaredTokens(kitFile(name))) if (!declared.has(token)) declared.set(token, name);
  return { colors, radius, text, space, sizes: [...sizes].sort((a, b) => a - b), classes, inline, tokens, declared };
}

// The tokens of a project without the kit, from the files it names. Only hex colors are read.
export function loadProjectTokens(files) {
  const colors = [], radius = [], space = [], sizes = new Set();
  for (const file of files) {
    for (const d of declarations(fs.readFileSync(file, "utf8"))) {
      if (!d.prop.startsWith("--")) continue;
      const hex = /^#[0-9a-f]{3,8}$/i.test(d.value) ? hexOf(d.value) : null;
      if (hex && hex.length === 6) colors.push({ name: d.prop, hex });
      const length = /^(\d*\.?\d+)(px|rem)$/.exec(d.value);
      if (length && /radius/.test(d.prop)) radius.push({ name: d.prop, px: toPx(length[1], length[2]) });
      if (length && /font-size|text/.test(d.prop)) sizes.add(toPx(length[1], length[2]));
      if (length && /spac/.test(d.prop)) space.push({ name: d.prop, px: toPx(length[1], length[2]) });
    }
  }
  return { colors, radius, text: [], space, sizes: [...sizes].sort((a, b) => a - b), classes: new Set(), inline: new Set() };
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

// useKit: hold values to the kit. tokens: hold them to the project's own token set, passed as kit.
// inline: source is one style attribute. copyDeclared: the --jk- names the project's kit copies set, when it has a copy.
export function checkSource(source, { kit, useKit, tokens = false, inline = false, copyDeclared = null }) {
  const scaled = useKit || tokens;
  const tokenWord = useKit ? "키트 토큰" : "토큰";
  const findings = [];
  const add = (d, level, rule, message, suggestion) => findings.push({ level, rule, index: d.index, prop: d.prop, value: d.value, message, ...(suggestion ? { suggestion } : {}) });
  for (const d of declarations(source)) {
    const isToken = d.prop.startsWith("--") || d.prop.startsWith("$");
    // In a style attribute a custom property fills a slot the component reads (--jk-hue, --value).
    if (inline && (isToken || kit.inline.has(inlineKey(d.prop, d.value)))) continue;
    // A reference without a fallback to a token nothing defines resolves to nothing: padding becomes 0, color is inherited.
    if (useKit) for (const m of d.value.matchAll(TOKEN_READ)) {
      const name = m[1], file = kit.declared.get(name);
      if (!kit.tokens.has(name) && !copyDeclared?.has(name)) {
        let near = null;
        for (const known of kit.tokens.keys()) { const distance = editDistance(name, known); if (distance <= TYPO_DISTANCE && (!near || distance < near.distance)) near = { known, distance }; }
        add(d, "error", "unknown-token", `키트에 없는 토큰 ${name}입니다.`, near ? `가장 가까운 키트 토큰: ${near.known}` : "키트 페이지(jstyle kit)의 기초 구역에서 이름을 확인하세요.");
      } else if (file && copyDeclared && !copyDeclared.has(name)) {
        add(d, "error", "missing-in-copy", `토큰 ${name}: 설치된 키트의 ${file}에는 있지만 프로젝트의 키트 사본에는 없습니다.`, `설치된 키트의 ${file} 파일을 프로젝트로 다시 복사하세요.`);
      }
    }
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
      if (!scaled) { add(d, "warn", "raw-color", `${d.prop}에 색 ${color}를 직접 썼습니다.`, "프로젝트의 색 토큰(CSS 변수)을 쓰세요."); continue; }
      const near = hex ? nearestColor(hex, kit) : null;
      const exact = near && near.d === 0 && hex.length === 6;
      add(d, "error", "raw-color", `${d.prop}에 색 ${color}를 직접 썼습니다.`, near ? `${exact ? "같은 값의 토큰" : `가장 가까운 ${tokenWord}`}: var(${near.name}) ${"#" + near.hex}` : useKit ? "키트 색 토큰(--jk-*)을 쓰세요." : "프로젝트의 색 토큰을 쓰세요.");
    }
    if (!scaled || isToken) continue;
    if (kit.radius.length && RADIUS_PROPS.test(d.prop)) {
      for (const m of value.matchAll(/(?<![\w.-])(\d*\.?\d+)(px|rem)\b/g)) {
        const px = toPx(m[1], m[2]);
        if (px < 6) continue;
        const near = nearestPx(px, kit.radius);
        add(d, "error", "raw-radius", `${d.prop}에 ${written(m[1], m[2])} 모서리를 직접 썼습니다.`, `var(${near.name}) (${near.px}px)`);
      }
    }
    if (kit.sizes.length && (d.prop === "font-size" || d.prop === "font")) {
      const m = /(?:^|\s)(\d*\.?\d+)(px|rem)\b/.exec(value);
      const px = m ? toPx(m[1], m[2]) : null;
      if (m && !kit.sizes.includes(px)) {
        const near = kit.sizes.reduce((best, size) => (best === null || Math.abs(size - px) < Math.abs(best - px) ? size : best), null);
        add(d, "warn", "raw-font-size", `${d.prop}의 ${written(m[1], m[2])}는 ${useKit ? "키트가 쓰는" : "토큰에 있는"} 글자 크기가 아닙니다.`, `가장 가까운 ${useKit ? "키트 " : ""}크기: ${near}px`);
      }
    }
    if (kit.space.length && SPACING_PROPS.test(d.prop)) {
      const largest = Math.max(...kit.space.map((t) => t.px));
      const off = bareLengths(value).filter((length) => length.px >= SMALLEST_SPACING_PX && length.px <= largest && !kit.space.some((t) => t.px === length.px));
      if (off.length) {
        const near = nearestPx(off[0].px, kit.space);
        add(d, "warn", "raw-spacing", `${d.prop}의 ${[...new Set(off.map((length) => length.text))].join(", ")}는 ${useKit ? "키트 " : ""}간격 척도에 없습니다.`, `가장 가까운 간격: var(${near.name}) (${near.px}px)`);
      }
    }
    if (!useKit) continue;
    const subject = inline ? null : kitSubject(d.selector, kit.classes);
    if (subject && LOOK_PROPS.test(d.prop)) add(d, "warn", "kit-restyle", `제품 스타일시트가 키트 클래스 .${subject}의 모양을 바꿉니다(${d.prop}).`, "키트 페이지에서 맞는 크기·모양 변형을 먼저 찾고, 없으면 제품 클래스를 따로 만드세요.");
    if (d.prop === "font-family" && !/var\(--jk-font\)|^(?:inherit|initial|unset|revert)$/i.test(value) && !/mono|courier|consolas|menlo/i.test(value)) {
      add(d, "warn", "raw-font", `font-family를 직접 정했습니다: ${d.value.slice(0, 60)}`, "var(--jk-font)를 쓰세요. 코드용 고정폭 글꼴은 허용합니다.");
    }
  }
  return findings;
}

const JK_NAME = "jk-[a-z0-9]+(?:-[a-z0-9]+)*";
const WHOLE_NAME = new RegExp(`^${JK_NAME}$`);
// A quoted class value. ${…} may hold quotes of its own: class="jk-tag ${on ? "jk-on" : ""}".
const CLASS_VALUE = /\bclass(?:Name)?\s*=\s*(?:"((?:[^"$]|\$\{[^{}]*\}|\$)*)"|'((?:[^'$]|\$\{[^{}]*\}|\$)*)')/g;
// Where class names are passed as an expression: className={…}, classList calls and the usual class helpers.
const CLASS_EXPRESSION = /\bclass(?:Name)?\s*=\s*\{|\bclassList\.(?:add|remove|toggle|contains|replace)\s*\(|\b(?:clsx|classNames|classnames|cn|cx)\s*\(/g;
// A span longer than this is a bracket that paired with unrelated code, not one class expression.
const MAX_EXPRESSION = 2000;
const INTERPOLATION = /\$\{[^{}]*\}/g;
const HOLE = "\u0001";
const WRAPPING = "[\"'`,:;()\\[\\]{}?]*";
const LEADING = new RegExp(`^${WRAPPING}`);
const TRAILING = new RegExp(`${WRAPPING}$`);
const NAME_WITH_HOLES = new RegExp(`^jk-[a-z0-9${HOLE}-]*$`);

// Index of the bracket that closes text[open], or -1 when the span does not balance.
function closingIndex(text, open) {
  const opener = text[open], closer = opener === "{" ? "}" : ")";
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i += 1; i < text.length && text[i] !== c; i += 1) if (text[i] === "\\") i += 1;
    } else if (c === opener) depth += 1;
    else if (c === closer && (depth -= 1) === 0) return i;
  }
  return -1;
}

function stringLiterals(text, from, to) {
  const found = [];
  for (let i = from; i < to; i += 1) {
    const quote = text[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    let end = i + 1;
    for (; end < to && text[end] !== quote; end += 1) if (text[end] === "\\") end += 1;
    found.push({ value: text.slice(i + 1, end), index: i + 1 });
    i = end;
  }
  return found;
}

// jk class names in class and className values, classList calls, class helpers and Vue bindings.
// A name joined to an interpolation (jk-btn-${size}) comes back with `pattern`, the name with holes.
export function classUses(text) {
  const uses = new Map();
  const take = (value, at) => {
    for (const hole of value.matchAll(INTERPOLATION)) for (const inner of stringLiterals(hole[0], 0, hole[0].length)) take(inner.value, at + hole.index + inner.index);
    const flat = value.replace(INTERPOLATION, (hole) => HOLE.repeat(hole.length));
    for (const m of flat.matchAll(/\S+/g)) {
      const start = m.index + m[0].match(LEADING)[0].length;
      const token = flat.slice(start, m.index + m[0].length).replace(TRAILING, "");
      if (WHOLE_NAME.test(token)) uses.set(at + start, { name: token, index: at + start });
      else if (token.includes(HOLE) && NAME_WITH_HOLES.test(token)) uses.set(at + start, { name: value.slice(start, start + token.length), pattern: token, index: at + start });
    }
  };
  for (const m of text.matchAll(CLASS_VALUE)) {
    const value = m[1] ?? m[2];
    take(value, m.index + m[0].length - 1 - value.length);
  }
  for (const m of text.matchAll(CLASS_EXPRESSION)) {
    const open = m.index + m[0].length - 1;
    const close = closingIndex(text, open);
    if (close < 0 || close - open > MAX_EXPRESSION) continue;
    for (const literal of stringLiterals(text, open + 1, close)) take(literal.value, literal.index);
  }
  return [...uses.values()].sort((a, b) => a.index - b.index);
}

const selectorClasses = (css) => [...css.matchAll(new RegExp(`\\.(${JK_NAME})`, "g"))].map((m) => m[1]);
const kitFile = (name) => fs.readFileSync(path.join(KIT_DIR, name), "utf8");

// installed: class → the installed kit file that defines it. project: classes the project's kit copy and
// its own stylesheets define; the copy can be older than the installed kit, and a jk class with a
// product rule is styled. hasCopy: a kit copy sits under the inputs, so what it lacks is unstyled there.
export function classIndex(projectCss = [], hasCopy = false) {
  const installed = new Map();
  for (const name of ["kit.css", "decor.css"]) for (const c of selectorClasses(kitFile(name))) if (!installed.has(c)) installed.set(c, name);
  // kit.js sets state classes that no stylesheet names (jk-fx-entry-complete).
  for (const m of kitFile("kit.js").matchAll(new RegExp(`(?<![\\w-])${JK_NAME}`, "g"))) if (!installed.has(m[0])) installed.set(m[0], "kit.js");
  const project = new Set(projectCss.flatMap(selectorClasses));
  return { installed, project, hasCopy, known: [...new Set([...installed.keys(), ...project])] };
}

function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

const TYPO_DISTANCE = 2;

export function checkClasses(text, { installed, project, hasCopy, known }) {
  const LOOK_UP = "키트 페이지(jstyle kit)에서 이름을 확인하세요.";
  const findings = [];
  const add = (use, rule, message, suggestion) => findings.push({ level: "error", rule, index: use.index, prop: "class", value: use.name, message, suggestion });
  for (const use of classUses(text)) {
    if (use.pattern) {
      const shape = new RegExp(`^${use.pattern.replace(new RegExp(`${HOLE}+`, "g"), "[a-z0-9-]*")}$`);
      if (!known.some((name) => shape.test(name))) add(use, "unknown-class", `조합한 이름 ${use.name}에 맞는 클래스가 키트와 검사한 스타일시트에 없습니다.`, LOOK_UP);
    } else if (!installed.has(use.name) && !project.has(use.name)) {
      let near = null;
      for (const name of known) { const d = editDistance(use.name, name); if (d <= TYPO_DISTANCE && (!near || d < near.d)) near = { name, d }; }
      add(use, "unknown-class", `키트와 검사한 스타일시트에 없는 클래스 ${use.name}입니다.`, near ? `가장 가까운 키트 클래스: ${near.name}` : LOOK_UP);
    } else if (hasCopy && !project.has(use.name) && installed.get(use.name) !== "kit.js") {
      const file = installed.get(use.name);
      add(use, "missing-in-copy", `클래스 ${use.name}: 설치된 키트의 ${file}에는 있지만 프로젝트의 키트 사본에는 없습니다.`, `설치된 키트의 ${file} 파일을 프로젝트로 다시 복사하세요.`);
    }
  }
  return findings;
}

function lineCol(text, index) {
  let line = 1, last = -1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) { line += 1; last = i; }
  return { line, col: index - last };
}

// "kit.css" is anchored so that uikit.css or toolkit.css does not turn warnings into errors.
const STYLE_SIGN = /(?<![\w-])kit\.css\b|var\(--jk-|--jk-[\w-]+\s*:/;
const SCRIPT_SIGN = /(?:import|require)\b[^\n;]*(?<![\w-])kit\.css\b/;

// Returns the file that shows the kit in use, or null.
function kitBasis({ files, scripts, kitCopies }, read, scan) {
  return kitCopies.find((file) => path.basename(file) === "kit.css" && /--jk-/.test(read(file)))
    // The same reader the class rule uses, so a class inside clsx() or a condition counts as kit use too.
    ?? files.find((file) => STYLE_SIGN.test(read(file)) || classUses(scan(file)).length > 0)
    ?? scripts.find((file) => SCRIPT_SIGN.test(read(file)) || classUses(scan(file)).length > 0)
    ?? null;
}

const WIRING_FILES = ["AGENTS.md", "CLAUDE.md", "Makefile", "justfile", "package.json", ".pre-commit-config.yaml", "lefthook.yml", path.join(".husky", "pre-commit")];
// Also "node …/jstyle.mjs check", a make variable such as "$(JSTYLE) check" and the CI form "npx github:x-mesh/jstyle#v1.2.3 check".
const WIRED = /jstyle(?:\.mjs)?(?:#[\w.-]+)?["')}]*\s+check\b/i;

// The nearest folder with .git, or the working folder when it holds the input (a project without git).
function repoRoot(input) {
  const start = path.resolve(input);
  for (let dir = start; ;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const rel = path.relative(process.cwd(), start);
  return rel.startsWith("..") || path.isAbsolute(rel) ? null : process.cwd();
}

// true or false: the project's own commands and instruction files name this check. null: no project root to look in.
function wiring(input) {
  const root = repoRoot(input);
  if (!root) return { root: null, wired: null };
  const workflows = path.join(root, ".github", "workflows");
  const candidates = [...WIRING_FILES.map((name) => path.join(root, name)),
    ...(fs.existsSync(workflows) ? fs.readdirSync(workflows).filter((name) => /\.ya?ml$/.test(name)).map((name) => path.join(workflows, name)) : [])];
  const wired = candidates.some((file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() && WIRED.test(fs.readFileSync(file, "utf8")));
  return { root, wired };
}

// Keeps one long-standing habit (hand-set spacing, kit overrides) from burying the error count in the text report.
const WARNINGS_SHOWN = 5;

const tokenValues = (css) => new Map(declarations(css).filter((d) => d.prop.startsWith("--jk-")).map((d) => [`${d.selector} ${d.prop}`, d]));
const sameValue = (a, b) => a.replace(/\s+/g, " ").toLowerCase() === b.replace(/\s+/g, " ").toLowerCase();

// One finding for a kit copy whose token values are not the installed kit's: an older copy or one edited in place.
function copyDiffers(file, text) {
  if (!["kit.css", "decor.css"].includes(path.basename(file))) return null;
  const installed = tokenValues(kitFile(path.basename(file)));
  const changed = [...tokenValues(text)].filter(([key, d]) => installed.has(key) && !sameValue(installed.get(key).value, d.value)).map(([, d]) => d);
  if (!changed.length) return null;
  const names = [...new Set(changed.map((d) => d.prop))];
  return { level: "warn", rule: "copy-differs", index: changed[0].index, prop: changed[0].prop, value: changed[0].value,
    message: `키트 사본의 토큰 값 ${names.length}개가 설치된 키트와 다릅니다: ${names.slice(0, 5).join(", ")}${names.length > 5 ? " 등" : ""}`,
    suggestion: "버전이 다른 사본이면 새로 복사하고, 직접 고친 값이면 되돌린 뒤 data-jk-theme으로 테마를 고르세요." };
}

// One finding for a kit copy that reads tokens no copy in the project sets: a new decor.css beside an older kit.css.
function copyUnpaired(file, text, kit, copyDeclared) {
  if (!["kit.css", "decor.css"].includes(path.basename(file))) return null;
  const unset = declarations(text).flatMap((d) => [...d.value.matchAll(TOKEN_READ)].filter((m) => kit.declared.has(m[1]) && !copyDeclared.has(m[1])).map((m) => ({ name: m[1], d })));
  if (!unset.length) return null;
  const names = [...new Set(unset.map((item) => item.name))];
  return { level: "error", rule: "missing-in-copy", index: unset[0].d.index, prop: unset[0].d.prop, value: unset[0].d.value,
    message: `이 키트 사본이 읽는 토큰 ${names.length}개를 프로젝트의 어느 키트 사본도 정하지 않습니다: ${names.slice(0, 5).join(", ")}${names.length > 5 ? " 등" : ""}`,
    suggestion: "kit.css와 decor.css를 같은 버전으로 함께 다시 복사하세요." };
}

export function run(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) { stderr.write(`check: ${error.message}\n${HELP}`); return 2; }
  if (opts.help) { stdout.write(HELP); return 0; }
  if (!opts.inputs.length) { stderr.write(`check: 검사할 파일이나 폴더가 필요합니다.\n${HELP}`); return 2; }
  let found;
  try { found = collectFiles(opts.inputs, opts.exclude); } catch (error) { stderr.write(`check: ${error.message}\n`); return 2; }
  const { files, scripts, kitCopies } = found;
  const texts = new Map();
  const read = (file) => { if (!texts.has(file)) texts.set(file, fs.readFileSync(file, "utf8")); return texts.get(file); };
  const scans = new Map();
  const scan = (file) => { if (!scans.has(file)) scans.set(file, withoutComments(file, read(file))); return scans.get(file); };
  const basis = opts.kit === null ? kitBasis(found, read, scan) : null;
  const useKit = opts.kit ?? basis !== null;
  let kit = loadKitTokens();
  const ownTokens = opts.tokens.length > 0 && !useKit;
  if (opts.tokens.length && useKit) stderr.write("check: 키트를 쓰는 프로젝트라 --tokens는 쓰지 않고 키트 토큰을 기준으로 봅니다.\n");
  if (ownTokens) {
    try { kit = loadProjectTokens(opts.tokens); } catch (error) { stderr.write(`check: 토큰 파일을 읽지 못했습니다: ${error.message}\n`); return 2; }
    if (!kit.colors.length) { stderr.write(`check: ${opts.tokens.join(", ")}에서 hex 색 토큰(--이름: #값)을 찾지 못했습니다. hsl()·oklch() 값은 읽지 않습니다.\n`); return 2; }
  }
  const styled = new Set(files);
  const hasCopy = kitCopies.some((file) => path.basename(file) === "kit.css" && /--jk-/.test(read(file)));
  const copyDeclared = hasCopy ? new Set(kitCopies.flatMap((file) => [...declaredTokens(read(file))])) : null;
  const classes = useKit ? classIndex([...kitCopies.map(read), ...files.flatMap((file) => styleRegions(file, scan(file)).map((region) => region.css))], hasCopy) : null;
  const results = [];
  for (const file of [...files, ...scripts].sort()) {
    const text = read(file);
    const inFile = [];
    if (styled.has(file)) for (const region of styleRegions(file, scan(file))) for (const f of checkSource(region.css, { kit, useKit, tokens: ownTokens, inline: region.inline, copyDeclared })) inFile.push({ ...f, index: region.offset + f.index });
    if (useKit && (!styled.has(file) || MARKUP_EXT.has(path.extname(file).toLowerCase()))) inFile.push(...checkClasses(scan(file), classes));
    for (const { index, ...rest } of inFile.sort((a, b) => a.index - b.index)) results.push({ file, ...lineCol(text, index), ...rest });
  }
  if (useKit) {
    for (const file of kitCopies) {
      for (const finding of [copyDiffers(file, read(file)), copyDeclared && copyUnpaired(file, read(file), kit, copyDeclared)]) {
        if (!finding) continue;
        const { index, ...rest } = finding;
        results.push({ file, ...lineCol(read(file), index), ...rest });
      }
    }
  }
  const errors = results.filter((r) => r.level === "error").length;
  const warns = results.length - errors;
  const readCount = files.length + scripts.length;
  const { root, wired } = useKit ? wiring(opts.inputs[0]) : { root: null, wired: null };
  if (opts.json) {
    stdout.write(JSON.stringify({ kit: useKit, kitBasis: basis, wired, files: readCount, errors, warnings: warns, findings: results }) + "\n");
  } else {
    const warned = new Map();
    for (const r of results) {
      if (r.level === "warn") {
        warned.set(r.rule, (warned.get(r.rule) ?? 0) + 1);
        if (warned.get(r.rule) > WARNINGS_SHOWN) continue;
      }
      stdout.write(`${r.file}:${r.line}:${r.col}  ${r.level === "error" ? "오류" : "경고"}  ${r.rule}  ${r.message}\n`);
      if (r.suggestion) stdout.write(`    → ${r.suggestion}\n`);
    }
    for (const [rule, count] of warned) if (count > WARNINGS_SHOWN) stdout.write(`경고 ${rule}: ${count - WARNINGS_SHOWN}건 더 있습니다. 전체는 --json으로 봅니다.\n`);
    const why = opts.kit !== null ? "" : basis ? `(근거: ${basis})` : ownTokens ? `(토큰 기준: ${opts.tokens.join(", ")})` : "(kit.css 사본과 jk- 클래스·토큰을 찾지 못함. 키트를 쓴다면 마크업·스크립트 폴더를 함께 주거나 --kit)";
    stdout.write(`${readCount}개 파일, 키트 ${useKit ? "사용" : "사용 안 함"}${why}: 오류 ${errors}개, 경고 ${warns}개\n`);
    if (wired === false) {
      stdout.write(`알림: ${root}의 지침 파일·Makefile·package.json·pre-commit·CI에서 jstyle check를 찾지 못했습니다. 이 검사를 실행하지 않는 세션이 고친 스타일은 걸러지지 않습니다.\n`);
      // Relative to the root: the line is pasted into a shared Makefile, where a typed absolute path would not hold.
      const shown = opts.inputs.map((input) => path.relative(root, path.resolve(input)) || ".").join(" ");
      stdout.write(`    → 프로젝트가 쓰는 검사 명령에 \`jstyle check ${shown}\`를 추가하세요.\n`);
    }
  }
  return errors || (opts.strict && warns) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = run(process.argv.slice(2));
