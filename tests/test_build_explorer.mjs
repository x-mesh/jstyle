// Observable builder contracts. Run with: node --test tests/test_build_explorer.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { MARKER, PREVIEW_CSP, PathSet, TEMPLATE, build, limits, prepareHtml, readAsset } from "../scripts/build_explorer.mjs";
import { findChrome } from "../scripts/chrome.mjs";
import { HTMLParser } from "../scripts/lib/html-parser.mjs";
import { PyError, PyFloat, isValueError, jsonDumps } from "../scripts/lib/pycompat.mjs";

// Hangul and Han: the English UI and the template shell must contain neither.
const KOREAN_OR_HAN = /[\p{Script=Hangul}\p{Script=Han}]/u;

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const WINDOWS = process.platform === "win32";
const SLOW = Boolean(process.env.JSTYLE_SHOOT_SLOW_HOST);
const CHROME = (() => {
  try {
    return findChrome();
  } catch {
    return null;
  }
})();

const builderCommand = (scripts = path.join(ROOT, "scripts")) => [process.execPath, path.join(scripts, "build_explorer.mjs")];
const run = (command, options = {}) => spawnSync(command[0], command.slice(1), { encoding: "utf8", ...options });

// The Python tests read and wrote text files with universal newlines; keep that on Windows.
const readText = (file) => fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
const writeText = (file, text) => fs.writeFileSync(file, WINDOWS ? text.replace(/\n/g, "\r\n") : text);
const readBytes = (file) => fs.readFileSync(file);

// Python's str.split(sep, 1)[1] raises when sep is absent; so does this.
function after(text, separator) {
  const at = text.indexOf(separator);
  assert.notEqual(at, -1, `missing ${JSON.stringify(separator)}`);
  return text.slice(at + separator.length);
}
const before = (text, separator) => (text.includes(separator) ? text.slice(0, text.indexOf(separator)) : text);
const between = (text, start, end) => before(after(text, start), end);

function indexOf(container, item) {
  const at = container.indexOf(item);
  assert.notEqual(at, -1, `missing ${JSON.stringify(item)}`);
  return at;
}

const payload = (page) => JSON.parse(between(page, "const DATA = ", ";\n"));
const i18nTable = () => JSON.parse(between(readText(TEMPLATE), "const I18N = ", ";\n"));

const isManifestError = (error) => error instanceof PyError && error.type === "ManifestError";
const isFileExistsError = (error) => error instanceof PyError && error.type === "FileExistsError";

function raises(action, kind, pattern) {
  let caught;
  assert.throws(action, (error) => {
    caught = error;
    return true;
  });
  assert.ok(kind(caught), `expected ${kind.name}, got ${caught?.type ?? caught}: ${caught?.message}`);
  if (pattern) assert.match(caught.message, pattern);
  return caught;
}

function withLimits(overrides, action) {
  const saved = { ...limits };
  Object.assign(limits, overrides);
  try {
    return action();
  } finally {
    Object.assign(limits, saved);
  }
}

// unittest's assertAlmostEqual: round(a - b, 7) == 0 unless a delta is given.
function almostEqual(actual, expected, delta = 5e-8) {
  assert.ok(Math.abs(actual - expected) <= delta, `${actual} != ${expected} within ${delta}`);
}

// urllib.parse.quote with safe="/".
const quote = (text) => text.split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase())).join("/");
const asUri = (file) => pathToFileURL(file).href;

const tempDir = (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "tmp"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
};

class Fixture {
  constructor(t) {
    this.folder = tempDir(t);
    this.manifest = path.join(this.folder, "manifest.json");
    this.output = path.join(this.folder, "output", "explore.html");
    this.source = path.join(this.folder, "sample.html");
    writeText(this.source, '<!doctype html><html><head><style>body{color:#123}</style></head><body>같은 내용<script>window.bad=true</script></body></html>');
    this.data = { schemaVersion: 1, project: "프로젝트", brief: "같은 내용 비교", round: "01", candidates: [{ id: "a", name: "첫 번째 안", concept: "편집 화면", typography: "명조체와 고딕체", palette: ["#112233", "#fff"], traits: ["큰 제목"], kind: "html", source: "sample.html" }] };
    this.save();
  }

  save() {
    writeText(this.manifest, jsonDumps(this.data));
  }

  build(force = false) {
    return build(this.manifest, this.output, { force });
  }

  page() {
    return readText(this.output);
  }

  runBrowserProbe(resultId = "i18n-result", profile = "chrome-probe") {
    let runner = String.raw`
import {spawn} from 'node:child_process';
const chrome=spawn(process.argv[1],['--headless=new','--remote-debugging-pipe',
 '--no-first-run','--no-default-browser-check','--disable-extensions',
 '--force-prefers-reduced-motion',${"`"}--user-data-dir=${"${process.argv[2]}"}${"`"},'about:blank'],
 {stdio:['ignore','ignore','ignore','pipe','pipe']});
let seq=0,buffer='';const pending=new Map();
chrome.on('error',error=>{console.error(error);process.exitCode=1;});
chrome.stdio[4].on('data',data=>{
 buffer+=data.toString();let end;
 while((end=buffer.indexOf('\0'))>=0){
  const message=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
  if(pending.has(message.id)){const {resolve,reject}=pending.get(message.id);pending.delete(message.id);
   message.error?reject(Error(message.error.message)):resolve(message.result);}
 }
});
const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
 const id=++seq;pending.set(id,{resolve,reject});
 chrome.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');
});
const deadlineMs=process.env.JSTYLE_SHOOT_SLOW_HOST?30000:15000;
const deadline=setTimeout(()=>{console.error('Browser probe timed out');chrome.kill('SIGKILL');process.exitCode=1;},deadlineMs);
try{
 const {targetId}=await send('Target.createTarget',{url:'about:blank'});
 const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 await send('Page.enable',{},sessionId);
 await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]},sessionId);
 await send('Page.navigate',{url:process.argv[3]},sessionId);
 let result;
 for(let i=0;i<100;i++){
  const response=await send('Runtime.evaluate',{expression:"document.querySelector('#i18n-result')?.textContent",returnByValue:true},sessionId);
  result=response.result.value;if(result)break;
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 if(!result)throw Error('The page did not complete its interface/copy probe');
 console.log(result);
}catch(error){console.error(error);process.exitCode=1;}
finally{clearTimeout(deadline);chrome.kill();}
`;
    runner = runner.replaceAll("#i18n-result", "#" + resultId);
    return run([process.execPath, "--input-type=module", "-e", runner, CHROME, path.join(this.folder, profile), asUri(this.output)],
      { timeout: SLOW ? 45000 : 25000 });
  }
}

class StartTags extends HTMLParser {
  constructor() {
    super();
    this.observed = [];
  }

  handleStarttag(tag, attrs) {
    this.observed.push([tag, Object.fromEntries(attrs)]);
  }
}

function startTags(content) {
  const parser = new StartTags();
  parser.feed(content);
  return parser.observed;
}

const CHROME_SKIP = (purpose) => (CHROME ? false : `Chrome/Chromium is needed for ${purpose}`);

test("lang is optional and preserved when explicit", async (t) => {
  const f = new Fixture(t);
  f.build();
  assert.ok(!("lang" in payload(f.page())));
  for (const lang of ["ko", "en"]) {
    await t.test(`lang=${lang}`, () => {
      f.data.lang = lang;
      f.save();
      f.build(true);
      assert.equal(payload(f.page()).lang, lang);
    });
  }
});

