#!/usr/bin/env node
// 디자인 시안을 캡처·녹화하고 기본 검사를 합니다. Node 22 이상과 로컬 Chrome / Chromium / Edge만 있으면 됩니다.
// 사용법은 references/tools.md와 `node shoot.mjs --help`에서 볼 수 있습니다.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createChrome } from "./chrome.mjs";

const HELP = `자주 쓰는 명령:
  node scripts/shoot.mjs page.html --size desktop --out shots
  node scripts/shoot.mjs page.html --size desktop --steps "click .nav button; wait 300" --out shots
  node scripts/shoot.mjs page.html --size desktop --frames 8 --steps "send: click text=Send" --out evidence

사용법: node shoot.mjs <페이지 주소, 파일, manifest.json 또는 폴더> [...] [선택지]
여러 HTML은 쉼표로 나눌 수 있습니다. 같은 서버와 브라우저에서 처리하며 sheet.png를 함께 만듭니다.

  --out <폴더>          저장할 곳. 기본 ./shots
  --root <폴더>         로컬 서버의 루트. 페이지와 cwd로 정하며 공유 파일은 프로젝트 루트를 씁니다.
  --size <크기,...>     기본 390x844. desktop=1440x900, phone/mobile=390x844. 직접 크기도 쓸 수 있습니다.
  --states <a,b,...>    ?state=<이름>으로 각 상태를 열어 한 장씩 찍습니다.
  --param <이름>        상태 매개변수 이름. 기본 state
  --query <값>          주소 뒤에 붙일 값. 예: --query "a=1&b=2". --states와 함께 쓸 수 있습니다.
  --zoom <배율,...>     기본 1. --zoom 1,2는 각 배율의 파일을 만듭니다.
  --full                화면 안쪽뿐 아니라 페이지 전체를 찍습니다.
  --selector <선택자>   해당 요소만 찍습니다. --full/--record/--frames/--motion/--entry/--evidence와 함께 쓰지 않습니다.
  --thumb               0.5배 축소 화면. 기다림을 줄이고 읽기 쉬움 검사는 건너뜁니다.
  --mask                모든 글자를 가린 파일도 만듭니다.
  --sheet               상태를 나란히 모읍니다. --mask와 함께 쓰면 가린 모음도 만듭니다.
  --no-sheet            여러 대상을 찍어도 sheet.png를 자동으로 만들지 않습니다.
  --mark "1=<선택자>"   요소에 테두리와 번호를 표시합니다. 번호가 없으면 차례로 붙입니다.
  --steps "<동작>"      여러 번 쓸 수 있습니다. 묶음마다 페이지를 다시 엽니다. 예: "고친 뒤 저장: click .save"
  --record              묶음마다 녹화하고 마지막 동작의 시작·중간·끝 프레임을 남깁니다.
  --entry               --record/--frames와 함께 첫 내용을 열기 전부터 찍습니다.
  --hold <밀리초>       마지막 동작 뒤에 더 찍을 시간. 기본 1200
  --motion              첫 등장·버튼 반응·스크롤의 변화를 봅니다. 스크롤할 수 없으면 건너뜁니다.
  --evidence            상태·모음·가린 모음·첫 상태 2배 이미지·움직임 자료를 함께 만듭니다.
  --compare <그림>      PNG/JPEG/WebP 참고와 현재·겹침·차이 그림을 만듭니다.
  --wait <밀리초>       로딩 뒤 기다림. 기본 400. 끝나는 애니메이션은 최대 2초 더 기다립니다.
  --timeout-scale <배율> 시작·CDP·인코딩의 제한 시간을 늘립니다. 기본 1
  --dry-run             브라우저와 파일 없이 선택지·동작만 읽어 JSON으로 보입니다.
  --stitch <그림>       이미지를 모아 stitch.png를 만듭니다. 여러 번 쓸 수 있습니다.
  --label <글>          바로 앞 --stitch에 붙일 설명
  --columns <개수>      모음의 열 수. stitch 기본 2, 연속 프레임 기본 최대 4
  --match-width <픽셀>  각 원본의 같은 물체 너비. 첫 이미지의 물체 크기로 맞춥니다.
  --scale <배율>        바로 앞 이미지의 배율. 기본 1. --match-width와 함께 쓰지 않습니다.
  --crop <x,y,너비,높이> 크기를 맞춘 뒤 모든 그림에서 같은 곳을 자릅니다. 범위를 넘으면 실패합니다.
  --frames <개수>      2~120개 시간 표시 프레임을 PNG로 만듭니다. 영상은 --record가 있어야 만듭니다.

같은 크기로 비교하기:
  node scripts/shoot.mjs --stitch ref.png --match-width 240px --label 참고 --stitch shot.png --match-width 300 --label 지금 --crop "0,0,800,600" --out shots
  node scripts/shoot.mjs --stitch ref.png --scale 1 --stitch shot.png --scale 80% --crop "0 0 800 600" --out shots
--match-width는 전체 그림이 아닌 같은 물체의 너비이며 도구가 물체를 자동으로 찾지는 않습니다.
--scale은 0.8, 0.8x, 80%, 4/5를 받습니다. --crop은 쉼표·공백·×와 px를 쓸 수 있습니다.
배율을 맞추고 자른 뒤 전체 모음을 줄입니다. 이 선택지가 없으면 각 그림을 비율대로 줄입니다.
실제 배율과 자른 영역은 report.json에 남습니다.

동작은 세미콜론으로 나눕니다. 따옴표·괄호 안의 세미콜론은 나누지 않습니다.
  click <선택자> | hover <선택자> | dblclick <선택자> | waitfor <선택자>
  drag <선택자> <dx> <dy>  예: drag .tiles .paper 240 0
  type <선택자> <글>      지금 커서에 글을 넣습니다.
  fill <선택자> <글>      기존 값을 지우고 input/change 이벤트를 보냅니다.
  fill ".form input" "hello world"
  select <선택자> <값 또는 보이는 글>  예: select #country "Korea"
  key <키 또는 키 조합>   예: key ControlOrMeta+A. macOS는 Meta, 나머지는 Control입니다.
  scroll <dy> | wait <시간>  예: wait450, wait 450ms, wait 0.5s
waitfor는 요소가 보일 때까지 최대 5초 기다립니다.
doubleclick=dblclick, press=key, sleep=wait도 쓸 수 있습니다.

선택자:
  CSS: click .nav button:nth-child(3), click [aria-label="Send money"]
  글: click text=More, click text="Send money". 같은 글을 먼저 찾고 포함한 글을 찾습니다.
  포함: click button:has-text("Undo")  /  같은 글: click button:text-is("Save")
  차례: click ".item >> nth=1". 0부터 시작합니다. 숫자 속성값은 따옴표를 보완합니다.
첫 문서 안에서만 찾으며 iframe/Shadow DOM에는 들어가지 않습니다. 못 찾으면 그 개수도 알립니다.

--이름=값과 --이름 값 모두 쓸 수 있습니다. 스위치에는 값이 없습니다.
상태·크기·배율이 겹치면 한 번만 쓰고 파일 이름이 겹치면 번호를 붙입니다.
--hold1000, --scale0.8처럼 숫자 선택지를 붙여 쓸 수도 있습니다.
여러 요소가 맞으면 먼저 보이는 것을 씁니다. 가려지거나 비활성인 경우에는 까닭을 알립니다.
클릭·두 번 클릭·hover는 가운데 가림과 비활성을 report.json에 남기되 계속 실행합니다.
캡처는 최대 90초, 다른 CDP 요청은 기본 30초입니다. 시간 초과면 두 배 시간으로 한 번 더 실행합니다.
다시 캡처가 늦으면 다음 항목을 계속하며 종료 코드 1입니다. 다른 CDP 오류나 브라우저 끊김은 멈춥니다.
진행은 stderr, 마지막 결과는 stdout으로 보냅니다. 콘솔 오류·가로 넘침·깨진 이미지는 issues, 읽기·배치·클릭 대상·키트 밖 색 문제는 lint에 남습니다.
녹화는 ffmpeg가 필요합니다. 없으면 프레임만 남깁니다.

일반 캡처는 모든 상태에서 각 steps 묶음을 실행합니다. 움직임과 녹화는 첫 상태·첫 크기를 씁니다.
--evidence는 묶음별로 한 번 녹화하며 첫 상태만 기본 2배입니다. 모두 2배가 필요하면 --zoom 1,2 또는 --zoom 2를 씁니다.
@2x는 픽셀 밀도이며 브라우저의 200% 확대·다시 배치 확인을 대신하지 않습니다.

저장 파일:
  <상태>.png, <상태>-masked.png, <상태>-marked.png, sheet.png, sheet-masked.png, <상태>-compare.png
  record.mp4, motion-start/mid/end.jpg
  이름이 있는 묶음: record-<이름>.mp4, motion-<이름>-start/mid/end.jpg
  첫 등장: record-entry.mp4, motion-entry-start/mid/end.jpg
  연속 그림: motion[-<이름>]-sequence.png
파일에 못 쓰는 글자와 공백은 하이픈으로 바꾸며 원래 묶음 이름은 report.json에 남깁니다.
report.json은 배열이고 각 항목에 file, lint, issues, motion 등이 있습니다.
녹화 시작은 마지막 click/dblclick/drag/type/fill/select/key 직전, 중간은 그 반응 중간, 끝은 hold 뒤입니다.
wait/hover/scroll은 기준 동작을 바꾸지 않습니다. 첫 등장은 처음 내용부터 안정된 때까지 봅니다.
frames.start/mid/end와 durationMs에 파일·시간이 남습니다. 짧은 효과의 영상이 3초 미만인 것은 정상입니다.
마지막 프레임과 새 캡처가 다르면 warnings에 적고 최종 캡처로 끝을 보완합니다. 정지한 끝과 움직이는 과정은 따로 판단합니다.
--compare는 참고 그림의 CSS 크기를 --size로 지정합니다. 차이 비율을 디자인 점수로 쓰지 않습니다.
--motion은 변화가 있는지만 보며 조작으로 시작되는 효과는 --steps를 함께 줍니다.
Canvas/WebGL의 변화는 놓칠 수 있습니다. 빈 캔버스는 근거로 쓰지 않습니다.
로컬 파일은 임시 로컬 서버에서 엽니다. 주소에 ?나 &가 있으면 따옴표나 --query를 씁니다.
WebGL은 필요하면 소프트웨어로 그리며 컨텍스트가 없으면 문제로 알립니다.`;

