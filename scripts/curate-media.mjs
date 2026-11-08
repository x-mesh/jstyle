#!/usr/bin/env node
// Media discovery and local delivery for design agents. Node 22+, no npm dependencies.
import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const exec = promisify(execFile);
const UA = 'jstyle-curate-media/2.1 (+https://api.github.com/repositories/1396939768; Powered by Poly Haven)';
const KINDS = ['all', 'texture', 'design', 'photo', 'blueprint', 'map', 'plate', 'science', 'video'];
const PREFIX = { polyhaven: 'T', vam: 'V', loc: 'L', wellcome: 'W', nasa: 'N', commons: 'C', met: 'M', aic: 'A', cleveland: 'K', japan: 'J', rijks: 'R' };
const USES = { page: 0, check: 1, reference: 2 };
const EXAMPLE = 'node scripts/curate-media.mjs search "wood" --kind texture --limit 6';
const HELP = `자주 쓰는 명령:
  ${EXAMPLE}
  node scripts/curate-media.mjs search "<장소> | <다른 이름> | <물건과 시대>" --sheet --dir candidates
  node scripts/curate-media.mjs search "bridge" --kind blueprint --sheet --dir candidates
  node scripts/curate-media.mjs search "earth" --kind video --limit 4
  node scripts/curate-media.mjs preview V1,T2 --sheet --dir candidates
  node scripts/curate-media.mjs fetch C1,T2 --dir assets --sheet
  node scripts/curate-media.mjs fetch T2 --maps all --resolution 1k --dir assets
  node scripts/curate-media.mjs fetch "https://example.org/image.jpg" --out assets/image.jpg --note "출처"

사용법: node curate-media.mjs <search|preview|fetch> <검색어 또는 번호/URL> [선택지]
search는 JSON으로 결과를 돌려줍니다. |로 검색어 묶음을 나눌 수 있습니다.
실제 장소·물건·고유 이름을 한두 단어로 찾은 뒤 매체나 시대를 더합니다. 현지 이름도 써 볼 수 있습니다.
preview는 캐시의 번호나 이미지 URL로 작은 그림 모음을 만듭니다.
fetch는 번호 또는 여러 HTTP(S) URL을 받습니다. 쉼표가 든 URL은 따로 전달합니다.

  --kind <종류>          ${KINDS.join('|')}. 기본 all
  --limit <1..30>        전체 결과 수. all 기본 12, 나머지 기본 6. 제공처를 섞어 고릅니다.
  --use <범위>           all|page. 기본 all. page는 페이지에 넣을 수 있는 항목만 남깁니다.
  --resolution <크기>    텍스처 JPG 1k|2k|4k|8k. 기본 1k. 없으면 실제 가능한 크기를 알립니다.
  --maps <이름,...>      diffuse|roughness|normal|all. 기본 diffuse
  --dir <폴더>           내려받을 곳과 그림 모음. 기본 assets
  --out <파일>           파일 하나의 경로. --dir과 함께 쓰지 않습니다. 덮어쓰지 않습니다.
  --sheet                검색·미리보기의 PNG와 HTML 모음 및 look 값을 만듭니다. 받은 파일은 완전히 읽어 확인합니다.
  --cache <파일>         기본 .curate-cache.json. 여러 명령에서 같은 캐시를 씁니다.
  --refresh              Poly Haven의 24시간 목록 캐시를 새로 읽습니다.
  --timeout <밀리초>     API 요청 제한 시간. 기본 12000
  --download-timeout <밀리초> 파일 받기 제한 시간. 기본 180000, 범위 1000..900000
  --max-mb <1..2048>     파일마다 받을 최대 크기. 기본 256 MB
  --video-size <버전>    medium|small|preview|orig. 기본 medium. 실패하면 작은 버전을 시도하고 까닭을 남깁니다.
  --note <설명>          출처에 덧붙일 말. 직접 URL의 사용 권리는 아직 확인하지 않은 것으로 둡니다.
  --help, -h             도움말. --이름=값 또는 --이름 값을 쓸 수 있습니다.

texture는 Poly Haven, design은 Met/AIC/Cleveland/Rijksmuseum/V&A/Japan Search와 3D 모델,
photo는 Commons/LOC/NASA, blueprint는 LOC hh/HABS-HAER, map은 LOC maps/Commons,
plate는 Wellcome/Japan Search/Commons, science는 NASA/Wellcome, video는 NASA를 찾습니다.
검색어가 제목과 설명 어디에도 없으면 걸러내고 filtered에 개수를 남깁니다.
use=page는 상업 페이지 사용이 가능한 항목입니다. CC BY/BY-SA는 이름 표시가 필요합니다.
use=check는 사용 범위를 먼저 확인해야 하며 reference는 페이지에 넣지 않고 참고로만 씁니다.
page, check, reference 순서로 정리합니다. 공개 주소가 있다고 상업용 사용까지 허용된 것은 아닙니다.
look에는 밝기·단색에 가까운 정도·모서리 색·종이 바탕·글 자리 등이 담깁니다.
이미지·영상과 poster, 텍스처·지도 파일은 SOURCES.md에 출처와 사용 범위를 남깁니다.
원본 제공처의 조건과 이름 표시를 지킵니다. 자세한 내용은 references/media.md를 읽습니다.`;

function usage(message) { throw new Error(`${message}\n예시: ${EXAMPLE}\n한꺼번에 받기: node scripts/curate-media.mjs fetch V1,T2 --dir assets --sheet\n모든 선택지: node scripts/curate-media.mjs --help`); }
export function parseArgs(argv) {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h' || args.includes('--help') || args.includes('-h')) return { help: true };
  if (!['search', 'fetch', 'preview'].includes(command)) usage(`알 수 없는 명령입니다: ${command}`);
  const allowed = {
    search: ['kind', 'limit', 'use', 'resolution', 'dir', 'sheet', 'cache', 'refresh', 'timeout'],
    preview: ['dir', 'sheet', 'cache', 'timeout'],
    fetch: ['dir', 'out', 'sheet', 'cache', 'maps', 'resolution', 'timeout', 'max-mb', 'note', 'video-size', 'download-timeout'],
  }[command];
  const flags = ['sheet', 'refresh'];
  const opts = {}, positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match || !allowed.includes(match[1])) usage(`지원하지 않는 선택지입니다: ${arg}. ${command}에서 쓸 수 있는 선택지: ${allowed.map(k => '--' + k).join(' ')}`);
    const [, key, inline] = match;
    if (key in opts) usage(`--${key}는 한 번만 쓸 수 있습니다`);
    if (flags.includes(key)) {
      if (inline !== undefined) usage(`--${key} 값을 받지 않는 스위치입니다`);
      opts[key] = true;
    } else {
      const value = inline ?? args[++i];
      if (!value || value.startsWith('--')) usage(`--${key} 값이 없습니다`);
      opts[key] = value;
    }
  }
  if (!positional.length || !positional.join(' ').trim()) usage(`${command}에 검색어, 번호 또는 URL이 필요합니다`);
  if (opts.out && opts.dir) usage('--out과 --dir은 함께 쓸 수 없습니다');
  opts.kind ??= 'all';
  if (!KINDS.includes(opts.kind)) usage(`--kind 올바른 값: ${KINDS.join('|')}`);
  opts.use ??= 'all';
  if (!['all', 'page'].includes(opts.use)) usage('--use 올바른 값: all|page');
  for (const [key, fallback, min, max] of [['limit', opts.kind === 'all' ? 12 : 6, 1, 30],['timeout', 12000, 1000, 120000], ['max-mb', 256, 1, 2048], ['download-timeout', 180000, 1000, 900000]]) {
    opts[key] = Number(opts[key] ?? fallback);
    if (!Number.isInteger(opts[key]) || opts[key] < min || opts[key] > max) usage(`--${key}는 ${min}..${max} 범위의 정수여야 합니다`);
  }
  opts.resolution ??= '1k';
  if (!['1k', '2k', '4k', '8k'].includes(opts.resolution)) usage('--resolution 올바른 값: 1k|2k|4k|8k');
  opts['video-size'] ??= 'medium';
  if (!['medium', 'small', 'preview', 'orig'].includes(opts['video-size'])) usage('--video-size 올바른 값: medium|small|preview|orig');
  opts.maps = (opts.maps ?? 'diffuse').split(',');
  if (opts.maps.includes('all') && opts.maps.length === 1) opts.maps = ['diffuse', 'roughness', 'normal'];
  if (opts.maps.some(k => !['diffuse', 'roughness', 'normal'].includes(k))) usage('--maps 올바른 값: diffuse,roughness,normal 또는 all');
  opts.maps = [...new Set(opts.maps)];
  opts.dir = path.resolve(opts.dir ?? (opts.out ? path.dirname(opts.out) : 'assets'));
  const defaultCache = path.resolve('.curate-cache.json');
  const fallbackCaches = [path.join(opts.dir, '.curate-cache.json'), path.join(path.dirname(opts.dir), '.curate-cache.json')];
  opts.cache = opts.cache ? path.resolve(opts.cache) : (!existsSync(defaultCache) && fallbackCaches.find(c => existsSync(c))) || defaultCache;
  return { command, positional, opts };
}