test("invalid lang preserves existing output", async (t) => {
  const f = new Fixture(t);
  f.build();
  const original = readBytes(f.output);
  for (const lang of [null, "", "KO", "ko-KR", "en-US", "fr", 1, true, [], {}]) {
    await t.test(`lang=${jsonDumps(lang)}`, () => {
      f.data.lang = lang;
      f.save();
      raises(() => f.build(true), isValueError, /manifest.lang/);
      assert.deepEqual(readBytes(f.output), original);
    });
  }
});

test("native viewport formats are normalized and equivalent", async (t) => {
  const f = new Fixture(t);
  const fingerprints = new Set();
  const values = ["1920x1080", "1920×1080", " 1920 X 1080 ",
    { width: 1920, height: 1080 }, { width: new PyFloat(1920), height: new PyFloat(1080) }];
  for (const value of values) {
    for (const topLevel of [true, false]) {
      await t.test(`value=${jsonDumps(value)} top_level=${topLevel}`, () => {
        delete f.data.nativeViewport;
        delete f.data.candidates[0].nativeViewport;
        const target = topLevel ? f.data : f.data.candidates[0];
        target.nativeViewport = value;
        f.save();
        fingerprints.add(f.build(true).fingerprint);
        assert.deepEqual(payload(f.page()).candidates[0].nativeViewport, { width: 1920, height: 1080 });
      });
    }
  }
  assert.equal(fingerprints.size, 1);
});

test("native viewport inheritance, override and identity", (t) => {
  const f = new Fixture(t);
  const fallback = f.build();
  assert.ok(!("nativeViewport" in payload(f.page()).candidates[0]));
  f.data.nativeViewport = "1920x720";
  f.data.candidates.push(
    { ...f.data.candidates[0], id: "b", nativeViewport: { width: 1366, height: 1024 } },
    { ...f.data.candidates[0], id: "c", nativeViewport: "198×242" },
  );
  f.save();
  const result = f.build(true);
  const candidates = payload(f.page()).candidates;
  assert.deepEqual(candidates.map((c) => c.nativeViewport), [
    { width: 1920, height: 720 }, { width: 1366, height: 1024 }, { width: 198, height: 242 }]);
  assert.notEqual(result.fingerprint, fallback.fingerprint);
  f.data.candidates[0].nativeViewport = "1920x1080";
  f.save();
  assert.notEqual(f.build(true).fingerprint, result.fingerprint);
});

test("invalid native viewports report received values and preserve output", async (t) => {
  const f = new Fixture(t);
  f.build();
  const original = readBytes(f.output);
  const invalid = [null, true, 1920, [], {}, "", "1920", "1920:1080", "-1x1080", "0×1080",
    "1920.5x1080", { width: 1920 }, { width: "1920", height: 1080 },
    { width: true, height: 1080 }, { width: 1920, height: 0 },
    { width: 1920, height: 1.5 }];
  for (const value of invalid) {
    for (const topLevel of [true, false]) {
      await t.test(`value=${jsonDumps(value)} top_level=${topLevel}`, () => {
        delete f.data.nativeViewport;
        delete f.data.candidates[0].nativeViewport;
        const target = topLevel ? f.data : f.data.candidates[0];
        target.nativeViewport = value;
        f.save();
        const message = raises(() => f.build(true), isManifestError).message;
        for (const expected of ["안 a", "nativeViewport", jsonDumps(value),
          '"1920x1080"', '"1920×1080"', '{"width":1920,"height":1080}']) {
          assert.ok(message.includes(expected), expected);
        }
        assert.deepEqual(readBytes(f.output), original);
      });
    }
  }
});

test("native viewport errors are collected with other manifest problems", (t) => {
  const f = new Fixture(t);
  f.data.nativeViewport = "bad-default";
  f.data.candidates.push({ ...f.data.candidates[0], id: "b", nativeViewport: "bad-b", palette: ["red"] });
  f.data.candidates.push({ ...f.data.candidates[0], id: "c", nativeViewport: { height: 242 } });
  f.save();
  const caught = raises(() => f.build(), isManifestError);
  assert.equal(caught.problems.length, 4);
  for (const expected of ["manifest(안 a)", "bad-default", "안 b：nativeViewport", "bad-b",
    "안 b：palette", "안 c：nativeViewport", '{"height": 242}']) {
    assert.ok(caught.message.includes(expected), expected);
  }
});

test("default viewports and narrow native canvas fitting", () => {
  const template = readText(TEMPLATE);
  const fit = before(after(template, " function fit(s){"), "\n const fitAll=");
  const program = String.raw`
const SIZES={desktop:{w:1280,h:900},mobile:{w:390,h:844}},st={viewport:'desktop'};
const byId={a:{}},innerHeight=844,$=()=>({offsetHeight:100});
const narrow=()=>true,getComputedStyle=()=>({paddingLeft:'12',paddingRight:'12',paddingTop:'16',paddingBottom:'16'});
const m={style:{}},box={clientWidth:390,clientHeight:0,dataset:{zoom:'fit'},classList:{contains:()=>false}};
const s={isConnected:true,dataset:{id:'a'},parentElement:box,querySelector:()=>m,style:{}};
` + "function fit(s){" + fit + String.raw`
const result=[];
fit(s);result.push({...m.style,stage:{...s.style}});
st.viewport='mobile';fit(s);result.push({...m.style,stage:{...s.style}});
byId.a.nativeViewport={width:198,height:242};fit(s);result.push({...m.style,stage:{...s.style}});
byId.a.nativeViewport={width:1366,height:1024};box.classList.contains=()=>true;
fit(s);result.push({...m.style,stage:{...s.style}});
byId.a.nativeViewport={width:198,height:2000};fit(s);result.push({...m.style,stage:{...s.style}});
box.dataset.zoom='actual';fit(s);result.push({...m.style,stage:{...s.style}});
console.log(JSON.stringify(result));
`;
  const executed = run([process.execPath, "-e", program], { timeout: 10000 });
  assert.equal(executed.status, 0, executed.stderr);
  const results = JSON.parse(executed.stdout);
  const expected = [
    [1280, 900, 390 / 1280], [390, 844, 1], [198, 242, 1],
    [1366, 1024, 366 / 1366], [198, 2000, 712 / 2000], [198, 2000, 1]];
  // zip(): pairs only as many entries as both sides have.
  for (let index = 0; index < Math.min(results.length, expected.length); index += 1) {
    const result = results[index];
    const [width, height, scale] = expected[index];
    assert.equal(result.width, `${width}px`);
    assert.equal(result.height, `${height}px`);
    almostEqual(Number.parseFloat(result.transform.slice(6, -1)), scale);
    almostEqual(Number.parseFloat(result.stage.width.slice(0, -2)), width * scale);
    almostEqual(Number.parseFloat(result.stage.height.slice(0, -2)), height * scale);
  }
});