function fail(message) { console.error(`shoot: ${message}`); process.exit(1); }
const STITCH_EXAMPLE = 'node scripts/shoot.mjs --stitch ref.png --match-width 240 --stitch shot.png --match-width 300 --crop "0,0,800,600" --out shots';
const SCALE_EXAMPLE = 'node scripts/shoot.mjs --stitch ref.png --scale 1 --stitch shot.png --scale 80% --out shots';
function stitchNumber(value, key) {
  let text = value.trim().toLowerCase(), factor = 1;
  const example = key === "scale" ? SCALE_EXAMPLE : STITCH_EXAMPLE;
  if (key === "scale") {
    if (text.endsWith("%")) { factor = .01; text = text.slice(0, -1).trim(); }
    else text = text.replace(/\s*(?:x|×|배)$/, "").trim();
  } else text = text.replace(/\s*px$/, "").trim();
  const number = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
  const parts = key === "scale" ? text.split("/").map((part) => part.trim()) : [text];
  const n = parts.every((part) => number.test(part)) && parts.length <= 2 ? Number(parts[0]) / (parts.length === 2 ? Number(parts[1]) : 1) * factor : NaN;
  if (!Number.isFinite(n) || n <= 0) fail(`--${key}에는 양수가 필요합니다. 받은 값: ${value}. 예: ${example}`);
  return n;
}
function stitchCrop(value) {
  const parts = value.trim().replace(/(\d)\s*px(?=\s|[,，x×)\]]|$)/gi, "$1").replace(/^[[(]\s*|\s*[\])]$/g, "").trim().split(/[\s,，x×]+/i);
  const numbers = parts.map(Number);
  if (parts.length !== 4 || parts.some((part) => !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(part)) || numbers.some((n) => !Number.isFinite(n)) || numbers[2] <= 0 || numbers[3] <= 0) {
    fail(`--crop에는 음수가 아닌 x, y와 양수인 너비, 높이가 필요합니다. 받은 값: ${value}. 예: ${STITCH_EXAMPLE}`);
  }
  const [x, y, width, height] = numbers;
  return { x, y, width, height };
}
function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] !== b[j])));
    row = next;
  }
  return row[b.length];
}
const closest = (word, choices) => [...choices].sort((a, b) => distance(word, a) - distance(word, b))[0];
const ACTIONS = ["click", "hover", "dblclick", "drag", "type", "fill", "select", "waitfor", "key", "scroll", "wait"];
const ALIASES = { doubleclick: "dblclick", press: "key", sleep: "wait" };
const unquote = (s) => /^(["'])[\s\S]*\1$/.test(s) ? s.slice(1, -1).replace(/\\(["'\\])/g, "$1") : s;
// Split only outside quoted strings and selector brackets. Preserve the source for diagnostics.
function splitOutside(text, words = false) {
  const parts = []; let start = 0, quote = null, outerQuote = null, stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    // Outer quotes around a selector may contain attribute quotes, even unescaped ones.
    if (outerQuote) {
      if (!quote && !stack.length && c === outerQuote) { outerQuote = null; continue; }
      if (quote) { if (c === quote) quote = null; continue; }
      if (c === "[" || c === "(") { stack.push(c); continue; }
      if (c === "]" || c === ")") { stack.pop(); continue; }
      if (stack.length && (c === '"' || c === "'")) quote = c;
      continue;
    }
    if (quote) { if (c === quote) quote = null; continue; }
    const quoteStarts = (c === '"' || c === "'") && (i === 0 || /[\s=(]/.test(text[i - 1]));
    const prefix = text.slice(start, i).trim();
    const selectorQuote = words ? !parts.length && !prefix :
      /^(?:click|hover|dblclick|doubleclick|drag|type|fill|select|waitfor)$/.test(prefix) || /^(?:\d+\s*=\s*)?$/.test(prefix);
    if (quoteStarts) { if (selectorQuote) outerQuote = c; else quote = c; continue; }
    if (c === "[" || c === "(") stack.push(c);
    else if (c === "]" || c === ")") {
      if (stack.pop() !== (c === "]" ? "[" : "(")) throw new Error(`괄호의 짝이 맞지 않습니다. 받은 값: ${text}. 예: click [aria-label="Send money"]`);
    } else if (!stack.length && (words ? /\s/.test(c) : c === ";")) {
      if (text.slice(start, i).trim()) parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quote || outerQuote || stack.length) throw new Error(`따옴표나 괄호의 짝이 맞지 않습니다. 받은 값: ${text}. 예: click [aria-label="Send money"]`);
  if (text.slice(start).trim()) parts.push(text.slice(start).trim());
  return parts;
}
function parseSelector(source) {
  const value = unquote(source.trim());
  if (!value) throw new Error(`선택자가 없습니다. 받은 값: ${source}. 예: click .open`);
  if (value.startsWith("text=")) return { kind: "text", value: unquote(value.slice(5).trim()) };
  const m = value.match(/^(.*):has-text\(\s*(["'])([\s\S]*)\2\s*\)$/);
  if (m) return { kind: "has-text", css: m[1].trim() || "*", value: unquote(m[2] + m[3] + m[2]) };
  return { kind: "css", value };
}
function parseSteps(text) {
  let name = null;
  let quote = null, stack = [], split = null;
  const actions = [...ACTIONS, ...Object.keys(ALIASES)];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === "[" || c === "(") { stack.push(c); continue; }
    if (c === "]" || c === ")") { stack.pop(); continue; }
    if (stack.length || c !== ":" || !/\s/.test(text[i + 1] || "")) continue;
    const prefix = text.slice(0, i).trim(), rest = text.slice(i + 1).trimStart();
    const first = rest.match(/^(\S+)/)?.[1] || "";
    const action = ALIASES[first] || first.replace(/^(wait|sleep)\d[\s\S]*$/, "$1");
    if (prefix && (ACTIONS.includes(action) || actions.some((item) => distance(first, item) <= 2))) split = { prefix, rest };
  }
  if (split) { name = split.prefix; text = split.rest; }
  const steps = splitOutside(text).map((raw, i) => {
    const m = raw.match(/^(\S+)(?:\s+([\s\S]*))?$/);
    let action = ALIASES[m[1]] || m[1], tail = m[2] || "";
    if (/^(wait|sleep)\d/.test(action)) { tail = action.replace(/^(wait|sleep)/, ""); action = "wait"; }
    const bad = (example) => { throw new Error(`${i + 1}단계의 동작 인수가 올바르지 않습니다. 받은 값: ${raw}. 예: ${example}`); };
    if (!ACTIONS.includes(action)) throw new Error(`${i + 1}단계의 동작을 알 수 없습니다. 받은 값: ${raw}. 이렇게 쓰려던 것인가요: ${closest(action, [...ACTIONS, ...Object.keys(ALIASES)])}? 모든 동작: ${ACTIONS.join(", ")}. 다른 이름: ${Object.keys(ALIASES).join(", ")}`);
    const step = { action, raw, params: {} };
    if (["click", "hover", "dblclick", "waitfor"].includes(action)) {
      if (!tail) bad(`${action} .open`);
      step.selector = parseSelector(tail);
    } else if (action === "drag") {
      const match = tail.match(/^([\s\S]+?)\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/);
      if (!match) bad("drag .tiles .paper 240 0");
      step.selector = parseSelector(match[1]); step.params = { dx: +match[2], dy: +match[3] };
    } else if (["type", "fill", "select"].includes(action)) {
      const tokens = splitOutside(tail, true);
      if (tokens.length < 2) bad(`${action} #field "hello world"`);
      step.selector = parseSelector(tokens[0]);
      step.params = action === "select" ? { value: unquote(tail.slice(tokens[0].length).trim()) } : { text: unquote(tail.slice(tokens[0].length).trim()) };
    } else if (action === "wait") {
      const match = tail.match(/^(\d+(?:\.\d+)?)(ms|s)?$/);
      if (!match) bad("wait 450ms");
      step.params = { ms: +match[1] * (match[2] === "s" ? 1000 : 1) };
    } else if (action === "scroll") {
      if (!tail || !Number.isFinite(Number(tail))) bad("scroll -400");
      step.params = { dy: +tail };
    } else {
      const keys = unquote(tail).split("+");
      const mods = keys.slice(0, -1);
      if (!tail || /\s/.test(tail) || mods.some((k) => !["Alt", "Control", "Meta", "Shift", "ControlOrMeta"].includes(k)) || !keys.at(-1)) bad("key ControlOrMeta+A");
      step.params = { key: keys.at(-1), modifiers: mods };
    }
    return step;
  });
  return { name, steps };
}
const args = process.argv.slice(2);
if (!args.length || args.includes("--help") || args.includes("-h")) { console.log(HELP); process.exit(args.length ? 0 : 1); }
const opt = { out: "shots", size: "390x844", param: "state", zoom: "1", hold: "1200", wait: "400" };
const options = [...HELP.matchAll(/^  (--\S+)/gm)].map((m) => m[1]);
options.push("--label", "--columns", "--frames");
const booleanOptions = new Set(["full", "thumb", "mask", "sheet", "record", "motion", "entry", "evidence", "dry-run", "force", "no-sheet"]);
const flags = new Set(), stepsInputs = [], positional = [], suppliedOptions = new Set(), stitchInputs = [];
let lastFlag = null;
for (let i = 0; i < args.length; i++) {
  // Only numeric options accept a glued value; --out123 and switches keep their old errors.
  const gluedNumber = args[i].match(/^(--(?:hold|wait|zoom|timeout-scale|columns|frames|match-width|scale))((?:\d|\.\d)[\s\S]*)$/);
  const a = gluedNumber ? `${gluedNumber[1]}=${gluedNumber[2]}` : args[i];
  if (a.startsWith("--")) {
    const equal = a.indexOf("="), option = equal < 0 ? a : a.slice(0, equal), key = option.slice(2);
    if (!options.includes(option) && key !== "force") {
      const glued = options.find((o) => a.startsWith(o) && /^\d/.test(a.slice(o.length)));
      const suggestion = glued ? `${glued} ${a.slice(glued.length)}` : closest(option, options);
      const examples = { out: "shots", size: "desktop", states: "idle,done", param: "state", query: '"a=1&b=2"', zoom: "1,2", mark: '"1=.open"', steps: '"click .open"', hold: "1000", compare: "ref.png", wait: "400", stitch: "before.png", label: '"바꾸기 전"', columns: "2", frames: "8", "match-width": "240", scale: "80%", crop: '"0,0,800,600"' };
      const example = glued ? suggestion : `${suggestion}${examples[suggestion.slice(2)] ? " " + examples[suggestion.slice(2)] : ""}`;
      fail(`알 수 없는 선택지입니다: ${a}. 이렇게 쓰려던 것인가요: ${example}?\n쓸 수 있는 선택지: ${options.join(" ")}`);
    }
    if (booleanOptions.has(key)) {
      if (equal >= 0) fail(`${option}에는 값을 쓰지 않습니다. 받은 값: ${a}. 예: ${option}`);
      flags.add(key); lastFlag = option;
    } else {
      lastFlag = null;
      if (equal < 0 && (i + 1 >= args.length || args[i + 1].startsWith("--"))) {
        const example = { stitch: "--stitch before.png --stitch after.png --out shots", label: '--stitch before.png --label "바꾸기 전"', columns: "--stitch before.png --columns 2", frames: "page.html --record --frames 8", "match-width": STITCH_EXAMPLE, scale: SCALE_EXAMPLE, crop: STITCH_EXAMPLE }[key];
        fail(`${option}에는 값 하나가 필요합니다.${example ? ` 받은 값: ${a}. 예: ${example}` : ""}`);
      }
      const value = equal < 0 ? args[++i] : a.slice(equal + 1);
      if (!value) fail(`${option}에는 값 하나가 필요합니다. 받은 값: ${a}. 예: ${{ "match-width": STITCH_EXAMPLE, scale: SCALE_EXAMPLE, crop: STITCH_EXAMPLE }[key] || `${option} 값`}`);
      suppliedOptions.add(key);
      if (key === "steps") stepsInputs.push(value);
      else if (key === "stitch") stitchInputs.push({ path: value });
      else if (key === "label") {
        if (!stitchInputs.length || stitchInputs.at(-1).label !== undefined) fail(`--label은 --stitch 이미지 바로 뒤에 와야 합니다. 받은 값: ${a} ${value}. 예: --stitch before.png --label "바꾸기 전" --stitch after.png --label "바꾼 뒤"`);
        stitchInputs.at(-1).label = value;
      } else if (key === "match-width" || key === "scale") {
        const image = stitchInputs.at(-1), field = key === "match-width" ? "matchWidth" : "scale";
        if (!image || image[field] !== undefined) fail(`--${key}는 --stitch 이미지 바로 뒤에 한 번만 씁니다. 받은 값: ${a} ${value}. 예: ${key === "scale" ? SCALE_EXAMPLE : STITCH_EXAMPLE}`);
        image[field] = stitchNumber(value, key);
      } else if (key === "crop") {
        if (opt.crop !== undefined) fail(`--crop은 모든 이미지에 함께 적용하는 영역이므로 한 번만 씁니다. 받은 값: ${value}. 예: ${STITCH_EXAMPLE}`);
        opt.crop = stitchCrop(value);
      } else opt[key] = value;
    }
  } else {
    if (stitchInputs.length) fail(`그림 모음에는 페이지가 필요하지 않습니다. 이미지마다 앞에 --stitch를 붙이세요. 받은 값: ${a}. 예: --stitch before.png --label "바꾸기 전" --stitch after.png --label "바꾼 뒤" --columns 2 --out shots`);
    if (lastFlag === "--motion" && /^(?:[.#\[]|text=)|:has-text\(/.test(a)) fail(`--motion에는 값을 쓰지 않습니다. 받은 값: --motion ${a}. 살펴볼 동작은 --steps에 적으세요. 예: --motion --steps "click ${a}"`);
    if (positional.length && !/^(?:https?:|file:)|\.html?(?:,|$)|(?:^|[\/])manifest\.json$/i.test(a) && !existsSync(a)) fail(`페이지 주소가 여러 개이거나 남는 인수가 있습니다. 받은 값: ${positional[0]}, ${a}${lastFlag ? `. ${lastFlag}에는 값을 쓰지 않습니다` : ""}. 예: page.html --steps "click .open"`);
    // Selector-like extras after a switch are never page targets.
    if (lastFlag && /^(?:[.#\[]|text=)/.test(a) && !existsSync(a)) fail(`${lastFlag}에는 값을 쓰지 않습니다. 받은 값: ${lastFlag} ${a}. 예: page.html ${lastFlag}`);
    positional.push(a); lastFlag = null;
  }
}
// Expand explorer inputs before dry-run, without requiring ordinary page paths to exist.
let batchMode = positional.length > 1;
const localPath = (value) => /^file:\/\//i.test(value) ? fileURLToPath(value) : resolve(value);
function expandTarget(value) {
  if (/^https?:\/\//i.test(value)) return [{ target: value }];
  let path;
  try { path = localPath(value); } catch { fail(`파일을 찾을 수 없습니다: ${value}`); }
  if (!existsSync(path) && value.includes(",") && value.split(",").every((p) => /\.html?$/i.test(p.trim()))) {
    batchMode = true;
    return value.split(",").flatMap((p) => expandTarget(p.trim()));
  }
  if (existsSync(path) && statSync(path).isDirectory()) {
    if (existsSync(join(path, "manifest.json"))) return expandTarget(join(path, "manifest.json"));
    if (existsSync(join(path, "index.html"))) return [{ target: value }];
    batchMode = true;
    const pages = readdirSync(path, { withFileTypes: true }).filter((p) => p.isFile() && /\.html$/i.test(p.name) && p.name.toLowerCase() !== "style-explorer.html").map((p) => p.name).sort();
    if (!pages.length) fail(`폴더에서 HTML을 찾지 못했습니다: ${value}`);
    return pages.flatMap((page) => expandTarget(join(path, page)));
  }
  if (basename(path).toLowerCase() === "manifest.json") {
    batchMode = true;
    let manifest;
    try { manifest = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { fail(`manifest를 읽을 수 없습니다: ${value} (${error.message})`); }
    if (!Array.isArray(manifest.candidates)) fail(`manifest에 candidates 배열이 없습니다: ${value}`);
    const candidates = manifest.candidates.filter((c) => c && (!c.kind || c.kind === "html") && typeof c.source === "string" && /\.html?$/i.test(c.source) && !/^[a-z][a-z\d+.-]*:/i.test(c.source));
    if (!candidates.length) fail(`manifest에서 로컬 HTML 파일을 찾지 못했습니다: ${value}`);
    return candidates.map((c) => ({ target: resolve(dirname(path), c.source), id: c.id, name: c.name }));
  }
  return [{ target: value }];
}
const targets = positional.flatMap(expandTarget);
const target = targets[0]?.target;
// IDs become filenames only after removing separators and reserved path components.
const targetStem = (candidate) => {
  const source = candidate.id || basename(/^https?:\/\//i.test(candidate.target) ? new URL(candidate.target).pathname : localPath(candidate.target), extname(candidate.target));
  return String(source).replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/^[. ]+|[. ]+$/g, "") || "page";
};
const stitching = stitchInputs.length > 0;
if (opt.crop !== undefined && !stitching) fail(`--crop은 --stitch 이미지와 함께 써야 합니다. 받은 값: ${args.join(" ")}. 예: ${STITCH_EXAMPLE}`);
if (!target && !stitching) {
  if (opt.frames !== undefined || opt.columns !== undefined) fail(`페이지나 그림 모음 입력이 없습니다. 받은 값: ${args.join(" ")}. 예: page.html --record --frames 8 --columns 4 또는 --stitch before.png --stitch after.png --columns 2`);
  fail("페이지 주소나 파일이 없습니다.");
}
if (stitching) {
  const incompatible = [...suppliedOptions].filter((key) => !["stitch", "label", "columns", "out", "timeout-scale", "match-width", "scale", "crop"].includes(key));
  if (target || incompatible.length || [...flags].some((key) => key !== "dry-run" && key !== "force")) fail(`그림 모음에는 페이지나 캡처·녹화 선택지를 쓰지 않습니다. 받은 값: ${target || incompatible.map((key) => "--" + key).join(", ") || [...flags].join(", ")}. 예: --stitch before.png --label "바꾸기 전" --stitch after.png --label "바꾼 뒤" --columns 2 --out shots`);
  for (const [i, image] of stitchInputs.entries()) {
    try { if (!statSync(image.path).isFile()) throw new Error("파일이 아님"); }
    catch { fail(`모음의 ${i + 1}번째 이미지가 없거나 파일이 아닙니다. 받은 값: ${image.path}. 예: --stitch before.png --label "바꾸기 전" --out shots`); }
  }
  if (stitchInputs.some((image) => image.matchWidth !== undefined)) {
    if (stitchInputs.some((image) => image.scale !== undefined)) fail(`--match-width와 --scale은 섞어 쓸 수 없습니다. 받은 값: 이미지마다 다른 배율 지정 방식. 예: ${STITCH_EXAMPLE} 또는 ${SCALE_EXAMPLE}`);
    if (stitchInputs.some((image) => image.matchWidth === undefined)) fail(`--match-width를 쓰면 이미지마다 같은 물체의 너비를 적어야 합니다. 받은 값: 일부 이미지에 너비가 없음. 예: ${STITCH_EXAMPLE}`);
  }
}
if (opt.frames !== undefined && (!/^\d+$/.test(opt.frames) || !Number.isSafeInteger(+opt.frames) || +opt.frames < 2 || +opt.frames > 120)) fail(`--frames에는 2~120 사이의 정수가 필요합니다. 받은 값: ${opt.frames}. 예: page.html --record --frames 8`);
const captureMotion = flags.has("record") || opt.frames !== undefined;
if (opt.columns !== undefined && (!/^\d+$/.test(opt.columns) || !Number.isSafeInteger(+opt.columns) || +opt.columns < 1)) fail(`--columns에는 양의 정수가 필요합니다. 받은 값: ${opt.columns}. 예: --stitch before.png --stitch after.png --columns 2`);
if (opt.columns !== undefined && !stitching && opt.frames === undefined) fail(`--columns는 --stitch나 --frames와 함께 써야 합니다. 받은 값: --columns ${opt.columns}. 예: page.html --record --frames 8 --columns 4`);
if (flags.has("thumb")) {
  const badThumb = [...["full", "mask", "record", "motion", "entry", "evidence"].filter((k) => flags.has(k)).map((k) => "--" + k), ...(opt.frames !== undefined ? ["--frames"] : []), ...(opt.mark ? ["--mark"] : []), ...(opt.compare ? ["--compare"] : [])];
  if (badThumb.length) fail(`--thumb는 작은 미리보기에만 쓰므로 다음 선택지와 함께 쓸 수 없습니다: ${badThumb.join(", ")}. 예: page.html --size desktop --thumb --out shots`);
  if (!suppliedOptions.has("wait")) opt.wait = "150";
}
const notices = [];
function deduplicate(values, key, label) {
  const seen = new Set(), removed = [];
  const unique = values.filter((value) => {
    const id = key(value); if (seen.has(id)) { removed.push(id); return false; } seen.add(id); return true;
  });
  if (removed.length) notices.push(`${label}에서 겹친 항목을 뺐습니다: ${[...new Set(removed)].join(", ")}`);
  return unique;
}
let groups, sizes, zooms, marks, selector = null;
if (opt.selector) {
  const conflicts = [...["full", "record", "motion", "entry", "evidence"].filter((key) => flags.has(key)), ...(opt.frames !== undefined ? ["frames"] : [])];
  if (conflicts.length) fail(`--selector와 함께 쓸 수 없는 선택지입니다: ${conflicts.map((key) => "--" + key).join(", ")}`);
}
try {
  selector = opt.selector ? parseSelector(opt.selector) : null;
  groups = stepsInputs.map(parseSteps);
  const names = groups.map((g, i) => g.name || (groups.length > 1 ? String(i + 1) : ""));
  if (new Set(names).size !== names.length) throw new Error(`동작 묶음 이름이 겹칩니다. 받은 값: ${names.join(", ")}. 예: --steps "open: click .open" --steps "send: click .send"`);
  const usedGroupFiles = new Set();
  const safeGroupFile = (value) => {
    let stem = String(value).trim().replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "-").replace(/\s+/g, "-")
      .replace(/^[. ]+|[. ]+$/g, "").replace(/[. ]+$/g, "");
    let bytes = 0;
    stem = Array.from(stem).filter((character) => {
      bytes += Buffer.byteLength(character);
      return bytes <= 120;
    }).join("");
    if (!stem) stem = "group";
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(stem)) stem = `_${stem}`;
    const base = stem; let n = 2;
    while (usedGroupFiles.has(stem.toLowerCase())) stem = `${base}-${n++}`;
    usedGroupFiles.add(stem.toLowerCase());
    return stem;
  };
  groups.forEach((g, i) => { g.reportName = names[i]; g.id = names[i] ? safeGroupFile(names[i]) : ""; });
  sizes = opt.size.split(",").map((s) => {
    const value = ({ desktop: "1440x900", phone: "390x844", mobile: "390x844" })[s.trim()] || s.trim();
    const m = value.match(/^(\d+)x(\d+)$/);
    if (!m || +m[1] < 1 || +m[2] < 1) throw new Error(`크기 형식이 맞지 않습니다. 받은 값: ${s}. 예: --size desktop,390x844`);
    return { w: +m[1], h: +m[2] };
  });
  zooms = opt.zoom.split(",").map((s) => {
    const n = Number(s); if (!Number.isFinite(n) || n <= 0) throw new Error(`배율이 맞지 않습니다. 받은 값: ${s}. 예: --zoom 1,2`); return n;
  });
  sizes = deduplicate(sizes, (s) => `${s.w}x${s.h}`, "크기");
  zooms = deduplicate(zooms, String, "배율");
  for (const key of ["hold", "wait"]) if (!/^\d+(?:\.\d+)?$/.test(opt[key])) throw new Error(`--${key}에는 밀리초 값이 필요합니다. 받은 값: ${opt[key]}. 예: --${key} 1000`);
  if (opt["timeout-scale"] !== undefined && (!Number.isFinite(Number(opt["timeout-scale"])) || Number(opt["timeout-scale"]) < 1)) throw new Error(`--timeout-scale에는 1 이상인 수가 필요합니다. 받은 값: ${opt["timeout-scale"]}. 예: --timeout-scale 2`);
  marks = (opt.mark ? splitOutside(opt.mark) : []).map((s, i) => {
    const m = s.match(/^(\d+)\s*=\s*(.+)$/);
    return { label: m ? m[1] : String(i + 1), selector: parseSelector(m ? m[2] : s) };
  });
} catch (error) { fail(error.message); }
const timeoutScale = Number(opt["timeout-scale"] || 1);
const timeoutMs = (ms) => Math.min(2147483647, ms * timeoutScale);
const quoteArg = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
const retryCommand = `node ${quoteArg(resolve(process.argv[1]))} ${stitching ? args.map(quoteArg).join(" ") : quoteArg(target)} --timeout-scale 2`;
let currentRetryCommand = retryCommand;
const slowHint = () => `여러 작업을 동시에 하면 느려질 수 있습니다. 따로 다시 실행해 보세요: ${currentRetryCommand}`;
const states = deduplicate(opt.states ? opt.states.split(",").map((s) => s.trim()).filter(Boolean) : [null], String, "상태");
if (!states.length) fail(`--states에 상태가 없습니다. 받은 값: ${opt.states}. 예: --states idle,done`);
const stateIds = states.map((s, i) => !s ? "page" : /^[A-Za-z0-9_-]{1,80}$/.test(s) ? s : `state-${i + 1}-${createHash("sha256").update(s).digest("hex").slice(0, 12)}`);
const refImage = opt.compare ? resolve(opt.compare) : null;
if (refImage && !existsSync(refImage)) fail(`참고 그림을 찾을 수 없습니다: ${opt.compare}`);
if (refImage && !/\.(png|jpe?g|webp)$/i.test(refImage)) fail("--compare에는 png, jpg, webp 파일만 쓸 수 있습니다.");
if (refImage && (captureMotion || flags.has("evidence"))) fail("--compare는 정지 캡처에만 씁니다. --record, --frames, --evidence와 함께 쓰지 않습니다. 예: --compare ref.png");
if (flags.has("dry-run")) {
  console.log(JSON.stringify({ target, ...(targets.length > 1 ? { targets: targets.map((t) => t.target) } : {}), selector, options: opt, flags: [...flags], sizes, zooms, states, groups, marks, notices, ...(stitching ? { stitch: stitchInputs } : {}) }, null, 2));
  process.exit(0);
}
// A small supervisor preserves the complete invocation and gives every run fresh state.
// The worker reports only transport/startup timeouts with 75; ordinary failures stay 1.
const attemptKey = "JSTYLE_SHOOT_TIMEOUT_ATTEMPT";
const workerAttempt = process.env[attemptKey];
if (workerAttempt === undefined) {
  let child;
  process.on("SIGINT", () => child?.kill("SIGINT"));
  process.on("SIGTERM", () => child?.kill("SIGTERM"));
  const run = (attempt) => new Promise((ok) => {
    child = spawn(process.execPath, [...process.execArgv, process.argv[1], ...args,
      ...(attempt ? ["--timeout-scale", String(timeoutScale * 2)] : [])],
    { stdio: "inherit", env: { ...process.env, [attemptKey]: String(attempt) } });
    child.once("error", (error) => { console.error(`shoot: 캡처 프로세스를 시작하지 못했습니다: ${error.message}`); ok(1); });
    child.once("exit", (code, signal) => ok(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : code ?? 1));
  });
  let code = await run(0);
  if (code === 75) {
    console.error(`shoot: 제한 시간을 두 배로 늘려(--timeout-scale ${timeoutScale * 2}) 원래 인수 그대로 전체를 한 번 더 시도합니다.`);
    code = await run(1);
  }
  process.exit(code);
}
if (typeof WebSocket !== "function") fail("Node 22 이상이 필요합니다.");
const out = resolve(opt.out);
mkdirSync(out, { recursive: true });
const temporaryFrames = new Set(), encoders = new Set();
function removeFrames() { for (const dir of temporaryFrames) rmSync(dir, { recursive: true, force: true }); temporaryFrames.clear(); }

// ---------- 로컬 파일은 로컬 전용 정적 서버에서 엽니다. 그래야 모듈 스크립트와 fetch가 제대로 실행됩니다 ----------
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".otf": "font/otf", ".mp4": "video/mp4", ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm", ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json", ".bin": "application/octet-stream", ".geojson": "application/geo+json",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".pdf": "application/pdf",
  ".csv": "text/csv; charset=utf-8", ".ico": "image/x-icon", ".mov": "video/quicktime", ".m4a": "audio/mp4",
  ".hdr": "application/octet-stream", ".exr": "image/x-exr", ".ktx2": "image/ktx2",
};
const privatePath = (path) => path.split(/[\\/]/).some((part) => part !== ".jstyle" && (part.startsWith(".")
  || /^(?:credentials?|secrets?|id_(?:rsa|dsa|ecdsa|ed25519))(?:[._-]|$)/i.test(part)));
let server = null;
const localFiles = targets.filter((t) => !/^https?:\/\//i.test(t.target)).map(({ target }) => {
  const path = localPath(target);
  if (!existsSync(path)) fail(`파일을 찾을 수 없습니다: ${target}`);
  const file = statSync(path).isDirectory() ? join(path, "index.html") : path;
  if (!existsSync(file) || !statSync(file).isFile()) fail(`파일을 찾을 수 없습니다: ${file}`);
  return realpathSync(file);
});
let sharedRoot = localFiles.length ? dirname(localFiles[0]) : null;
for (const file of localFiles) {
  while (relative(sharedRoot, file) === ".." || relative(sharedRoot, file).startsWith(`..${sep}`) || isAbsolute(relative(sharedRoot, file))) {
    const parent = dirname(sharedRoot);
    if (parent === sharedRoot) fail("여러 로컬 대상이 같은 디스크에 있어야 같은 정적 서버로 열 수 있습니다.");
    sharedRoot = parent;
  }
}
let explicitRoot = null;
if (opt.root) {
  const candidate = resolve(opt.root);
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) fail(`--root에는 이미 있는 폴더가 필요합니다: ${opt.root}`);
  explicitRoot = realpathSync(candidate);
  if (explicitRoot === parse(explicitRoot).root || explicitRoot === realpathSync(tmpdir())) fail(`--root 범위가 너무 넓습니다. 프로젝트 폴더를 쓰세요: ${opt.root}`);
  for (const file of localFiles) {
    const fromRoot = relative(explicitRoot, file);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) fail(`로컬 대상이 --root 밖에 있습니다: ${file}`);
  }
}
async function resolveTarget(t) {
  if (/^https?:\/\//i.test(t)) return t;
  let localTarget = t;
  if (/^file:\/\//i.test(t)) {
    try { localTarget = fileURLToPath(t); } catch { fail(`파일을 찾을 수 없습니다: ${t}`); }
  }
  const file = resolve(localTarget);
  if (!existsSync(file)) fail(`파일을 찾을 수 없습니다: ${t}`);
  const isDir = statSync(file).isDirectory();
  const fileDir = realpathSync(isDir ? file : dirname(file));
  let root = explicitRoot || sharedRoot || fileDir;
  try {
    const cwdReal = realpathSync(process.cwd());
    const tmpReal = realpathSync(tmpdir());
    const relDir = relative(cwdReal, root);
    if (!explicitRoot && relDir && relDir !== ".." && !relDir.startsWith(`..${sep}`) && !isAbsolute(relDir)
      && relDir.split(sep).length <= 3 && cwdReal !== parse(cwdReal).root && cwdReal !== tmpReal && !fileDir.startsWith(tmpReal + sep)) {
      root = cwdReal;
    }
  } catch {}
  const targetFile = isDir ? join(fileDir, "index.html") : realpathSync(file);
  const pagePath = relative(root, targetFile).split(sep).map(encodeURIComponent).join("/");
  if (server) return `http://127.0.0.1:${server.address().port}/${pagePath}`;
  server = createServer((req, res) => {
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      const url = new URL(req.url, origin);
      if (req.headers.host !== new URL(origin).host || url.origin !== origin || !["GET", "HEAD"].includes(req.method)) {
        res.writeHead(404).end();
        return;
      }
      const path = decodeURIComponent(url.pathname);
      if (privatePath(path)) { res.writeHead(404).end(); return; }
      const local = realpathSync(resolve(join(root, path)));
      const fromRoot = relative(root, local);
      const type = MIME[extname(local).toLowerCase()];
      if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot) || privatePath(fromRoot) || !type || !statSync(local).isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : readFileSync(local));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return `http://127.0.0.1:${server.address().port}/${pagePath}`;
}

// ---------- 따로 쓸 임시 브라우저를 엽니다. 사용자 브라우저 자료는 건드리지 않습니다 ----------
let ws, cleaning;
let browser;
try { browser = createChrome({ timeoutMs, prefix: "jstyle-shoot-", label: "shoot" }); }
catch (error) { fail(error.message); }
const launchChrome = () => browser.launch();
const stopChrome = () => browser.stop(ws);
function cleanup() { return cleaning ||= (async () => { for (const child of encoders) child.kill("SIGKILL"); await stopChrome(); server?.close(); removeFrames(); })(); }
process.on("exit", () => {
  try { for (const child of encoders) child.kill("SIGKILL"); removeFrames(); } catch {}
  try { server?.close(); } catch {}
  browser.dispose();
});
process.on("SIGINT", async () => { await cleanup(); process.exit(130); });
process.on("SIGTERM", async () => { await cleanup(); process.exit(143); });
let wsUrl;
try { wsUrl = await launchChrome(); }
catch (error) {
  await cleanup();
  console.error(`shoot: 브라우저를 열지 못했습니다: ${error.message === "timeout" ? `${45 * timeoutScale}초 안에 시작하지 못했습니다` : error.message}. ${slowHint()}`);
  process.exit(error.message === "timeout" && workerAttempt === "0" ? 75 : 1);
}

// ---------- Chrome DevTools 프로토콜 ----------
let currentContext = "브라우저 연결", transportFailure = null, finishing = false;
async function during(context, work) {
  const previous = currentContext; currentContext = context;
  try { return await work(); } finally { currentContext = previous; }
}
let sessionId, browserNeedsRestart = false;
let seq = 0;
const pending = new Map(), listeners = [];
let saveFatalReport = () => {};
function abortTransport(error) {
  if (transportFailure || finishing) return;
  transportFailure = error; process.exitCode = error.code === "TRANSPORT_TIMEOUT" && workerAttempt === "0" ? 75 : 1;
  for (const request of pending.values()) { clearTimeout(request.timer); request.no(error); }
  pending.clear();
  console.error(`shoot: ${error.message}`);
  try { saveFatalReport(error); } catch {}
  void cleanup().finally(() => process.exit(process.exitCode));
}
async function connectTransport(url) {
  let opened = false;
  ws = new WebSocket(url);
  ws.onclose = () => abortTransport(new Error(`${currentContext}: 브라우저 연결이 갑자기 끊겼습니다. 실행을 멈춥니다. ${slowHint()}`));
  ws.onerror = () => abortTransport(new Error(`${currentContext}: ${opened ? "브라우저 연결이 갑자기 끊겼습니다" : "브라우저 연결에 오류가 발생했습니다"}. 실행을 멈춥니다. ${slowHint()}`));
  await new Promise((ok, no) => {
    const timer = setTimeout(() => { const error = new Error(`브라우저 연결이 ${30 * timeoutScale}초 안에 응답하지 않았습니다. ${slowHint()}`); error.code = "TRANSPORT_TIMEOUT"; no(error); abortTransport(error); }, timeoutMs(30000));
    ws.onopen = () => { opened = true; clearTimeout(timer); ok(); };
    const failed = () => { clearTimeout(timer); no(transportFailure || new Error("브라우저에 연결하지 못했습니다")); };
    ws.addEventListener("close", failed, { once: true }); ws.addEventListener("error", failed, { once: true });
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, no, timer, context } = pending.get(msg.id);
      pending.delete(msg.id); clearTimeout(timer);
      msg.error ? no(new Error(`${context}: ${msg.error.message}`)) : ok(msg.result);
    } else if (msg.method) listeners.forEach((fn) => fn(msg));
  };
}
const send = (method, params = {}, targetSession) => new Promise((ok, no) => {
  if (transportFailure || ws.readyState !== WebSocket.OPEN) { no(transportFailure || new Error(`${currentContext}: 브라우저 연결이 이미 끊겼습니다.`)); return; }
  const id = ++seq, context = currentContext;
  // Rasterization competes with other tasks for CPU/GPU time; allow three ordinary request budgets.
  const limit = timeoutMs(method === "Page.captureScreenshot" ? 90000 : 30000);
  const timer = setTimeout(() => {
    const error = new Error(`${context}: CDP ${method} 요청이 ${limit / 1000}초 안에 응답하지 않았습니다. ${slowHint()}`);
    error.code = "TRANSPORT_TIMEOUT";
    if (method === "Page.navigate") {
      pending.delete(id); error.code = "NAVIGATION_TIMEOUT"; no(error);
    } else if (method === "Page.captureScreenshot" && workerAttempt === "1") {
      pending.delete(id); browserNeedsRestart = true; error.code = "SCREENSHOT_TIMEOUT"; no(error);
    } else abortTransport(error);
  }, limit);
  pending.set(id, { ok, no, timer, context });
  try { ws.send(JSON.stringify({ id, method, params, ...(targetSession ? { sessionId: targetSession } : {}) })); }
  catch { abortTransport(new Error(`${context}: CDP ${method} 요청을 보내는 중 브라우저 연결이 끊겼습니다. 실행을 멈춥니다. ${slowHint()}`)); }
});
try { await connectTransport(wsUrl); } catch { await cleanup(); process.exit(process.exitCode || 1); }

async function setupSend(...args) {
  try { return await send(...args); }
  catch (error) { if (transportFailure) { await cleanup(); process.exit(process.exitCode || 1); } throw error; }
}
const cdp = (method, params) => setupSend(method, params, sessionId);
async function setupSession() {
  const { targetId } = await setupSend("Target.createTarget", { url: "about:blank" });
  ({ sessionId } = await setupSend("Target.attachToTarget", { targetId, flatten: true }));
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Log.enable");
  // WebGL 컨텍스트를 만들지 못했거나 잃은 캔버스를 기록합니다. 캡처는 그대로 끝나지만 캔버스는 비어 있습니다.
  // webgl2가 실패한 뒤 webgl로 되돌아가는 페이지는 실패로 보지 않고, 마지막에 컨텍스트를 받았는지만 봅니다.
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    const gl = window.__jstyleWebgl = { failed: [], ok: [], lost: 0 };
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      const ctx = get.call(this, type, ...rest);
      if (/^(webgl2?|experimental-webgl)$/.test(type)) {
        if (!ctx) gl.failed.push(this);
        else if (!gl.ok.includes(this)) { gl.ok.push(this); this.addEventListener("webglcontextlost", () => gl.lost++); }
      }
      return ctx;
    };
  })()` });
}
await setupSession();
async function restartBrowser() {
  ws.onclose = ws.onerror = ws.onmessage = null; ws.close();
  for (const request of pending.values()) { clearTimeout(request.timer); request.no(new Error("캡처 시간이 초과되어 브라우저를 다시 엽니다.")); }
  pending.clear();
  await stopChrome();
  try {
    await connectTransport(await launchChrome());
    await setupSession(); browserNeedsRestart = false;
  } catch (error) {
    abortTransport(new Error(`브라우저를 다시 열지 못했습니다: ${error.message}. ${slowHint()}`));
    throw error;
  }
}

let problems = [];
function isAutoFavicon(url) {
  try { return new URL(url || "").pathname === "/favicon.ico"; } catch { return false; }
}
listeners.push((m) => {
  if (m.sessionId !== sessionId) return;
  if (m.method === "Runtime.exceptionThrown") problems.push(`스크립트 오류: ${m.params.exceptionDetails?.exception?.description?.split("\n")[0] || m.params.exceptionDetails?.text}`);
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") problems.push(`콘솔 오류: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 200)}`);
  // Browsers ask for /favicon.ico on their own; a mockup without one has no page problem.
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error" && !isAutoFavicon(m.params.entry.url)) problems.push(`불러오기 오류: ${m.params.entry.text.slice(0, 200)} ${m.params.entry.url || ""}`.trim());
});

const evaluate = async (expression) => {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setViewport(w, h, scale) {
  await cdp("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: scale, mobile: w < 600 });
  await cdp("Emulation.setTouchEmulationEnabled", { enabled: w < 600 });
}

async function open(url, wait = Number(opt.wait)) {
  return during(`${currentContext} / 페이지 열기 ${url}`, async () => {
    let loadedListener, timer;
    const loaded = new Promise((ok) => {
      loadedListener = (m) => { if (m.sessionId === sessionId && m.method === "Page.loadEventFired") ok(); };
      listeners.push(loadedListener);
      timer = setTimeout(ok, timeoutMs(15000));
    });
    try {
      let nav, retried = false;
      try { nav = await cdp("Page.navigate", { url }); }
      catch (error) {
        if (error.code !== "NAVIGATION_TIMEOUT") throw error;
        retried = true; await sleep(300); nav = await cdp("Page.navigate", { url });
      }
      // 취소나 시간 초과를 열기 실패로 단정하지 않습니다. 브라우저의 화면 이동이 이 작업을 끊을 수 있으므로 한 번만 더 시도합니다.
      if (!retried && nav.errorText === "net::ERR_ABORTED") { await sleep(300); nav = await cdp("Page.navigate", { url }); }
      if (nav.errorText) throw new Error(`페이지를 열 수 없습니다: ${url} (${nav.errorText})`);
      await loaded;
      await evaluate(`document.fonts ? document.fonts.ready.then(() => true) : true`);
      await sleep(wait);
    } finally {
      clearTimeout(timer); const index = listeners.indexOf(loadedListener); if (index >= 0) listeners.splice(index, 1);
    }
  });
}

async function check() {
  const found = await evaluate(`(() => {
    const out = [];
    const doc = document.documentElement;
    if (doc.scrollWidth > innerWidth + 1) out.push("가로 넘침: 페이지 너비 " + doc.scrollWidth + "px, 화면 너비 " + innerWidth + "px");
    for (const img of document.images) if (img.complete && img.naturalWidth === 0) out.push("이미지를 읽지 못했습니다: " + (img.getAttribute("src") || "").slice(0, 120));
    const gl = window.__jstyleWebgl;
    if (gl) {
      const blank = new Set(gl.failed.filter((c) => !gl.ok.includes(c))).size;
      if (blank) out.push("WebGL: 캔버스 " + blank + "개에서 그리기 컨텍스트를 만들지 못해 캡처가 비어 있습니다");
      if (gl.lost) out.push("WebGL: 그리기 컨텍스트를 " + gl.lost + "번 잃었습니다");
    }
    return out;
  })()`);
  return [...problems, ...found];
}

// ---------- 읽기 쉬움과 그리기 안내: 대비, 작은 글자, 좁은 줄 간격, 투명한 채 멈춤, 잘린 글자, 클릭 대상, 맞춤선, 키트 밖 색 ----------
// 페이지 안에서 실행하므로 바깥 변수를 참조할 수 없습니다.
function lintPage() {
  const LABELS = {
    contrastLow: "글자 대비가 WCAG AA에 못 미칩니다(본문 4.5:1, 큰 글자 3:1 미만. 키트 주색 위 --jk-on-primary 글자는 키트가 정한 예외)",
    smallText: "11px보다 작은 본문", tightLeading: "여러 줄 본문의 줄 간격이 너무 좁습니다",
    stuck: "첫 화면에 투명한 채 멈춘 내용이 있습니다(등장 애니메이션이 시작되지 않았을 수 있습니다)",
    clipped: "말줄임표 없이 잘린 글자", smallTarget: "24px보다 작은 클릭 대상", overlapTarget: "서로 겹친 클릭 대상",
    scatteredEdges: "첫 화면에서 다른 글과 줄이 맞지 않는 왼쪽 시작점", offKitColor: "키트 토큰에 없는 색",
  };
  const found = new Map();
  const describe = (el) => {
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24);
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + cls + (text ? ' "' + text + '"' : "");
  };
  const add = (rule, el, note) => {
    let r = found.get(rule);
    if (!r) found.set(rule, r = { rule, label: LABELS[rule], count: 0, examples: [] });
    r.count++;
    if (r.examples.length < 3) r.examples.push(describe(el) + (note ? "(" + note + ")" : ""));
  };
  const css = (el, pseudo) => getComputedStyle(el, pseudo);
  const shown = (el) => {
    const r = el.getBoundingClientRect(), s = css(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  // 색을 캔버스에 그린 뒤 다시 읽습니다. 그래서 oklch, color-mix로 쓴 색도 비교할 수 있습니다.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const colors = new Map();
  const rgba = (value) => {
    if (!ctx || !value) return { r: 0, g: 0, b: 0, a: 0 };
    if (colors.has(value)) return colors.get(value);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.fillStyle = value;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const c = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
    colors.set(value, c);
    return c;
  };
  const luminance = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a), a: 1,
  });
  const media = [...document.querySelectorAll("img,video,canvas,picture,iframe,svg image")]
    .filter(shown).map((m) => m.getBoundingClientRect()).filter((r) => r.width * r.height > 2000);
  const overMedia = (r) => media.some((m) => {
    const w = Math.min(r.right, m.right) - Math.max(r.left, m.left), h = Math.min(r.bottom, m.bottom) - Math.max(r.top, m.top);
    return w > 0 && h > 0 && w * h > r.width * r.height * 0.3;
  });
  // 글자 뒤의 바탕색: 조상을 따라 올라가며 색을 겹칩니다. 바탕 이미지, 그라디언트, 미디어가 있으면 알 수 없는 것으로 봅니다.
  const backdrop = (el) => {
    const layers = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const s = css(node);
      if (s.backgroundImage !== "none") return null;
      const c = rgba(s.backgroundColor);
      if (c.a > 0) { layers.push(c); if (c.a >= 0.99) break; }
    }
    return layers.reverse().reduce((base, c) => over(c, base), { r: 255, g: 255, b: 255, a: 1 });
  };
  // The kit keeps white on its product green (about 2.6:1) on purpose; see references/extended/kit.md.
  const kitPrimaryValue = getComputedStyle(document.documentElement).getPropertyValue("--jk-primary").trim();
  const kitPrimary = kitPrimaryValue ? rgba(kitPrimaryValue) : null;
  const kitOnPrimary = kitPrimary ? rgba(getComputedStyle(document.documentElement).getPropertyValue("--jk-on-primary").trim() || "#fff") : null;
  const sameColor = (a, b) => Math.abs(a.r - b.r) <= 2 && Math.abs(a.g - b.g) <= 2 && Math.abs(a.b - b.b) <= 2;
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
  const all = [...document.body.querySelectorAll("*")].slice(0, 8000)
    .filter((el) => !el.closest("svg,script,style,noscript,template,head,[aria-hidden='true'],#jstyle-mark"));
  const texts = all.filter((el) => ownText(el).length >= 2 && shown(el));

  const isAncestor = (anc, node) => {
    for (let p = node; p; p = p.parentElement) if (p === anc) return true;
    return false;
  };
  const containingRect = (node, pos) => {
    if (pos === "fixed") return { left: 0, top: 0 };
    for (let p = node; p && p.nodeType === 1; p = p.parentElement) {
      if (css(p).position !== "static") return p.getBoundingClientRect();
    }
    return document.documentElement?.getBoundingClientRect?.() || { left: 0, top: 0 };
  };
  const hasOverlayPlate = (el, r) => {
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      for (const pseudo of ["::before", "::after"]) {
        const ps = css(node, pseudo);
        if (!ps || !ps.content || ps.content === "none" || !(ps.backgroundImage !== "none" || rgba(ps.backgroundColor).a > 0.05)) continue;
        const pw = parseFloat(ps.width), ph = parseFloat(ps.height);
        if (!(pw >= r.width * 0.5 && ph >= r.height * 0.5)) continue;
        const base = (ps.position === "absolute" || ps.position === "fixed") ? containingRect(node, ps.position) : node.getBoundingClientRect();
        const pl = base.left + (parseFloat(ps.left) || 0), pt = base.top + (parseFloat(ps.top) || 0);
        if (cx >= pl && cx <= pl + pw && cy >= pt && cy <= pt + ph) return true;
      }
      if (rgba(css(node).backgroundColor).a >= 0.99) break;
    }
    return all.some((other) => {
      if (other === el || isAncestor(other, el) || isAncestor(el, other)) return false;
      const or = other.getBoundingClientRect();
      if (cx < or.left || cx > or.right || cy < or.top || cy > or.bottom) return false;
      const os = css(other);
      return os.backgroundImage !== "none" || rgba(os.backgroundColor).a > 0.05;
    });
  };

  for (const el of texts) {
    const s = css(el), r = el.getBoundingClientRect();
    if (el.closest("button:disabled,[disabled],[aria-disabled='true'],input,textarea,select,option")) continue;
    const size = parseFloat(s.fontSize);
    let alpha = 1;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) alpha *= parseFloat(css(node).opacity);
    const bg = overMedia(r) ? null : backdrop(el);
    const fg = rgba(s.color);
    if (bg && alpha > 0.05 && fg.a > 0) {
      const color = over({ ...fg, a: fg.a * alpha }, bg);
      const contrast = ratio(color, bg);
      const large = size >= 24 || (size >= 18.6 && parseInt(s.fontWeight, 10) >= 700);
      // 대비가 1.5:1 미만이고 뒤에 조상이 아닌 바탕이나 가상 요소(슬라이더, 절대 위치의 둥근 꼬리표)가 있으면 대비를 잘못 알리지 않습니다. 바탕색을 알면 낮은 대비를 그대로 알립니다
      if (!(contrast < 1.5 && hasOverlayPlate(el, r))) {
        const kitPair = kitPrimary && sameColor(bg, kitPrimary) && sameColor(color, kitOnPrimary);
        if (!kitPair && contrast < (large ? 3 : 4.5)) add("contrastLow", el, contrast.toFixed(2) + ":1");
      }
    }
    // 본문: 두 줄 이상인 문단
    const text = ownText(el);
    const isCjk = /[\u3400-\u9fff\uac00-\ud7af]/.test(text);
    if (text.length < (isCjk ? 30 : 60) || el.closest("code,pre,table,nav,button,label,figcaption,kbd")) continue;
    const lh = s.lineHeight === "normal" ? size * 1.2 : parseFloat(s.lineHeight);
    if (r.height < lh * 1.8) continue;
    if (size < 11) add("smallText", el, size + "px");
    if (lh / size < (isCjk ? 1.4 : 1.3)) add("tightLeading", el, (lh / size).toFixed(2));
  }

  // 첫 화면에서 투명한 내용: 등장하지 않으면 캡처에 빈 곳이 생깁니다
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.top >= innerHeight || r.bottom <= 0 || r.width < 40 || r.height < 16) continue;
    if (!(ownText(el).length >= 4 || (el.tagName === "IMG" && el.complete))) continue;
    if (el.closest("[role='dialog'],[role='tooltip'],[role='menu'],[hidden],dialog:not([open]),details:not([open])")) continue;
    let alpha = 1, hider = null;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const o = parseFloat(css(node).opacity);
      if (o < 0.5 && !hider) hider = node;
      alpha *= o;
    }
    if (alpha >= 0.05 || !hider) continue;
    const hs = css(hider);
    if (/absolute|fixed/.test(hs.position) || hs.pointerEvents === "none" || css(el).visibility === "hidden") continue;
    add("stuck", el);
  }

  // 잘린 글자: 넘친 내용을 숨겼는데 말줄임표나 줄 수 제한이 없으면 글이 말없이 잘립니다.
  for (const el of texts) {
    const s = css(el);
    // 1~2px 상자는 화면 읽기 프로그램 전용 글자(visually hidden)입니다.
    if (el.closest("input,textarea,select,option,[contenteditable]") || el.clientWidth <= 2 || el.clientHeight <= 2) continue;
    const clampX = /hidden|clip/.test(s.overflowX) && s.textOverflow !== "ellipsis" && el.scrollWidth > el.clientWidth + 1;
    const clamped = s.webkitLineClamp && s.webkitLineClamp !== "none";
    const clampY = /hidden|clip/.test(s.overflowY) && !clamped && el.scrollHeight > el.clientHeight + 2;
    if (clampX || clampY) add("clipped", el, clampX ? `너비 ${el.clientWidth}px, 내용 ${el.scrollWidth}px` : `높이 ${el.clientHeight}px, 내용 ${el.scrollHeight}px`);
  }

  // 클릭 대상: WCAG 2.5.8은 24px 이상이거나 주변에 충분한 간격을 요구합니다. 문장 안의 링크는 예외입니다.
  const targets = all.filter((el) => el.matches("a[href],button,select,textarea,summary,input:not([type='hidden']),[role='button'],[role='tab'],[role='checkbox'],[role='switch'],[role='menuitem'],[tabindex]:not([tabindex='-1'])")
    && shown(el) && !el.closest("[disabled],[aria-disabled='true']")).slice(0, 600);
  const inSentence = (el) => el.tagName === "A" && [...(el.parentElement?.childNodes || [])].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
  // 스크롤 상자나 overflow 조상이 가린 부분은 누를 수 없으므로 보이는 영역만 남깁니다.
  const visibleRect = (el, rect) => {
    let { left, right, top, bottom } = rect;
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const ns = css(node);
      if (ns.overflowX === "visible" && ns.overflowY === "visible") continue;
      const nr = node.getBoundingClientRect();
      left = Math.max(left, nr.left); right = Math.min(right, nr.right); top = Math.max(top, nr.top); bottom = Math.min(bottom, nr.bottom);
    }
    return right > left && bottom > top ? { left, right, top, bottom, width: right - left, height: bottom - top } : null;
  };
  const boxes = targets.map((el) => {
    let r = el.getBoundingClientRect();
    // 숨긴 체크박스·라디오는 연결된 label이 실제 클릭 영역입니다.
    if (el.matches("input[type='checkbox'],input[type='radio']") && el.labels?.length) r = el.labels[0].getBoundingClientRect();
    const full = r;
    r = visibleRect(el, r);
    return r && { el, r, full };
  }).filter(Boolean);
  const hit = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;
  for (const { el, r, full } of boxes) {
    if (!(r.width < 24 || r.height < 24) || inSentence(el) || r.width <= 0) continue;
    if (r.width < full.width - 1 || r.height < full.height - 1) continue;
    // 간격 예외: 대상 중심의 24px 상자가 다른 대상과 닿지 않으면 통과합니다.
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const zone = { left: cx - 12, right: cx + 12, top: cy - 12, bottom: cy + 12 };
    if (boxes.some((o) => o.el !== el && !o.el.contains(el) && !el.contains(o.el) && hit(zone, o.r))) add("smallTarget", el, `${Math.round(r.width)}x${Math.round(r.height)}px`);
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i], b = boxes[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      // 큰 행 위에 올린 작은 버튼처럼 한쪽이 다른 쪽 안에 완전히 들어가면 의도한 배치로 봅니다.
      const inside = (x, y) => x.left >= y.left - 1 && x.right <= y.right + 1 && x.top >= y.top - 1 && x.bottom <= y.bottom + 1;
      if (inside(a.r, b.r) || inside(b.r, a.r)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left), h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > 2 && h > 2) add("overlapTarget", a.el, describe(b.el));
    }
  }

  // 첫 화면의 왼쪽 시작점: 다른 어떤 글과도 줄이 맞지 않는 시작점이 여럿이면 배치가 흩어져 보입니다.
  const edges = texts.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.top < innerHeight && r.bottom > 0 && r.width >= 40 && css(el).display !== "inline" && !el.closest("table,nav,button,[role='tab'],ul,ol,label,a,code,pre");
  }).map((el) => ({ el, x: Math.round(el.getBoundingClientRect().left) }));
  const lone = edges.filter((e) => !edges.some((o) => o !== e && Math.abs(o.x - e.x) <= 2));
  if (edges.length >= 8 && lone.length >= 4) for (const e of lone) add("scatteredEdges", e.el, `x=${e.x}`);

  // 키트를 쓰는 화면에서 키트 토큰에 없는 색: 정적 검사가 못 보는 인라인·JS 스타일까지 잡습니다.
  // 글자가 없는 채움(아이콘 타일, 차트 막대)은 키트 문서가 잰 값을 그대로 쓰도록 허용하므로 보지 않습니다.
  if (kitPrimary) {
    const palette = [{ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }];
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      const kitSheet = /\/kit\.css(?:[?#]|$)/.test(sheet.href || "");
      const walk = (list) => {
        for (const rule of list) {
          if (rule.cssRules) walk(rule.cssRules);
          if (!rule.style) continue;
          for (const name of rule.style) {
            const value = rule.style.getPropertyValue(name).trim();
            if (name.startsWith("--jk-")) { const c = rgba(value); if (c.a > 0) palette.push(c); }
            // 키트 파일이 컴포넌트에 직접 쓴 색(파일 아이콘, 타일 등)도 키트의 색으로 봅니다.
            else if (kitSheet) for (const m of value.match(/#[0-9a-f]{3,8}\b|rgba?\([^()]*\)/gi) || []) { const c = rgba(m); if (c.a > 0) palette.push(c); }
          }
        }
      };
      walk(rules);
    }
    const known = (c) => palette.some((p) => sameColor(p, c));
    const seen = new Map();
    for (const el of all) {
      // style="--jk-hue:160"처럼 키트 컴포넌트가 정한 자리로 고른 색은 키트 안의 선택입니다.
      if (!shown(el) || el.closest("svg,canvas,img,video,[data-jk-chart],.jk-chart") || /--jk-/.test(el.getAttribute("style") || "")) continue;
      const s = css(el);
      for (const [prop, value] of [["color", ownText(el) ? s.color : ""], ["background", (el.innerText || "").trim() ? s.backgroundColor : ""], ["border", (el.innerText || "").trim() && s.borderTopWidth !== "0px" && s.borderTopStyle !== "none" ? s.borderTopColor : ""]]) {
        const c = rgba(value);
        if (c.a < 0.99 || known(c)) continue;
        const key = `${prop} rgb(${c.r} ${c.g} ${c.b})`;
        if (seen.has(key)) continue;
        seen.set(key, true);
        add("offKitColor", el, key);
      }
    }
  }

  return [...found.values()];
}

async function lint() {
  try {
    return await evaluate(`(${lintPage.toString()})()`);
  } catch (error) {
    return [{ rule: "lintError", label: "읽기 쉬움 검사를 끝내지 못했습니다", count: 1, examples: [error.message.slice(0, 160)] }];
  }
}
const lintLine = (items) => items.map((i) => `${i.label} ${i.count}곳(${i.examples.join(", ")})`).join("; ");

async function settleAnimations(limit) {
  if (limit <= 0) return 0;
  return during(`${currentContext} / 끝나는 애니메이션을 기다립니다`, () => evaluate(`(async () => {
    const start = performance.now(), limit = ${limit};
    let waited = false;
    while (true) {
      const animations = document.getAnimations().filter((a) => (a.playState === "running" || a.pending) && a.effect
        && Number.isFinite(a.effect.getComputedTiming().endTime));
      if (!animations.length || performance.now() - start >= limit) break;
      waited = true;
      await Promise.race([Promise.all(animations.map((a) => a.finished.catch(() => {}))),
        new Promise((ok) => setTimeout(ok, Math.min(50, Math.max(0, limit - (performance.now() - start))))) ]);
    }
    return waited ? Math.min(limit, Math.round(performance.now() - start)) : 0;
  })()`));
}

async function selectorClip() {
  try {
    await locate(selector, "--selector", false, "screenshot");
    const box = await evaluate(`(async () => {
      const el = (${findSource})(${JSON.stringify(selector)})[0];
      if (!el) return null;
      const r0 = el.getBoundingClientRect();
      const hasTopBar = [...document.body.querySelectorAll("*")].slice(0, 1000).some((n) => {
        if (n === el || n.contains(el) || el.contains(n)) return false;
        const pos = getComputedStyle(n).position;
        if (pos !== "fixed" && pos !== "sticky") return false;
        const nr = n.getBoundingClientRect();
        return nr.width > innerWidth * 0.3 && nr.height > 0 && nr.height <= 160 && nr.top <= 24 && nr.bottom > 0;
      });
      if (r0.height > innerHeight * 0.65 || hasTopBar) {
        el.scrollIntoView({ block: "nearest", inline: "center", behavior: "instant" });
        const r1 = el.getBoundingClientRect();
        window.scrollTo({ top: Math.max(0, r1.top + scrollY - 72), left: scrollX, behavior: "instant" });
      } else {
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      }
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      const r = el.getBoundingClientRect();
      return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
    })()`);
    if (!box || box.width <= 0 || box.height <= 0) throw new Error(`--selector: 요소가 없거나 너비나 높이가 0입니다: ${opt.selector}`);
    return { ...box, scale: flags.has("thumb") ? 0.5 : 1 };
  } catch (error) {
    if (transportFailure) throw error;
    await cleanup(); fail(error.message);
  }
}
async function screenshot(file, full, clipOverride = null) {
  let clip = clipOverride;
  if (full) {
    const { contentSize } = await cdp("Page.getLayoutMetrics");
    clip = { x: 0, y: 0, width: Math.ceil(contentSize.width), height: Math.ceil(contentSize.height), scale: 1 };
  }
  const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: !!full || !!clip, ...(clip ? { clip } : {}) });
  writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

// Keep color intact: SVG icons and CSS decorations may use currentColor.
const MASK_CSS = `*,*::before,*::after{text-shadow:none!important;-webkit-text-fill-color:transparent!important;caret-color:transparent!important}
::placeholder{color:transparent!important}svg text,svg tspan{fill:transparent!important;stroke:transparent!important}`;
const mask = () => evaluate(`(() => { const s = document.createElement("style"); s.id = "jstyle-mask"; s.textContent = ${JSON.stringify(MASK_CSS)}; document.head.append(s); return true; })()`);

// 표시한 그림: 테두리와 번호를 페이지 맨 위 층에 문서 좌표로 그리므로 전체 페이지를 찍어도 위치가 맞습니다.
async function mark() {
  for (const { selector } of marks) await locate(selector, "--mark", false);
  const result = await evaluate(`((selectors) => {
    const find = ${findSource};
    const layer = document.createElement("div");
    layer.id = "jstyle-mark";
    layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none";
    const color = "#e8175d";
    const missing = [];
    selectors.forEach(({ label, selector }) => {
      let found;
      try { found = find(selector); } catch { missing.push(selector + " (선택자를 잘못 썼습니다)"); return; }
      const boxes = found.map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
      if (!boxes.length) { missing.push(selector + (found.length ? " (요소가 보이지 않음)" : "")); return; }
      boxes.forEach((r, j) => {
        const box = document.createElement("div");
        box.style.cssText = "position:absolute;box-sizing:border-box;border:2px solid " + color + ";border-radius:3px;" +
          "left:" + (r.left + scrollX - 4) + "px;top:" + (r.top + scrollY - 4) + "px;width:" + (r.width + 8) + "px;height:" + (r.height + 8) + "px";
        if (j === 0) {
          // 작은 요소의 번호는 요소를 가리지 않도록 테두리 밖에 둡니다. 왼쪽에 자리가 없으면 오른쪽에 놓습니다.
          const small = r.width < 48 || r.height < 28;
          const pos = !small ? "left:-12px;top:-12px" : r.left + scrollX - 34 >= 0 ? "left:-30px;top:" + (r.height / 2 - 7) + "px" : "right:-30px;top:" + (r.height / 2 - 7) + "px";
          const tag = document.createElement("span");
          tag.textContent = label;
          tag.style.cssText = "position:absolute;" + pos + ";min-width:22px;height:22px;padding:0 6px;box-sizing:border-box;border-radius:11px;" +
            "background:" + color + ";color:#fff;font:600 13px/22px -apple-system,'PingFang SC',sans-serif;text-align:center;box-shadow:0 0 0 2px #fff";
          box.append(tag);
        }
        layer.append(box);
      });
    });
    document.body.append(layer);
    return missing;
  })(${JSON.stringify(marks)})`);
  if (result.length) throw new Error(`--mark로 표시할 요소를 찾지 못했습니다: ${result.join("; ")}`);
}
const unmark = () => evaluate(`(document.getElementById("jstyle-mark")?.remove(), true)`);

// ---------- 동작 ----------
// Serialized into the page; each helper includes its own dependencies.
function hiddenReason(el) {
  const describe = (e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "");
  for (let e = el; e; e = e.parentElement) {
    const style = getComputedStyle(e);
    const owner = e === el ? "" : "조상 요소 " + describe(e) + "에서 숨김: ";
    if (style.display === "none") return owner + "display:none";
    // An ancestor's hidden visibility can be overridden by the child.
    if (e === el && (style.visibility === "hidden" || style.visibility === "collapse")) {
      let owner = e;
      while (owner.parentElement && getComputedStyle(owner.parentElement).visibility === style.visibility) owner = owner.parentElement;
      return (owner === el ? "" : "조상 요소 " + describe(owner) + "에서 숨김: ") + "visibility:" + style.visibility;
    }
    if (Number(style.opacity) === 0) return owner + "opacity:0";
    if (style.contentVisibility === "hidden") return owner + "content-visibility:hidden";
    if (e !== el && e.tagName === "DETAILS" && !e.open && !e.querySelector(":scope > summary")?.contains(el)) return "조상 요소 " + describe(e) + "에서 숨김: details가 닫혀 있음";
  }
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return "크기 0(너비 " + r.width + "px, 높이 " + r.height + "px)";
  if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return "조상 요소나 브라우저 배치가 숨겼습니다";
  return null;
}
// Normalize at lookup time so existing --dry-run selector objects remain byte-for-byte stable.
// Read quoted strings/brackets before recognizing Playwright operators: their literals are CSS data.
function compatibleSelector(selector) {
  if (selector.kind === "text") return selector;
  const source = selector.kind === "has-text" ? selector.css : selector.value;
  const received = selector.kind === "has-text" ? `${selector.css}:has-text(${JSON.stringify(selector.value)})` : source;
  const filters = [], legacyText = selector.kind === "has-text" ? selector.value : null;
  let css = "", nth, depth = 0;
  const unsupported = () => {
    const value = filters[0]?.value ?? legacyText ?? "Send money";
    const error = new Error(`선택자를 바꿀 수 없습니다. 받은 값: ${received}. 글로 찾거나 CSS를 쓰세요. 차례 번호는 0부터 셉니다`);
    error.selectorExample = filters.length || legacyText !== null ? `text=${JSON.stringify(value)}` : `${!depth && css.trim() || ".item"} >> nth=1`;
    throw error;
  };
  const quotedEnd = (start) => {
    for (let i = start + 1; i < source.length; i++) {
      if (source[i] === "\\") { i++; continue; }
      if (source[i] === source[start]) return i;
    }
    unsupported();
  };
  for (let i = 0; i < source.length;) {
    const c = source[i];
    if (c === "\\") { css += source.slice(i, i + 2); i += 2; continue; }
    if (c === '"' || c === "'") { const end = quotedEnd(i); css += source.slice(i, end + 1); i = end + 1; continue; }
    if (c === "[") {
      let end = i + 1;
      for (; end < source.length && source[end] !== "]"; end++) {
        if (source[end] === "\\") end++;
        else if (source[end] === '"' || source[end] === "'") end = quotedEnd(end);
      }
      const attr = source.slice(i, end + 1);
      css += attr.replace(/^(\[\s*[^\s~|^$*!=\]]+\s*[~|^$*]?=\s*)(\d[^\s"'\\\[\]]*)(\s*(?:[is]\s*)?\])$/, (_, prefix, value, suffix) => prefix + JSON.stringify(value) + suffix);
      i = end + 1; continue;
    }
    if (source.startsWith(">>", i)) {
      if (depth || legacyText !== null) unsupported();
      const match = source.slice(i).match(/^>>\s*nth\s*=\s*(-?\d+)\s*$/);
      if (!match || !Number.isSafeInteger(Number(match[1]))) unsupported();
      nth = Number(match[1]); break;
    }
    const pseudo = source.slice(i).match(/^:(has-text|text-is)\(/);
    if (pseudo) {
      let end = i + pseudo[0].length, start = end;
      for (; end < source.length && source[end] !== ")"; end++) {
        if (source[end] === "\\") end++;
        else if (source[end] === '"' || source[end] === "'") end = quotedEnd(end);
        else if (source[end] === "(") unsupported();
      }
      if (end >= source.length) unsupported();
      const argument = source.slice(start, end).trim();
      const quoted = /^("|')[\s\S]*\1$/.test(argument);
      if (!quoted && /["']/.test(argument)) unsupported();
      const value = quoted ? argument.slice(1, -1).replace(/\\(["'\\])/g, "$1") : argument;
      filters.push({ exact: pseudo[1] === "text-is", value });
      if (depth) unsupported();
      i = end + 1; continue;
    }
    // A descendant/combinator after a text filter changes the subject; do not silently drop it.
    if (filters.length && depth === 0 && /[\s>+~,]/.test(c) && source.slice(i).trim() && !source.slice(i).trimStart().startsWith(">>")) unsupported();
    if (c === "(") depth++;
    if (c === ")") depth--;
    css += c; i++;
  }
  if (legacyText !== null) filters.push({ exact: false, value: legacyText });
  if (!filters.length) return { kind: "css", value: css.trim(), ...(nth === undefined ? {} : { nth }) };
  return { kind: "filtered-text", css: css.trim() || "*", value: filters[0].value, filters, ...(nth === undefined ? {} : { nth }) };
}
function findElements(selector, includeHidden = false) {
  selector = compatibleSelector(selector);
  const reason = hiddenReason;
  const text = (el) => (includeHidden && reason(el) ? el.textContent : typeof el.innerText === "string" ? el.innerText : el.textContent || "").trim().replace(/\s+/g, " ");
  let all = [...document.querySelectorAll(selector.kind === "css" ? selector.value : selector.css || "*")];
  if (selector.kind === "filtered-text") {
    all = all.filter((el) => !el.closest("script,style,template,noscript,head") && selector.filters.every((f) => {
      const wanted = f.value.trim().replace(/\s+/g, " ");
      return f.exact ? text(el) === wanted : text(el).includes(wanted);
    }));
    // Unscoped text lookup uses the existing deepest-text-first behavior instead of clicking body.
    if (selector.css === "*") all.sort((a, b) => {
      const depth = (el) => { let n = 0; for (; el; el = el.parentElement) n++; return n; };
      return depth(b) - depth(a);
    });
  }
  if (selector.nth !== undefined) {
    const index = selector.nth < 0 ? all.length + selector.nth : selector.nth;
    all = index >= 0 && index < all.length ? [all[index]] : [];
  }
  const visible = all.filter((el) => !reason(el));
  if (selector.kind === "css" || selector.kind === "filtered-text") return includeHidden ? all : visible;
  const wanted = selector.value.trim().replace(/\s+/g, " ");
  const match = (pool) => {
    // Script literals and metadata are not page text, including in hidden-match diagnostics.
    pool = pool.filter((el) => !el.closest("script,style,template,noscript,head"));
    let found = pool.filter((el) => text(el) === wanted);
    if (!found.length) found = pool.filter((el) => text(el).includes(wanted));
    const depth = (el) => { let n = 0; for (; el; el = el.parentElement) n++; return n; };
    found.sort((a, b) => depth(b) - depth(a) || Number(b.matches("button,a,[role=button],input,label,summary,[tabindex]")) - Number(a.matches("button,a,[role=button],input,label,summary,[tabindex]")));
    return found;
  };
  return includeHidden ? match(all) : match(visible).slice(0, 1);
}
const findSource = findElements.toString().replace("selector = compatibleSelector(selector);", "selector = (" + compatibleSelector.toString() + ")(selector);")
  .replace("const reason = hiddenReason;", "const reason = " + hiddenReason.toString() + ";");
async function locate(selector, context, scroll = true, action = "click", params = {}) {
  const result = await evaluate(String.raw`((selector) => {
    const find = ${findSource}, reason = ${hiddenReason.toString()};
    let found, usable;
    try { found = find(selector, true); usable = find(selector); } catch (error) { return { invalid: true, detail: error.message, selectorExample: error.selectorExample }; }
    const el = usable[0];
    if (el) {
      let r = el.getBoundingClientRect();
      if (${scroll} && (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth)) {
        el.scrollIntoView({ block: "center", inline: "center" }); r = el.getBoundingClientRect();
      }
      const x = Math.max(1, Math.min(innerWidth - 1, r.left + r.width / 2)), y = Math.max(1, Math.min(innerHeight - 1, r.top + r.height / 2));
      const warnings = [];
      if (${scroll && ["click", "dblclick", "hover"].includes(action)}) {
        const identify = (element) => {
          const parts = [];
          for (let e = element; e; e = e.parentElement) {
            let part = e.localName;
            if (e.id) part += "#" + CSS.escape(e.id);
            else {
              part += [...e.classList].slice(0, 3).map((c) => "." + CSS.escape(c)).join("");
              const siblings = e.parentElement ? [...e.parentElement.children].filter((s) => s.localName === e.localName) : [e];
              if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(e) + 1) + ")";
            }
            parts.unshift(part);
            if (document.querySelectorAll(parts.join(" > ")).length === 1) break;
          }
          return parts.join(" > ");
        };
        const top = document.elementFromPoint(x, y);
        if (top && top !== el && !el.contains(top)) warnings.push("요소 가운데가 " + identify(top) + "에 가려져 있습니다. 동작은 그대로 실행합니다");
        const disabled = [];
        if (el.hasAttribute("disabled") || el.matches(":disabled")) disabled.push("disabled");
        if (el.getAttribute("aria-disabled")?.toLowerCase() === "true") disabled.push('aria-disabled="true"');
        if (getComputedStyle(el).pointerEvents === "none") disabled.push("pointer-events: none");
        if (disabled.length) warnings.push("대상이 비활성 상태입니다(" + disabled.join(", ") + "). 동작은 그대로 실행합니다");
      }
      return { x, y, warnings };
    }
    const hints = [], suggestions = [];
    const css = selector.kind === "css" ? selector.value : selector.css || "";
    const attrs = [...css.matchAll(/\[([^\s~|^$*!=\]]+)(?:[^\]]*)\]/g)].map((m) => m[1]);
    for (const attr of selector.kind === "css" ? [...new Set(attrs)] : []) {
      const candidates = [...document.querySelectorAll("*")].filter((e) => e.hasAttribute(attr));
      candidates.sort((a, b) => Number(!!reason(a)) - Number(!!reason(b)));
      const seen = new Set();
      for (const e of candidates) {
        const value = e.getAttribute(attr); if (seen.has(value)) continue; seen.add(value);
        const query = "[" + CSS.escape(attr) + "=" + JSON.stringify(value) + "]";
        if (hints.length < 5) hints.push(attr + "=" + JSON.stringify(value) + (reason(e) ? " (보이지 않음)" : ""));
        if (!reason(e)) suggestions.push(query);
      }
      if (!candidates.length && hints.length < 5) hints.push("페이지에 " + attr + " 속성이 없습니다");
    }
    if (selector.kind !== "css") {
      const distance = ${distance.toString()};
      const texts = [...new Set([...document.querySelectorAll("body *")].filter((e) => !reason(e))
        .map((e) => (typeof e.innerText === "string" ? e.innerText : e.textContent || "").trim().replace(/\s+/g, " ")).filter((t) => t && t.length < 160))];
      const wanted = selector.value.trim().replace(/\s+/g, " ");
      const contains = (t) => t.includes(wanted) || wanted.includes(t);
      texts.sort((a, b) => Number(contains(b)) - Number(contains(a)) || distance(a, wanted) - distance(b, wanted));
      hints.push(...texts.slice(0, 5).map((t) => "보이는 글 " + JSON.stringify(t)));
      suggestions.push(...texts.slice(0, 5).map((t) => "text=" + JSON.stringify(t)));
    }
    if (!hints.length) {
      const prefix = css.replace(/\s*[^\s]+$/, "").replace(/[>+~]\s*$/, "").trim();
      let matches = []; try { if (prefix) matches = [...document.querySelectorAll(prefix)]; } catch {}
      hints.push("마지막 부분을 뺀 " + JSON.stringify(prefix || "(빈 값)") + "에 맞는 요소 " + matches.length + "개");
      if (matches.some((e) => !reason(e))) suggestions.push(prefix);
    }
    const closed = found[0]?.closest("details:not([open])"), summary = closed?.querySelector(":scope > summary");
    const opener = summary && !reason(summary) ? (closed.id ? "#" + CSS.escape(closed.id) + " > summary" : "details:not([open]) > summary") : null;
    let iframes = 0, shadowRoots = 0;
    if (!found.length) {
      const roots = [document];
      for (let i = 0; i < roots.length; i++) for (const e of roots[i].querySelectorAll("*")) {
        if (e.localName === "iframe") iframes++;
        if (e.shadowRoot) { shadowRoots++; roots.push(e.shadowRoot); }
      }
    }
    return { opener, missing: !found.length, count: found.length, reasons: [...new Set(found.map(reason))].slice(0, 5), hints: hints.slice(0, 5), suggestion: suggestions[0], iframes, shadowRoots };
  })(${JSON.stringify(selector)})`);
  const source = selector.kind === "css" ? selector.value : selector.kind === "text" ? `text=${selector.value}` : `${selector.css}:has-text(${JSON.stringify(selector.value)})`;
  const suffix = action === "drag" ? ` ${params.dx ?? 0} ${params.dy ?? 0}` : ["type", "fill"].includes(action) ? ` ${JSON.stringify(params.text ?? "글자")}` : action === "select" ? ` ${JSON.stringify(params.value ?? "선택지")}` : "";
  const example = result.opener && !result.suggestion ? `click ${result.opener}` : `${action} ${result.suggestion || (selector.kind === "css" ? ".open" : 'text="Send money"')}${suffix}`;
  if (result.invalid && result.detail?.startsWith("선택자를 바꿀 수 없습니다")) {
    const selectorExample = ["type", "fill", "select"].includes(action) ? JSON.stringify(result.selectorExample) : result.selectorExample;
    const rewrite = context === "--mark" ? `--mark ${quoteArg(`1=${result.selectorExample}`)}` : `${action} ${selectorExample}${suffix}`;
    throw new Error(`${context}: ${result.detail}. 예: ${rewrite}`);
  }
  if (result.invalid) throw new Error(`${context}: 올바른 CSS 선택자가 아닙니다. 받은 값: ${source}. text="Send money"나 button:has-text("Undo")처럼 글로 찾을 수도 있습니다. 예: ${action} text="Send money"${suffix}`);
  const scope = result.iframes || result.shadowRoots ? `. 첫 문서 안에서만 요소를 찾습니다. 페이지에 iframe ${result.iframes}개, 열린 shadow root ${result.shadowRoots}개가 있습니다` : "";
  if (result.missing) throw new Error(`${context}: 요소를 찾지 못했습니다: ${source}. 단서: ${result.hints.join("; ")}. 예: ${example}${scope}`);
  if (result.count) throw new Error(`${context}: ${source}에 맞는 요소 ${result.count}개가 모두 보이지 않아 다룰 수 없습니다(${result.reasons.join("; ")}). 보이게 하는 앞 단계를 먼저 실행하거나 지금 보이는 요소로 바꾸세요. 단서: ${result.hints.join("; ")}. 예: ${example}`);
  for (const warning of result.warnings || []) {
    const message = `${context}: ${warning}`;
    problems.push(message); console.log(`안내: ${message}`);
  }
  return result;
}
const KEYS = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27, Tab: 9, " ": 32, Space: 32, Home: 36, End: 35, PageUp: 33, PageDown: 34, Backspace: 8, Delete: 46 };
const mouse = (type, x, y, extra = {}) => cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", pointerType: "mouse", ...extra });
async function runSteps(steps = [], observer = {}) {
  for (const [i, step] of steps.entries()) {
    const { action, selector, params } = step;
    const context = `${i + 1}단계 "${step.raw}"`;
    await during(`${currentContext} / ${context}`, async () => {
      await observer.step?.(step, i);
      if (action === "wait") { await sleep(params.ms); return; }
      if (action === "waitfor") {
        const end = Date.now() + timeoutMs(5000);
        while (true) {
          try { await locate(selector, context, false, action, params); break; }
          catch (error) { if ((!error.message.includes("요소를 찾지 못했습니다") && !error.message.includes("모두 보이지 않아")) || Date.now() >= end) throw error; await sleep(100); }
        }
        return;
      }
      if (["click", "hover", "dblclick", "drag"].includes(action)) {
        const p = await locate(selector, context, true, action, params);
        await mouse("mouseMoved", p.x, p.y);
        if (action === "hover") { await sleep(200); return; }
        await observer.before?.(step, i);
        await mouse("mousePressed", p.x, p.y, { clickCount: 1, buttons: 1 });
        if (action === "drag") {
          for (let n = 1; n <= 24; n++) { await mouse("mouseMoved", p.x + params.dx * n / 24, p.y + params.dy * n / 24, { buttons: 1 }); await sleep(16); }
          await mouse("mouseReleased", p.x + params.dx, p.y + params.dy, { clickCount: 1 });
        } else {
          await mouse("mouseReleased", p.x, p.y, { clickCount: 1 });
          if (action === "dblclick") {
            await mouse("mousePressed", p.x, p.y, { clickCount: 2 }); await mouse("mouseReleased", p.x, p.y, { clickCount: 2 });
          }
        }
        await observer.after?.(step, i);
        await sleep(120);
      } else if (["type", "fill", "select"].includes(action)) {
        await locate(selector, context, false, action, params);
        await observer.before?.(step, i);
        await evaluate(`(() => {
          const el = (${findSource})(${JSON.stringify(selector)})[0];
          el.focus();
          ${action === "select" ? `if (!(el instanceof HTMLSelectElement)) throw new Error(${JSON.stringify(`${context}: select에는 기본 select 요소가 필요합니다. 예: select #country China`)});
          const option = [...el.options].find((o) => o.value === ${JSON.stringify(params.value)}) || [...el.options].find((o) => o.textContent.trim() === ${JSON.stringify(params.value)});
          if (!option) throw new Error(${JSON.stringify(`${context}: 드롭다운 항목을 찾지 못했습니다: ${params.value}. 예: select #country China`)});
          el.value = option.value; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));` : action === "fill" ? `
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            const set = Object.getOwnPropertyDescriptor(prototype, "value").set;
            set.call(el, ""); set.call(el, ${JSON.stringify(params.text)});
          } else if (el.isContentEditable) {
            el.replaceChildren(); el.textContent = ${JSON.stringify(params.text)};
            const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
            const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
          } else throw new Error(${JSON.stringify(`${context}: fill에는 입력창이나 편집 가능한 요소가 필요합니다. 예: fill #message "hello world"`)});
          el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));` : ""}
          return true;
        })()`);
        if (action === "type") await cdp("Input.insertText", { text: params.text });
        await observer.after?.(step, i);
        await sleep(120);
      } else if (action === "key") {
        const modifiers = params.modifiers.reduce((n, k) => n | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8, ControlOrMeta: process.platform === "darwin" ? 4 : 2 })[k], 0);
        const key = params.key === "Space" ? " " : params.key;
        const code = KEYS[params.key] ?? key.toUpperCase().charCodeAt(0);
        const event = { key, code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : params.key, windowsVirtualKeyCode: code, modifiers };
        await observer.before?.(step, i);
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...event, ...(modifiers & 4 && key.toLowerCase() === "a" ? { commands: ["selectAll"] } : {}) });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...event });
        await observer.after?.(step, i); await sleep(80);
      } else if (action === "scroll") { await evaluate(`scrollBy(0, ${params.dy}), true`); await sleep(200); }
    });
  }
}

