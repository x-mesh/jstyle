#!/usr/bin/env node
// Local web-image preparation. Node 22+, Chrome/Chromium/Edge, no npm dependencies.
import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { basename, extname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChrome } from './chrome.mjs';

const HELP = `사용법: node prep-image.mjs <로컬 이미지 또는 폴더> [...] [선택지]
자주 쓰는 명령:
  node scripts/prep-image.mjs assets/source.png --out assets/web --widths 480,960,1600
  node scripts/prep-image.mjs assets/source.png --out assets/web --crop 16:9 --focus right --trim

Node 22 이상과 Chrome/Chromium/Edge가 필요합니다. 도구를 자동으로 설치하지 않습니다.
입력은 정지 PNG/JPEG/WebP입니다. 폴더의 바로 아래 파일만 읽고 다른 형식과 하위 폴더는 처리하지 않습니다.

  --out <폴더>         기본 web-images. 기존 파일은 덮어쓰지 않고 번호를 붙입니다.
  --width <너비>       한 크기. px 또는 k를 쓸 수 있습니다.
  --widths <목록>      여러 너비. 예: 480,960,1.6k. 쉼표와 공백으로 나눕니다.
  --sizes <값>         srcset의 sizes. 기본 100vw. 실제 페이지 배치에 맞게 씁니다.
  --format <형식>      webp|png|jpeg. 기본 webp. jpg는 jpeg와 같습니다.
  --quality <품질>     기본 82%. 82, 82%, 0.82를 받을 수 있습니다. PNG에는 쓰지 않습니다.
  --crop <비율>        16:9, 4/3, 1x1 또는 숫자 비율
  --focus <위치>       center/left/right/top/bottom 및 모서리, 또는 75%,25%. --crop과 함께 씁니다.
  --trim              완전히 투명한 바깥쪽만 자릅니다. 흰 바탕을 지우지는 않습니다.
  --help, -h          도움말

원본은 유지하고 --trim, 비율 자르기, 줄이기 순서로 처리합니다. 원본보다 키우지 않습니다.
더 큰 너비는 원본 너비로 모으고, 큰 폭의 축소는 여러 단계로 나눕니다.
결과가 더 작지 않으면 원본을 복사하며 실제 크기·형식을 알립니다. 여러 크기가 같은 원본이면 하나만 남깁니다.
투명 픽셀을 JPEG로 바꿔 잃지 않도록 알립니다. 이름과 확장자는 실제 저장 형식에 맞춥니다.
stdout은 JSON, 진행·경고·복사할 picture/srcset 조각은 stderr입니다.
명령은 프로젝트 루트에서 실행하고 파일을 사이트 폴더 안에 둡니다. HTML 경로는 실행 폴더 기준입니다.
한 파일이 실패해도 나머지는 계속하며 실패와 다시 실행할 명령을 남깁니다.
브라우저 시작이 늦으면 한 번 더 시도합니다. 원본과 만든 파일을 보존합니다.`;
const example = 'node <skill>/scripts/prep-image.mjs image.png --width 960 --out assets/web';
const usage = message => { throw new Error(`${message}\n예시：${example}\n모든 선택지：node <skill>/scripts/prep-image.mjs --help`); };
export function parseArgs(argv) {
  const end = argv.indexOf('--'), beforeTerminator = end < 0 ? argv : argv.slice(0, end);
  if (!argv.length || beforeTerminator.some(a => /^(--help|-h)$/i.test(a))) return { help: true };
  const opts = {}, inputs = [], aliases = { dir: 'out', output: 'out', 'max-width': 'width', resize: 'width', ratio: 'crop' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { inputs.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('-')) { inputs.push(arg); continue; }
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) usage(`알 수 없는 선택지：${arg}`);
    const key = aliases[m[1].toLowerCase()] ?? m[1].toLowerCase();
    if (!['out', 'width', 'widths', 'sizes', 'format', 'quality', 'crop', 'focus', 'trim'].includes(key)) usage(`알 수 없는 선택지：${arg}`);
    if (key in opts) usage(`--${key} 겹침；여러 너비는 다음을 쓰세요: --widths 480,960,1600`);
    if (key === 'trim') { if (m[2] !== undefined) usage('--trim 값을 받지 않음；사용 --trim'); opts.trim = true; }
    else { const v = m[2] ?? argv[++i]; if (!v || v.startsWith('--')) usage(`--${key} 값이 없습니다`); opts[key] = v; }
  }
  if (!inputs.length) usage('로컬 이미지나 폴더가 없습니다');
  if (opts.width && opts.widths) usage('--width 및 --widths 하나 고르기；여러 크기는 다음을 씁니다: --widths 480,960');
  const width = s => {
    const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(px|k)?$/i), n = m ? Number(m[1]) * (m[2]?.toLowerCase() === 'k' ? 1000 : 1) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 32768) usage(`너비가 올바르지 않습니다 ${s}；사용 --width 960px 또는 --widths 480,960,1.6k`);
    return n;
  };
  const widths = [...new Set((opts.widths ?? opts.width ?? '1600').split(/[,\s]+/).filter(Boolean).map(width))].sort((a, b) => a - b);
  if (!widths.length) usage('너비 목록이 비어 있습니다；사용 --widths 480,960');
  const format = (opts.format ?? 'webp').toLowerCase().replace(/^jpg$/, 'jpeg');
  if (!['webp', 'png', 'jpeg'].includes(format)) usage('지원하지 않는 형식；사용 --format webp、png 또는 jpeg');
  let quality = 0.82;
  if (opts.quality !== undefined) {
    const s = opts.quality.trim(), n = Number(s.replace(/%$/, ''));
    quality = s.endsWith('%') || n >= 1 ? n / 100 : n;
    if (!Number.isFinite(quality) || quality < .01 || quality > 1) usage('품질 값이 올바르지 않습니다；사용 --quality 82');
    if (format === 'png') usage('PNG 손실 압축 품질을 쓰지 않습니다；빼기 --quality，다음 방식으로 바꾸세요: --format webp');
  }
  let ratio;
  if (opts.crop !== undefined) {
    const parts = opts.crop.trim().split(/\s*[:/x×]\s*/i);
    if (!parts.every(p => /^\d+(?:\.\d+)?$/.test(p))) usage('자를 비율이 올바르지 않습니다；사용 --crop 16:9');
    ratio = parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : parts.length === 1 ? Number(parts[0]) : NaN;
    if (!Number.isFinite(ratio) || ratio < 1 / 100 || ratio > 100) usage('자를 비율이 올바르지 않습니다；사용 --crop 16:9');
  }
  let focus = [.5, .5];
  if (opts.focus !== undefined) {
    if (!ratio) usage('--focus 필요 --crop；예: --crop 16:9 --focus right');
    const named = { center: [.5, .5], centre: [.5, .5], left: [0, .5], right: [1, .5], top: [.5, 0], bottom: [.5, 1], 'top-left': [0, 0], 'top-right': [1, 0], 'bottom-left': [0, 1], 'bottom-right': [1, 1] };
    const s = opts.focus.trim().toLowerCase();
    if (named[s]) focus = named[s];
    else if (/^\d+(?:\.\d+)?%\s*,\s*\d+(?:\.\d+)?%$/.test(s)) focus = s.split(',').map(x => Number(x.trim().slice(0, -1)) / 100);
    else usage('초점이 올바르지 않습니다；사용 --focus right 또는 --focus 75%,25%');
    if (focus.some(x => x > 1)) usage('초점이 범위를 넘습니다；사용 --focus 75%,25%');
  }
  return { inputs, out: resolve(opts.out ?? 'web-images'), widths, format, quality, ratio, focus, trim: Boolean(opts.trim), sizes: opts.sizes ?? '100vw' };
}