test("rendered native viewports fit cards, loupe and actual size", { skip: CHROME_SKIP("rendered viewport checks") }, async (t) => {
  const f = new Fixture(t);
  f.data.nativeViewport = "1920x1080";
  f.data.candidates.push(
    { ...f.data.candidates[0], id: "b", nativeViewport: "1920×720" },
    { ...f.data.candidates[0], id: "c", nativeViewport: { width: 198, height: 242 } },
  );
  f.save();
  f.build();
  const probe = String.raw`<script>
(async()=>{
 const tick=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 const measure=s=>{
  const m=s.querySelector('iframe'),r=m.getBoundingClientRect(),b=s.getBoundingClientRect();
  const box=s.parentElement,cs=getComputedStyle(box);
  return {id:s.dataset.id,width:parseFloat(m.style.width),height:parseFloat(m.style.height),
   scale:new DOMMatrix(getComputedStyle(m).transform).a,stage:[b.width,b.height],media:[r.width,r.height],
   available:[box.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight),
              box.clientHeight-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom)]};
 };
 await tick();const cards=[...document.querySelectorAll('.card .stage')].map(measure);
 document.querySelector('[data-viewport=mobile]').click();await tick();
 const mobile=[...document.querySelectorAll('.card .stage')].map(measure);
 const loupe=[],actual=[];
 for(const card of document.querySelectorAll('.card')){
  card.querySelector('.hit').click();await tick();
  loupe.push(measure(document.querySelector('.slide.is-current .stage')));
  document.querySelector('#zoom').click();await tick();
  actual.push(measure(document.querySelector('.slide.is-current .stage')));
  document.querySelector('[data-layout=compare]').click();await tick();
 }
 const out=document.createElement('pre');out.id='viewport-result';
 out.textContent=JSON.stringify({cards,mobile,loupe,actual});document.body.append(out);
})();
</script>`;
  writeText(f.output, f.page().replaceAll("</body></html>", () => probe + "</body></html>"));
  const probed = f.runBrowserProbe("viewport-result", "chrome-native");
  assert.equal(probed.status, 0, probed.stderr);
  const result = JSON.parse(probed.stdout);
  const sizes = { a: [1920, 1080], b: [1920, 720], c: [198, 242] };
  for (const [mode, samples] of Object.entries(result)) {
    assert.equal(samples.length, 3, mode);
    for (const sample of samples) {
      await t.test(`mode=${mode} id=${sample.id}`, () => {
        const [width, height] = sizes[sample.id];
        assert.deepEqual([sample.width, sample.height], [width, height]);
        const scale = sample.scale;
        assert.ok(scale > 0);
        assert.ok(scale <= 1);
        if (mode === "actual") {
          assert.equal(scale, 1);
        } else {
          assert.ok(sample.stage[0] <= sample.available[0] + 0.1);
          if (mode === "loupe") assert.ok(sample.stage[1] <= sample.available[1] + 0.1);
        }
        [width, height].forEach((native, dimension) => {
          almostEqual(sample.stage[dimension], native * scale, 0.1);
          almostEqual(sample.media[dimension], native * scale, 0.1);
        });
      });
    }
  }
});