// ---------- 로컬 그림 모음과 녹화 프레임: 같은 비율 배치를 함께 씁니다 ----------
async function composeImages(items, file, columns, crop = null) {
  const example = stitching ? '--stitch before.png --stitch after.png --columns 2 --out shots' : 'page.html --record --frames 8 --columns 4 --out shots';
  const types = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif", ".bmp": "image/bmp", ".svg": "image/svg+xml" };
  const inputs = items.map((item, i) => {
    try { return { ...item, data: `data:${types[extname(item.path).toLowerCase()] || "application/octet-stream"};base64,${readFileSync(item.path).toString("base64")}` }; }
    catch (error) { throw new Error(`모음의 ${i + 1}번째 이미지를 읽지 못했습니다. 받은 값: ${item.path} (${error.code || error.message}). 예: --stitch before.png --label "바꾸기 전" --out shots`); }
  });
  // Render off the recorded page so its scripts, styles and fonts cannot alter the composition.
  await open("data:text/html,<meta charset=utf-8><meta http-equiv=Content-Security-Policy content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'\">", 0);
  const result = await evaluate(`(async (items, columns, crop) => {
    const images = await Promise.all(items.map((item, i) => new Promise((ok, no) => {
      const image = new Image(); image.onload = () => ok(image);
      image.onerror = () => no(new Error('모음의 ' + (i + 1) + '번째 이미지를 디코딩할 수 없습니다. 받은 값: ' + item.path + '. 예: --stitch before.png --label "바꾸기 전" --out shots'));
      image.src = item.data;
    })));
    const margin = 24, gap = 16, lineHeight = 24;
    const normalized = !!crop || items.some((item) => item.matchWidth !== undefined || item.scale !== undefined);
    const regions = images.map((image, i) => {
      const scale = items[i].matchWidth !== undefined ? items[0].matchWidth / items[i].matchWidth : (items[i].scale ?? 1);
      const width = image.naturalWidth * scale, height = image.naturalHeight * scale;
      if (![scale, width, height].every((n) => Number.isFinite(n) && n > 0)) throw new Error('모음의 ' + (i + 1) + '번째 이미지의 배율이 너무 크거나 작습니다. 받은 값: ' + scale + '. 예: ' + ${JSON.stringify(SCALE_EXAMPLE)});
      if (items[i].matchWidth > image.naturalWidth) throw new Error('모음의 ' + (i + 1) + '번째 물체 너비가 원본 너비보다 큽니다. 받은 값: ' + items[i].matchWidth + ', 원본 너비: ' + image.naturalWidth + '. 예: ' + ${JSON.stringify(STITCH_EXAMPLE)});
      if (crop && (crop.x + crop.width > width + 1e-7 || crop.y + crop.height > height + 1e-7)) throw new Error('모음의 ' + (i + 1) + '번째 자르기 영역이 이미지 밖에 있습니다. 받은 값: ' + JSON.stringify(crop) + ', 배율을 맞춘 크기: ' + width + '×' + height + '. 자를 영역을 줄이거나 --crop을 빼고 전체 그림을 먼저 보세요. 예: ' + ${JSON.stringify(SCALE_EXAMPLE)});
      const region = crop || { x: 0, y: 0, width, height };
      return { scale, width: region.width, height: region.height,
        sourceCrop: { x: region.x / scale, y: region.y / scale, width: region.width / scale, height: region.height / scale } };
    });
    const widest = Math.max(...regions.map((region) => region.width));
    const cell = Math.ceil(Math.min(640, Math.max(items.some((item) => item.label) ? 160 : 1, widest)));
    // A single preview factor preserves the declared relationship, even for different image widths.
    const commonFit = Math.min(1, cell / widest);
    columns = Math.min(columns, images.length);
    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
    const font = '18px "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
    ctx.font = font;
    const labels = items.map((item) => {
      if (!item.label) return [];
      return String(item.label).split(/\\r?\\n/).flatMap((paragraph) => {
        const lines = []; let line = '';
        for (const character of paragraph) {
          if (line && ctx.measureText(line + character).width > cell) { lines.push(line); line = ''; }
          line += character;
        }
        lines.push(line); return lines;
      });
    });
    const dimensions = images.map((image, i) => {
      const region = regions[i], fit = normalized ? commonFit : Math.min(1, cell / region.width);
      return { naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
        scale: region.scale, renderScale: region.scale * fit, sourceCrop: region.sourceCrop,
        ...(items[i].matchWidth !== undefined ? { matchWidth: items[i].matchWidth } : {}),
        width: Math.max(1, Math.round(region.width * fit)), height: Math.max(1, Math.round(region.height * fit)),
        labelHeight: labels[i].length ? 8 + labels[i].length * lineHeight : 0 };
    });
    const heights = [];
    dimensions.forEach((item, i) => { const row = Math.floor(i / columns); heights[row] = Math.max(heights[row] || 0, item.height + item.labelHeight); });
    canvas.width = columns * cell + (columns - 1) * gap + margin * 2;
    canvas.height = heights.reduce((sum, height) => sum + height, 0) + (heights.length - 1) * gap + margin * 2;
    if (canvas.width > 32767 || canvas.height > 32767 || canvas.width * canvas.height > 67108864) throw new Error('그림 모음의 캔버스가 너무 큽니다. 받은 값: ' + canvas.width + '×' + canvas.height + '. 이미지 수나 프레임 수를 줄이거나 열 수를 조절하세요. 예: ' + ${JSON.stringify(example)});
    ctx.fillStyle = '#ececea'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = font; ctx.textBaseline = 'top';
    let top = margin;
    const layout = dimensions.map((item, i) => {
      const row = Math.floor(i / columns), column = i % columns;
      if (i && !column) top += heights[row - 1] + gap;
      const x = margin + column * (cell + gap) + Math.floor((cell - item.width) / 2);
      const source = item.sourceCrop;
      ctx.drawImage(images[i], source.x, source.y, source.width, source.height, x, top, item.width, item.height);
      ctx.fillStyle = '#333';
      labels[i].forEach((line, index) => ctx.fillText(line, margin + column * (cell + gap), top + item.height + 8 + index * lineHeight));
      return { ...item, x, y: top, label: items[i].label || '', labelY: top + item.height + 8 };
    });
    const data = canvas.toDataURL('image/png').split(',')[1];
    if (!data) throw new Error('그림 모음을 PNG로 내보낼 수 없습니다. 이미지 수나 프레임 수를 줄이세요. 예: ' + ${JSON.stringify(example)});
    return { data, width: canvas.width, height: canvas.height, columns, ...(crop ? { crop } : {}), items: layout };
  })(${JSON.stringify(inputs)}, ${columns}, ${JSON.stringify(crop)})`);
  writeFileSync(file, Buffer.from(result.data, "base64"));
  const { data, ...layout } = result;
  return { file: basename(file), ...layout };
}