// Use the same isolated launch/hand-off/cleanup logic as shoot, with a small bounded CDP transport.
export async function canvasBrowser() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('필요 Node 22+；설치한 뒤 원래 명령을 다시 실행하세요');
  const browser = createChrome({ prefix: 'jstyle-image-', label: 'prep-image' });
  let ws, seq = 0, sessionId, closing = false;
  const pending = new Map();
  const rejectAll = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.no(error); } pending.clear(); };
  const dispose = () => browser.dispose();
  const close = async () => {
    closing = true; rejectAll(new Error('브라우저가 닫혔습니다'));
    await browser.stop(ws); ws?.close();
    process.off('exit', dispose); process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
  };
  const sigint = () => { void close().finally(() => process.exit(130)); };
  const sigterm = () => { void close().finally(() => process.exit(143)); };
  process.on('exit', dispose); process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
  const send = (method, params = {}, targetSession = sessionId) => new Promise((ok, no) => {
    if (ws?.readyState !== WebSocket.OPEN) { no(new Error('브라우저 연결이 끊겼습니다；원래 명령 다시 실행')); return; }
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); no(new Error(`CDP ${method} 넘음 90 초；나중에 원래 명령을 다시 실행하세요`)); }, 90000);
    pending.set(id, { ok, no, timer });
    try { ws.send(JSON.stringify({ id, method, params, ...(targetSession ? { sessionId: targetSession } : {}) })); }
    catch (error) { clearTimeout(timer); pending.delete(id); no(error); }
  });
  try {
    let url;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { url = await browser.launch(); break; }
      catch (e) { await browser.stop(); if (e.message !== 'timeout' || attempt) throw e; console.error('prep-image：브라우저 시작 시간 초과，한 번 더 시도'); }
    }
    ws = new WebSocket(url);
    await new Promise((ok, no) => {
      const timer = setTimeout(() => { ws.close(); no(new Error('브라우저 연결 시간 초과')); }, 30000);
      ws.onopen = () => { clearTimeout(timer); ok(); };
      ws.onerror = ws.onclose = () => { clearTimeout(timer); no(new Error('브라우저에 연결하지 못했습니다')); };
    });
    ws.onmessage = event => {
      const msg = JSON.parse(event.data), p = pending.get(msg.id);
      if (!p) return; pending.delete(msg.id); clearTimeout(p.timer);
      msg.error ? p.no(new Error(msg.error.message)) : p.ok(msg.result);
    };
    ws.onerror = ws.onclose = () => { if (!closing) rejectAll(new Error('브라우저 연결이 갑자기 끊겼습니다；원래 명령 다시 실행')); };
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
    return { send, close, async evaluate(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    } };
  } catch (error) { await close(); throw error; }
}