const https = value => String(value).replace(/^http:\/\//, 'https://').replace(/^\/\//, 'https://');
function httpUrl(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('인증 정보가 없는 HTTP(S) URL만 받습니다');
  return u.href;
}
const apiUrl = (base, params) => { const u = new URL(base); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v)); return u.href; };
// AIC asks clients to identify themselves in its own header, for the API and IIIF alike.
const headersFor = url => ({ 'User-Agent': UA, ...(/^https:\/\/[^/]*artic\.edu\//.test(url) ? { 'AIC-User-Agent': UA } : {}) });
async function json(url, opts) {
  const res = await fetch(httpUrl(url), { headers: { ...headersFor(url), Accept: 'application/json' }, signal: AbortSignal.timeout(opts.timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}
async function pool(values, fn, concurrency = 3) {
  const output = new Array(values.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) { const i = cursor++; try { output[i] = { status: 'fulfilled', value: await fn(values[i], i) }; } catch (reason) { output[i] = { status: 'rejected', reason }; } }
  }));
  return output;
}
// Latin words of one or two letters are joiners (of, de, la, en); years, numbers and CJK words stay.
const JOINERS = new Set(['the', 'and', 'for', 'with', 'from', 'der', 'die', 'das', 'les', 'des', 'del', 'van', 'von']);
export const queryTerms = q => String(q).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w && (/\d|[^\p{Script=Latin}]/u.test(w) || (w.length > 2 && !JOINERS.has(w))));
// Whole words with plurals; long terms also match compounds. Substrings made "fig" match "configuration"; plate captions write "fig. 2".
export function matchCount(text, terms) {
  const flat = String(text ?? '').normalize('NFKC').toLowerCase(), list = flat.replace(/<[^>]*>/g, ' ').replace(/\b(figs?|pl|no|vol)\.\s*\d+/g, ' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // Adjacent pairs joined, so "tea pot" in a title answers "teapot".
  const words = new Set([...list, ...list.slice(1).map((w, i) => list[i] + w)]);
  // CJK text has no spaces between words, so CJK terms match as substrings.
  const has = t => /[^\p{Script=Latin}\p{N}]/u.test(t) ? flat.includes(t) : words.has(t) || words.has(t + 's') || words.has(t + 'es') || (t.length > 3 && t.endsWith('s') && words.has(t.slice(0, -1))) || (t.length >= 5 && [...words].some(w => w.startsWith(t)));
  return terms.filter(has).length;
}
// page: the licence allows a commercial page; reference: it does not, but the picture can guide generation; check: unclear.
export function rightsUse(license = '', licenseUrl = '') {
  const s = `${license} ${licenseUrl}`.toLowerCase();
  if (/non-?commercial|by-nc|\bnc\b|no ?deriv|by-nd|\bnd\b|requires licensing/.test(s)) return 'reference';
  if (/third-party rights|not verified|not specified|in copyright/.test(s)) return 'check';
  if (/cc0|publicdomain|public domain|\bpdm?\b|no known restrictions|not subject to us copyright|creativecommons\.org\/licenses\/by(-sa)?\/|\bcc[ -]by(-sa)?\b|attribution( |-sharealike )\d/.test(s)) return 'page';
  return 'check';
}
const emptyCache = () => ({ version: 1, items: {}, catalogues: {} });
async function readCache(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    if (data.version !== 1 || !data.items || !data.catalogues) throw new Error('지원하지 않는 형식이나 버전입니다');
    return data;
  } catch (e) {
    if (e.code === 'ENOENT') return emptyCache();
    throw new Error(`캐시 파일을 읽을 수 없습니다(${file}: ${e.message}). --cache로 새 파일을 지정하세요`);
  }
}
async function replaceCache(temp, file) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try { await fs.rename(temp, file); return; }
    catch (error) {
      // Windows readers/virus scanners can briefly deny replacing an existing
      // file. Keep the old cache intact and retry only sharing/permission errors.
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
  }
}
// Serialize read/modify/write across concurrent agent processes; network calls stay outside the lock.
async function updateCache(file, fn) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lock = file + '.lock'; const deadline = Date.now() + 5000;
  while (true) {
    try { await fs.mkdir(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (Date.now() > deadline) throw new Error(`다른 프로세스가 캐시를 쓰는 중입니다: ${lock}. 그 프로세스가 이미 끝났다면 잠금 폴더를 지우고 다시 시도하세요`);
      await new Promise(resolve => setTimeout(resolve, 60));
    }
  }
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    const data = await readCache(file); const result = await fn(data);
    await fs.writeFile(temp, JSON.stringify(data)); await replaceCache(temp, file); return result;
  } finally { await fs.rm(temp, { force: true }); await fs.rmdir(lock); }
}
async function catalogue(type, opts) {
  const data = await readCache(opts.cache); const cached = data.catalogues[type];
  if (!opts.refresh && cached && Date.now() - cached.time < 86400000) return cached.data;
  const fresh = await json(`https://api.polyhaven.com/assets?t=${type}`, opts);
  await updateCache(opts.cache, c => { c.catalogues[type] = { time: Date.now(), data: fresh }; });
  return fresh;
}
export function selectMap(files, keys, resolution) {
  for (const key of keys) {
    const group = files[key]; if (!group) continue;
    const available = Object.keys(group).filter(r => group[r]?.jpg?.url).sort((a, b) => parseInt(a) - parseInt(b));
    const r = available.includes(resolution) ? resolution : available.filter(r => parseInt(r) <= parseInt(resolution)).at(-1) ?? available[0];
    if (r) return { ...group[r].jpg, resolution: r, channel: key };
  }
  return null;
}
async function resolveTexture(item, opts) {
  const files = await json(`https://api.polyhaven.com/files/${encodeURIComponent(item.sourceId)}`, opts);
  const textureMaps = {
    diffuse: selectMap(files, ['Diffuse', 'diff', 'Color', 'col'], opts.resolution),
    roughness: selectMap(files, ['Rough', 'rough', 'Roughness'], opts.resolution),
    normal: selectMap(files, ['nor_gl', 'Normal', 'normal'], opts.resolution),
  };
  if (!textureMaps.diffuse) throw new Error(`${item.sourceId}에 쓸 수 있는 Diffuse JPG가 없습니다`);
  return { ...item, textureMaps, textureUrl: textureMaps.diffuse.url, imageUrl: textureMaps.diffuse.url, normalConvention: 'OpenGL', tiling: 'previewUrl에서 반복되는 가장자리도 확인합니다. 일부 텍스처는 한 축으로만 반복됩니다' };
}
async function searchPoly(query, limit, opts, type = 'textures') {
  const data = await catalogue(type, opts), terms = queryTerms(query);
  const ranked = Object.entries(data).map(([slug, meta]) => {
    const hay = [slug.replaceAll('_', ' '), meta.name, meta.description, meta.category, ...(meta.categories ?? []), ...(meta.tags ?? [])].join(' ');
    return { slug, meta, score: matchCount(hay, terms) };
  }).filter(x => x.score >= Math.max(1, Math.ceil(terms.length / 2))).sort((a, b) => b.score - a.score).slice(0, limit);
  const out = await pool(ranked, async ({ slug, meta }) => {
    const previewUrl = `https://cdn.polyhaven.com/asset_img/thumbs/${encodeURIComponent(slug)}.png?width=768`;
    const item = { matched: ranked.find(x => x.slug === slug).score, provider: 'polyhaven', sourceId: slug, kind: type === 'textures' ? 'texture' : 'model', title: meta.name ?? slug, detail: (meta.categories ?? []).join(', '), license: 'CC0', licenseUrl: 'https://polyhaven.com/license', attribution: [Object.keys(meta.authors ?? {}).join(', '), 'Powered by Poly Haven'].filter(Boolean).join(' · '), pageUrl: `https://polyhaven.com/a/${encodeURIComponent(slug)}`, previewUrl, imageUrl: previewUrl };
    if (type === 'textures') return resolveTexture(item, opts);
    const files = await json(`https://api.polyhaven.com/files/${encodeURIComponent(slug)}`, opts);
    const model = files.gltf?.[opts.resolution]?.gltf ?? Object.values(files.gltf ?? {})[0]?.gltf;
    return { ...item, modelFile: model ?? null, previewType: 'rendered-image' };
  });
  const errors = out.flatMap((r, i) => r.status === 'rejected' ? [`${ranked[i].slug}: ${r.reason.message}`] : []);
  return { items: out.filter(r => r.status === 'fulfilled').map(r => r.value), errors };
}
function iiifBase(value) { return value?.replace(/\/info\.json(?:\?.*)?$/, '').replace(/\/full\/.*$/, '').replace(/\/$/, ''); }
async function searchVam(query, limit, opts) {
  const data = await json(apiUrl('https://api.vam.ac.uk/v2/objects/search', { q: query, images_exist: 1, page_size: limit }), opts);
  return (data.records ?? []).flatMap(r => {
    const base = iiifBase(r._images?._iiif_image_base_url ?? r._images?._primary_thumbnail ?? (r._primaryImageId ? `https://framemark.vam.ac.uk/collections/${r._primaryImageId}` : null));
    if (!base) return [];
    return [{ provider: 'vam', sourceId: r.systemNumber, kind: 'design', title: r._primaryTitle || r.objectType || r.systemNumber, detail: [r.objectType, r._primaryMaker?.name, r._primaryDate, r._primaryPlace].filter(Boolean).join(' · '), license: 'V&A terms: permitted non-commercial uses only; commercial/home-page/high-resolution publication requires licensing', licenseUrl: 'https://www.vam.ac.uk/info/va-websites-terms-conditions', attribution: `© Victoria and Albert Museum, London (${r.systemNumber})`, pageUrl: `https://collections.vam.ac.uk/item/${r.systemNumber}`, iiifInfoUrl: `${base}/info.json`, imageUrl: `${base}/full/!1600,1600/0/default.jpg`, previewUrl: `${base}/full/!400,400/0/default.jpg` }];
  });
}
async function searchWellcome(query, limit, opts, kind = 'plate') {
  const data = await json(apiUrl('https://api.wellcomecollection.org/catalogue/v2/images', { query, pageSize: limit, include: 'source.contributors' }), opts);
  return (data.results ?? []).flatMap(r => {
    const loc = r.locations?.find(x => x.locationType?.id === 'iiif-image') ?? r.thumbnail;
    const base = iiifBase(loc?.url); if (!base) return [];
    const people = (r.source?.contributors ?? []).map(c => c.agent?.label).filter(Boolean);
    return [{ provider: 'wellcome', sourceId: r.id, kind, title: r.source?.title ?? r.id, detail: people.join(', '), license: loc.license?.label ?? 'Rights not specified; check item', licenseUrl: loc.license?.url ?? `https://wellcomecollection.org/works/${r.source?.id}`, attribution: [...people, loc.credit || 'Wellcome Collection'].join(' · '), pageUrl: `https://wellcomecollection.org/works/${r.source?.id}`, iiifInfoUrl: `${base}/info.json`, imageUrl: `${base}/full/!1600,1600/0/default.jpg`, previewUrl: `${base}/full/!400,400/0/default.jpg` }];
  });
}
function locItem(row, kind, imageUrl, previewUrl, sourceId, pageUrl) {
  const rights = row.item?.rights_advisory ?? row.item?.rights_information ?? row.rights ?? 'Rights not specified in search; check Rights & Access on item page';
  return { provider: 'loc', sourceId, kind, title: row.title ?? 'Library of Congress', detail: [row.date, ...(row.contributor ?? row.contributors ?? [])].filter(Boolean).join(' · '), license: Array.isArray(rights) ? rights.join(' ') : rights, licenseUrl: pageUrl, attribution: row.item?.repository ?? 'Library of Congress', pageUrl, imageUrl: https(imageUrl), previewUrl: https(previewUrl ?? imageUrl) };
}
async function searchLoc(query, limit, opts, kind = 'photo') {
  if (kind === 'blueprint') return searchBlueprint(query, limit, opts);
  const data = await json(apiUrl(`https://www.loc.gov/${kind === 'map' ? 'maps' : 'photos'}/`, { q: query, fo: 'json', c: Math.min(limit * 2, 60) }), opts);
  return (data.results ?? []).filter(r => !r.access_restricted).flatMap(r => {
    const urls = (r.image_url ?? []).filter(u => /\.(jpe?g|png)(?:[?#]|$)/i.test(u));
    if (!urls.length) return [];
    const best = urls.at(-1).split('#')[0], page = https(r.url || r.id);
    return [locItem(r, kind, best, (urls[1] ?? urls[0]).split('#')[0], r.id ?? page, page)];
  }).slice(0, limit);
}
async function searchBlueprint(query, limit, opts) {
  // hh includes photographs and surveys. Only /sheet/ images are measured drawings.
  const data = await json(apiUrl('https://www.loc.gov/collections/historic-american-buildings-landscapes-and-engineering-records/', { q: `${query} drawings`, fo: 'json', at: 'results', c: Math.min(limit * 3, 60) }), opts);
  return (data.results ?? []).flatMap(row => {
    const resource = (row.resources ?? []).find(r => /\/sheet\//.test(r.image ?? ''));
    const image = resource?.image ?? (row.image_url ?? []).find(u => /\/sheet\//.test(u));
    if (!image) return [];
    const preview = new URL(https(image), 'https://www.loc.gov').href.split('#')[0];
    // LOC service derivative suffixes: _150px thumbnail, r medium, v large.
    const full = preview.replace(/_150px\.jpg$/, 'v.jpg').replace(/r\.jpg$/, 'v.jpg');
    const page = https(resource?.url ?? row.url ?? row.id);
    return [locItem(row, 'blueprint', full, preview.replace(/_150px\.jpg$/, 'r.jpg'), page, page)];
  }).slice(0, limit);
}
export function selectNasaFile(urls, type, videoSize = 'medium') {
  const candidates = urls.filter(u => type === 'video' ? /\.(mp4|mov)(?:\?|$)/i.test(u) : /\.(jpe?g|png)(?:\?|$)/i.test(u));
  const rank = type === 'video' ? [`~${videoSize}.`, ...['~medium.', '~small.', '~mobile.', '~preview.', '~orig.'].filter(x => x !== `~${videoSize}.`)] : ['~orig.', '~large.', '~medium.', '~small.', '~thumb.'];
  return candidates.sort((a, b) => {
    const score = u => { const i = rank.findIndex(t => u.includes(t)); return i < 0 ? 99 : i; };
    return score(a) - score(b);
  })[0];
}
async function resolveNasa(item, opts) {
  const data = await json(item.manifestUrl, opts);
  const urls = Array.isArray(data) ? data : (data.collection?.items ?? []).map(r => r.href);
  const url = selectNasaFile(urls, item.mediaType, opts['video-size']);
  if (!url) throw new Error(`${item.sourceId}에 받을 수 있는 ${item.mediaType} 파일이 없습니다`);
  const alternates = item.mediaType === 'video' ? ['preview', 'small', 'mobile'].map(size => urls.find(u => u.includes(`~${size}.`) && /\.mp4$/i.test(u))).filter(Boolean) : ['large', 'medium', 'small'].map(size => urls.find(u => u.includes(`~${size}.`) && /\.(jpe?g|png)$/i.test(u))).filter(Boolean);
  return { ...item, downloadCandidates: [...new Set([url, ...alternates].map(https))], ...(item.mediaType === 'video' ? { videoUrl: https(url) } : { imageUrl: https(url) }) };
}
async function searchNasa(query, limit, opts, mediaType = 'image', kind = 'science') {
  const data = await json(apiUrl('https://images-api.nasa.gov/search', { q: query, media_type: mediaType, page_size: mediaType === 'video' ? Math.min(limit * 3, 100) : limit }), opts);
  return (data.collection?.items ?? []).flatMap(row => {
    const r = row.data?.[0]; if (!r) return [];
    const image = row.links?.find(l => l.render === 'image' && l.rel === 'preview')?.href ?? row.links?.find(l => l.render === 'image')?.href;
    if (!image) return [];
    if (mediaType === 'video' && /animation|visualization|simulation|computer.generated|rendering/i.test([r.title, ...(r.keywords ?? [])].join(' '))) return [];
    const thirdParty = /copyright|©|all rights reserved/i.test([r.description, r.photographer, r.secondary_creator].join(' '));
    return [{ provider: 'nasa', sourceId: r.nasa_id, kind, mediaType: r.media_type, title: r.title ?? r.nasa_id, detail: [r.center, r.date_created, r.description?.replace(/<[^>]*>/g, '').slice(0, 500)].filter(Boolean).join(' · '), license: thirdParty ? 'Third-party rights mentioned; check item credits' : 'NASA media usage guidelines; generally not subject to US copyright; verify third-party credits', licenseUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/', attribution: ['NASA', r.center, r.photographer, r.secondary_creator].filter(Boolean).join(' · '), pageUrl: `https://images.nasa.gov/details/${encodeURIComponent(r.nasa_id)}`, imageUrl: https(image), previewUrl: https(image), manifestUrl: https(row.href ?? `https://images-api.nasa.gov/asset/${encodeURIComponent(r.nasa_id)}`) }];
  }).slice(0, limit);
}
const plain = s => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
// Commons search matches anywhere on the file page; map and plate kinds keep only files whose title or description names the medium.
const MEDIUM = { map: /\b(map|maps|plan|chart|atlas|kaart|carte|karte|plattegrond)\b/i, plate: /\b(engraving|etching|lithograph|woodcut|plate|print|illustration|drawing|gravure)\b/i };
async function searchCommons(query, limit, opts, kind = 'photo') {
  // Wikimedia only serves standard thumbnail widths; 500 and 1920 are among them.
  const data = await json(apiUrl('https://commons.wikimedia.org/w/api.php', { action: 'query', format: 'json', formatversion: 2, generator: 'search', gsrsearch: `${query} filetype:bitmap`, gsrnamespace: 6, gsrlimit: Math.min(limit * 2, 40), prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: 1920, iiextmetadatafilter: 'LicenseShortName|License|LicenseUrl|Artist|DateTimeOriginal|ObjectName|ImageDescription|AttributionRequired' }), opts);
  return (data.query?.pages ?? []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).flatMap(p => {
    const ii = p.imageinfo?.[0]; if (!ii?.url || !ii.width) return [];
    const m = k => plain(ii.extmetadata?.[k]?.value);
    const webSafe = /^image\/(jpeg|png|webp|gif)$/.test(ii.mime);
    const imageUrl = ii.thumburl && (ii.width > 1920 || !webSafe) ? ii.thumburl : webSafe ? ii.url : null;
    if (!imageUrl) return [];
    const previewUrl = ii.thumburl && ii.width > 500 ? ii.thumburl.replace(/\/\d+px-/, '/500px-') : imageUrl;
    const short = m('LicenseShortName') || m('License') || 'License on file page';
    if (MEDIUM[kind] && !MEDIUM[kind].test(`${p.title} ${m('ObjectName')} ${m('ImageDescription')}`)) return [];
    return [{ provider: 'commons', sourceId: String(p.pageid), kind, title: m('ObjectName') || p.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''), detail: [m('DateTimeOriginal'), m('Artist')].filter(Boolean).join(' · ').slice(0, 200), about: m('ImageDescription').slice(0, 300), license: short, licenseUrl: m('LicenseUrl') || ii.descriptionurl, attribution: [m('Artist') || 'Unknown', 'via Wikimedia Commons'].join(' · ').slice(0, 300), pageUrl: ii.descriptionurl, imageUrl: https(imageUrl), previewUrl: https(previewUrl), originalWidth: ii.width, originalHeight: ii.height }];
  }).slice(0, limit * 2);
}
async function searchAic(query, limit, opts, kind = 'design') {
  const data = await json(apiUrl('https://api.artic.edu/api/v1/artworks/search', { q: query, limit: Math.min(limit * 2, 40), fields: 'id,title,artist_display,date_display,image_id,is_public_domain,thumbnail,medium_display,artwork_type_title', 'query[term][is_public_domain]': 'true' }), opts);
  const iiif = data.config?.iiif_url ?? 'https://www.artic.edu/iiif/2';
  return (data.data ?? []).flatMap(r => {
    if (!r.image_id || !r.is_public_domain) return [];
    const width = r.thumbnail?.width, height = r.thumbnail?.height;
    const base = `${iiif}/${r.image_id}/full`;
    return [{ provider: 'aic', sourceId: String(r.id), kind, title: r.title ?? String(r.id), detail: [r.artwork_type_title, plain(r.artist_display), r.date_display].filter(Boolean).join(' · '), about: [r.medium_display, r.thumbnail?.alt_text].filter(Boolean).join(' · ').slice(0, 300), license: 'CC0 (public-domain artwork, Art Institute of Chicago)', licenseUrl: 'https://www.artic.edu/open-access/open-access-images', attribution: `Art Institute of Chicago (${r.id})`, pageUrl: `https://www.artic.edu/artworks/${r.id}`, imageUrl: `${base}/${width && width < 1686 ? width : 1686},/0/default.jpg`, previewUrl: `${base}/400,/0/default.jpg`, originalWidth: width, originalHeight: height }];
  });
}
async function searchCleveland(query, limit, opts, kind = 'design') {
  const data = await json(apiUrl('https://openaccess-api.clevelandart.org/api/artworks/', { q: query, has_image: 1, cc0: 1, limit: Math.min(limit * 2, 40) }), opts);
  return (data.data ?? []).flatMap(r => {
    const web = r.images?.web, print = r.images?.print, full = r.images?.full;
    if (!web?.url) return [];
    return [{ provider: 'cleveland', sourceId: String(r.id), kind, title: r.title ?? String(r.id), detail: [r.type, ...(r.creators ?? []).map(c => c.description), r.creation_date].filter(Boolean).join(' · '), about: plain(r.description ?? r.technique ?? '').slice(0, 300), license: 'CC0', licenseUrl: 'https://www.clevelandart.org/open-access', attribution: r.creditline ? `Cleveland Museum of Art · ${r.creditline}` : 'Cleveland Museum of Art', pageUrl: r.url, imageUrl: https((print ?? web).url), previewUrl: https(web.url), originalWidth: Number(full?.width ?? print?.width) || undefined, originalHeight: Number(full?.height ?? print?.height) || undefined }];
  });
}
async function searchMet(query, limit, opts, kind = 'design') {
  // v1 search was retired on 2026-10-01; v1.1 pages results, and each object needs its own request.
  const data = await json(apiUrl('https://collectionapi.metmuseum.org/public/collection/v1.1/search', { q: query, hasImages: 'true', isPublicDomain: 'true', limit: Math.min(limit * 2, 12) }), opts);
  const out = await pool(data.objectIDs ?? [], id => json(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`, opts), 4);
  return out.flatMap(r => {
    const o = r.status === 'fulfilled' ? r.value : null;
    if (!o?.isPublicDomain || !o.primaryImage) return [];
    return [{ provider: 'met', sourceId: String(o.objectID), kind, title: o.title || o.objectName || String(o.objectID), detail: [o.objectName, o.artistDisplayName, o.objectDate, o.culture].filter(Boolean).join(' · '), about: [o.medium, o.classification].filter(Boolean).join(' · ').slice(0, 300), license: 'CC0 (Met Open Access, public domain)', licenseUrl: 'https://www.metmuseum.org/policies/image-resources', attribution: `The Metropolitan Museum of Art (${o.objectID})`, pageUrl: o.objectURL, imageUrl: https(o.primaryImage), previewUrl: https(o.primaryImageSmall || o.primaryImage) }];
  });
}
const JAPAN_RIGHTS = { cc0: 'CC0', pdm: 'Public Domain Mark', ccby: 'CC BY 4.0', ccbysa: 'CC BY-SA 4.0' };
async function searchJapan(query, limit, opts, kind = 'design') {
  // Japan Search gathers ColBase (the national museums), the National Diet Library and regional collections; only openly licensed images are requested.
  const u = new URL('https://jpsearch.go.jp/api/item/search/jps-cross');
  u.searchParams.set('keyword', query); u.searchParams.set('f-contents', 'image'); u.searchParams.set('size', String(Math.min(limit * 3, 60)));
  for (const r of Object.keys(JAPAN_RIGHTS)) u.searchParams.append('f-rights', '+' + r);
  const data = await json(u.href, opts);
  return (data.list ?? []).flatMap(x => {
    const c = x.common ?? {}, raw = c.contentsUrl?.[0] ?? c.thumbnailUrl?.[0];
    if (!raw || !JAPAN_RIGHTS[c.contentsRightsType]) return [];
    // ColBase keeps a 3000px image at /slideshow/ beside the small /slideshow_s/; some items lack it, so the small one stays as fallback.
    const original = https(raw), large = original.replace('/slideshow_s/', '/slideshow/');
    const people = (c.contributor ?? []).filter(Boolean).slice(0, 2).join(' / ');
    return [{ provider: 'japan', sourceId: c.id ?? x.id, kind, title: plain(c.title) || c.id, detail: [plain(c.titleEn), (c.temporal ?? []).at(-1), people].filter(Boolean).join(' · ').slice(0, 240), about: plain(c.description).slice(0, 300), license: JAPAN_RIGHTS[c.contentsRightsType], licenseUrl: 'https://jpsearch.go.jp/policy/available-rights-statements', attribution: c.database === 'cobas' ? `출처: ColBase(https://colbase.nich.go.jp/) · ${people}` : [people || c.provider, 'via Japan Search'].filter(Boolean).join(' · '), pageUrl: c.linkUrl ?? `https://jpsearch.go.jp/item/${c.id}`, imageUrl: large, previewUrl: https(c.thumbnailUrl?.[0] ?? raw), downloadCandidates: [...new Set([large, original])] }];
  });
}
async function searchRijks(query, limit, opts, kind = 'design') {
  // Linked Art: the search lists object ids; the image sits two hops away (object → visual item → digital object).
  const data = await json(apiUrl('https://data.rijksmuseum.nl/search/collection', { description: query, imageAvailable: 'true' }), opts);
  const out = await pool((data.orderedItems ?? []).slice(0, Math.min(limit * 2, 10)).map(x => x.id), async id => {
    const o = await json(id, opts);
    const visual = await json(o.shows[0].id, opts), digital = await json(visual.digitally_shown_by[0].id, opts);
    const service = digital.access_point?.[0]?.id?.replace(/\/full\/.*$/, '');
    if (!service) return null;
    const names = (o.identified_by ?? []).filter(n => n.type === 'Name'), english = names.find(n => JSON.stringify(n.language ?? '').includes('300388277'));
    const rights = JSON.stringify(o.subject_of ?? '').match(/https?:\/\/creativecommons\.org\/[a-z/]+\/[\d.]+\//)?.[0];
    const number = (o.identified_by ?? []).find(n => n.type === 'Identifier')?.content;
    return { provider: 'rijks', sourceId: id.split('/').pop(), kind, title: (english ?? names[0])?.content ?? number ?? id, detail: [names.find(n => n !== english)?.content, number].filter(Boolean).join(' · ').slice(0, 240), about: (o.referred_to_by ?? []).map(r => r.content).filter(Boolean).join(' · ').slice(0, 300), license: rights ? (rights.includes('/zero/') ? 'CC0' : rights.includes('/mark/') ? 'Public Domain Mark' : rights) : 'Rights not specified in record; check item page', licenseUrl: rights ?? id, attribution: `Rijksmuseum, Amsterdam${number ? ` (${number})` : ''}`, pageUrl: id, imageUrl: `${service}/full/!2400,2400/0/default.jpg`, previewUrl: `${service}/full/!500,500/0/default.jpg` };
  }, 4);
  return out.flatMap(r => r.status === 'fulfilled' && r.value ? [r.value] : []);
}
export function interleave(groups, limit) {
  const out = [], seen = new Set();
  for (let i = 0; groups.some(g => i < g.length) && out.length < limit; i++) {
    for (const group of groups) {
      const item = group[i]; if (!item) continue;
      // Archives often list one work as several records; identical title and detail add nothing to compare.
      const key = `${item.provider}:${item.sourceId}`, twin = `${item.provider}:${item.title}:${item.detail ?? ''}`.toLowerCase();
      if (seen.has(key) || seen.has(twin)) continue; seen.add(key); seen.add(twin); out.push(item);
      if (out.length === limit) break;
    }
  }
  return out;
}
async function remember(items, opts) {
  return updateCache(opts.cache, cache => items.map(item => {
    const existing = Object.values(cache.items).find(x => x.provider === item.provider && x.sourceId === item.sourceId);
    const prefix = PREFIX[item.provider];
    const next = Math.max(0, ...Object.keys(cache.items).filter(k => k.startsWith(prefix)).map(k => Number(k.slice(1)) || 0)) + 1;
    const ref = existing?.ref ?? prefix + next;
    const result = { ...existing, ...item, ref, cachedAt: new Date().toISOString() }; cache.items[ref] = result; return result;
  }));
}
function searchJobs(query, opts) {
  const kinds = opts.kind === 'all' ? 15 : 1;
  const per = Math.max(2, Math.ceil(opts.limit / kinds));
  const jobs = {
    texture: [['polyhaven/textures', () => searchPoly(query, per, opts)]],
    design: [['met', () => searchMet(query, per, opts)], ['aic', () => searchAic(query, per, opts)], ['cleveland', () => searchCleveland(query, per, opts)], ['vam', () => searchVam(query, per, opts)], ['polyhaven/models', () => searchPoly(query, per, opts, 'models')], ['japan', () => searchJapan(query, per, opts)], ['rijks', () => searchRijks(query, per, opts)]],
    photo: [['commons', () => searchCommons(query, per, opts)], ['loc/photos', () => searchLoc(query, per, opts)], ['nasa/images', () => searchNasa(query, per, opts, 'image', 'photo')]],
    blueprint: [['loc/hh', () => searchLoc(query, per, opts, 'blueprint')]],
    map: [['loc/maps', () => searchLoc(query, per, opts, 'map')], ['commons/maps', () => searchCommons(`${query} (map OR chart OR plan)`, per, opts, 'map')]],
    plate: [['wellcome', () => searchWellcome(query, per, opts)], ['japan/plates', () => searchJapan(query, per, opts, 'plate')], ['commons/plates', () => searchCommons(`${query} engraving`, per, opts, 'plate')]],
    science: [['nasa/science', () => searchNasa(query, per, opts)], ['wellcome/science', () => searchWellcome(query, per, opts, 'science')]],
    video: [['nasa/video', () => searchNasa(query, per, opts, 'video', 'video')]],
  };
  if (opts.kind !== 'all') return jobs[opts.kind];
  // One job per source, so a single slow or empty source cannot take the whole first round.
  return [jobs.photo[0], jobs.design[5], jobs.texture[0], jobs.design[1], jobs.photo[1], jobs.design[6], jobs.design[2], jobs.plate[0], jobs.design[0], jobs.science[0], jobs.blueprint[0], jobs.map[0], jobs.design[3], jobs.video[0], jobs.design[4]];
}
async function runSearch(input, opts) {
  const queries = input.split(/\s*\|\s*/).map(q => q.trim()).filter(Boolean);
  if (!queries.length) usage('search에 검색어가 필요합니다');
  const selected = queries.flatMap(query => searchJobs(query, opts).map(([label, fn]) => [queries.length > 1 ? `${label} "${query}"` : label, fn, query]));
  let filtered = 0;
  const results = await Promise.allSettled(selected.map(async ([label, fn, query]) => {
    const start = Date.now(); const value = await fn(); let items = Array.isArray(value) ? value : value.items;
    const terms = queryTerms(query), before = items.length;
    // Sources that search full records return items whose title and summary never mention the subject.
    // full: the item names every query term. Full matches are picked across sources first, so a medium word alone ("engraving") cannot crowd out the subject.
    // CJK queries reach records catalogued only in English, so a CJK miss ranks lower instead of being dropped.
    items = items.map(item => { const score = item.matched ?? matchCount(`${item.title} ${item.detail} ${item.about ?? ''}`, terms); return { ...item, score, full: score >= terms.length }; });
    if (terms.length && terms.every(t => /^[\p{Script=Latin}\p{N}]+$/u.test(t))) items = items.filter(item => item.score > 0);
    filtered += before - items.length;
    items = items.map(({ matched, score, ...item }) => ({ ...item, use: item.use ?? rightsUse(item.license, item.licenseUrl), query }));
    if (opts.use === 'page') items = items.filter(item => item.use === 'page');
    console.error(`[curate-media] ${label}: ${items.length}개 항목${before > items.length ? `, ${before - items.length}개 걸러냄` : ''} (${Date.now() - start}ms)`);
    return { items, errors: value.errors ?? [] };
  }));
  const errors = results.flatMap((r, i) => r.status === 'rejected' ? [{ source: selected[i][0], message: r.reason.message }] : r.value.errors.map(message => ({ source: selected[i][0], message })));
  const groups = results.filter(r => r.status === 'fulfilled').map(r => r.value.items);
  const full = interleave(groups.map(g => g.filter(i => i.full)), opts.limit), taken = new Set(full.map(i => `${i.provider}:${i.sourceId}`));
  const partial = interleave(groups.map(g => g.filter(i => !i.full && !taken.has(`${i.provider}:${i.sourceId}`))), opts.limit - full.length);
  const picked = [...full, ...partial].map(({ full, ...item }) => item).sort((a, b) => USES[a.use] - USES[b.use]);
  let items = await remember(picked, opts);
  let sheet;
  if (opts.sheet) ({ items, sheet } = await remoteSheet(items, opts));
  const hint = items.length ? undefined : '결과가 없습니다. 묶음마다 한두 단어만 남기고 장소나 물건 이름부터 찾으세요. |로 서로 다른 검색어를 나누거나 --kind all로 바꿔 볼 수도 있습니다';
  return { query: input, ...(queries.length > 1 ? { queries } : {}), kind: opts.kind, count: items.length, ...(hint ? { hint } : {}), filtered, cache: opts.cache, items, errors, ...sheet, failed: results.every(r => r.status === 'rejected') || (!items.length && errors.length > 0) };
}
async function targets(positional, opts) {
  const tokens = positional.flatMap(x => /^https?:\/\//i.test(x) ? [x] : x.split(/[,\s]+/)).filter(Boolean);
  const cache = await readCache(opts.cache);
  for (const extra of [path.join(opts.dir, '.curate-cache.json'), path.join(path.dirname(opts.dir), '.curate-cache.json')]) {
    if (extra !== opts.cache && existsSync(extra)) {
      try { const other = await readCache(extra); cache.items = { ...other.items, ...cache.items }; } catch {}
    }
  }
  return [...new Set(tokens)].map(token => {
    if (/^[A-Z]\d+$/i.test(token) && Object.values(PREFIX).includes(token[0].toUpperCase())) {
      const item = cache.items[token.toUpperCase()];
      if (!item) usage(`캐시에 없는 번호입니다: ${token}. 먼저 search를 실행하거나 --cache로 기존 캐시를 고르세요`);
      return item;
    }
    try {
      const url = httpUrl(token);
      // A pasted result URL retains its source metadata whenever the workspace knows it.
      const known = Object.values(cache.items).find(x => [x.imageUrl, x.videoUrl, ...Object.values(x.textureMaps ?? {}).map(m => m?.url)].includes(url));
      return { ...known, directUrl: url, imageUrl: url, title: known?.title ?? path.basename(new URL(url).pathname), provider: known?.provider ?? 'url', use: known?.use ?? 'check', license: known?.license ?? 'Rights not verified (direct URL)', attribution: known?.attribution ?? 'Source supplied by user', pageUrl: known?.pageUrl ?? url, previewUrl: url };
    } catch { usage(`번호나 URL이 올바르지 않습니다: ${token}`); }
  });
}
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function writeSheet(items, dir, remote) {
  await fs.mkdir(dir, { recursive: true });
  const cards = items.map(item => {
    const src = remote ? item.previewUrl ?? item.imageUrl : item.poster ?? item.saved;
    const href = remote ? src : src && path.relative(dir, src).split(path.sep).map(encodeURIComponent).join('/');
    const image = href && !/\.(mp4|mov|webm)(?:\?|$)/i.test(href) ? `<img src="${escapeHtml(href)}" alt="${escapeHtml(item.title)}"><p class="size">읽는 중…</p>` : '<p>이미지 미리보기가 없습니다. 받은 결과를 확인하세요</p>';
    return `<article>${image}<h2>${escapeHtml(item.ref ?? 'URL')} · ${escapeHtml(item.use ?? 'check')} · ${escapeHtml(item.map ?? item.kind)} · ${escapeHtml(item.title)}</h2><p>${escapeHtml(item.license)}</p><p>${escapeHtml(item.attribution)}</p><a href="${escapeHtml(item.pageUrl)}">출처 기록</a>${item.integrity ? `<p>${escapeHtml(item.integrity)} · ${item.width ?? '?'} × ${item.height ?? '?'}</p>` : ''}</article>`;
  }).join('\n');
  const file = path.join(dir, remote ? 'candidates.html' : 'sheet.html');
  const html = `<!doctype html><html lang="ko-KR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>이미지 후보 모음</title><style>body{font:15px/1.5 system-ui;margin:24px;background:#eee;color:#222}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px}article{background:white;padding:16px;overflow-wrap:anywhere}img{width:100%;height:240px;object-fit:contain}h2{font-size:17px;line-height:1.4}.error{color:#a00}</style><h1>이미지 후보 · ${items.length} 항목</h1><p>${remote ? '외부 미리보기: 표시한 크기는 미리보기 파일의 너비와 높이입니다. 원본 크기는 실제로 받은 파일에서 확인하세요.' : '로컬 이미지: 읽은 결과와 실제 크기를 각 항목에 표시합니다.'}</p><main>${cards}</main><script>for(const img of document.images){const label=img.nextElementSibling;function check(){label.textContent=img.naturalWidth?img.naturalWidth+' × '+img.naturalHeight:'읽기 실패';if(!img.naturalWidth)label.className='error'}img.addEventListener('load',check);img.addEventListener('error',check);if(img.complete)check()}</script></html>`;
  await fs.writeFile(file, html); return file;
}
async function hasTool(name) { try { await exec(name, ['-version'], { timeout: 5000, maxBuffer: 100000 }); return true; } catch { return false; } }
// Design facts from a 48×48 thumbnail: where text can sit, what the edges fuse with, whether ink sits on paper.
// Calm needs both low spread and low neighbour contrast; spread alone calls a fine-lined map calm. Thresholds come from real previews.
export function describePixels(buf, n = 48) {
  const px = i => [buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]];
  const lum = i => { const [r, g, b] = px(i); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
  const region = (x0, y0, x1, y1) => {
    let sum = 0, sq = 0, sat = 0, grad = 0, pairs = 0; const rgb = [0, 0, 0], count = (x1 - x0) * (y1 - y0);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * n + x, v = lum(i), c = px(i), max = Math.max(...c);
      sum += v; sq += v * v; sat += max ? (max - Math.min(...c)) / max : 0; c.forEach((value, k) => { rgb[k] += value; });
      if (x + 1 < x1) { grad += Math.abs(v - lum(i + 1)); pairs++; }
      if (y + 1 < y1) { grad += Math.abs(v - lum(i + n)); pairs++; }
    }
    const mean = sum / count;
    return { mean, sd: Math.sqrt(Math.max(0, sq / count - mean * mean)), sat: sat / count, grad: grad / pairs, rgb: rgb.map(v => v / count) };
  };
  const calmOf = r => r.sd < 0.09 && r.grad < 0.02;
  const all = region(0, 0, n, n), t = Math.round(n / 3), e = 3;
  const strips = [region(0, 0, n, e), region(0, n - e, n, n), region(0, 0, e, n), region(n - e, 0, n, n)];
  const edgeFlat = strips.every(r => r.sd < 0.06 && r.grad < 0.02);
  const ring = { mean: strips.reduce((v, r) => v + r.mean, 0) / 4, sat: strips.reduce((v, r) => v + r.sat, 0) / 4, rgb: [0, 1, 2].map(k => strips.reduce((v, r) => v + r.rgb[k], 0) / 4) };
  const regions = { top: region(0, 0, n, t), bottom: region(0, n - t, n, n), left: region(0, 0, t, n), right: region(n - t, 0, n, n), centre: region(t, t, n - t, n - t) };
  const hex = rgb => '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  return { tone: all.mean < 0.33 ? 'dark' : all.mean > 0.66 ? 'light' : 'mid', mono: all.sat < 0.1, edge: hex(ring.rgb), edgeFlat, paper: edgeFlat && ring.mean > 0.75 && ring.sat < 0.2, calm: Object.keys(regions).filter(k => calmOf(regions[k])) };
}
async function lookAt(file, info) {
  const { stdout } = await exec('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'scale=48:48:flags=area,format=rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', timeout: 20000, maxBuffer: 100000 });
  if (stdout.length < 48 * 48 * 3) throw new Error('미리보기를 디코딩할 수 없습니다');
  return { ...describePixels(stdout), ratio: +(info.width / info.height).toFixed(2) };
}
const FONTS = ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf', 'C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf'];
const labelText = s => String(s ?? '').normalize('NFKD').replace(/[^A-Za-z0-9 ./#+()-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 46);
// One PNG an agent can read in a single look: each cell carries its ref, use and size.
async function contactSheet(cells, file) {
  const cols = Math.min(4, cells.length), rows = Math.ceil(cells.length / cols), W = 360, H = 300, IW = W - 16, IH = H - 62;
  const graph = [`color=c=0xEDEDED:s=${cols * W}x${rows * H}:d=1[b0]`];
  cells.forEach((_, i) => {
    const x = (i % cols) * W + 8, y = Math.floor(i / cols) * H + 8;
    graph.push(`[${i}:v]scale=${IW}:${IH}:force_original_aspect_ratio=decrease[s${i}]`, `[b${i}][s${i}]overlay=x='${x}+(${IW}-w)/2':y='${y}+(${IH}-h)/2'[b${i + 1}]`);
  });
  const font = FONTS.find(f => existsSync(f));
  const draw = (t, x, y, size, color) => `drawtext=${font ? `fontfile='${font.replace(/:/g, '\\:')}':` : ''}text='${labelText(t)}':x=${x}:y=${y}:fontsize=${size}:fontcolor=${color}`;
  const labels = cells.flatMap((c, i) => { const x = (i % cols) * W + 10, y = Math.floor(i / cols) * H + H - 50; return [draw(c.top, x, y, 18, '0x111111'), draw(c.bottom, x, y + 25, 13, '0x555555')]; });
  const run = withLabels => exec('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...cells.flatMap(c => ['-i', c.src]), '-filter_complex', graph.join(';') + (withLabels ? `;[b${cells.length}]${labels.join(',')}[out]` : ''), '-map', withLabels ? '[out]' : `[b${cells.length}]`, '-frames:v', '1', '-update', '1', file], { timeout: 60000, maxBuffer: 1000000 });
  try { await run(true); return { file, labelled: true }; }
  catch { await run(false); return { file, labelled: false }; }
}
const sizeLabel = item => item.originalWidth && item.originalHeight ? `${item.originalWidth}x${item.originalHeight}` : item.width && item.height ? `${item.width}x${item.height}` : '';
async function remoteSheet(items, opts) {
  const html = await writeSheet(items, opts.dir, true);
  if (!(await hasTool('ffmpeg')) || !(await hasTool('ffprobe'))) return { items, sheet: { sheet: html, sheetWarnings: ['ffmpeg/ffprobe가 없어 PNG 그림 모음과 look 값을 만들지 못했습니다. HTML 이미지 모음을 열어 고르세요'] } };
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jstyle-curate-'));
  try {
    const looked = await pool(items, async (item, i) => {
      const file = path.join(temp, `${i}.part`);
      await download(item.previewUrl ?? item.imageUrl, file, { ...opts, 'download-timeout': opts.timeout });
      const size = await inspect(file, { ffprobe: true }, false);
      return { file, size, look: await lookAt(file, size) };
    }, 6);
    const out = items.map((item, i) => looked[i].status !== 'fulfilled' ? { ...item, look: null, lookError: looked[i].reason.message } : { ...item, look: looked[i].value.look, ...(!item.originalWidth && item.previewUrl === item.imageUrl ? { originalWidth: looked[i].value.size.width, originalHeight: looked[i].value.size.height } : {}) });
    const cells = out.flatMap((item, i) => looked[i].status === 'fulfilled' ? [{ src: looked[i].value.file, top: `${item.ref ?? 'URL'}  ${item.use ?? ''}  ${sizeLabel(item)}`, bottom: `${item.provider} - ${/[a-z]{3}/i.test(labelText(item.title)) ? item.title : item.detail}` }] : []);
    const warnings = out.filter(x => x.lookError).map(x => `${x.ref ?? x.imageUrl}: 미리보기를 받지 못해 PNG에서 뺐습니다(${x.lookError})`);
    if (!cells.length) return { items: out, sheet: { sheet: html, sheetWarnings: warnings } };
    const png = await contactSheet(cells, path.join(opts.dir, 'candidates.png'));
    if (!png.labelled) warnings.push('ffmpeg가 글자를 그리지 못해 PNG에 번호가 없습니다. 칸은 items에서 look이 있는 항목 순서대로 왼쪽에서 오른쪽, 위에서 아래로 놓입니다');
    console.error(`[curate-media] 이미지 모음: ${png.file} (실제 그림을 보고 고르세요)`);
    return { items: out, sheet: { sheet: html, sheetImage: png.file, ...(warnings.length ? { sheetWarnings: warnings } : {}) } };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
export function sniff(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: '.jpg', video: false };
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { ext: '.png', video: false };
  if (buffer.toString('ascii', 0, 6).match(/^GIF8[79]a$/)) return { ext: '.gif', video: false };
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { ext: '.webp', video: false };
  if (buffer.toString('ascii', 4, 8) === 'ftyp') return { ext: buffer.toString('ascii', 8, 12).startsWith('qt') ? '.mov' : '.mp4', video: true };
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { ext: '.webm', video: true };
  throw new Error('지원하는 이미지나 영상 응답이 아닙니다. HTML이나 JSON 오류 페이지, 또는 깨진 파일일 수 있습니다');
}
async function download(url, temp, opts, expected) {
  const res = await fetch(httpUrl(url), { headers: headersFor(url), signal: AbortSignal.timeout(opts['download-timeout']) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  const max = opts['max-mb'] * 1024 * 1024, length = Number(res.headers.get('content-length'));
  if (length > max) { await res.body?.cancel(); throw new Error(`파일이 제한을 넘습니다: --max-mb ${opts['max-mb']}`); }
  if (/text\/html|application\/json/.test(res.headers.get('content-type') ?? '')) { await res.body?.cancel(); throw new Error('미디어 파일이 아니라 오류 페이지나 메타데이터 응답입니다'); }
  const handle = await fs.open(temp, 'wx'); let bytes = 0, head = Buffer.alloc(0); const md5 = createHash('md5');
  try {
    for await (const chunk of res.body) {
      bytes += chunk.length; if (bytes > max) throw new Error(`파일이 제한을 넘습니다: --max-mb ${opts['max-mb']}`);
      if (head.length < 32) head = Buffer.concat([head, Buffer.from(chunk)]).subarray(0, 32);
      md5.update(chunk); await handle.writeFile(chunk);
    }
  } finally { await handle.close(); }
  if (!bytes || (length && !res.headers.get('content-encoding') && bytes !== length)) throw new Error('파일이 비었거나 전송이 끝나지 않았습니다');
  if (expected?.size && bytes !== expected.size) throw new Error(`파일 크기가 맞지 않습니다(받은 크기 ${bytes}, 예상 ${expected.size})`);
  const digest = md5.digest('hex'); if (expected?.md5 && digest !== expected.md5) throw new Error('MD5 검사 실패');
  return { bytes, md5: digest, ...sniff(head) };
}
async function inspect(file, tools, full) {
  if (!tools.ffprobe) return { integrity: 'signature-and-length-only', warnings: ['ffprobe가 없어 실제 너비와 높이를 확인하지 못했습니다'] };
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name:format=duration', '-of', 'json', file], { timeout: 20000, maxBuffer: 100000 });
  const data = JSON.parse(stdout), stream = data.streams?.[0];
  if (!stream?.width || !stream?.height) throw new Error('디코딩할 수 있는 이미지/영상 스트림이 없습니다');
  if (full && tools.ffmpeg) await exec('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { timeout: 120000, maxBuffer: 1000000 });
  return { width: stream.width, height: stream.height, codec: stream.codec_name, duration: Number(data.format?.duration) || undefined, integrity: full && tools.ffmpeg ? 'full-decode' : 'probed', warnings: full && !tools.ffmpeg ? ['ffmpeg가 없어 파일 전체를 디코딩해 확인하지 못했습니다'] : [] };
}
const safeName = s => String(s ?? 'media').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 90) || 'media';
// Reserve the destination atomically; repeated downloads get suffixes instead of overwriting.
async function deliver(temp, wanted, explicit = false) {
  for (let i = 0; i < 1000; i++) {
    const p = path.parse(wanted), file = i ? path.join(p.dir, `${p.name}-${i}${p.ext}`) : wanted;
    try { await fs.copyFile(temp, file, fs.constants.COPYFILE_EXCL); return file; } catch (e) { if (e.code !== 'EEXIST') throw e; if (explicit) throw new Error(`파일이 이미 있습니다: ${file}. --out에 다른 파일 이름을 지정하세요`); }
  }
  throw new Error('겹치는 파일 이름이 너무 많습니다');
}
const mdText = s => String(s ?? '').replace(/[\r\n]+/g, ' ').replace(/[`\[\]<>]/g, '');
async function logSources(records, note) {
  const groups = new Map();
  for (const r of records) {
    const dir = path.dirname(r.saved); if (!groups.has(dir)) groups.set(dir, []);
    const line = `- \`${path.basename(r.saved)}\` — ${mdText(r.ref ?? r.provider)} · ${mdText(r.title)}${r.map ? ' · ' + r.map : ''}\n  - Use: ${r.use === 'reference' ? 'reference only, not for the page' : r.use === 'page' ? 'page' : 'check rights on the source page'}\n  - Source: ${r.pageUrl}\n  - Download: ${r.url}\n  - License: ${mdText(r.license)} (${r.licenseUrl ?? r.pageUrl})\n  - Credit: ${mdText(r.attribution)}${note ? '\n  - Note: ' + mdText(note) : ''}\n`;
    groups.get(dir).push(line);
    if (r.poster) groups.get(dir).push(`- \`${path.basename(r.poster)}\` — first-frame poster derived from \`${path.basename(r.saved)}\`; same license and credit as above.\n`);
  }
  for (const [dir, lines] of groups) await fs.appendFile(path.join(dir, 'SOURCES.md'), lines.join('\n') + '\n');
}
async function resolveIIIF(item, opts) {
  const info = await json(item.iiifInfoUrl, opts);
  if (!info.width || !info.height) throw new Error('IIIF 정보에 올바른 원본 크기가 없습니다');
  const base = iiifBase(item.iiifInfoUrl);
  const imageUrl = Math.max(info.width, info.height) <= 1600 ? `${base}/full/full/0/default.jpg` : `${base}/full/!1600,1600/0/default.jpg`;
  return { ...item, imageUrl, originalWidth: info.width, originalHeight: info.height };
}
// Final picks get the same look fields and a PNG, measured on the files the page will use.
async function localSheet(records, dir) {
  const cells = [];
  for (const r of records) {
    const src = r.poster ?? (r.video ? null : r.saved); if (!src) continue;
    try { r.look = await lookAt(src, await inspect(src, { ffprobe: true }, false)); cells.push({ src, top: `${r.ref ?? 'URL'}  ${r.use}  ${r.width && r.height ? `${r.width}x${r.height}` : ''}`, bottom: path.basename(r.saved) }); }
    catch (e) { r.warnings.push(`look 실패: ${e.message}`); }
  }
  return cells.length ? (await contactSheet(cells, path.join(dir, 'sheet.png'))).file : undefined;
}
async function runFetch(items, opts) {
  if (opts.out && (items.length !== 1 || (items[0].kind === 'texture' && !items[0].directUrl && opts.maps.length > 1))) usage('--out은 파일 하나에만 쓸 수 있습니다. 여러 파일은 --dir assets로 받으세요');
  await fs.mkdir(opts.dir, { recursive: true });
  const tools = { ffmpeg: await hasTool('ffmpeg'), ffprobe: await hasTool('ffprobe') };
  const tasks = [], errors = [], records = [];
  for (let item of items) {
    try {
      if (!item.directUrl && item.kind === 'texture') item = await resolveTexture(item, opts);
      else if (!item.directUrl && item.provider === 'nasa') item = await resolveNasa(item, opts);
      else if (!item.directUrl && item.iiifInfoUrl) item = await resolveIIIF(item, opts);
      if (item.kind === 'texture' && !item.directUrl) {
        for (const map of opts.maps) {
          const file = item.textureMaps[map];
          if (!file) { errors.push({ ref: item.ref, map, message: `쓸 수 있는 ${map} JPG가 없습니다` }); continue; }
          tasks.push({ item, map, url: file.url, expected: file });
        }
      } else tasks.push({ item, url: item.directUrl ?? item.videoUrl ?? item.imageUrl });
    } catch (e) { errors.push({ ref: item.ref, message: e.message }); }
  }
  const settled = await pool(tasks, async ({ item, map, url, expected }) => {
    const temp = path.join(opts.dir, `.${randomUUID()}.part`); let result;
    try {
      let received; const recovery = [];
      const candidates = item.directUrl ? [url] : item.downloadCandidates ?? [url];
      for (const candidate of candidates.slice(0, 3)) {
        try { received = await download(candidate, temp, opts, expected); url = candidate; break; }
        catch (e) { recovery.push(`${candidate}: ${e.message}`); await fs.rm(temp, { force: true }); }
      }
      if (!received) throw new Error(recovery.join('; '));
      const inspection = await inspect(temp, tools, opts.sheet);
      const filename = `${safeName(item.ref ?? item.provider)}-${safeName(item.sourceId ?? item.title)}${map ? '-' + map + '-' + expected.resolution : ''}${received.ext}`;
      const out = opts.out ? path.resolve(opts.out) : path.join(opts.dir, filename);
      if (opts.out && ![received.ext, ...(received.ext === '.jpg' ? ['.jpeg'] : [])].includes(path.extname(out).toLowerCase())) throw new Error(`--out 확장자가 실제 파일 형식과 다릅니다. 확장자를 ${received.ext}로 바꾸세요`);
      const saved = await deliver(temp, out, Boolean(opts.out));
      result = { ref: item.ref, provider: item.provider, sourceId: item.sourceId, kind: item.kind, use: item.use ?? rightsUse(item.license, item.licenseUrl), title: item.title, map, resolution: expected?.resolution, url, saved, pageUrl: item.pageUrl, license: item.license, licenseUrl: item.licenseUrl, attribution: item.attribution, originalWidth: item.originalWidth, originalHeight: item.originalHeight, ...(map === 'normal' ? { normalConvention: item.normalConvention } : {}), ...received, ...inspection };
      if (!received.video && Math.max(result.width ?? 9999, result.height ?? 9999) < 1000) result.warnings.push(`크기가 작습니다(${result.width}x${result.height}). 작은 그림 자리에만 알맞습니다`);
      if (result.use === 'reference') result.warnings.push('페이지 사용이 허용되지 않은 이미지라 만들 때 참고로만 써야 합니다. 서비스에 넣지 않는 폴더에 두세요');
      if (recovery.length) result.warnings.push(`쓸 수 있는 버전으로 바꿨습니다. 이전 실패: ${recovery.join('; ')}`);
      if (received.video) {
        if (!tools.ffmpeg) result.warnings.push('ffmpeg가 없어 poster를 만들지 못했습니다');
        else {
          const posterTemp = path.join(opts.dir, `.${randomUUID()}.jpg`);
          try {
            await exec('ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-i', saved, '-frames:v', '1', '-q:v', '2', posterTemp], { timeout: 30000, maxBuffer: 100000 });
            result.poster = await deliver(posterTemp, saved.replace(/\.[^.]+$/, '-poster.jpg'));
          } catch (e) { result.warnings.push(`poster 실패: ${e.message}`); }
          finally { await fs.rm(posterTemp, { force: true }); }
        }
      }
      console.error(`[curate-media] ${item.ref ?? 'URL'}${map ? '/' + map : ''}: ${received.bytes} bytes → ${saved}`);
      return result;
    } finally { await fs.rm(temp, { force: true }); }
  });
  settled.forEach((r, i) => { if (r.status === 'fulfilled') records.push(r.value); else errors.push({ ref: tasks[i].item.ref, url: tasks[i].url, message: r.reason.message }); });
  await logSources(records, opts.note);
  for (const r of records) if ((opts.sheet && r.integrity !== 'full-decode') || (r.video && !r.poster)) errors.push({ ref: r.ref, saved: r.saved, message: r.warnings.join('; ') || '검사나 poster 생성을 끝내지 못했습니다' });
  const sheet = opts.sheet ? await writeSheet(records, opts.dir, false) : undefined;
  const sheetImage = opts.sheet && tools.ffmpeg && tools.ffprobe ? await localSheet(records, opts.dir) : undefined;
  return { count: records.length, files: records, errors, ...(sheet ? { sheet } : {}), ...(sheetImage ? { sheetImage } : {}), ...(records.length === 1 ? { saved: records[0].saved, bytes: records[0].bytes } : {}), failed: errors.length > 0 };
}
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv); if (parsed.help) { console.log(HELP); return; }
  const { command, positional, opts } = parsed; const start = Date.now(); let result;
  if (command === 'search') result = await runSearch(positional.join(' ').trim(), opts);
  else {
    const items = await targets(positional, opts);
    if (command === 'fetch') result = await runFetch(items, opts);
    else { const { items: out, sheet } = await remoteSheet(items, opts); result = { count: out.length, items: out, ...sheet }; }
  }
  const { failed, ...output } = result;
  console.log(JSON.stringify({ ...output, elapsedMs: Date.now() - start }, null, 2));
  if (failed) process.exitCode = 1;
}
// Compare real paths: through a symlinked install or /tmp on macOS, the URL and argv differ and the script would exit silently.
const real = file => { try { return realpathSync(file); } catch { return path.resolve(file); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  main().catch(err => { console.error(`[curate-media] ${err.message}`); process.exitCode = 1; });
}