// ---------- 나란히 보기 그림: 같은 브라우저에서 캡처를 한 장으로 모읍니다 ----------
async function sheet(items, file, w, h) {
  const cell = Math.min(w, 420);
  const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const figures = items.map(({ path, label }) =>
    `<figure><img src="data:image/png;base64,${readFileSync(path).toString("base64")}"><figcaption>${escapeHtml(label)}</figcaption></figure>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{margin:0;padding:32px;background:#ececea;font:13px -apple-system,"PingFang SC",sans-serif;color:#555}
main{display:flex;gap:24px;align-items:flex-start}figure{margin:0;width:${cell}px}img{width:100%;display:block;border-radius:12px;box-shadow:0 1px 3px #0002}
figcaption{margin-top:10px}</style><main>${figures}</main>`;
  const tmp = browser.tempFile("sheet.html");
  writeFileSync(tmp, html);
  const width = items.length * cell + (items.length - 1) * 24 + 64;
  await setViewport(width, Math.round((cell * h) / w) + 120, 1);
  await open(`file://${tmp}`);
  return screenshot(file, true);
}

// ---------- 비교 그림: 참고 그림과 캡처를 나란히 놓고 겹친 그림과 차이 그림을 만듭니다 ----------
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const CELLS = ["왼쪽 위", "위 가운데", "오른쪽 위", "왼쪽 가운데", "가운데", "오른쪽 가운데", "왼쪽 아래", "아래 가운데", "오른쪽 아래"];
async function compare(buildPath, refPath, file) {
  const ref = `data:${IMAGE_TYPES[extname(refPath).toLowerCase()]};base64,${readFileSync(refPath).toString("base64")}`;
  const build = `data:image/png;base64,${readFileSync(buildPath).toString("base64")}`;
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<style>body{margin:0;padding:28px;background:#ececea;font:13px -apple-system,"PingFang SC",sans-serif;color:#555}
main{display:grid;grid-template-columns:repeat(2,720px);gap:24px 20px;align-items:start}figure{margin:0}
canvas{width:100%;display:block;border-radius:8px;box-shadow:0 1px 3px #0002;background:#fff}figcaption{margin-top:8px}</style>
<main><figure><canvas id="ref"></canvas><figcaption>참고</figcaption></figure><figure><canvas id="build"></canvas><figcaption>지금</figcaption></figure>
<figure><canvas id="overlay"></canvas><figcaption>겹쳐 보기(참고 그림 위에 지금 화면을 50%로 겹침)</figcaption></figure><figure><canvas id="diff"></canvas><figcaption id="note">차이</figcaption></figure></main>
<script>(async () => {
  const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("참고 그림을 열 수 없습니다")); i.src = src; });
  const [ref, build] = await Promise.all([load(${JSON.stringify(ref)}), load(${JSON.stringify(build)})]);
  const W = build.naturalWidth, refH = Math.round(ref.naturalHeight * W / ref.naturalWidth), H = Math.min(refH, build.naturalHeight);
  const paint = (id, fn) => { const c = document.getElementById(id); c.width = W; c.height = H; const x = c.getContext("2d"); fn(x); return x; };
  paint("ref", (x) => x.drawImage(ref, 0, 0, W, refH));
  paint("build", (x) => x.drawImage(build, 0, 0));
  paint("overlay", (x) => { x.drawImage(ref, 0, 0, W, refH); x.globalAlpha = 0.5; x.drawImage(build, 0, 0); });
  // 480px 너비로 줄인 뒤 픽셀 색을 비교합니다. 어느 채널이든 차이가 0.1을 넘을 때만 "차이 있음"으로 세어 안티앨리어싱과 1~2픽셀 차이를 무시합니다
  const sw = 480, sh = Math.max(1, Math.round(H * sw / W));
  const sample = (img) => { const c = document.createElement("canvas"); c.width = sw; c.height = sh; const x = c.getContext("2d", { willReadFrequently: true });
    const k = img.naturalWidth / W; x.drawImage(img, 0, 0, img.naturalWidth, H * k, 0, 0, sw, sh); return x.getImageData(0, 0, sw, sh).data; };
  const a = sample(ref), b = sample(build);
  const lum = (d, i) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  const heat = new ImageData(sw, sh), sums = Array(9).fill(0), counts = Array(9).fill(0);
  let total = 0;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const i = (y * sw + x) * 4, d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) / 255, cell = Math.min(2, Math.floor(y * 3 / sh)) * 3 + Math.min(2, Math.floor(x * 3 / sw));
    const hit = d > 0.1 ? 1 : 0;
    total += hit; sums[cell] += hit; counts[cell]++;
    const g = lum(b, i) * 255 * 0.35 + 150;
    heat.data[i] = hit ? 225 : g; heat.data[i + 1] = hit ? 40 : g; heat.data[i + 2] = hit ? 60 : g; heat.data[i + 3] = 255;
  }
  const small = document.createElement("canvas"); small.width = sw; small.height = sh; small.getContext("2d").putImageData(heat, 0, 0);
  const cells = sums.map((s, i) => +(100 * s / Math.max(1, counts[i])).toFixed(1));
  paint("diff", (x) => {
    x.drawImage(small, 0, 0, W, H);
    x.strokeStyle = "#0006"; x.lineWidth = Math.max(1, W / 420); x.fillStyle = "#111"; x.font = "600 " + Math.round(W / 22) + "px -apple-system,sans-serif";
    for (let i = 0; i < 9; i++) { const cx = (i % 3) * W / 3, cy = Math.floor(i / 3) * H / 3; x.strokeRect(cx, cy, W / 3, H / 3); x.fillText(cells[i] + "%", cx + W / 60, cy + W / 18); }
  });
  window.__compare = { overall: +(100 * total / (sw * sh)).toFixed(1), cells, refHeight: refH, buildHeight: build.naturalHeight };
})().catch((e) => { window.__compare = { error: e.message }; });</script>`;
  const tmp = browser.tempFile("compare.html");
  writeFileSync(tmp, html);
  await setViewport(2 * 720 + 20 + 56, 900, 1);
  await open(`file://${tmp}`);
  let result = null;
  for (let i = 0; i < 50 && !result; i++) { result = await evaluate(`window.__compare || null`); if (!result) await sleep(100); }
  if (!result || result.error) throw new Error(`비교 그림을 만들지 못했습니다: ${result?.error || "시간 초과"}`);
  await screenshot(file, true);
  const worst = result.cells.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v).slice(0, 3).map(({ v, i }) => `${CELLS[i]} ${v}%`);
  const gap = Math.abs(result.refHeight - result.buildHeight) / result.buildHeight > 0.05
    ? `; 너비를 맞춘 참고 그림 높이 ${result.refHeight}px, 캡처 높이 ${result.buildHeight}px, 겹치는 부분만 비교` : "";
  return { file: basename(file), overall: result.overall, cells: Object.fromEntries(CELLS.map((c, i) => [c, result.cells[i]])),
    message: `${basename(file)}: 차이가 뚜렷한 픽셀 비율 ${result.overall}%, 차이가 가장 큰 칸 ${worst.join(", ")}${gap}` };
}