function imageType(buf) {
  if (buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    for (let i = 8; i + 12 <= buf.length;) { const n = buf.readUInt32BE(i); if (buf.toString('ascii', i + 4, i + 8) === 'acTL') throw new Error('처리하지 않음 APNG 애니메이션；정지 파일을 주세요: PNG'); i += n + 12; }
    return 'png';
  }
  if (buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return 'jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    for (let i = 12; i + 8 <= buf.length;) { const n = buf.readUInt32LE(i + 4); if (['ANIM', 'ANMF'].includes(buf.toString('ascii', i, i + 4))) throw new Error('처리하지 않음 WebP 애니메이션；정지 파일을 주세요: WebP'); i += 8 + n + (n % 2); }
    return 'webp';
  }
  throw new Error('정지 이미지가 아님 PNG/JPEG/WebP（받기 오류 페이지나 애니메이션일 수 있습니다）；디코딩할 수 있는 정지 이미지를 쓰세요');
}

// Executed inside Chrome. Read alpha once; derive all variants from the same decoded original.
export async function renderImage(data, opts) {
  const img = new Image(); img.src = data;
  try { await img.decode(); } catch { throw new Error('이미지 디코딩에 실패했습니다；파일이 온전히 있는지 확인하세요，다시 받으세요'); }
  const width = img.naturalWidth, height = img.naturalHeight;
  if (width * height > 40000000 || Math.max(width, height) > 32768) throw new Error('이미지가 제한을 넘습니다: 4000 만 픽셀 또는 한 변 32768；더 작은 원본을 먼저 주세요');
  const make = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  let source = make(width, height), ctx = source.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1, alpha = false;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const a = pixels[(y * width + x) * 4 + 3];
    if (a < 255) alpha = true;
    if (a && opts.trim) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  if (alpha && opts.format === 'jpeg') throw new Error('이미지에 투명 픽셀이 있습니다；다음으로 바꾸세요: --format webp 또는 --format png 다시 실행하세요');
  if (!opts.trim) { x0 = 0; y0 = 0; x1 = width - 1; y1 = height - 1; }
  else if (x1 < 0) throw new Error('이미지 전체가 투명합니다，가장자리를 자를 수 없습니다；빼기 --trim 내용이 있는 이미지를 주세요');
  let w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (opts.ratio) {
    const cw = Math.max(1, Math.min(w, Math.round(h * opts.ratio))), ch = Math.max(1, Math.min(h, Math.round(w / opts.ratio)));
    x0 += Math.round((w - cw) * opts.focus[0]); y0 += Math.round((h - ch) * opts.focus[1]); w = cw; h = ch;
  }
  const cropped = make(w, h); cropped.getContext('2d').drawImage(source, x0, y0, w, h, 0, 0, w, h); source.width = source.height = 1; source = cropped;
  const variants = [];
  for (const tw of [...new Set(opts.widths.map(v => Math.min(v, w)))]) {
    const th = Math.max(1, Math.round(h * tw / w)); let c = source;
    // Halve large reductions before the final high-quality sample to avoid fine-detail aliasing.
    while (c.width > tw * 2) {
      const next = make(Math.max(tw, Math.round(c.width / 2)), Math.max(th, Math.round(c.height / 2)));
      const cx = next.getContext('2d'); cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high'; cx.drawImage(c, 0, 0, next.width, next.height);
      if (c !== source) c.width = c.height = 1; c = next;
    }
    const dest = make(tw, th), dc = dest.getContext('2d'); dc.imageSmoothingEnabled = true; dc.imageSmoothingQuality = 'high'; dc.drawImage(c, 0, 0, tw, th);
    const url = dest.toDataURL('image/' + opts.format, opts.quality);
    if (!url.startsWith('data:image/' + opts.format + ';')) throw new Error('브라우저가 대상 인코딩을 지원하지 않습니다；다음으로 바꾸세요: --format png 다시 실행하세요');
    variants.push({ width: tw, height: th, data: url.split(',')[1] });
    dest.width = dest.height = 1; if (c !== source) c.width = c.height = 1;
  }
  return { width, height, alpha, crop: { x: x0, y: y0, width: w, height: h }, variants };
}
const htmlEscape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const outputUrl = saved => fileUrl(realpathSync(saved), realpathSync(process.cwd()));
export function fileUrl(p, cwd = process.cwd(), platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix, rel = path.relative(cwd, p);
  if (path.isAbsolute(rel)) return pathToFileURL(p, { windows: platform === 'win32' }).href;
  return rel.split(path.sep).map(x => encodeURIComponent(x).replace(/'/g, '%27')).join('/');
}
function deliver(buf, dir, name, ext) {
  for (let i = 0; i < 10000; i++) {
    const file = join(dir, name + (i ? '-' + i : '') + '.' + ext);
    try { writeFileSync(file, buf, { flag: 'wx' }); return file; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('같은 이름의 파일이 너무 많습니다；다음을 쓰세요: --out 빈 폴더 지정');
}
const commandArg = s => "'" + String(s).replace(/'/g, process.platform === 'win32' ? "''" : "'\"'\"'") + "'";
function rerun(file, opts) {
  // JSON carries argv as well, so callers can spawn without shell quoting on every OS.
  const args = [fileURLToPath(import.meta.url), file, '--out', opts.out, '--widths', opts.widths.join(','), '--format', opts.format];
  if (opts.format !== 'png') args.push('--quality', String(opts.quality * 100) + '%');
  if (opts.trim) args.push('--trim'); if (opts.ratio) args.push('--crop', String(opts.ratio), '--focus', opts.focus.map(v => v * 100 + '%').join(','));
  args.push('--sizes', opts.sizes);
  return { argv: [process.execPath, ...args], command: 'node ' + args.map(commandArg).join(' ') };
}
export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv); if (opts.help) { console.log(HELP); return; }
  fileUrl(opts.out);
  const files = [], errors = [];
  for (const input of opts.inputs) {
    try {
      const p = resolve(input), st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error('심볼릭 링크를 따라가지 않습니다；실제 로컬 경로를 주세요');
      if (st.isDirectory()) {
        const entries = readdirSync(p, { withFileTypes: true }).filter(e => e.isFile() && /\.(png|jpe?g|webp)$/i.test(e.name)).sort((a, b) => a.name.localeCompare(b.name));
        if (!entries.length) throw new Error('폴더에 정지 이미지가 없습니다: PNG/JPEG/WebP；이미지 파일이나 이미지가 든 폴더를 주세요');
        files.push(...entries.map(e => join(p, e.name)));
      } else if (st.isFile()) files.push(p);
      else throw new Error('일반 로컬 파일이 아님');
    } catch (e) { errors.push({ input, message: e.message, ...rerun(input, opts) }); }
  }
  let browser; const records = [];
  try {
    for (const file of [...new Set(files.map(p => realpathSync(p)))]) {
      try {
        const original = readFileSync(file), type = imageType(original);
        browser ??= await canvasBrowser();
        const rendered = await browser.evaluate(`(${renderImage.toString()})(${JSON.stringify('data:image/' + type + ';base64,' + original.toString('base64'))},${JSON.stringify(opts)})`);
        mkdirSync(opts.out, { recursive: true });
        const outputs = [], warnings = []; let kept;
        if (opts.trim && !rendered.alpha) warnings.push('이미지에 투명 픽셀이 없습니다，투명 가장자리를 잘라도 이미지가 같았습니다；--trim 불투명한 바탕은 지우지 않습니다');
        let variants = rendered.variants;
        const changedCrop = rendered.crop.width !== rendered.width || rendered.crop.height !== rendered.height;
        // A srcset must share one composition; never mix an uncropped fallback with cropped variants.
        if (changedCrop && variants.some(v => Buffer.byteLength(v.data, 'base64') >= original.length)) {
          variants = [variants.find(v => Buffer.byteLength(v.data, 'base64') >= original.length)];
          warnings.push('잘라 낸 일부 크기가 원본보다 작지 않습니다，모두 원본으로 돌아갑니다，막기 srcset 서로 다른 배치를 섞음');
        }
        for (const variant of variants) {
          const encoded = Buffer.from(variant.data, 'base64'), keep = encoded.length >= original.length;
          if (keep && kept) continue;
          const ext = keep ? type.replace('jpeg', 'jpg') : opts.format.replace('jpeg', 'jpg');
          const name = basename(file, extname(file)) + (keep ? '-original' : '-' + variant.width);
          const saved = deliver(keep ? original : encoded, opts.out, name, ext);
          const result = { saved, width: keep ? rendered.width : variant.width, height: keep ? rendered.height : variant.height, bytes: keep ? original.length : encoded.length, keptOriginal: keep };
          outputs.push(result);
          if (keep) { kept = true; warnings.push(`인코딩 ${variant.width}×${variant.height} 값: ${encoded.length} B，원본보다 작지 않음 ${original.length} B；원본 유지，자르기/크기 변경이 적용되지 않았습니다`); }
          console.error(`prep-image：${file} ${rendered.width}×${rendered.height} / ${original.length} B → ${saved} ${result.width}×${result.height} / ${result.bytes} B${keep ? '（원본 유지）' : `（줄인 크기 ${(100 * (1 - result.bytes / original.length)).toFixed(1)}%）`}`);
        }
        outputs.sort((a, b) => a.width - b.width || a.bytes - b.bytes);
        const candidates = outputs.filter((o, i) => !i || o.width !== outputs[i - 1].width), last = candidates.at(-1);
        const html = `<img src="${htmlEscape(outputUrl(last.saved))}" srcset="${htmlEscape(candidates.map(o => outputUrl(o.saved) + ' ' + o.width + 'w').join(', '))}" sizes="${htmlEscape(opts.sizes)}" width="${last.width}" height="${last.height}" alt="">`;
        records.push({ input: file, original: { width: rendered.width, height: rendered.height, bytes: original.length, alpha: rendered.alpha }, crop: rendered.crop, outputs, warnings, html });
        for (const warning of warnings) console.error('prep-image：' + warning);
        console.error(html);
      } catch (e) {
        const recovery = e.message.includes('이미지에 투명 픽셀이 있습니다') ? { ...opts, format: 'webp' } : e.message.includes('이미지 전체가 투명합니다') ? { ...opts, trim: false } : opts;
        const error = { input: file, message: e.message, ...rerun(file, recovery) }; errors.push(error); console.error(`prep-image：${file}：${e.message}\n다시 실행：${error.command}`); }
    }
  } finally { await browser?.close(); }
  console.log(JSON.stringify({ files: records, errors }, null, 2));
  for (const e of errors.filter(e => !files.includes(e.input))) console.error(`prep-image：${e.input}：${e.message}\n다시 실행：${e.command}`);
  if (errors.length) process.exitCode = 1;
}
const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  main().catch(e => { console.error('prep-image：' + e.message); process.exitCode = 1; });
}