test("interface strings are complete and centralized", () => {
  const template = readText(TEMPLATE);
  const tableText = between(template, "const I18N = ", ";\n");
  const table = JSON.parse(tableText);
  assert.deepEqual(Object.keys(table).sort(), ["en", "ko"]);
  assert.deepEqual(Object.keys(table.ko).sort(), Object.keys(table.en).sort());
  // Python's \w and \b are Unicode-aware; JavaScript's are ASCII-only.
  const keys = new Set(Array.from(template.matchAll(/(?<![\p{L}\p{N}_])t\('([^']+)'/gu), (match) => match[1]));
  for (const match of template.matchAll(/data-i18n(?:-[\p{L}\p{N}_-]+)?="([^"]+)"/gu)) keys.add(match[1]);
  assert.deepEqual([...keys].sort(), Object.keys(table.ko).sort());
  const placeholders = (value) => [...new Set(Array.from(value.matchAll(/\{([\p{L}\p{N}_]+)\}/gu), (match) => match[1]))].sort();
  for (const key of keys) {
    assert.ok(table.ko[key], key);
    assert.ok(table.en[key], key);
    assert.doesNotMatch(table.en[key], KOREAN_OR_HAN, key);
    assert.deepEqual(placeholders(table.ko[key]), placeholders(table.en[key]), key);
  }
  // Both locales are shipped for browser detection; neither may leak into
  // markup or JavaScript outside this single table (comments are not UI).
  let shell = template.replaceAll(tableText, () => "{}");
  shell = shell.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/[^\n]*/gm, "");
  assert.doesNotMatch(shell, KOREAN_OR_HAN);
});

test("browser language fallback and copied sentence", (t) => {
  const template = readText(TEMPLATE);
  let translations = before(after(template, "// Interface strings:"), "(()=>{");
  translations = translations.slice(indexOf(translations, "const I18N = "));
  const copyFunction = before(after(template, " function copyText()"), "\n async function copy");
  const numberFunction = before(after(template, "no=c=>"), ",vtName=");
  const cases = [[null, "ko-KR", "ko"], [null, "KO-KR", "ko"],
    [null, "en-US", "en"], [null, "fr-FR", "en"],
    [null, "", "en"], ["ko", "en-US", "ko"], ["en", "ko-KR", "en"]];
  let program = "const results=[];\n";
  for (const [lang, browserLang] of cases) {
    for (const [roundValue, notes, baseline] of [["01", "  More space  ", false], ["", "", false], ["02", "", true]]) {
      const data = { round: roundValue };
      if (lang !== null) data.lang = lang;
      program += "{\nconst DATA=" + JSON.stringify(data) + ";const navigator={language:" + JSON.stringify(browserLang) + "};\n";
      program += translations;
      program += "const c={name:'Direction A',baseline:" + JSON.stringify(baseline) + "};const DIRS=[c],byId={a:c},st={chosen:'a',notes:" + JSON.stringify(notes) + "};\n";
      program += "const no=c=>" + numberFunction + ";\nfunction copyText()" + copyFunction;
      program += "\nresults.push({lang:LANG,text:copyText()});\n}\n";
    }
  }
  program += "console.log(JSON.stringify(results));";
  // Passed as a file: the program is longer than a Windows command line may be.
  const script = path.join(tempDir(t), "program.cjs");
  writeText(script, program);
  const executed = run([process.execPath, script], { timeout: 30000 });
  assert.equal(executed.status, 0, executed.stderr);
  const results = JSON.parse(executed.stdout)[Symbol.iterator]();
  for (const [, , expected] of cases) {
    const number = expected === "ko" ? "기존 화면" : "Current";
    const texts = expected === "ko"
      ? ["01회: 01 Direction A 안을 고릅니다", "01 Direction A 안을 고릅니다", `02회: ${number} Direction A 안을 고릅니다`]
      : ["Round 01: Go with 01 Direction A", "Go with 01 Direction A", `Round 02: Go with ${number} Direction A`];
    for (const text of texts) {
      const next = results.next();
      assert.ok(!next.done, "fewer results than expected");
      assert.deepEqual(next.value, { lang: expected, text });
    }
  }
});

test("rendered interfaces do not mix languages", { skip: CHROME_SKIP("rendered interface checks") }, async (t) => {
  const f = new Fixture(t);
  writeText(f.source, "<html><head></head><body>Sample</body></html>");
  Object.assign(f.data, { project: "Demo", brief: "Compare directions", round: "01" });
  Object.assign(f.data.candidates[0], { name: "Direction A", concept: "Clear hierarchy", typography: "System font", traits: ["Large headings"] });
  f.data.candidates.push({ ...f.data.candidates[0], id: "b", baseline: true, interactive: true });
  const probe = String.raw`<script>
(async()=>{
 const snapshots=[],copied=[];
 Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>copied.push(text)},configurable:true});
 const capture=()=>{
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  let n;while(n=walker.nextNode())if(!n.parentElement.closest('script,style'))snapshots.push(n.textContent.trim());
  document.querySelectorAll('[aria-label],[title],[placeholder]').forEach(n=>['aria-label','title','placeholder'].forEach(a=>{if(n.hasAttribute(a))snapshots.push(n.getAttribute(a));}));
 };
 const initial={loupe:!document.querySelector('#loupe').hidden,current:document.querySelector('.slide.is-current').dataset.id,mobile:document.querySelector('[data-viewport=mobile]').getAttribute('aria-pressed'),cards:document.querySelectorAll('.card').length,descriptions:[...document.querySelectorAll('.lede')].every(n=>getComputedStyle(n).display!=='none')};
 capture();document.querySelector('[data-layout=loupe]').click();capture();
 document.querySelector('#zoom').click();capture();document.querySelector('#zoom').click();
 document.querySelector('#info-body [data-pick]').click();await Promise.resolve();capture();
 navigator.clipboard.writeText=async()=>{throw Error('denied')};document.execCommand=()=>false;
 document.querySelector('#info-body [data-pick]').click();await Promise.resolve();await Promise.resolve();capture();
 const result=document.createElement('pre');result.id='i18n-result';result.textContent=JSON.stringify({lang:document.documentElement.lang,title:document.title,snapshots,copied,initial,saved:JSON.parse(localStorage.getItem(${"`"}jstyle:${"${DATA.fingerprint}"}${"`"}))});document.body.append(result);
})();
</script>`;
  const table = i18nTable();
  for (const lang of ["ko", "en"]) {
    await t.test(`lang=${lang}`, () => {
      f.data.lang = lang;
      f.save();
      f.build(true);
      let page = f.page();
      const key = "jstyle:" + payload(page).fingerprint;
      const legacy = { layout: "loupe", viewport: "mobile", current: "b", chosen: "a",
        visible: [], notesOn: false, notes: "Old private note" };
      const seed = "<script>localStorage.setItem(" + JSON.stringify(key) + "," + JSON.stringify(JSON.stringify(legacy)) + ");</script>";
      page = page.replace("<script>\nconst DATA", () => seed + "<script>\nconst DATA");
      page = page.replaceAll("</body></html>", () => probe + "</body></html>");
      writeText(f.output, page);
      // Use the debugging pipe rather than virtual time: previews can
      // keep animation frames alive, so --dump-dom may never finish.
      const probed = f.runBrowserProbe("i18n-result", "chrome-" + lang);
      assert.equal(probed.status, 0, probed.stderr);
      const observed = JSON.parse(probed.stdout);
      assert.equal(observed.lang, table[lang].htmlLang);
      assert.equal(observed.title, table[lang].projectTitle.replace("{project}", () => "Demo").replace("{edition}", () => (payload(page).edition === "pro" ? " Pro" : "")));
      assert.deepEqual(observed.initial, { loupe: true, current: "b", mobile: "true", cards: 2, descriptions: true });
      assert.deepEqual(Object.keys(observed.saved).sort(), ["chosen", "current", "layout", "viewport"]);
      assert.equal(observed.saved.chosen, "b");
      const strings = observed.snapshots;
      assert.ok(!strings.includes("Old private note"));
      for (const name of ["compare", "loupe", "layoutLabel", "viewportLabel",
        "baseline", "fonts", "traits", "actual", "fit", "empty", "copied", "copyFailed"]) {
        assert.ok(strings.includes(table[lang][name]), name);
        const other = table[lang === "ko" ? "en" : "ko"][name];
        assert.ok(!strings.includes(other), name);
      }
      if (lang === "en") assert.doesNotMatch(strings.join("\n"), KOREAN_OR_HAN);
      assert.deepEqual(observed.copied, lang === "ko" ? ["01회: 기존 화면 Direction A 안을 고릅니다"]
        : ["Round 01: Go with Current Direction A"]);
    });
  }
});

test("portable single file and HTML payload", (t) => {
  const f = new Fixture(t);
  const result = f.build();
  const page = f.page();
  assert.equal(result.candidates, 1);
  assert.ok(page.includes("같은 내용"));
  assert.ok(!page.includes(f.folder));
  assert.ok(!page.includes(MARKER));
  assert.ok(page.includes("script-src 'none'"));
});

test("metadata cannot close script", (t) => {
  const f = new Fixture(t);
  f.data.project = "</script><script>window.injected=true</script>";
  f.save();
  f.build();
  const page = f.page();
  assert.ok(!page.includes(f.data.project));
  assert.ok(page.includes("\\u003c/script>"));
});

test("CSP is inserted in the actual head, not a comment", (t) => {
  const f = new Fixture(t);
  writeText(f.source, `<!doctype html>
        <!-- Skeleton: <head> \u2028 extra text -->
        <html><head data-note="a > b"></head><body>content</body></html>`);
  const observed = startTags(prepareHtml(f.source));
  const meta = observed.filter(([tag]) => tag === "meta").map(([, attrs]) => attrs);
  assert.deepEqual(meta, [{ "http-equiv": "Content-Security-Policy", content: PREVIEW_CSP }]);
  assert.deepEqual(observed.map(([tag]) => tag).slice(0, 3), ["html", "head", "meta"]);
});

test("nested documents are rejected before replacing output", (t) => {
  const f = new Fixture(t);
  f.build();
  const original = readBytes(f.output);
  writeText(f.source, `<html><head></head><body>
        <iframe srcdoc="&lt;img src='https://example.invalid/a.png'&gt;"></iframe>
        </body></html>`);
  raises(() => f.build(true), isValueError);
  assert.deepEqual(readBytes(f.output), original);
});

test("existing output is preserved and force is explicit", (t) => {
  const f = new Fixture(t);
  f.build();
  const original = readBytes(f.output);
  f.data.project = "새 프로젝트";
  f.save();
  raises(() => f.build(), isFileExistsError);
  assert.deepEqual(readBytes(f.output), original);
  f.build(true);
  assert.notDeepEqual(readBytes(f.output), original);
});

test("invalid resource keeps prior output even with force", (t) => {
  const f = new Fixture(t);
  f.build();
  const original = readBytes(f.output);
  writeText(f.source, '<html><head></head><body><img src="missing.png"></body></html>');
  raises(() => f.build(true), isValueError);
  assert.deepEqual(readBytes(f.output), original);
});

test("duplicate identifier and invalid colors", (t) => {
  const f = new Fixture(t);
  f.data.candidates.push({ ...f.data.candidates[0] });
  f.save();
  raises(() => f.build(), isValueError);
  f.data.candidates.pop();
  f.data.candidates[0].palette = ["url(example)"];
  f.save();
  raises(() => f.build(), isValueError);
  assert.ok(!fs.existsSync(f.output));
});

test("text and preserved script are not CSS resources", (t) => {
  const f = new Fixture(t);
  writeText(f.source, `<html><head><style>
        /* @import "unused.css"; */
        p::after {content: "example url(example.png) @import"}
        </style></head><body><p>Explain @import and url(example.png)</p>
        <script>const example = "url(unused.png)";</script></body></html>`);
  f.build();
  assert.ok(fs.statSync(f.output).isFile());
});

test("CSS sources are checked in styles and inline attributes", async (t) => {
  const f = new Fixture(t);
  const fragments = [
    '<style>.hero{background:image-set("https://example.invalid/a.png" 1x)}</style>',
    '<style>.hero{background:-webkit-image-set("missing.png" 1x)}</style>',
    '<style>.hero{background:u\\72l(missing.png)}</style>',
    '<style>@import "missing.css";</style>',
  ];
  for (const fragment of fragments) {
    await t.test(`fragment=${fragment}`, () => {
      writeText(f.source, `<html><head>${fragment}</head><body>content</body></html>`);
      raises(() => f.build(), isValueError);
    });
  }
  writeText(f.source, '<html><head></head><body style="background:url(missing.png)">content</body></html>');
  raises(() => f.build(), isValueError);
});

test("missing outside source and overwriting inputs are rejected", (t) => {
  const f = new Fixture(t);
  f.data.candidates[0].source = "../outside.html";
  f.save();
  raises(() => f.build(), isValueError, /로컬 파일을 찾을 수 없습니다.*outside.html/);
  f.data.candidates[0].source = "sample.html";
  f.save();
  raises(() => build(f.manifest, f.source, { force: true }), isValueError);
  raises(() => build(f.manifest, f.manifest, { force: true }), isValueError);
});

test("static image embedded and content changes identity", (t) => {
  const f = new Fixture(t);
  const image = path.join(f.folder, "preview.png");
  fs.writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7ioAAAAASUVORK5CYII=", "base64"));
  Object.assign(f.data.candidates[0], { kind: "image", source: "preview.png" });
  f.save();
  const first = f.build();
  assert.ok(f.page().includes("data:image/png;base64,"));
  f.data.round = "02";
  f.save();
  const second = f.build(true);
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test("relative local assets are embedded", (t) => {
  const f = new Fixture(t);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  fs.mkdirSync(path.join(f.folder, "pages", "img"), { recursive: true });
  fs.writeFileSync(path.join(f.folder, "pages", "img", "dot.png"), png);
  writeText(path.join(f.folder, "pages", "a.html"), '<!doctype html><html><head><style>.x{background:url("img/dot.png")}</style></head><body><img src="img/dot.png" alt=""></body></html>');
  f.data.candidates[0].source = "pages/a.html";
  f.save();
  f.build();
  const page = f.page();
  assert.ok(!page.includes("img/dot.png"));
  assert.ok(page.includes("data:image/png;base64,"));
});

test("local assets outside manifest are embedded and protected", async (t) => {
  const f = new Fixture(t);
  const assets = path.join(fs.realpathSync(tempDir(t)), "이미지와 자료 #100%");
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, "font.ttf"), "local-font");
  fs.writeFileSync(path.join(assets, "image.png"), "local-image");
  writeText(path.join(assets, "app.js"), "window.loaded=true");
  writeText(path.join(assets, "app.css"), "@font-face{font-family:test;src:url(font.ttf)}");
  // Exercise ../ traversal as well as absolute references; no file copying is needed.
  const relative = quote(path.relative(fs.realpathSync(f.folder), path.join(assets, "app.css")).split(path.sep).join("/"));
  const image = asUri(path.join(assets, "image.png"));
  writeText(f.source, `<html><head><link rel="stylesheet" href="${relative}"></head>`
    + `<body style="background:url(${image})">`
    + `<img src="${image}">`
    + `<script defer src="${asUri(path.join(assets, "app.js"))}"></script></body></html>`);
  f.data.candidates[0].interactive = true;
  f.save();
  const first = f.build();
  const content = payload(f.page()).candidates[0].content;
  assert.ok(content.includes("data:font/ttf;base64," + Buffer.from("local-font").toString("base64")));
  assert.equal(content.split("data:image/png;base64,").length - 1, 2);
  assert.ok(content.includes("window.loaded=true"));
  assert.ok(!content.includes(assets));
  const original = new Map(fs.readdirSync(assets).map((name) => [path.join(assets, name), readBytes(path.join(assets, name))]));
  for (const [file, bytes] of original) {
    await t.test(`overwrite=${path.basename(file)}`, () => {
      raises(() => build(f.manifest, file, { force: true }), isValueError, /출력으로 입력을 덮어쓸 수 없습니다/);
    });
    assert.deepEqual(readBytes(file), bytes);
  }
  fs.writeFileSync(path.join(assets, "font.ttf"), "updated-font");
  const second = f.build(true);
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test("outside candidate source is accepted and protected", (t) => {
  const f = new Fixture(t);
  const source = path.join(tempDir(t), "outside.html");
  writeText(source, "<p>밖의 비교 파일</p>");
  f.data.candidates[0].source = source;
  f.save();
  f.build();
  assert.ok(payload(f.page()).candidates[0].content.includes("밖의 비교 파일"));
  raises(() => build(f.manifest, source, { force: true }), isValueError, /출력으로 입력을 덮어쓸 수 없습니다/);
});

test("native Windows resource paths accept slashes and reserved characters", { skip: !WINDOWS && "Windows drive paths" }, async (t) => {
  const f = new Fixture(t);
  const image = path.join(f.folder, "이미지와 자료 #100%.png");
  fs.writeFileSync(image, "image");
  for (const ref of [image, image.split(path.sep).join("/"), asUri(image)]) {
    await t.test(`ref=${ref}`, () => {
      writeText(f.source, `<img src="${ref}">`);
      f.build(true);
      const content = payload(f.page()).candidates[0].content;
      assert.ok(content.includes("data:image/png;base64,aW1hZ2U="));
      assert.ok(!content.includes("#100"));
    });
  }
});

test("source filesystem paths and text newlines keep existing behavior", (t) => {
  const f = new Fixture(t);
  const source = path.join(f.folder, "candidate #1%20.html");
  fs.writeFileSync(source, "<html>\r\n<head></head>\r\n<body>content</body></html>");
  f.data.candidates[0].source = path.basename(source);
  f.save();
  f.build();
  const content = payload(f.page()).candidates[0].content;
  assert.ok(content.includes("<html>\n<head>"));
  assert.ok(!content.includes("\r"));
  assert.deepEqual(readBytes(source), Buffer.from("<html>\r\n<head></head>\r\n<body>content</body></html>"));
});

test("CSS imports resolve relative to each stylesheet", (t) => {
  const f = new Fixture(t);
  fs.mkdirSync(path.join(f.folder, "styles", "nested"), { recursive: true });
  writeText(path.join(f.folder, "styles", "main.css"), '@import "nested/theme.css" layer(theme) supports(display: grid) screen; body{margin:0}');
  writeText(path.join(f.folder, "styles", "nested", "theme.css"), '@import "../main.css"; @font-face{src:url("../../font.ttf?v=1")} .hero{background:url(../../image.png)}');
  fs.writeFileSync(path.join(f.folder, "font.ttf"), "font");
  fs.writeFileSync(path.join(f.folder, "image.png"), "image");
  writeText(f.source, '<link REL=stylesheet HREF="styles/main.css" media="(min-width: 1px)"><p>내용</p>');
  f.build();
  const content = payload(f.page()).candidates[0].content;
  for (const expected of ["@media (min-width: 1px)", "@layer theme", "@supports (display: grid)", "@media screen", "data:font/ttf;base64,", "data:image/png;base64,"]) {
    assert.ok(content.includes(expected), expected);
  }
  assert.ok(!content.includes("@import"));
  assert.ok(!content.includes("image.png"));
});

test("resource spelling variants are embedded", (t) => {
  const f = new Fixture(t);
  fs.writeFileSync(path.join(f.folder, "그림 조각.png"), "image");
  writeText(path.join(f.folder, "sprite.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="dot"/></svg>');
  writeText(f.source, String.raw`<html><head><style>
          .hero{background:u\72l(/* image */ "그림%20조각.png?cache=1")}
          .retina{background:image-set("그림%20조각.png" 1x, url("그림%20조각.png") 2x)}
        </style></head><body><IMG SRC=그림%20조각.png><svg><use href="sprite.svg#dot"/></svg>
        <video poster="그림%20조각.png"></video></body></html>`);
  f.build();
  const content = payload(f.page()).candidates[0].content;
  assert.equal(content.split("data:image/png;base64,").length - 1, 5);
  assert.ok(content.includes("data:image/svg+xml;base64,"));
  assert.ok(content.includes('#dot"'));
  assert.ok(!content.includes("그림%20조각.png"));
});

test("img srcset keeps src or takes the widest candidate", async (t) => {
  const f = new Fixture(t);
  fs.writeFileSync(path.join(f.folder, "small.png"), "small");
  fs.writeFileSync(path.join(f.folder, "large.png"), "large-image");
  const cases = [
    ['<img src="small.png" srcset="small.png 600w, large.png 1200w" alt="">', "small"],
    ['<img srcset="small.png 600w, large.png 1200w" alt="">', "large-image"],
    ['<img srcset="large.png 2x, small.png" alt="">', "large-image"],
  ];
  for (const [tag, expected] of cases) {
    await t.test(`tag=${tag}`, () => {
      writeText(f.source, `<html><head></head><body>${tag}</body></html>`);
      f.build(true);
      const content = payload(f.page()).candidates[0].content;
      assert.ok(!content.includes("srcset"));
      assert.equal(content.split("data:image/png;base64,").length - 1, 1);
      assert.ok(content.includes('src="data:image/png;base64,' + Buffer.from(expected).toString("base64")));
    });
  }
  // A data URL keeps its commas, and an empty src gives way instead of leaving two src attributes.
  const inline = "data:image/png;base64,QUFB,QkI=";
  for (const [tag, expected] of [[`<img srcset="${inline} 2x, small.png 1x" alt="">`, inline],
    ['<img src="" srcset="large.png 1200w" alt="">', "data:image/png;base64," + Buffer.from("large-image").toString("base64")]]) {
    await t.test(`tag=${tag}`, () => {
      writeText(f.source, `<html><head></head><body>${tag}</body></html>`);
      f.build(true);
      const content = payload(f.page()).candidates[0].content;
      const img = content.match(/<img[^>]*>/)[0];
      assert.deepEqual(Array.from(img.matchAll(/\ssrc="([^"]*)"/g), (match) => match[1]), [expected]);
      assert.ok(!img.includes("srcset"));
    });
  }
});

test("shell secondary text meets body contrast", async (t) => {
  const template = readText(path.join(ROOT, "assets", "style-explorer.html"));
  const root = template.match(/:root\{([^}]*)\}/)[1];
  const tokens = Object.fromEntries(Array.from(root.matchAll(/--(canvas|well|faint|soft):(#[0-9a-f]{6})/g), (match) => [match[1], match[2]]));
  const luminance = (color) => {
    const channels = [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  for (const text of ["faint", "soft"]) {
    for (const ground of ["canvas", "well"]) {
      await t.test(`text=${text} ground=${ground}`, () => {
        const [high, low] = [luminance(tokens[text]), luminance(tokens[ground])].sort((a, b) => b - a);
        assert.ok((high + 0.05) / (low + 0.05) >= 4.5);
      });
    }
  }
});

test("resource examples in text, comments and scripts stay unchanged", (t) => {
  const f = new Fixture(t);
  const example = '<img src="missing.png"> url(missing.png)';
  writeText(f.source, `<html><head><style>/* url(missing.png) */ p::after{content:'url(missing.png)'}</style></head>`
    + `<body><!-- ${example} --><script>const example = '${example}';</script></body></html>`);
  const content = prepareHtml(f.source, true);
  assert.ok(content.includes(example));
  assert.ok(content.includes("/* url(missing.png) */"));
  assert.ok(content.includes("content:'url(missing.png)'"));
});

test("remote and missing resources report exact reference and fix", async (t) => {
  const f = new Fixture(t);
  for (const ref of ["https://example.invalid/font.ttf", "//example.invalid/font.ttf", "missing.ttf"]) {
    for (const fragment of [`<img src="${ref}">`, `<style>@font-face{src:url("${ref}")}</style>`,
      `<link rel="stylesheet" href="${ref}">`, `<script src="${ref}"></script>`]) {
      await t.test(`ref=${ref} fragment=${fragment}`, () => {
        writeText(f.source, fragment);
        const message = raises(() => f.build(), isManifestError).message;
        for (const expected of ["안 a", "sample.html", ref, "다시 만드세요"]) assert.ok(message.includes(expected), expected);
        assert.ok(message.includes(ref.includes("example.invalid") ? "curl -L --fail --output" : "파일을 다음 위치에 저장하세요:"));
        assert.ok(!fs.existsSync(f.output));
      });
    }
  }
});

test("resource size limits preserve output and allow the boundary", (t) => {
  const f = new Fixture(t);
  f.build();
  const original = readBytes(f.output);
  const image = path.join(f.folder, "large.png");
  fs.writeFileSync(image, "i".repeat(1025));
  writeText(f.source, '<img src="large.png">');
  withLimits({ maxResourceBytes: 1024 }, () => {
    raises(() => f.build(true), isValueError, /large.png.*파일 하나의 최대 크기 1024.*압축/);
  });
  assert.deepEqual(readBytes(f.output), original);
  const used = new PathSet();
  fs.writeFileSync(image, "i".repeat(1024));
  withLimits({ maxResourceBytes: 1024, maxTotalResourceBytes: 1024 }, () => {
    assert.equal(readAsset(image, used).length, 1024);
    readAsset(image, used); // Repeated references count as one input.
    const other = path.join(f.folder, "other.png");
    fs.writeFileSync(other, "i");
    raises(() => readAsset(other, used), isValueError, /총 크기.*전체 최대 크기 1024.*줄이/);
  });
  withLimits({ maxTotalResourceBytes: 1 }, () => {
    raises(() => f.build(true), isValueError, /전체 최대 크기/);
  });
  assert.deepEqual(readBytes(f.output), original);
});

test("palette extracts hex colors from descriptions and other shapes", async (t) => {
  const f = new Fixture(t);
  const examples = [
    [["짙은 초록 #1b3a2a 단색 띠", "흰색 #FFF"], ["#1b3a2a", "#FFF"]],
    ["짙은 초록 #1b3a2a，흰색 #FFF", ["#1b3a2a", "#FFF"]],
    [{ "주된 색": "#1b3a2a", 바탕: "흰색 #FFF" }, ["#1b3a2a", "#FFF"]],
    [[null, 42, { color: "#1234" }, "#12345678 #abc"], ["#1234", "#12345678", "#abc"]],
    [["red", "#fff"], ["#fff"]],
  ];
  for (const [value, expected] of examples) {
    await t.test(`value=${jsonDumps(value)}`, () => {
      f.data.candidates[0].palette = value;
      f.save();
      f.build(true);
      assert.deepEqual(payload(f.page()).candidates[0].palette, expected);
    });
  }
});

test("palette without any complete hex color has copyable fix", async (t) => {
  const f = new Fixture(t);
  for (const value of [null, 123, [], {}, ["green"], "#12 #12345 #1234567 #123456789 #12345g"]) {
    await t.test(`value=${jsonDumps(value)}`, () => {
      f.data.candidates[0].palette = value;
      f.save();
      raises(() => f.build(), isValueError, /안 a：palette.*"palette": \["#1a2b3c", "#ffffff"\]/);
    });
  }
  assert.ok(!fs.existsSync(f.output));
});

test("missing or unclosed head is completed before CSP", async (t) => {
  const f = new Fixture(t);
  const examples = [
    "<!doctype html><html><body><p>내용</p></body></html>",
    "<!doctype html><p>내용</p>",
    "<body><p>내용</p></body>",
    "<html><head/><body><p>내용</p></body></html>",
    "<!-- <head>가짜 꼬리표</head> --><p>내용</p>",
    "<html><head><style>p{color:red}</style><body><p>내용</p></body></html>",
    "<html><head><title>내용</title></html>",
  ];
  for (const source of examples) {
    for (const interactive of [false, true]) {
      await t.test(`source=${source} interactive=${interactive}`, () => {
        writeText(f.source, source);
        const content = prepareHtml(f.source, interactive);
        assert.ok(content.includes("내용"));
        assert.ok(content.includes("</head>"));
        const observed = startTags(content).map(([tag]) => tag);
        const head = indexOf(observed, "head");
        assert.equal(observed[head + 1], "meta");
        assert.ok(indexOf(content, "Content-Security-Policy") < indexOf(content, "</head>"));
        assert.equal(readText(f.source), source);
      });
    }
  }
});

test("rendered inlined assets and completed head work offline", { skip: CHROME_SKIP("offline resource rendering") }, (t) => {
  const f = new Fixture(t);
  fs.writeFileSync(path.join(f.folder, "image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7ioAAAAASUVORK5CYII=", "base64"));
  const font = path.join(ROOT, "assets", "fonts", "instrument-serif", "InstrumentSerif-Regular.ttf");
  writeText(f.source, `<style>@font-face{font-family:Test;src:url("${asUri(font)}")}
          p{font-family:Test}</style><p>Offline font</p><img src="image.png">
          <script>window.addEventListener('load',async()=>{await document.fonts.load('16px Test');await document.fonts.ready;
            parent.postMessage({probe:'offline-assets',image:document.querySelector('img').naturalWidth,
              font:[...document.fonts].every(f=>f.status==='loaded')},'*');
          });</script>`);
  f.data.candidates[0].interactive = true;
  f.save();
  f.build();
  const probe = `<script>window.addEventListener('message',event=>{
          if(event.data?.probe!=='offline-assets')return;
          const out=document.createElement('pre');out.id='offline-result';
          out.textContent=JSON.stringify(event.data);document.body.append(out);
        });</script>`;
  writeText(f.output, f.page().replace("<head>", () => "<head>" + probe));
  const probed = f.runBrowserProbe("offline-result", "chrome-offline");
  assert.equal(probed.status, 0, probed.stderr);
  assert.deepEqual(JSON.parse(probed.stdout), { probe: "offline-assets", image: 1, font: true });
});

test("live candidates accept only local dev servers", (t) => {
  const f = new Fixture(t);
  f.data.candidates.push({ id: "live", name: "기존 화면", concept: "지금 버전", typography: "시스템 글꼴", palette: ["#fff"], traits: ["기존 페이지"], kind: "url", url: "http://localhost:5173/orders", baseline: true });
  f.save();
  f.build();
  assert.deepEqual(payload(f.page()).candidates.map((c) => c.id), ["live", "a"]);
  for (const url of ["https://example.com/", "file:///etc/passwd", "http://user:pw@localhost:3000/"]) {
    f.data.candidates[1].url = url;
    f.save();
    raises(() => f.build(true), isValueError);
  }
});

test("serve accepts command and optional absolute cwd and local url", async (t) => {
  const f = new Fixture(t);
  for (const serve of [
    { command: "pnpm dev" },
    { command: "pnpm dev", cwd: f.folder },
    { command: "pnpm dev", cwd: f.folder, url: "http://localhost:3456" },
    { command: "pnpm dev", url: "https://127.0.0.1:3456/" },
    { command: "pnpm dev", url: "http://[::1]:3456/" },
  ]) {
    await t.test(`serve=${jsonDumps(serve)}`, () => {
      f.data.serve = serve;
      f.save();
      f.build(true);
      assert.deepEqual(payload(f.page()).serve, serve);
    });
  }
});

test("serve requires a nonempty string command", async (t) => {
  const f = new Fixture(t);
  for (const serve of [{}, { command: "" }, { command: "  " }, { command: 123 }, { command: null }]) {
    await t.test(`serve=${jsonDumps(serve)}`, () => {
      f.data.serve = serve;
      f.save();
      raises(() => f.build(), isValueError, /serve.command 비어 있지 않은 문자열이어야 합니다/);
    });
  }
  for (const serve of [null, [], "pnpm dev"]) {
    await t.test(`serve=${jsonDumps(serve)}`, () => {
      f.data.serve = serve;
      f.save();
      raises(() => f.build(), isValueError, /serve 객체여야 합니다/);
    });
  }
  assert.ok(!fs.existsSync(f.output));
});

test("serve cwd must be an absolute path", async (t) => {
  const f = new Fixture(t);
  for (const cwd of ["project", "./project", "~/project", "", null, 123]) {
    await t.test(`cwd=${jsonDumps(cwd)}`, () => {
      f.data.serve = { command: "pnpm dev", cwd };
      f.save();
      raises(() => f.build(), isValueError, /serve.cwd 절대 경로여야 합니다/);
    });
  }
});

test("serve url must be local http or https", async (t) => {
  const f = new Fixture(t);
  for (const url of ["https://example.com/", "file:///tmp/index.html", "ftp://localhost/", "http://user:pw@localhost:3456/", "http://localhost:bad/", "http://[::1", "", null, 123]) {
    await t.test(`url=${jsonDumps(url)}`, () => {
      f.data.serve = { command: "pnpm dev", url };
      f.save();
      raises(() => f.build(), isValueError, /serve.*url.*로컬/);
    });
  }
});

test("serve is embedded unchanged without script escape", (t) => {
  const f = new Fixture(t);
  const serve = { command: "  printf '</script><script>window.injected=true</script>'\u2028\u2029  ", cwd: path.join(f.folder, 'a"$`\\b'), url: "http://localhost:3456", note: "추가 메타데이터 유지" };
  f.data.serve = serve;
  f.save();
  f.build();
  const page = f.page();
  assert.deepEqual(payload(page).serve, serve);
  assert.ok(!page.includes(serve.command));
  assert.ok(page.includes("\\u003c/script>"));
  assert.ok(page.includes("\\u2028\\u2029"));
});

test("url candidates without serve warn but still build", (t) => {
  const f = new Fixture(t);
  Object.assign(f.data.candidates[0], { kind: "url", url: "http://localhost:3456/" });
  f.save();
  const capture = () => {
    const stream = { text: "", write(chunk) { this.text += chunk; return true; } };
    return stream;
  };
  let messages = capture();
  build(f.manifest, f.output, { stderr: messages });
  assert.ok(fs.statSync(f.output).isFile());
  assert.equal(messages.text.split(/\r\n|\n|\r/).filter((line, index, lines) => index < lines.length - 1 || line).length, 1);
  assert.ok(messages.text.includes("manifest의 serve에 실행 방법"));
  f.data.serve = { command: "pnpm dev" };
  f.save();
  messages = capture();
  build(f.manifest, f.output, { force: true, stderr: messages });
  assert.equal(messages.text, "");
});

test("shell connections allow only this round's candidate origins", (t) => {
  const f = new Fixture(t);
  f.data.serve = { command: "pnpm dev", url: "http://localhost:9999/" };
  const urls = ['http://localhost:3456/a?note="<script>', "http://localhost:3456/b", "https://127.0.0.1:4443/", "http://[::1]:5173/"];
  f.data.candidates = urls.map((url, i) => ({ ...f.data.candidates[0], id: `live${i}`, kind: "url", url }));
  f.save();
  f.build();
  const policies = startTags(f.page())
    .filter(([tag, attrs]) => tag === "meta" && attrs["http-equiv"] === "Content-Security-Policy")
    .map(([, attrs]) => attrs.content);
  assert.deepEqual(policies, ["connect-src http://localhost:3456 http://localhost:5173 https://127.0.0.1:4443"]);
  f.data.candidates = [{ ...f.data.candidates[0], kind: "html" }];
  f.save();
  f.build(true);
  assert.ok(f.page().includes("content=\"connect-src 'none'\""));
});

test("interactive HTML runs inline scripts only when asked", (t) => {
  const f = new Fixture(t);
  assert.ok(prepareHtml(f.source).includes("script-src 'none'"));
  const csp = prepareHtml(f.source, true);
  assert.ok(csp.includes("script-src 'unsafe-inline'"));
  assert.ok(csp.includes("localStorage"));
  assert.ok(!prepareHtml(f.source).includes("localStorage"));
  assert.ok(csp.includes("default-src 'none'"));
  f.data.candidates[0].interactive = true;
  f.save();
  f.build();
  writeText(f.source, '<html><head><script src="https://example.invalid/a.js"></script></head><body></body></html>');
  raises(() => f.build(true), isValueError);
  Object.assign(f.data.candidates[0], { kind: "image", interactive: true });
  f.save();
  raises(() => f.build(true), isValueError);
});

test("local stylesheets and scripts are inlined", (t) => {
  const f = new Fixture(t);
  fs.mkdirSync(path.join(f.folder, "vendor"));
  writeText(path.join(f.folder, "vendor", "lib.js"), "window.lib='</script>'");
  writeText(path.join(f.folder, "app.css"), "body{color:#123}");
  writeText(f.source, '<!doctype html><html><head><link rel="stylesheet" href="app.css">'
    + '<script defer src="vendor/lib.js"></script></head><body><p>내용</p></body></html>');
  const fixed = prepareHtml(f.source);
  assert.ok(fixed.includes("<style>body{color:#123}</style>"));
  assert.ok(!fixed.includes("lib.js"));
  assert.ok(!fixed.includes("window.lib"));
  const live = prepareHtml(f.source, true);
  assert.ok(live.includes("'unsafe-eval'"));
  assert.ok(indexOf(live, "<p>내용</p>") < indexOf(live, "window.lib"));
  assert.ok(live.includes("<\\/script>"));
  f.data.candidates[0].interactive = true;
  f.save();
  f.build();
});

test("only one baseline", (t) => {
  const f = new Fixture(t);
  const second = { ...f.data.candidates[0], id: "b", baseline: true };
  f.data.candidates[0].baseline = true;
  f.data.candidates.push(second);
  f.save();
  raises(() => f.build(), isValueError);
});

test("brand assets and edition survive relocation", async (t) => {
  const f = new Fixture(t);
  const copy = path.join(f.folder, "relocated");
  fs.cpSync(path.join(ROOT, "scripts"), path.join(copy, "scripts"), { recursive: true, filter: (item) => path.basename(item) !== "__pycache__" });
  fs.cpSync(path.join(ROOT, "assets"), path.join(copy, "assets"), { recursive: true });
  const logo = "data:image/svg+xml;base64," + readBytes(path.join(ROOT, "assets", "jstyle-mark.svg")).toString("base64");
  const font = "data:font/ttf;base64," + readBytes(path.join(ROOT, "assets", "fonts", "instrument-serif", "InstrumentSerif-Regular.ttf")).toString("base64");
  for (const [name, edition] of [["jstyle-pro", "pro"], ["jstyle", "open"]]) {
    await t.test(`edition=${edition}`, () => {
      writeText(path.join(copy, "SKILL.md"), "---\nname: " + name + "\n---\n");
      const output = path.join(f.folder, edition + ".html");
      const executed = run([...builderCommand(path.join(copy, "scripts")), f.manifest, "--output", output], { cwd: f.folder });
      assert.equal(executed.status, 0, executed.stderr);
      const page = readText(output);
      assert.equal(payload(page).edition, edition);
      assert.ok(page.includes(logo));
      assert.ok(page.includes(font));
      assert.ok(!page.includes('href="jstyle-mark.svg"'));
      assert.ok(!page.includes('src="jstyle-mark.svg"'));
      assert.ok(!page.includes('url("fonts/'));
    });
  }
});

test("every manifest problem is reported in one pass", (t) => {
  const f = new Fixture(t);
  f.data.schemaVersion = 2;
  Object.assign(f.data.candidates[0], { id: "A", palette: ["red"], source: "missing.html" });
  f.data.candidates.push({ id: "b", concept: "c", typography: "t", palette: ["#123456"], traits: [], kind: "pdf" });
  f.save();
  const caught = raises(() => f.build(), isManifestError);
  assert.ok(caught.problems.length >= 6);
  for (const expected of ["schemaVersion", '안 id "A" 올바르지 않음', "missing.html", "red", "kind 가능한 값:", "안 b：traits"]) {
    assert.ok(caught.message.includes(expected), expected);
  }
  assert.ok(!fs.existsSync(f.output));
});

test("single problem reads as one sentence", (t) => {
  const f = new Fixture(t);
  f.data.candidates[0].palette = ["blue"];
  f.save();
  const caught = raises(() => f.build(), isValueError);
  assert.ok(!caught.message.includes("곳을 고쳐야 합니다"));
  assert.ok(caught.message.includes("안 a：palette"));
});

test("output defaults to a file beside the manifest", (t) => {
  const f = new Fixture(t);
  const executed = run([...builderCommand(), f.manifest]);
  assert.equal(executed.status, 0, executed.stderr);
  const expected = path.join(fs.realpathSync(f.folder), "style-explorer.html");
  assert.equal(path.normalize(JSON.parse(executed.stdout).output), expected);
  assert.ok(fs.statSync(expected).isFile());
  const again = run([...builderCommand(), f.manifest]);
  assert.equal(again.status, 1);
  assert.ok(again.stderr.includes("--force"));
});

test("missing and malformed manifests say what to do", (t) => {
  const f = new Fixture(t);
  const missing = run([...builderCommand(), path.join(f.folder, "nope.json")]);
  assert.equal(missing.status, 1);
  assert.ok(missing.stderr.includes("찾을 수 없습니다 manifest"));
  assert.ok(!missing.stderr.includes("Errno"));
  const broken = path.join(f.folder, "broken.json");
  writeText(broken, '{"schemaVersion": 1,');
  const malformed = run([...builderCommand(), broken]);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /올바르지 않음: JSON： \d+ 줄의 \d+ 열/);
  assert.ok(!malformed.stderr.includes("Traceback"));
});

test("help shows a complete example", () => {
  const executed = run([...builderCommand(), "--help"]);
  assert.equal(executed.status, 0);
  for (const expected of ["manifest.json", '"candidates": [{"source": "a.html"}', "--force", "style-explorer.html"]) {
    assert.ok(executed.stdout.includes(expected), expected);
  }
});

test("minimal manifest needs only source and uses title", (t) => {
  const f = new Fixture(t);
  writeText(f.source, "<!doctype html><html><head><title>  Title   from HTML </title></head><body>Page</body></html>");
  f.data = { candidates: [{ source: "sample.html" }] };
  f.save();
  f.build();
  const candidate = payload(f.page()).candidates[0];
  assert.equal(candidate.name, "Title from HTML");
  assert.equal(candidate.id, "candidate-1");
  for (const optional of ["concept", "typography", "palette", "traits", "nativeViewport"]) {
    assert.ok(!(optional in candidate), optional);
  }
});

test("directory and multiple HTML files build without manifest", (t) => {
  const f = new Fixture(t);
  const folder = path.join(f.folder, "candidates");
  fs.mkdirSync(folder);
  const first = path.join(folder, "first.html");
  const second = path.join(folder, "second.html");
  writeText(first, "<title>First option</title><main>One</main>");
  writeText(second, "<main>Two</main>");
  const output = path.join(f.folder, "direct.html");
  const result = build([first, second], output);
  assert.equal(result.candidates, 2);
  const candidates = payload(readText(output)).candidates;
  assert.deepEqual(candidates.map((c) => c.name), ["First option", "second"]);
  assert.deepEqual(candidates.filter((c) => "concept" in c).map((c) => c.concept), []);

  const directoryOutput = path.join(f.folder, "directory", "style-explorer.html");
  build(folder, directoryOutput);
  const directoryCandidates = payload(readText(directoryOutput)).candidates;
  assert.deepEqual(directoryCandidates.map((c) => c.name), ["First option", "second"]);
});