// 인코딩도 비동기로 실행합니다. 브라우저가 끊겨도 동기 인코딩이 종료를 막지 않게 하기 위해서입니다.
function runFfmpeg(args, timeout) {
  return new Promise((ok) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    encoders.add(child);
    let stderr = "", done = false;
    const finish = (status, error) => {
      if (done) return; done = true; clearTimeout(timer); encoders.delete(child);
      ok({ status, stderr, error });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null, { code: "ETIMEDOUT" });
      child.stderr.destroy();
    }, timeoutMs(timeout));
    child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-16384); });
    child.once("error", (error) => finish(null, error));
    child.once("close", (code) => finish(code));
  });
}

// ---------- 녹화 ----------
// Keep finite animation intervals even after a short feedback has finished. Runs before page scripts.
function recordTiming() {
  let baseline = new Set(), start = null, end = null, raf, active = true;
  function sample() {
    for (const a of document.getAnimations()) {
      if (baseline.has(a) || !a.effect || !a.playbackRate || typeof a.startTime !== "number") continue;
      const timing = a.effect.getComputedTiming(), rate = a.playbackRate;
      if (!Number.isFinite(timing.endTime) || a.playState === "paused" || !["DocumentTimeline", undefined].includes(a.timeline?.constructor.name)) continue;
      const zero = performance.timeOrigin + a.startTime;
      const first = Math.min(zero + timing.delay / rate, zero + timing.endTime / rate);
      const last = Math.max(zero + timing.delay / rate, zero + timing.endTime / rate);
      start = start === null ? first : Math.min(start, first);
      end = end === null ? last : Math.max(end, last);
    }
  }
  function tick() { if (!active) return; sample(); raf = requestAnimationFrame(tick); }
  window.__jstyleRecordTiming = {
    reset() { baseline = new Set(document.getAnimations()); start = end = null; },
    read() { if (active) sample(); return { start, end }; },
    stop() { active = false; cancelAnimationFrame(raf); },
  };
  tick();
}
async function frameDifference(first, second) {
  return evaluate(`(async () => {
    const load = (data) => new Promise((ok, no) => { const img = new Image(); img.onload = () => ok(img); img.onerror = () => no(new Error("녹화의 마지막 프레임을 디코딩할 수 없습니다")); img.src = "data:image/jpeg;base64," + data; });
    const a = await load(${JSON.stringify(readFileSync(first).toString("base64"))});
    const b = await load(${JSON.stringify(readFileSync(second).toString("base64"))});
    if (a.width !== b.width || a.height !== b.height) return { different: true, dimensions: [a.width, a.height, b.width, b.height] };
    const canvas = document.createElement("canvas"); canvas.width = a.width; canvas.height = a.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(a, 0, 0); const p = ctx.getImageData(0, 0, a.width, a.height).data;
    ctx.clearRect(0, 0, a.width, a.height); ctx.drawImage(b, 0, 0); const q = ctx.getImageData(0, 0, b.width, b.height).data;
    const cols = Math.ceil(a.width / 32), tiles = new Uint32Array(cols * Math.ceil(a.height / 32));
    let changed = 0;
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if ((Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2])) / 3 > 32) {
        changed++; tiles[Math.floor(y / 32) * cols + Math.floor(x / 32)]++;
      }
    }
    const maxTile = tiles.reduce((n, v) => Math.max(n, v), 0);
    return { different: changed >= 32 && (changed / (a.width * a.height) > .005 || maxTile >= 48), changedPixels: changed, maxTilePixels: maxTile, pixelRatio: changed / (a.width * a.height) };
  })()`);
}
function sequenceFrames(frames, finished, count) {
  const start = frames[0].t, duration = Math.max(0, finished - start);
  let index = 0;
  return Array.from({ length: count }, (_, i) => {
    const time = start + duration * i / (count - 1);
    // A screencast emits only changed images: hold the preceding frame, never a future one.
    while (index + 1 < frames.length && frames[index + 1].t <= time) index++;
    return { path: frames[index].name, timeMs: Math.round((time - start) * 1000), sourceTimeMs: Math.max(0, Math.round((frames[index].t - start) * 1000)) };
  });
}
function screencastList(frames, finished) {
  // JPEG's default 25fps time base rounds timestamps and can discard a short feedback frame.
  // Use the same millisecond precision as the durations before resampling the video to 30fps.
  const file = (frame) => `file '${basename(frame.name)}'\noption framerate 1000`;
  // Keep a full 30fps output frame of the final still even when recording ends between ticks.
  return frames.map((f, i) => `${file(f)}\nduration ${Math.max(i === frames.length - 1 ? 0.034 : 0.016, ((frames[i + 1]?.t ?? finished) - f.t)).toFixed(3)}`).join("\n") + `\n${file(frames.at(-1))}\n`;
}
async function record(url, w, h, { steps = [], name = "", entry = flags.has("entry"), zoom = zooms[0] } = {}) {
  const video = `record${name ? "-" + name : ""}.mp4`;
  const motion = `motion${name ? "-" + name : ""}`;
  const frames = [];
  const dir = join(out, name ? `frames-${name}` : "frames");
  mkdirSync(dir, { recursive: true }); temporaryFrames.add(dir);
  let identifier, actionStart, actionEnd, beforeAction, painted = 0;
  const lastAction = steps.findLastIndex((s) => ["click", "dblclick", "drag", "type", "fill", "select", "key"].includes(s.action));
  const captureFrame = async (label) => {
    const { data } = await cdp("Page.captureScreenshot", { format: "jpeg", quality: 88 });
    const frame = { name: join(dir, `${label}.jpg`), t: Date.now() / 1000, source: "Page.captureScreenshot" };
    writeFileSync(frame.name, Buffer.from(data, "base64")); return frame;
  };
  const onFrame = (m) => {
    if (transportFailure || m.sessionId !== sessionId || m.method !== "Page.screencastFrame") return;
    const name = join(dir, `f${String(frames.length).padStart(4, "0")}.jpg`);
    writeFileSync(name, Buffer.from(m.params.data, "base64"));
    frames.push({ name, t: Math.max(frames.at(-1)?.t || 0, m.params.metadata.timestamp), source: "Page.screencastFrame" });
    cdp("Page.screencastFrameAck", { sessionId: m.params.sessionId }).catch(() => {});
  };
  try {
    await setViewport(w, h, zoom);
    ({ identifier } = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `(${recordTiming.toString()})()` }));
    if (entry) {
      // 첫 빈 페이지의 흰 바탕을 직접 지정합니다. 시스템이 어두운 테마이면 브라우저가 about:blank를 짙은 회색으로 그려 같은 녹화도 기기에 따라 첫 부분이 달라지기 때문입니다.
      await open("data:text/html,<html style='background:%23fff'>", 0);
      // Seed the video with a painted blank page, never the preceding evidence item.
      frames.push(await captureFrame("blank"));
    } else await open(url);
    listeners.push(onFrame);
    await cdp("Page.startScreencast", { format: "jpeg", quality: 88, everyNthFrame: 1 });
    if (entry) {
      await sleep(50);
      await open(url);
      painted = await evaluate(`(() => { const p = performance.getEntriesByName("first-contentful-paint")[0] || performance.getEntriesByType("paint")[0]; return (performance.timeOrigin + (p?.startTime || 0)) / 1000; })()`);
    } else await sleep(500);
    await runSteps(steps, {
      step: async (step, i) => {
        // A later hover or scroll can have its own animation; it is not this action's feedback.
        if (lastAction >= 0 && i > lastAction && ["hover", "scroll"].includes(step.action)) await evaluate(`(__jstyleRecordTiming.stop(), true)`);
      },
      before: async (_, i) => {
        if (i !== lastAction) return;
        beforeAction = await captureFrame("before-action");
        await evaluate(`(__jstyleRecordTiming.reset(), true)`);
        actionStart = Date.now() / 1000;
      },
      after: async (_, i) => { if (i === lastAction) actionEnd = Date.now() / 1000; },
    });
    if (entry && lastAction < 0) await settleAnimations(2000);
    await sleep(Number(opt.hold));
    const finished = Date.now() / 1000;
    const final = await captureFrame("hold-end");
    if (final) final.t = finished;
    const streamEnd = frames.filter((frame) => frame.t <= finished).at(-1);
    const warnings = [];
    let consistency = { status: "unavailable", reference: `${motion}-end.jpg` };
    if (streamEnd) {
      const difference = await frameDifference(streamEnd.name, final.name);
      consistency = { status: "matched", reference: `${motion}-end.jpg`, ...difference };
      if (difference.different) {
        // Confirm the page is still before attributing the mismatch to the stream. No frame comparison can prove intermediate motion is correct.
        await sleep(100);
        const verification = await captureFrame("verification");
        const stability = await frameDifference(final.name, verification.name);
        consistency.status = stability.different ? "moving" : "mismatch";
        if (!stability.different) {
          const original = `record${name ? "-" + name : ""}-stream-end.jpg`;
          writeFileSync(join(out, original), readFileSync(streamEnd.name));
          consistency.original = original;
          warnings.push(`녹화 마지막 프레임이 캡처와 뚜렷이 달라 일부를 찍지 못했을 수 있습니다. 멈춘 마지막 모습은 ${motion}-end.jpg를 기준으로 녹화의 마지막 프레임을 보완했고, 원래 마지막 프레임은 ${original}에 보관했습니다. 전환은 따로 다시 녹화하세요: ${currentRetryCommand} --hold 2000`);
        }
      }
    }
    const feedback = await evaluate(`__jstyleRecordTiming.read()`);
    const issues = await check();
    await cdp("Page.stopScreencast");
    listeners.splice(listeners.indexOf(onFrame), 1);
    if (!frames.length) throw new Error("녹화 화면을 받지 못했습니다");
    if (final) {
      // The stream may deliver a frame from after --hold while checks are running.
      while (frames.length > 1 && frames.at(-1).t > finished) frames.pop();
      // Plain recordings keep their original head/middle/tail samples when the two paths agree.
      if (entry || lastAction >= 0 || consistency.different) frames.push(final);
    }
    const nearest = (time, pool = frames) => pool.reduce((best, f) => Math.abs(f.t - time) < Math.abs(best.t - time) ? f : best);
    let pick, sampling;
    if (lastAction >= 0) {
      const from = Math.max(actionStart, (feedback.start ?? actionStart * 1000) / 1000);
      const to = Math.max(from, Math.min(finished, (feedback.end ?? (actionEnd * 1000 + 200)) / 1000));
      const candidates = [...frames.filter((f) => f.t >= actionStart && f.t <= finished), final];
      pick = { start: beforeAction, mid: nearest((from + to) / 2, candidates), end: final };
      sampling = { mode: "action", step: lastAction + 1, action: steps[lastAction].action, raw: steps[lastAction].raw };
    } else if (entry) {
      const content = frames.filter((f) => f.t >= painted);
      const from = content[0]?.t ?? final.t;
      const to = Math.max(from, Math.min(finished, (feedback.end ?? finished * 1000) / 1000));
      pick = { start: content[0] || final, mid: nearest((from + to) / 2, [...content, final]), end: final };
      sampling = { mode: "entry" };
    } else {
      pick = { start: frames[0], mid: frames[Math.floor(frames.length / 2)], end: frames[frames.length - 1] };
      sampling = { mode: "recording" };
    }
    for (const [k, f] of Object.entries(pick)) writeFileSync(join(out, `${motion}-${k}.jpg`), readFileSync(f.name));
    const frameReport = Object.fromEntries(Object.entries(pick).map(([k, f]) => [k, {
      file: `${motion}-${k}.jpg`, source: f.source, timeMs: Math.max(0, Math.round((f.t - frames[0].t) * 1000)),
    }]));
    const details = { frames: frameReport, sampling, consistency, warnings, durationMs: Math.round((finished - frames[0].t) * 1000) };
    let sequenceMessage = "";
    if (opt.frames !== undefined) {
      const samples = sequenceFrames(frames, finished, Number(opt.frames));
      const sequence = await during(`${currentContext} / 녹화의 여러 프레임`, () => composeImages(samples.map((frame) => ({ ...frame, label: `${(frame.timeMs / 1000).toFixed(3)} s` })), join(out, `${motion}-sequence.png`), Number(opt.columns || Math.min(4, samples.length))));
      details.sequence = { ...sequence, frames: samples.map(({ path, ...time }) => time) };
      sequenceMessage = `, ${sequence.file}`;
    }
    if (opt.frames !== undefined && !flags.has("record")) return { issues, ...details, message: `연속 그림: ${details.sequence.file} (${(finished - frames[0].t).toFixed(1)}초), 영상을 인코딩하지 않음` };
    const ffmpeg = (await runFfmpeg(["-version"], 5000)).status === 0;
    if (!ffmpeg) return { issues, ...details, failed: true, message: `녹화: ffmpeg가 없어 영상을 만들지 않았습니다. 남긴 파일: ${motion}-start/mid/end.jpg 세 프레임${sequenceMessage}` };
    // Generated basenames are safe for concat's quoting, even when --out contains an apostrophe.
    // Keep the final still frame through the end of --hold; screencasts only emit changed frames.
    const list = screencastList(frames, finished);
    writeFileSync(join(dir, "list.txt"), list);
    const r = await runFfmpeg(["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"),
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30", "-pix_fmt", "yuv420p", join(out, video)], 60000);
    if (r.status !== 0) return { issues, ...details, failed: true, message: `녹화: ffmpeg로 영상을 합치지 못했습니다(${r.error?.code === "ETIMEDOUT" ? `${60 * timeoutScale}초 안에 끝나지 않음` : r.error?.message || r.stderr.trim().split("\n").pop()}). 남긴 파일: ${motion}-start/mid/end.jpg 세 프레임${sequenceMessage}` };
    rmSync(dir, { recursive: true, force: true });
    return { issues, ...details, message: `녹화: ${video} (${(finished - frames[0].t).toFixed(1)}초), ${motion}-start/mid/end.jpg${sequenceMessage}` };
  } finally {
    const index = listeners.indexOf(onFrame); if (index >= 0) listeners.splice(index, 1);
    try { if (!transportFailure && !browserNeedsRestart) await cdp("Page.stopScreencast"); }
    finally {
      try {
        if (!transportFailure && !browserNeedsRestart) {
          await evaluate(`(window.__jstyleRecordTiming?.stop(), delete window.__jstyleRecordTiming, true)`);
          if (identifier) await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier });
        }
      } finally { rmSync(dir, { recursive: true, force: true }); temporaryFrames.delete(dir); }
    }
  }
}


// ---------- 움직임 살펴보기 ----------
// Runs before page scripts: records which elements animate in each phase and how far they move.
const MOTION_PROBE = `(() => {
  if (window.__jstyleMotion) return;
  const tracked = new Map();
  let phase = "load";
  const seen = new Set();
  function touch(el, source) {
    if (!(el instanceof Element) || el.id === "jstyle-mask") return;
    let t = tracked.get(el);
    if (!t) { if (tracked.size >= 400) return; t = { phases: {} }; tracked.set(el, t); }
    let p = t.phases[phase];
    if (!p) p = t.phases[phase] = { first: null, last: null, frames: 0, move: 0, size: 0, opacity: 0, sources: new Set() };
    p.sources.add(source);
    if (source.startsWith("js:")) t.lastJs = performance.now();
  }
  addEventListener("animationstart", (e) => touch(e.target, "css:" + e.animationName), true);
  addEventListener("transitionrun", (e) => touch(e.target, "transition:" + e.propertyName), true);
  new MutationObserver((list) => { for (const m of list) touch(m.target, "js:" + m.attributeName); })
    .observe(document, { subtree: true, attributes: true, attributeFilter: ["style", "transform", "viewBox", "d", "x", "y", "cx", "cy", "r", "points", "opacity", "stroke-dashoffset"] });
  // 첫 화면은 화면 좌표로 잽니다. 고정된 무대 자체는 움직임으로 세지 않고, 무대 안의 층이 바뀌어야 셉니다.
  function read(el) {
    const r = el.getBoundingClientRect();
    const page = phase === "hero" ? 0 : 1;
    return { x: r.left + scrollX * page, y: r.top + scrollY * page, w: r.width, h: r.height, o: +getComputedStyle(el).opacity };
  }
  function sample() {
    if (document.getAnimations) for (const a of document.getAnimations()) {
      if (a.playState !== "running" || !a.effect || !a.effect.target) continue;
      const tl = a.timeline && a.timeline.constructor && a.timeline.constructor.name;
      const scrollLinked = tl === "ScrollTimeline" || tl === "ViewTimeline";
      if (scrollLinked) touch(a.effect.target, "scroll-timeline:" + (a.animationName || "animation"));
      else if (!seen.has(a)) { seen.add(a); if (!a.animationName && !a.transitionProperty) touch(a.effect.target, "waapi"); }
    }
    for (const [el, t] of tracked) {
      const p = t.phases[phase];
      if (!p || !el.isConnected) continue;
      const now = read(el);
      if (!p.first) { p.first = p.last = now; continue; }
      const l = p.last;
      if (Math.abs(now.x - l.x) + Math.abs(now.y - l.y) + Math.abs(now.w - l.w) + Math.abs(now.h - l.h) > 0.1 || Math.abs(now.o - l.o) > 0.005) p.frames++;
      p.last = now;
      p.move = Math.max(p.move, Math.hypot(now.x - p.first.x, now.y - p.first.y));
      p.size = Math.max(p.size, Math.abs(now.w - p.first.w) / Math.max(1, p.first.w), Math.abs(now.h - p.first.h) / Math.max(1, p.first.h));
      p.opacity = Math.max(p.opacity, Math.abs(now.o - p.first.o));
    }
    requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
  window.__jstyleMotion = {
    setPhase(next) { phase = next; },
    summary(name) {
      const items = [];
      for (const [el, t] of tracked) {
        const p = t.phases[name];
        if (!p) continue;
        const label = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
        const infinite = el.getAnimations ? el.getAnimations().some((a) => a.effect && a.effect.getTiming && a.effect.getTiming().iterations === Infinity) : false;
        const loop = infinite || (t.lastJs && performance.now() - t.lastJs < 250);
        if (p.frames < 3) continue; // one-off jumps are state writes, not motion
        items.push({ el: label, move: Math.round(p.move), size: +p.size.toFixed(3), opacity: +p.opacity.toFixed(2), loop: !!loop, sources: [...p.sources].slice(0, 3) });
      }
      const visible = items.filter((i) => ((name !== "scroll" && name !== "hero") || !i.loop) && (i.move >= 1 || i.size >= 0.005 || i.opacity >= 0.05 || i.sources.some((s) => s.startsWith("scroll-timeline"))));
      visible.sort((a, b) => (b.move + b.size * 400 + b.opacity * 40) - (a.move + a.size * 400 + a.opacity * 40));
      return {
        elements: visible.length,
        loops: visible.filter((i) => i.loop).length,
        maxMove: Math.max(0, ...visible.map((i) => i.move)),
        maxSize: Math.max(0, ...visible.map((i) => i.size)),
        maxOpacity: Math.max(0, ...visible.map((i) => i.opacity)),
        top: visible.slice(0, 8),
      };
    },
  };
})()`;

async function probeMotion(url, w, h, steps = []) {
  const { identifier } = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: MOTION_PROBE });
  try {
    problems = [];
    await setViewport(w, h, 1);
    await open(url);
    await sleep(1200);
    const phases = { load: await evaluate(`__jstyleMotion.summary("load")`) };
    if (steps.length) {
      await evaluate(`__jstyleMotion.setPhase("steps"), true`);
      await runSteps(steps);
      await sleep(900);
      phases.steps = await evaluate(`__jstyleMotion.summary("steps")`);
    }
    await evaluate(`(scrollTo(0, 0), __jstyleMotion.setPhase("hero"), true)`);
    await sleep(150);
    const height = await evaluate(`document.documentElement.scrollHeight - innerHeight`);
    const scrollable = height > 4;
    const heroEnd = Math.min(height, Math.round(h * 1.5));
    for (let y = 0; y <= heroEnd; y += Math.round(h / 10)) { await evaluate(`scrollTo(0, ${y}), true`); await sleep(70); }
    await sleep(400);
    phases.hero = await evaluate(`__jstyleMotion.summary("hero")`);
    await evaluate(`(__jstyleMotion.setPhase("scroll"), true)`);
    for (let y = heroEnd; y < height; y += Math.round(h / 4)) { await evaluate(`scrollTo(0, ${y}), true`); await sleep(90); }
    await evaluate(`scrollTo(0, ${height}), true`);
    await sleep(600);
    phases.scroll = await evaluate(`__jstyleMotion.summary("scroll")`);

    const issues = [];
    const names = { load: "처음 들어올 때", steps: "--steps 동작", hero: "첫 화면 스크롤", scroll: "처음부터 끝까지 스크롤" };
    const weak = (p) => p.maxMove < 4 && p.maxSize < 0.02 && p.maxOpacity < 0.3;
    for (const [k, p] of Object.entries(phases)) {
      // 첫 화면의 깊이 변화는 선택 사항입니다. 고른 페이지를 확인할 때 쓰도록 층 수와 이동 폭만 알리고 문제로 세지 않습니다.
      if (k === "hero") {
        p.layers = p.top.filter((i) => i.size >= 0.05 || i.move >= h * 0.05).length;
        continue;
      }
      if (k === "scroll") {
        p.scrollable = scrollable;
        if (!p.elements && scrollable) issues.push("스크롤: 스크롤에 따른 변화를 찾지 못했습니다. 소개, 브랜드, 전시 화면에는 스크롤 연출이 필요합니다");
        continue;
      }
      if (!p.elements) issues.push(`${names[k]}: 움직임을 찾지 못했습니다${k === "load" && !steps.length ? ". 조작 효과는 --steps를 함께 줘야 찾을 수 있습니다" : ""}`);
      else if (p.loops === p.elements) issues.push(`${names[k]}: 계속 도는 애니메이션만 있고 한 번만 재생하는 ${k === "load" ? "첫 등장" : "반응"}이 없습니다`);
      else if (weak(p)) issues.push(`${names[k]}: 움직임이 너무 작아 알아보기 어렵습니다(가장 큰 이동 ${p.maxMove}px, 크기 변화 ${(p.maxSize * 100).toFixed(1)}%, 투명도 변화 ${p.maxOpacity})`);
    }
    const brief = (k, p) => k === "scroll" && !p.scrollable ? "페이지에 스크롤이 없어 스크롤 검사를 건너뜀" : k === "hero" ? `첫 화면 스크롤: 층 ${p.layers}개가 바뀜, 가장 큰 확대 ${(p.maxSize * 100).toFixed(1)}%, 가장 큰 이동 ${p.maxMove}px`
      : `${names[k]}: 요소 ${p.elements}개가 움직임, 가장 큰 이동 ${p.maxMove}px, 투명도 변화 ${p.maxOpacity}`;
    return { phases, issues: [...problems, ...issues], message: "움직임 살펴보기: " + Object.entries(phases).map(([k, p]) => brief(k, p)).join("; ") };
  } finally { await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier }); }
}

// ---------- 주된 흐름 ----------
const bases = [];
for (const candidate of targets) bases.push(await resolveTarget(candidate.target));
let base = bases[0], activeTarget = targets[0];
const withState = (s) => {
  const u = new URL(base);
  for (const [key, value] of new URLSearchParams(opt.query || "")) u.searchParams.set(key, value);
  if (s) u.searchParams.set(opt.param, s);
  return u.toString();
};
const report = [], lines = [];
const usedFiles = new Set();
const targetShots = [];
const autoSheet = targets.length > 1 && !flags.has("no-sheet") && (!captureMotion || flags.has("evidence"));
if (autoSheet) usedFiles.add("sheet.png");
const candidatePrefix = () => batchMode ? targetStem(activeTarget) : "";
function reserveFamily(preferred, files) {
  let name = preferred, n = 2;
  while (files(name).some((file) => usedFiles.has(file))) name = `${preferred ? preferred + "-" : ""}${n++}`;
  files(name).forEach((file) => usedFiles.add(file));
  if (name !== preferred) notices.push(`파일 이름이 겹쳐 이름을 바꿨습니다: ${files(preferred)[0]} → ${files(name)[0]}`);
  return name;
}
saveFatalReport = (error) => {
  report.push({ file: "browser", failed: true, issues: [...problems, error.message] });
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
};
const evidence = flags.has("evidence");
// One completed item produces one stderr progress line; stdout keeps its existing summary.
let completed = 0, progressTotal = 0;
function progress(file, failed = false) {
  console.error(`[${++completed}/${progressTotal}] ${file} ${failed === "skipped" ? "건너뜀, 보고서에 기록" : failed ? "실패, 보고서에 기록" : "완료"}`);
}
function skipped(file, metadata, reason) {
  report.push({ file, ...metadata, skipped: true, issues: [reason] });
  lines.push(`${file}  ⚠ 건너뜀: ${reason}`); progress(file, "skipped");
}
function retryItem(file, metadata, extra = "") {
  const group = groups.find((g) => g.reportName === (metadata.group || "") && !(evidence && file.endsWith(".png")));
  const steps = group?.steps.length ? (group.reportName ? group.reportName + ": " : "") + group.steps.map((s) => s.raw).join("; ") : "";
  const variant = file.endsWith("-masked.png") ? " --mask" : file.endsWith("-marked.png") ? ` --mark ${quoteArg(opt.mark)}` : file.endsWith("-compare.png") ? ` --compare ${quoteArg(refImage)}` : "";
  const isSheet = file.endsWith(".png") && metadata.state === undefined && states.length > 1;
  if (autoSheet && file === "sheet.png") return `node ${quoteArg(resolve(process.argv[1]))} ${args.map(quoteArg).join(" ")} --timeout-scale 2`;
  const command = stitching ? retryCommand : `node ${quoteArg(resolve(process.argv[1]))} ${quoteArg(activeTarget.target)} --timeout-scale 2`;
  return command + ` --out ${quoteArg(out)}${metadata.size ? ` --size ${quoteArg(metadata.size)}` : ""}${metadata.zoom ? ` --zoom ${metadata.zoom}` : ""}` +
    (metadata.state !== null && metadata.state !== undefined ? ` --states ${quoteArg(metadata.state)} --param ${quoteArg(opt.param)}` : "") +
    (isSheet ? ` --states ${quoteArg(states.join(","))} --param ${quoteArg(opt.param)} --sheet` : "") + variant +
    (opt.selector ? ` --selector ${quoteArg(opt.selector)}` : "") + (flags.has("thumb") ? " --thumb" : "") +
    (opt.query ? ` --query ${quoteArg(opt.query)}` : "") + (steps ? ` --steps ${quoteArg(steps)}` : "") +
    (file.startsWith("motion-probe") ? " --motion" : extra) + (flags.has("full") && file.endsWith(".png") ? " --full" : "");
}
async function item(file, metadata, work, extra = "") {
  currentRetryCommand = retryItem(file, metadata, extra);
  let failed = false;
  const firstResult = report.length;
  const reopened = browserNeedsRestart;
  if (reopened) await restartBrowser();
  try { await during(file, () => work(reopened)); }
  catch (error) {
    if (transportFailure) throw error;
    report.push({ file, ...metadata, failed: true, issues: [...problems, error.message] });
    lines.push(`${file}  ⚠ 실패: ${error.message}`); process.exitCode = 1; failed = true;
    // Ordinary one-item failures retain their old stderr diagnostic; batches can finish the rest.
    console.error(`shoot: ${error.message}`);
  }
  progress(file, failed || report.slice(firstResult).some((r) => r.failed));
}
async function captureBatch(selectedStates, selectedZooms, selectedGroups, useMask, useSheet) {
  for (const { w, h } of sizes) for (const zoom of selectedZooms) for (const group of selectedGroups) {
    const shots = [], masked = [];
    const suffix = [group.id, sizes.length > 1 ? `${w}x${h}` : "", zoom !== 1 ? `@${zoom}x` : ""].filter(Boolean).join("-");
    for (const stateIndex of selectedStates) {
      const state = states[stateIndex];
      const preferred = [candidatePrefix(), batchMode && state === null ? "" : stateIds[stateIndex], suffix].filter(Boolean).join("-");
      const name = reserveFamily(preferred, (stem) => [`${stem}.png`, ...(useMask ? [`${stem}-masked.png`] : []), ...(marks.length ? [`${stem}-marked.png`] : []), ...(refImage ? [`${stem}-compare.png`] : [])]);
      const meta = { ...(batchMode ? { target: activeTarget.target, name: activeTarget.name || targetStem(activeTarget) } : {}), state, size: `${w}x${h}`, zoom, ...(group.reportName ? { group: group.reportName } : {}) };
      const thumb = flags.has("thumb");
      const settleBudget = thumb ? 300 : 2000;
      const prepare = async () => {
        problems = [];
        await setViewport(w, h, zoom); await open(withState(state));
        let waited = await settleAnimations(settleBudget);
        await runSteps(group.steps);
        waited += await settleAnimations(settleBudget - waited); return waited;
      };
      let entry;
      const file = join(out, `${name}.png`);
      await item(`${name}.png`, meta, async () => {
        const animationWaitMs = await prepare();
        await screenshot(file, flags.has("full"), selector ? await selectorClip() : thumb ? { x: 0, y: 0, width: w, height: h, scale: 0.5 } : null);
        const issues = await check(), hints = thumb ? [] : await lint();
        entry = { file: basename(file), ...meta, ...(thumb ? { thumb: true } : {}), animationWaitMs, issues, lint: hints };
        lines.push(`${basename(file)}${issues.length ? "  ⚠ " + issues.join("; ") : ""}${hints.length ? "  ◇ 읽기 쉬움 안내: " + lintLine(hints) : ""}`);
        report.push(entry); shots.push({ path: file, label: state || "page" });
        if (batchMode) targetShots.push({ path: file, label: [meta.name, state, suffix].filter(Boolean).join(" · ") });
      });
      if (!shots.some((shot) => basename(shot.path) === `${name}.png`)) {
        for (const extra of [marks.length && "marked", useMask && "masked", refImage && "compare"].filter(Boolean)) {
          skipped(`${name}-${extra}.png`, meta, `원래 캡처 ${name}.png가 실패해 이 항목을 만들 수 없습니다`);
        }
        continue;
      }
      if (marks.length) await item(`${name}-marked.png`, meta, async (retried) => {
        if (retried) await prepare();
        try { await mark(); lines.push(basename(await screenshot(join(out, `${name}-marked.png`), flags.has("full"), selector ? await selectorClip() : null))); }
        finally { if (!browserNeedsRestart) await unmark(); }
      });
      if (useMask) await item(`${name}-masked.png`, meta, async (retried) => {
        if (retried) await prepare();
        try {
          await mask(); await sleep(60);
          masked.push({ path: await screenshot(join(out, `${name}-masked.png`), flags.has("full"), selector ? await selectorClip() : null), label: state || "page" });
          lines.push(`${name}-masked.png`);
        } finally { if (!browserNeedsRestart) await evaluate(`(document.getElementById("jstyle-mask")?.remove(), true)`); }
      });
      if (refImage) await item(`${name}-compare.png`, meta, async () => {
        const result = await compare(file, refImage, join(out, `${name}-compare.png`));
        entry.compare = { file: result.file, overall: result.overall, cells: result.cells }; lines.push(result.message);
      });
    }
    if (useSheet && !flags.has("no-sheet") && selectedStates.length > 1) {
      const sheetSuffixParts = [group.id, sizes.length > 1 ? `${w}x${h}` : "", selectedZooms.length > 1 && zoom !== 1 ? `@${zoom}x` : ""].filter(Boolean);
      const preferred = `${candidatePrefix() ? candidatePrefix() + "-" : ""}sheet${sheetSuffixParts.length ? "-" + sheetSuffixParts.join("-") : ""}`;
      const sheetName = reserveFamily(preferred, (stem) => [`${stem}.png`, ...(useMask ? [`${stem}-masked.png`] : [])]);
      const meta = { size: `${w}x${h}`, zoom, ...(group.reportName ? { group: group.reportName } : {}) };
      if (shots.length > 1) await item(`${sheetName}.png`, meta, async () => {
        lines.push(basename(await sheet(shots, join(out, `${sheetName}.png`), w, h)));
      });
      else skipped(`${sheetName}.png`, meta, `성공한 캡처가 ${shots.length}장뿐입니다. 모음 그림에는 2장 이상이 필요합니다`);
      if (useMask) {
        if (masked.length > 1) await item(`${sheetName}-masked.png`, meta, async () => {
          lines.push(basename(await sheet(masked, join(out, `${sheetName}-masked.png`), w, h)));
        });
        else skipped(`${sheetName}-masked.png`, meta, `글자를 가린 캡처가 ${masked.length}장뿐입니다. 모음 그림에는 2장 이상이 필요합니다`);
      }
    }
  }
}
async function motionBatch() {
  for (const group of groups.length ? groups : [{ id: "", reportName: "", steps: [] }]) {
    const file = `${candidatePrefix() ? candidatePrefix() + "-" : ""}motion-probe${group.id ? "-" + group.id : ""}`;
    const meta = { state: states[0], size: `${sizes[0].w}x${sizes[0].h}`, zoom: 1, ...(group.reportName ? { group: group.reportName } : {}) };
    await item(file, meta, async () => {
      const result = await probeMotion(withState(states[0]), sizes[0].w, sizes[0].h, group.steps);
      lines.push(result.message + (result.issues.length ? "  ⚠ " + result.issues.join("; ") : ""));
      report.push({ file, ...meta, motion: result.phases, issues: result.issues });
    });
  }
}
async function recording(group, entry, zoom, multipleZooms = false) {
  const preferred = [candidatePrefix(), group.id, multipleZooms && zoom !== 1 ? `@${zoom}x` : ""].filter(Boolean).join("-");
  const name = reserveFamily(preferred, (stem) => [`record${stem ? "-" + stem : ""}.mp4`, ...["start", "mid", "end"].map((frame) => `motion${stem ? "-" + stem : ""}-${frame}.jpg`), ...(opt.frames !== undefined ? [`motion${stem ? "-" + stem : ""}-sequence.png`] : [])]);
  const file = `motion${name ? "-" + name : ""}-end.jpg`;
  const meta = { state: states[0], size: `${sizes[0].w}x${sizes[0].h}`, zoom,
    ...((group.reportName || group.id) ? { group: group.reportName || group.id } : {}) };
  await item(file, meta, async () => {
    problems = [];
    const result = await record(withState(states[0]), sizes[0].w, sizes[0].h, { name, steps: group.steps, entry, zoom });
    lines.push(result.message);
    for (const warning of result.warnings || []) lines.push(`⚠ ${warning}`);
    report.push({ file, ...meta, issues: result.issues, frames: result.frames, sampling: result.sampling, durationMs: result.durationMs, ...(result.sequence ? { sequence: result.sequence } : {}), ...(result.consistency ? { consistency: result.consistency } : {}), ...(result.warnings?.length ? { warnings: result.warnings } : {}), ...(result.failed ? { failed: true } : {}) });
    if (evidence && result.failed) { report.at(-1).issues.push(result.message); process.exitCode = 1; }
  }, `${opt.frames !== undefined ? ` --frames ${opt.frames}` : ""}${flags.has("record") || opt.frames === undefined ? " --record" : ""}${entry ? " --entry" : ""}`);
}
const shotCount = (n, z, g, mask, sheet) => sizes.length * z * g * (n * (1 + Number(mask) + Number(marks.length > 0) + Number(!!refImage)) + (sheet && !flags.has("no-sheet") && n > 1 ? 1 + Number(mask) : 0));
const batchMask = states.length > 1 || flags.has("mask");
progressTotal = evidence
  ? (suppliedOptions.has("zoom") ? shotCount(states.length, zooms.length, 1, batchMask, states.length > 1) : shotCount(states.length, 1, 1, batchMask, states.length > 1) + shotCount(1, 1, 1, flags.has("mask"), false)) + Math.max(1, groups.length) + 1 + groups.length
  : (flags.has("motion") ? Math.max(1, groups.length) : 0) + (captureMotion ? zooms.length * Math.max(1, groups.length) : shotCount(states.length, zooms.length, Math.max(1, groups.length), flags.has("mask"), flags.has("sheet")));
progressTotal = progressTotal * Math.max(1, targets.length) + Number(autoSheet);
try {
  if (stitching) {
    progressTotal = 1;
    await item("stitch.png", {}, async () => {
      const result = await composeImages(stitchInputs, join(out, "stitch.png"), Number(opt.columns || 2), opt.crop);
      report.push({ ...result, issues: [] });
      lines.push(`그림 모음: ${result.file} (${result.width}×${result.height}, ${result.columns}열)`);
    });
  } else {
    for (const [index, candidate] of targets.entries()) {
      base = bases[index]; activeTarget = candidate;
      if (evidence) {
        const plain = [{ id: "", reportName: "", steps: [] }];
        if (suppliedOptions.has("zoom")) {
          await captureBatch(states.map((_, i) => i), zooms, plain, states.length > 1 || flags.has("mask"), states.length > 1);
        } else {
          await captureBatch(states.map((_, i) => i), [1], plain, states.length > 1 || flags.has("mask"), states.length > 1);
          await captureBatch([0], [2], plain, flags.has("mask"), false);
        }
        await motionBatch();
        // Avoid collisions with a user group named entry.
        let entryId = "entry";
        while (groups.some((g) => g.id === entryId)) entryId += "-appearance";
        await recording({ id: entryId, reportName: entryId, steps: [] }, true, 1);
        for (const group of groups) await recording(group, false, 1);
      } else {
        if (flags.has("motion")) await motionBatch();
        if (captureMotion) {
          for (const zoom of zooms) for (const group of groups.length ? groups : [{ id: "", reportName: "", steps: [] }]) await recording(group, flags.has("entry"), zoom, zooms.length > 1);
        } else await captureBatch(states.map((_, i) => i), zooms, groups.length ? groups : [{ id: "", reportName: "", steps: [] }], flags.has("mask"), flags.has("sheet"));
      }
    }
    if (autoSheet) {
      if (targetShots.length > 1) await item("sheet.png", {}, async () => {
        const result = await composeImages(targetShots, join(out, "sheet.png"), targetShots.length);
        report.push({ ...result, issues: [] }); lines.push("sheet.png");
      });
      else skipped("sheet.png", {}, `성공한 캡처가 ${targetShots.length}장뿐입니다. 모음 그림에는 2장 이상이 필요합니다`);
    }
  }
} catch (error) { if (!transportFailure) console.error(`shoot: ${error.message}`); process.exitCode = 1; }
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
console.log(`출력 폴더: ${out}`);
for (const notice of notices) console.log(`- ${notice}`);
for (const l of lines) console.log(`- ${l}`);
const total = report.reduce((n, r) => n + r.issues.length, 0);
if (report.length) console.log(total ? `문제 ${total}개를 찾았습니다. 자세한 내용은 report.json에 있습니다.` : `검사를 통과했습니다. 콘솔 오류, 가로 넘침, 깨진 이미지가 없습니다${flags.has("motion") ? ". 세 단계의 움직임도 모두 찾았습니다" : ""}.`);
const hinted = [...new Set(report.flatMap((r) => (r.lint || []).map((i) => i.label)))];
if (hinted.length) console.log(`읽기 쉬움과 그리기 안내 ${hinted.length}종류: ${hinted.join(", ")}. 자세한 내용은 report.json의 lint에 있습니다.`);
const reviewerManual = resolve(dirname(process.argv[1]), "../references/reviewer-manual.md");
if (evidence && existsSync(reviewerManual)) console.log(`점검자에게 전달: 독립 점검 에이전트(Agent)에게 안내 문서와 확인 자료 폴더를 넘기세요. 안내 문서: ${reviewerManual}, 확인 자료 폴더: ${out}`);
finishing = true;
await cleanup();
process.exit(process.exitCode || 0);
