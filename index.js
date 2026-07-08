const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const { AsyncLocalStorage } = require('async_hooks');
const fetch = require('node-fetch');

// ─────────────────────────────────────────
//  MANIFEST
// ─────────────────────────────────────────
const manifest = {
  id: 'community.georgian.dubbed',
  version: '3.2.4',
  name: 'Mercury',
  description: 'Dubbed movies & series — 🇬🇪 Georgian · 🇷🇺 Russian · 🇺🇦 Ukrainian · 🇬🇧 English',
  logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0f/Flag_of_Georgia.svg/200px-Flag_of_Georgia.svg.png',
  // Stream-only addon: no catalogs (no home rows) — meta stays for adj_ ids.
  resources: ['stream', 'meta'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'adj_'],
  catalogs: [],
  behaviorHints: { adult: false, p2p: false }
};

const builder = new addonBuilder(manifest);

// ─────────────────────────────────────────
//  SOURCE SELECTION
//  All of these are Adjaranet-style sites. Only the ones that expose the
//  /api/v1 JSON API (Laravel backend) are usable by this adapter; the rest are
//  WordPress / bespoke front-ends and are skipped automatically. The active
//  base is auto-selected (first one that answers the API) and cached, so if the
//  primary goes down we fail over to the next working mirror on the next request.
//  Order = user priority: the two Adjaranet domains first, then the others.
// ─────────────────────────────────────────
const SOURCES = [
  'https://adjaranetto.com',
  'https://adjaranett.com',
  'https://croconet.cam',
  'https://kinolab.cc',
  'https://ufasofilmebi.ge',
  'https://kinomigma.com'
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  'Accept': 'application/json'
};

const BASE_TTL = 5 * 60 * 1000;       // re-validate the active base every 5 min
let activeBase = null;
let activeBaseAt = 0;

async function getJson(url, timeout = 9000) {
  const res = await fetch(url, { headers: { ...HEADERS, Referer: url }, timeout });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Probe one base: does it serve the Adjaranet /api/v1 movie list?
async function baseWorks(base) {
  try {
    const j = await getJson(`${base}/api/v1/movies?per_page=1`, 6000);
    return Array.isArray(j && j.data);
  } catch {
    return false;
  }
}

// Return a working base, preferring the cached one, otherwise probing in order.
async function getBase() {
  const now = Date.now();
  if (activeBase && now - activeBaseAt < BASE_TTL) return activeBase;
  for (const base of SOURCES) {
    if (await baseWorks(base)) {
      if (base !== activeBase) console.log(`✅ active source: ${base}`);
      activeBase = base;
      activeBaseAt = now;
      return base;
    }
    console.warn(`⏭️  source unavailable (no /api/v1): ${base}`);
  }
  throw new Error('No Georgian source is currently reachable');
}

// Run an API call against the active base; on failure, force a re-pick once and retry.
async function api(path, timeout) {
  let base = await getBase();
  try {
    return await getJson(`${base}${path}`, timeout);
  } catch (e) {
    activeBase = null; // invalidate and re-pick a mirror
    base = await getBase();
    return getJson(`${base}${path}`, timeout);
  }
}

// ─────────────────────────────────────────
//  MAPPING HELPERS
// ─────────────────────────────────────────
function absUrl(base, path) {
  if (!path) return null;
  return /^https?:\/\//.test(path) ? path : base + path;
}

const UA = HEADERS['User-Agent'];

// ─────────────────────────────────────────
//  STREAM PROXY — makes streams playable in a *browser* client (e.g. stredio),
//  not just the native Stremio app. Three problems it solves at once:
//    1. Referer-gating — em.filmx.my / voidboost / zetvideo only serve to a
//       request that carries the right Referer; a browser <video> element can't
//       set Referer, so we fetch server-side and add it.
//    2. IP-locked tokens — HDRezka's voidboost URL is issued to THIS server's IP,
//       so it must be fetched from here, not from the viewer's browser.
//    3. CORS — we re-serve every byte with Access-Control-Allow-Origin:*.
//  Stream URLs in the responses below are rewritten to /proxy on this addon's own
//  public origin (the tunnel URL). We still keep behaviorHints.proxyHeaders, so a
//  native Stremio app keeps working; when no public base is known (PUBLIC_URL
//  unset and no request context) proxify() returns the original CDN URL.
// ─────────────────────────────────────────
const als = new AsyncLocalStorage();
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
// Optional Cloudflare Worker stream relay (unmetered bandwidth). When set, the
// Referer-gated-but-NOT-IP-locked sources (ge.movie/em.filmx, UAFlix/zetvideo)
// stream through it instead of this origin, keeping their bytes off the host's
// bandwidth quota. HDRezka/voidboost is IP-locked to THIS server, so it must
// NOT use the Worker (it stays on the self /proxy below).
const WORKER_PROXY = (process.env.WORKER_PROXY || '').replace(/\/+$/, '');

// Resolve the public origin to embed in proxied stream URLs: prefer PUBLIC_URL
// (set it to the tunnel's https URL), else derive from the incoming request.
function reqBaseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// Compact, URL-safe token carrying the target url + the Referer to send upstream.
// h:1 marks the target as an HLS playlist — em.filmx.my serves playlists as
// text/plain from .txt//m3/ paths, so neither extension nor content-type reveals it.
// a:'ka'|'en'|'ru' pins the audio language: the rewriter keeps ONLY that rendition
// in a multi-audio master (players ignore behaviorHints.audioLang and would
// otherwise always play the master's DEFAULT track).
function encodeProxy(targetUrl, referer, isHls, audio) {
  return Buffer.from(JSON.stringify({ u: targetUrl, r: referer || '', ...(isHls ? { h: 1 } : {}), ...(audio ? { a: audio } : {}) }), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeProxy(token) {
  const b64 = String(token || '').replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

// Rewrite a CDN url → this addon's /proxy. Uses the request-scoped base url
// (AsyncLocalStorage survives awaits, so handlers/builders just call this). With
// no base known, returns the url untouched (native app + proxyHeaders path).
function proxify(url, referer, isHls, audio) {
  if (!url) return url;
  const store = als.getStore();
  const base = store && store.baseUrl;
  if (!base) return url;
  return `${base}/proxy?d=${encodeProxy(url, referer, isHls, audio)}`;
}

// Hosts the Cloudflare Worker cannot fetch reliably — these must ride the self
// proxy (Render), whose IP they serve consistently:
//  - em.filmx.my (HLS playlists): hard 403 to every Worker request.
//  - *.videodb.online (HLS segments + subs, e.g. cdn1-/str1-): Cloudflare-proxied
//    zones that erratically 403 Worker fetches per-URL (~20% of segments, stable
//    per URL, unaffected by ref/cache-busters) — enough to kill any playback.
// videodb.cloud (MP4 titles) is NOT Cloudflare-proxied and stays on the Worker.
function workerBlocked(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'em.filmx.my' || /(^|[.-])videodb\.online$/.test(h);
  } catch { return false; }
}

// Route a stream through the Cloudflare Worker relay (matches the Worker's
// /stream-proxy?src=&ref=&t=hls contract) so its bytes don't count against this
// host's bandwidth. Only for sources confirmed NOT IP-locked (ge.movie, UAFlix).
// Falls back to the self proxy when no Worker is configured or the host 403s
// Worker IPs (em.filmx.my — playlists only; segments still ride the Worker).
function workerProxify(url, referer, isHls, audio) {
  if (!url) return url;
  if (!WORKER_PROXY || workerBlocked(url)) return proxify(url, referer, isHls, audio);
  return `${WORKER_PROXY}/stream-proxy?src=${encodeURIComponent(url)}` +
    `&ref=${encodeURIComponent(referer || '')}${isHls ? '&t=hls' : ''}`;
}

const HLS_RE = /\.m3u8(\?|$)/i;

// Rewrite an HLS playlist so every variant/segment/key/map URI is itself proxied
// (carrying the same Referer). Relative URIs are resolved against the playlist's
// own URL first. Sub-playlists stay on the self proxy (tiny text, and em.filmx.my
// 403s the Worker) and get rewritten recursively; segments/keys go to the Worker
// when one is configured and the host allows it — that's where the real bytes are.
function rewritePlaylist(text, playlistUrl, referer, base, audio) {
  // A master playlist's bare-line URIs are variant playlists; a media playlist's
  // are segments. EXT-X-MEDIA/I-FRAME URIs are playlists; EXT-X-KEY/MAP are data.
  const isMaster = /#EXT-X-STREAM-INF/.test(text);
  const route = (u, asPlaylist) => {
    const abs = new URL(u, playlistUrl).toString();
    if (asPlaylist || !WORKER_PROXY || workerBlocked(abs))
      return `${base}/proxy?d=${encodeProxy(abs, referer, asPlaylist)}`;
    return `${WORKER_PROXY}/stream-proxy?src=${encodeURIComponent(abs)}&ref=${encodeURIComponent(referer || '')}`;
  };
  // Audio pinning: keep only the requested language's TYPE=AUDIO rendition and
  // force it DEFAULT — players play the master's DEFAULT track regardless of
  // which language row was clicked. Skipped unless the master actually carries
  // a matching rendition (never return a playlist with zero audio).
  const isAudioLine = t => /^#EXT-X-MEDIA/.test(t) && /TYPE=AUDIO/i.test(t);
  const lineLang = t => langInfo(((t.match(/NAME="([^"]*)"/) || [])[1] || '') + ' ' + ((t.match(/LANGUAGE="([^"]*)"/) || [])[1] || '')).code;
  const pinAudio = audio && isMaster &&
    text.split(/\r?\n/).some(l => isAudioLine(l.trim()) && lineLang(l.trim()) === audio);
  return text.split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      if (pinAudio && isAudioLine(t)) {
        if (lineLang(t) !== audio) return null;
        line = line.replace(/DEFAULT=(YES|NO)/i, 'DEFAULT=YES').replace(/AUTOSELECT=(YES|NO)/i, 'AUTOSELECT=YES');
      }
      const uriIsPlaylist = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF)/.test(t);
      return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${route(u, uriIsPlaylist)}"`);
    }
    return route(t, isMaster);
  }).filter(l => l !== null).join('\n');
}

// The /proxy request handler: fetch the target with the right Referer (+ forward
// Range for seeking), then either rewrite-and-return the HLS playlist or pipe the
// bytes straight through. No fetch timeout here — media bodies stream for minutes.
async function handleProxy(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  let target, referer, isHls, audio;
  try { ({ u: target, r: referer, h: isHls, a: audio } = decodeProxy(req.query.d)); }
  catch { res.status(400).end('bad proxy token'); return; }
  if (!/^https?:\/\//.test(target || '')) { res.status(400).end('bad url'); return; }

  const headers = { 'User-Agent': UA, Accept: '*/*' };
  if (referer) headers.Referer = referer;
  if (req.headers.range) headers.Range = req.headers.range;

  let up;
  try { up = await fetch(target, { headers, redirect: 'follow' }); }
  catch { res.status(502).end('upstream fetch failed'); return; }

  const ct = up.headers.get('content-type') || '';
  if (isHls || HLS_RE.test(String(target).split('?')[0]) || /mpegurl/i.test(ct)) {
    const body = await up.text();
    res.status(up.status);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.end(rewritePlaylist(body, target, referer, reqBaseUrl(req), audio));
    return;
  }

  res.status(up.status);
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const v = up.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!up.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
  up.body.on('error', () => { try { res.end(); } catch { /* client gone */ } });
  up.body.pipe(res);
}

// ─────────────────────────────────────────
//  DATA ACCESS
// ─────────────────────────────────────────
async function fetchDetail(slug) {
  const j = await api(`/api/v1/movies/${encodeURIComponent(slug)}`, 9000);
  return j && j.movie ? j.movie : null;
}

// Public Cinemeta lookup for an IMDb id → { name, tmdb }. Cinemeta exposes the
// TMDB id as `moviedb_id`, which is exactly the key ge.movie/em.filmx.my needs —
// so we can reach Georgian streams WITHOUT depending on an Adjaranet match.
async function cineMeta(imdbId, type) {
  try {
    const r = await getJson(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, 7000);
    const m = r && r.meta;
    if (!m) return null;
    const year = m.year ? String(m.year).match(/\d{4}/)?.[0] : (m.releaseInfo ? String(m.releaseInfo).match(/\d{4}/)?.[0] : null);
    return { name: m.name || null, tmdb: m.moviedb_id || null, year: year || null };
  } catch { return null; }
}

// Find an Adjaranet slug by title (TMDB backstop when Cinemeta lacks a tmdb id).
async function slugFromName(name, type) {
  if (!name) return null;
  try {
    const j = await api(`/api/v1/search?q=${encodeURIComponent(name)}`, 9000);
    const hits = (j && j.data) || [];
    const wantType = type === 'series' ? 'series' : 'movie';
    const match = hits.find(h => h.type === wantType && (h.title_en || '').toLowerCase() === name.toLowerCase())
      || hits.find(h => h.type === wantType);
    return match ? match.slug : null;
  } catch { return null; }
}

// Resolve a Stremio id (adj_<slug> or tt…) to a TMDB id — the key ge.movie needs.
// tt → Cinemeta's moviedb_id (fast, no Adjaranet needed); if Cinemeta has no tmdb,
// fall back to matching the title on Adjaranet and reading its tmdb_id.
async function tmdbForId(rawId, type) {
  if (rawId.startsWith('adj_')) {
    const m = await fetchDetail(rawId.slice('adj_'.length));
    return m && m.tmdb_id ? m.tmdb_id : null;
  }
  if (rawId.startsWith('tt')) {
    const cm = await cineMeta(rawId, type);
    if (cm && cm.tmdb) return cm.tmdb;
    const slug = await slugFromName(cm && cm.name, type);
    const m = slug ? await fetchDetail(slug) : null;
    return m && m.tmdb_id ? m.tmdb_id : null;
  }
  return null;
}

// Resolve a Stremio id → { name, year, tmdb } in ONE pass. name+year drive the
// title-search sources (HDRezka ru, UAFlix uk); tmdb drives ge.movie (ka). For tt
// ids the title/year come from public Cinemeta; for adj_ ids from the Adjaranet
// detail. Done once per request so the three sources resolve in parallel.
async function metaForId(rawId, type) {
  if (rawId.startsWith('adj_')) {
    const m = await fetchDetail(rawId.slice('adj_'.length));
    return {
      name: (m && (m.title_en || m.title_ka || m.title)) || null,
      year: (m && m.year) ? String(m.year) : null,
      tmdb: (m && m.tmdb_id) || null,
    };
  }
  if (rawId.startsWith('tt')) {
    const cm = await cineMeta(rawId, type);
    let tmdb = cm && cm.tmdb;
    if (!tmdb) {
      const slug = await slugFromName(cm && cm.name, type);
      const m = slug ? await fetchDetail(slug) : null;
      tmdb = (m && m.tmdb_id) || null;
    }
    return { name: (cm && cm.name) || null, year: (cm && cm.year) || null, tmdb };
  }
  return { name: null, year: null, tmdb: null };
}

// ─────────────────────────────────────────
//  GE.MOVIE / em.filmx.my — real Georgian-AUDIO streams, keyed by TMDB id.
//  ge.movie delegates playback to em.filmx.my/file/play?type=&id={tmdb}&lang=ka,
//  which returns either direct per-language MP4s (we pick the Georgian track) or
//  an HLS master that carries a Georgian audio track (+ subtitles). em.filmx.my
//  and its CDNs resolve on normal DNS (only ge.movie's own domain is ISP-blocked),
//  so we hit em.filmx.my directly with the tmdb_id from the Adjaranet detail.
// ─────────────────────────────────────────
const FILMX = 'https://em.filmx.my';
const FILMX_REF = 'https://em.filmx.my/';
const KA_TOKENS = ['ქართულ', 'georgian']; // Georgian-audio label tokens

function isKa(label) {
  const l = (label || '').toLowerCase();
  return KA_TOKENS.some(k => l.includes(k));
}

// Map a raw audio label (e.g. "ქართულად", "ინგლისურად", "Russian") → {code,name}.
function langInfo(label) {
  const l = (label || '').toLowerCase();
  if (/ქართ|georgian|^geo|^ka\b/.test(l)) return { code: 'ka', name: '🇬🇪 ქართული' };
  if (/ინგლ|english|^eng|^en\b/.test(l)) return { code: 'en', name: '🇬🇧 English' };
  if (/რუს|russian|^rus|^ru\b/.test(l)) return { code: 'ru', name: '🇷🇺 Русский' };
  return { code: 'other', name: label || 'Audio' };
}

async function gemPlaylist(type, tmdbId, timeout = 12000) {
  const kind = type === 'series' ? 'serial' : 'movie';
  const url = `${FILMX}/file/play?type=${kind}&id=${encodeURIComponent(tmdbId)}&name=x&lang=ka&p=l.playlist`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: `${FILMX}/play/?type=${kind}&id=${tmdbId}&lang=ka` },
    timeout
  });
  if (!res.ok) throw new Error('filmx ' + res.status);
  return res.json();
}

// Parse Playerjs multi-quality / multi-audio "file" string, e.g.
//   [HD]{ქართულად}urlA;{ინგლისურად}urlB;,[SD]{ქართულად}urlC;
// Returns EVERY {quality,label,url} entry (all languages, all qualities).
function parseMultiFile(file) {
  const out = [];
  for (const block of file.split(',')) {
    const b = block.trim();
    if (!b) continue;
    const qm = b.match(/^\[([^\]]+)\]/);
    const quality = qm ? qm[1] : '';
    const body = qm ? b.slice(qm[0].length) : b;
    const langs = [...body.matchAll(/\{([^}]*)\}([^;]+);?/g)];
    if (langs.length) {
      for (const m of langs) out.push({ quality, label: m[1], url: m[2].trim() });
    } else if (/^https?:/.test(body)) {
      out.push({ quality, label: '', url: body.trim() });
    }
  }
  return out;
}

function parseSubs(item) {
  const subs = [];
  if (Array.isArray(item.subtitles)) {
    for (const s of item.subtitles) if (s && s.file) subs.push({ url: s.file, lang: s.label || 'sub' });
  }
  return subs;
}

// One playlist item (movie or episode) → resolved Georgian streams.
function gemStreamsFromItem(item) {
  const out = [];
  const subtitles = parseSubs(item);
  const file = item.file || '';
  if (/^\s*\[/.test(file) || /\{[^}]+\}https?:/.test(file)) {
    for (const v of parseMultiFile(file)) {
      const li = langInfo(v.label);
      out.push({ kind: 'mp4', quality: v.quality, url: v.url, lang: li.code, langName: li.name, referer: FILMX_REF, subtitles });
    }
  } else if (/\.(m3u8|txt)(\?|$)/.test(file) || file.includes('/hls/')) {
    out.push({ kind: 'hls', quality: '', url: file, referer: FILMX_REF, subtitles });
  }
  return out;
}

// Which audio languages (ka/en/ru) does this em.filmx.my HLS master carry? An
// em.filmx.my master usually ships several EXT-X-MEDIA TYPE=AUDIO renditions (e.g.
// Georgian + English + Russian), all browser-playable AAC. We surface the SAME
// stream under each language tab and let the player select the matching audio
// track — so every available language plays with correct sound from one source.
// The master is Referer-gated, so we send the em.filmx.my Referer.
async function hlsAudioLangs(masterUrl) {
  try {
    const res = await fetch(masterUrl, { headers: { 'User-Agent': UA, Accept: '*/*', Referer: FILMX_REF }, timeout: 9000 });
    if (!res.ok) return [];
    const txt = await res.text();
    const langs = new Set();
    for (const line of txt.split(/\r?\n/)) {
      if (!/#EXT-X-MEDIA/i.test(line) || !/TYPE=AUDIO/i.test(line)) continue;
      const name = (line.match(/NAME="([^"]*)"/) || [])[1] || '';
      const lang = (line.match(/LANGUAGE="([^"]*)"/) || [])[1] || '';
      const info = langInfo(name + ' ' + lang);
      if (info.code !== 'other') langs.add(info.code);
    }
    return [...langs];
  } catch { return []; }
}

// This is the GEORGIAN-dub source: keep ONLY Georgian audio. English/Russian come
// from torrent sources (Torrentio), selected via the modal's language tabs — this
// addon must not surface them. MP4 entries are single-audio (kept only when tagged
// Georgian); an HLS master is kept only if it carries a Georgian audio rendition,
// and we record which langs it has so the player can select the Georgian track
// (em.filmx.my masters usually DEFAULT to Russian).
async function gemKeepGeorgian(resolved) {
  const out = [];
  for (const r of resolved) {
    if (r.kind === 'mp4') {
      if (r.lang === 'ka') out.push(r);
    } else if (r.kind === 'hls') {
      const langs = await hlsAudioLangs(r.url);
      if (langs.includes('ka')) out.push({ ...r, audioLangs: langs });
    }
  }
  return out;
}

// Resolve the raw (all-language) stream list for a movie or a specific episode
// from the em.filmx.my playlist. Shared by the Georgian (ka) and English (en)
// keepers below.
async function gemResolveItem(type, tmdbId, season, episode) {
  const data = await gemPlaylist(type, tmdbId);
  if (type === 'series') {
    for (const s of (Array.isArray(data) ? data : [])) {
      for (const e of (s.folder || [])) {
        if (e.id === `${season}-${episode}`) return gemStreamsFromItem(e);
      }
    }
    return [];
  }
  const item = Array.isArray(data) ? data[0] : data;
  return item ? gemStreamsFromItem(item) : [];
}

async function gemMovie(tmdbId) {
  try { return gemKeepGeorgian(await gemResolveItem('movie', tmdbId)); } catch { return []; }
}

async function gemEpisode(tmdbId, season, episode) {
  try { return gemKeepGeorgian(await gemResolveItem('series', tmdbId, season, episode)); } catch { return []; }
}

// English from em.filmx.my: keep ONLY English-audio entries — an MP4 labelled
// English ({ინგლისურად}/English), or an HLS master that carries an English
// EXT-X-MEDIA audio rendition (recorded so the player selects it).
async function gemEnglish(tmdbId, type, season, episode) {
  return gemKeepLang(tmdbId, type, season, episode, 'en');
}

// Russian from em.filmx.my (same multi-audio source as Georgian/English). Russian
// comes ONLY from ge.movie now — if a title has no Russian track here, Russian is
// simply omitted (no other Russian source).
async function gemRussian(tmdbId, type, season, episode) {
  return gemKeepLang(tmdbId, type, season, episode, 'ru');
}

// Resolve the em.filmx.my item and keep only entries carrying the requested audio
// language (mp4 tagged that language, or an HLS master with that EXT-X-MEDIA rendition).
async function gemKeepLang(tmdbId, type, season, episode, code) {
  try {
    const resolved = await gemResolveItem(type, tmdbId, season, episode);
    const out = [];
    for (const r of resolved) {
      if (r.kind === 'mp4') {
        if (r.lang === code) out.push(r);
      } else if (r.kind === 'hls') {
        const langs = await hlsAudioLangs(r.url);
        if (langs.includes(code)) out.push({ ...r, audioLangs: langs });
      }
    }
    return out;
  } catch { return []; }
}

// Rough quality score so we can keep just the best MP4 variant.
function qualityScore(q) {
  const s = String(q || '').toLowerCase();
  const n = parseInt(s); if (n) return n;
  if (s.includes('4k') || s.includes('2160')) return 2160;
  if (s.includes('fhd') || s.includes('1080')) return 1080;
  if (s === 'hd' || s.includes('720')) return 720;
  if (s === 'sd' || s.includes('480')) return 480;
  return 0;
}

// Wrap resolved Georgian streams as Stremio stream objects, tagged lang:'ka'. Each
// also carries behaviorHints.audioLang:'ka' so the player selects the Georgian
// audio rendition of a multi-audio em.filmx.my HLS master (which DEFAULTs to
// Russian otherwise). MP4 quality (HD/SD) is collapsed to the best one.
function gemToStremio(resolved) {
  const streams = [];
  const subsOf = r => (r.subtitles || []).map((s, i) => ({ id: 'gm' + i, url: workerProxify(s.url, r.referer, false), lang: s.lang }));

  const mp4 = resolved.filter(r => r.kind === 'mp4' && r.lang === 'ka').sort((a, b) => qualityScore(b.quality) - qualityScore(a.quality));
  if (mp4.length) {
    const r = mp4[0];
    streams.push({
      url: workerProxify(r.url, r.referer, false),
      subtitles: subsOf(r),
      behaviorHints: { notWebReady: false, proxyHeaders: { request: { Referer: r.referer, 'User-Agent': UA } }, streamType: 'mp4', lang: 'ka', audioLang: 'ka' },
    });
  }
  for (const r of resolved.filter(r => r.kind === 'hls')) {
    streams.push({
      url: workerProxify(r.url, r.referer, true, 'ka'),
      subtitles: subsOf(r),
      behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: r.referer, 'User-Agent': UA } }, streamType: 'hls', lang: 'ka', audioLang: 'ka' },
    });
  }
  return streams;
}

// Wrap em.filmx.my English-audio streams as 🇬🇧 rows (lang/audioLang 'en'). MP4 is
// collapsed to the best quality; an HLS master carries audioLang:'en' so the
// player selects the English rendition of a multi-audio master.
function gemEnglishToStremio(resolved) {
  const streams = [];
  const subsOf = r => (r.subtitles || []).map((s, i) => ({ id: 'gm' + i, url: workerProxify(s.url, r.referer, false), lang: s.lang }));

  const mp4 = resolved.filter(r => r.kind === 'mp4' && r.lang === 'en').sort((a, b) => qualityScore(b.quality) - qualityScore(a.quality));
  if (mp4.length) {
    const r = mp4[0];
    streams.push({
      url: workerProxify(r.url, r.referer, false),
      subtitles: subsOf(r),
      behaviorHints: { notWebReady: false, proxyHeaders: { request: { Referer: r.referer, 'User-Agent': UA } }, streamType: 'mp4', lang: 'en', audioLang: 'en' },
    });
  }
  for (const r of resolved.filter(r => r.kind === 'hls')) {
    streams.push({
      url: workerProxify(r.url, r.referer, true, 'en'),
      subtitles: subsOf(r),
      behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: r.referer, 'User-Agent': UA } }, streamType: 'hls', lang: 'en', audioLang: 'en' },
    });
  }
  return streams;
}

// Wrap em.filmx.my Russian-audio streams as 🇷🇺 rows (lang/audioLang 'ru'). MP4 is
// collapsed to the best quality; an HLS master carries audioLang:'ru' so the
// player selects the Russian rendition of a multi-audio master.
function gemRussianToStremio(resolved) {
  const streams = [];
  const subsOf = r => (r.subtitles || []).map((s, i) => ({ id: 'gm' + i, url: workerProxify(s.url, r.referer, false), lang: s.lang }));

  const mp4 = resolved.filter(r => r.kind === 'mp4' && r.lang === 'ru').sort((a, b) => qualityScore(b.quality) - qualityScore(a.quality));
  if (mp4.length) {
    const r = mp4[0];
    streams.push({
      url: workerProxify(r.url, r.referer, false),
      subtitles: subsOf(r),
      behaviorHints: { notWebReady: false, proxyHeaders: { request: { Referer: r.referer, 'User-Agent': UA } }, streamType: 'mp4', lang: 'ru', audioLang: 'ru' },
    });
  }
  for (const r of resolved.filter(r => r.kind === 'hls')) {
    streams.push({
      url: workerProxify(r.url, r.referer, true, 'ru'),
      subtitles: subsOf(r),
      behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: r.referer, 'User-Agent': UA } }, streamType: 'hls', lang: 'ru', audioLang: 'ru' },
    });
  }
  return streams;
}

// ─────────────────────────────────────────
//  UAFLIX (uafix.net) — Ukrainian-AUDIO streams via the zetvideo.net player (open
//  HLS, no token). Flow: DLE search → film/series page → zetvideo iframe → the
//  embed exposes file:"…/hls/index.m3u8" directly. Tagged lang:'uk'.
// ─────────────────────────────────────────
const UAFIX = 'https://uafix.net';
const UAFIX_REF = 'https://uafix.net/';
const ZET_REF = 'https://zetvideo.net/';

// DLE search returns result cards NEWEST-first (so a sequel can precede the
// original), and each card carries the title as "Ukr / English". We therefore
// match on the English title (+ year tiebreak), not document order.
const uaNorm = s => (s || '').toLowerCase().replace(/[^a-z0-9а-яіїєґ ]+/gi, ' ').replace(/\s+/g, ' ').trim();
async function uafixSearch(name, year, wantSeries) {
  if (!name) return null;
  try {
    const res = await fetch(`${UAFIX}/index.php?do=search&subaction=search&story=${encodeURIComponent(name)}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html', Referer: UAFIX_REF }, timeout: 12000,
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Scope to the results region; parse each card's url + title (from the img alt).
    const region = html.slice(Math.max(0, html.indexOf('searchtable')));
    const cards = [...region.matchAll(/<a class="sres-wrap[^"]*" href="(https:\/\/uafix\.net\/[^"]+)">[\s\S]*?alt="([^"]*)"/gi)]
      .map(m => ({ url: m[1], title: m[2] }))
      .filter(c => /\/(films|serial|series|cartoon|anime)\//i.test(c.url));
    if (!cards.length) return null;
    const isSeriesUrl = u => /\/(serial|series|anime)\//i.test(u);
    const pool = cards.filter(c => wantSeries ? isSeriesUrl(c.url) : !isSeriesUrl(c.url));
    const list = pool.length ? pool : cards;
    const want = uaNorm(name);
    // English part after "Ukr / English"; exact-match it to the query, then year.
    const engOf = t => uaNorm(t.includes('/') ? t.split('/').pop() : t);
    const exact = list.filter(c => engOf(c.title) === want);
    if (exact.length) return (year && exact.find(c => c.title.includes(String(year))) || exact[0]).url;
    const starts = list.filter(c => engOf(c.title).startsWith(want) || want.startsWith(engOf(c.title)));
    if (starts.length) return (year && starts.find(c => c.title.includes(String(year))) || starts[0]).url;
    // No confident title match → return nothing rather than a wrong title (e.g. a
    // sequel or a spin-off film). uk simply shows "not dubbed yet" for this title.
    return null;
  } catch { return null; }
}

// Film/series page → the zetvideo embed URL.
async function uafixEmbed(pageUrl) {
  try {
    const res = await fetch(pageUrl, { headers: { 'User-Agent': UA, Accept: 'text/html', Referer: UAFIX_REF }, timeout: 14000 });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<iframe[^>]*src="(https?:\/\/[^"]*zetvideo\.net\/[^"]+)"/i);
    return m ? m[1] : null;
  } catch { return null; }
}

// zetvideo embed → direct HLS file. For series the embed ships a seasons/episodes
// playlist; pick the requested episode (best-effort), else fall back to a single file.
async function zetFile(embedUrl, type, season, episode) {
  try {
    const res = await fetch(embedUrl, { headers: { 'User-Agent': UA, Accept: 'text/html', Referer: UAFIX_REF }, timeout: 12000 });
    if (!res.ok) return null;
    const html = await res.text();
    const direct = html.match(/file:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/i);
    if (type !== 'series') return direct ? direct[1] : null;
    const pl = html.match(/file:\s*(\[[\s\S]*?\])\s*[,}]/);
    if (pl) {
      try {
        const arr = JSON.parse(pl[1].replace(/'/g, '"'));
        for (const s of arr) {
          const sn = parseInt(String(s.title || '').match(/\d+/) || ['0'], 10);
          for (const e of (s.folder || s.episodes || [])) {
            const en = parseInt(String(e.title || '').match(/\d+/) || ['0'], 10);
            if ((sn === season || arr.length === 1) && en === episode && e.file) return e.file;
          }
        }
      } catch { /* not JSON → fall back to direct */ }
    }
    return direct ? direct[1] : null;
  } catch { return null; }
}

async function uafixResolve(name, year, type, season, episode) {
  try {
    const page = await uafixSearch(name, year, type === 'series');
    if (!page) return [];
    const embed = await uafixEmbed(page);
    if (!embed) return [];
    const file = await zetFile(embed, type, season, episode);
    return file ? [{ url: file }] : [];
  } catch { return []; }
}

function uafixToStremio(streams) {
  if (!streams.length) return [];
  return [{
    url: workerProxify(streams[0].url, ZET_REF, true),
    behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: ZET_REF, 'User-Agent': UA } }, streamType: 'hls', lang: 'uk', audioLang: 'uk' },
  }];
}

// English fallback from UAFlix — best-effort. The zetvideo player is a Ukrainian
// dub, so we ONLY surface it as English when its HLS master actually ships an
// English EXT-X-MEDIA audio rendition (never mislabel the Ukrainian track as en).
async function uafixEnglish(name, year, type, season, episode) {
  try {
    const page = await uafixSearch(name, year, type === 'series');
    if (!page) return [];
    const embed = await uafixEmbed(page);
    if (!embed) return [];
    const file = await zetFile(embed, type, season, episode);
    if (!file) return [];
    const res = await fetch(file, { headers: { 'User-Agent': UA, Referer: ZET_REF }, timeout: 10000 });
    if (!res.ok) return [];
    const txt = await res.text();
    const hasEn = txt.split(/\r?\n/).some(l =>
      /#EXT-X-MEDIA/i.test(l) && /TYPE=AUDIO/i.test(l) &&
      (/LANGUAGE="(en|eng)"/i.test(l) || /NAME="[^"]*\b(eng|english)\b/i.test(l)));
    if (!hasEn) return [];
    return [{
      url: workerProxify(file, ZET_REF, true),
      behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: ZET_REF, 'User-Agent': UA } }, streamType: 'hls', lang: 'en', audioLang: 'en' },
    }];
  } catch { return []; }
}

// ─────────────────────────────────────────
//  KKPHIM (phimapi.com) — LAST-RESORT English source. Vietnamese catalog, but its
//  "Vietsub" server is the ORIGINAL audio (English for Hollywood titles) — sometimes
//  with burned-in Vietnamese subtitles, so it's only used when no cleaner English
//  exists (ge.movie/UAFlix/HDRezka all lacked it). Public JSON API: search → detail
//  → direct .m3u8. The CDN is un-gated (no Referer, open CORS, NOT IP-locked), so it
//  rides the Worker like ge.movie/UAFlix. Matched STRICTLY by TMDB id to avoid wrong
//  titles (search payload carries tmdb.id, so one request resolves the slug).
// ─────────────────────────────────────────
const KKPHIM_API = 'https://phimapi.com';

// "Vietsub" = original audio; skip "Thuyết Minh"/"Lồng Tiếng" (Vietnamese voiceover).
function kkIsOriginalServer(name) {
  const n = (name || '').toLowerCase();
  if (/thuy[eế]t minh|l[oồ]ng ti[eế]ng/.test(n)) return false;
  return /vietsub|english|eng|sub|original/.test(n);
}

// phimapi search is finicky with multi-word English titles, so try progressively
// broader keywords (full cleaned title → first two words → first word).
function kkKeywords(name) {
  const clean = (name || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const words = clean.split(' ');
  const out = [clean];
  if (words.length > 2) out.push(words.slice(0, 2).join(' '));
  if (words.length > 1) out.push(words[0]);
  return [...new Set(out)];
}

const kkNorm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Find the kkphim detail doc for this title.
//   Movies — Tier 1: exact TMDB id (search payload carries tmdb.id); Tier 2 (older
//     entries whose tmdb is null): exact English title + year.
//   Series — kkphim splits shows per season as origin_name "Title (Season N)" with
//     tmdb null, so we match exact "<title> season <N>" (or the bare title for a
//     single-season show on S1). Episode is then picked from server_data by number.
async function kkFind(name, tmdbId, year, wantSeries, season) {
  if (!name) return null;
  const wantName = kkNorm(name);
  for (const kw of kkKeywords(name)) {
    let items;
    try {
      const j = await getJson(`${KKPHIM_API}/v1/api/tim-kiem?keyword=${encodeURIComponent(kw)}&limit=20`, 9000);
      items = (j && j.data && j.data.items) || [];
    } catch { continue; }

    let hit;
    if (wantSeries) {
      const ser = items.filter(it => it.type !== 'single');
      const wantSeason = kkNorm(`${name} season ${season}`);
      const seasonRe = new RegExp(`season0*${season}(?!\\d)`);
      hit = ser.find(it => kkNorm(it.origin_name) === wantSeason)
        || ser.find(it => kkNorm(it.origin_name).startsWith(wantName) && seasonRe.test(kkNorm(it.origin_name)))
        || (season === 1 && ser.find(it => kkNorm(it.origin_name) === wantName));
    } else {
      hit = (tmdbId && items.find(it => it.tmdb && String(it.tmdb.id) === String(tmdbId)))
        || (year && items.find(it => kkNorm(it.origin_name) === wantName && String(it.year) === String(year)));
    }
    if (hit) {
      const d = await getJson(`${KKPHIM_API}/phim/${encodeURIComponent(hit.slug)}`, 9000).catch(() => null);
      if (d && d.movie) return d;
    }
  }
  return null;
}

// Resolve the kkphim original-audio (English) m3u8 for a movie or episode.
async function kkphimEnglish(name, tmdbId, year, type, season, episode) {
  try {
    const d = await kkFind(name, tmdbId, year, type === 'series', season);
    if (!d) return [];
    const servers = d.episodes || [];
    const orig = servers.find(s => kkIsOriginalServer(s.server_name)) || servers[0];
    if (!orig || !Array.isArray(orig.server_data) || !orig.server_data.length) return [];

    let entry;
    if (type === 'series') {
      entry = orig.server_data.find(e => {
        const num = parseInt((String(e.name || e.slug || '').match(/\d+/) || ['0'])[0], 10);
        return num === episode;
      }) || (orig.server_data.length === 1 ? orig.server_data[0] : null);
    } else {
      entry = orig.server_data[0];
    }
    const m3u8 = entry && entry.link_m3u8;
    if (!m3u8 || !/^https?:/.test(m3u8)) return [];

    return [{
      url: workerProxify(m3u8, '', true),   // un-gated CDN → no Referer; rides the Worker
      behaviorHints: { notWebReady: true, proxyHeaders: { request: { 'User-Agent': UA } }, streamType: 'hls', lang: 'en', audioLang: 'en' },
    }];
  } catch { return []; }
}

// ─────────────────────────────────────────
//  META HANDLER
// ─────────────────────────────────────────
builder.defineMetaHandler(async ({ type, id }) => {
  if (!id.startsWith('adj_')) return { meta: null };
  const slug = id.slice('adj_'.length);
  const base = await getBase();

  try {
    const m = await fetchDetail(slug);
    if (!m) return { meta: null };

    const meta = {
      id,
      type: m.type === 'series' ? 'series' : 'movie',
      name: m.title_en || m.title_ka || m.title || 'Unknown',
      poster: absUrl(base, m.poster),
      background: absUrl(base, m.cover || m.poster),
      description: m.full_description || m.description || '',
      releaseInfo: m.year ? String(m.year) : undefined,
      imdbRating: m.imdb_rating ? String(m.imdb_rating) : undefined,
      genres: Array.isArray(m.genres) ? m.genres.map(g => g.name) : [],
      runtime: m.duration ? `${m.duration} min` : undefined
    };

    if (meta.type === 'series' && Array.isArray(m.seasons)) {
      meta.videos = [];
      for (const season of m.seasons) {
        const sNum = season.season_number || 1;
        for (const ep of (season.episodes || [])) {
          const eNum = ep.episode_number || 1;
          meta.videos.push({
            id: `${id}:${sNum}:${eNum}`,
            title: ep.title || `Episode ${eNum}`,
            season: sNum,
            episode: eNum,
            released: ep.created_at || undefined,
            thumbnail: meta.poster
          });
        }
      }
    }

    return { meta };
  } catch (e) {
    console.error('meta error:', e.message);
    return { meta: null };
  }
});

// English (en) cascade. Primary is ge.movie's English track; when ge.movie has no
// English audio, fall back to kkphim (original audio, may carry burned-in VN subs).
// Both stream through the Cloudflare Worker, so English never touches the origin.
async function resolveEnglishCascade(meta, type, season, episode) {
  const { name, year, tmdb } = meta;

  if (tmdb) {
    const en = gemEnglishToStremio(await gemEnglish(tmdb, type, season, episode).catch(() => []));
    if (en.length) return en;
  }
  if (name && (tmdb || year)) {
    const kk = await kkphimEnglish(name, tmdb, year, type, season, episode).catch(() => []);
    if (kk.length) return kk;
  }
  return [];
}

// ─────────────────────────────────────────
//  STREAM HANDLER
// ─────────────────────────────────────────
builder.defineStreamHandler(async ({ type, id }) => {
  try {
    if (type !== 'movie' && type !== 'series') return { streams: [] };

    // One id → title/year/tmdb, then resolve the language sources in parallel:
    //   ka → ge.movie · ru → ge.movie ONLY (omitted if absent) · uk → UAFlix ·
    //   en → ge.movie English, else kkphim. Every source streams through the
    //   Cloudflare Worker, so nothing here touches the origin's bandwidth.
    const baseId = type === 'series' ? id.split(':')[0] : id;
    const season = type === 'series' ? parseInt(id.split(':')[1] || '1', 10) : 1;
    const episode = type === 'series' ? parseInt(id.split(':')[2] || '1', 10) : 1;

    const meta = await metaForId(baseId, type);
    const { name, year, tmdb } = meta;

    const [ka, ru, uk, en] = await Promise.all([
      tmdb ? (type === 'series' ? gemEpisode(tmdb, season, episode) : gemMovie(tmdb)) : Promise.resolve([]),
      tmdb ? gemRussian(tmdb, type, season, episode) : Promise.resolve([]),
      name ? uafixResolve(name, year, type, season, episode) : Promise.resolve([]),
      resolveEnglishCascade({ name, year, tmdb }, type, season, episode),
    ]);

    return {
      streams: [
        ...en,                       // 🇬🇧 English (ge.movie → kkphim)
        ...gemToStremio(ka),         // 🇬🇪 Georgian (ge.movie)
        ...gemRussianToStremio(ru),  // 🇷🇺 Russian (ge.movie only)
        ...uafixToStremio(uk),       // 🇺🇦 Ukrainian (UAFlix)
      ],
    };
  } catch (e) {
    console.error('stream error:', e.message);
    return { streams: [] };
  }
});

// ─────────────────────────────────────────
//  START SERVER
//  Custom Express server (instead of the SDK's serveHTTP) so we can mount the
//  /proxy route alongside the addon protocol routes, and capture each request's
//  public origin (AsyncLocalStorage) for building absolute proxy URLs.
// ─────────────────────────────────────────
const PORT = process.env.PORT || 7000;
const app = express();

// Run every request inside an ALS store carrying this request's public origin, so
// proxify() (called deep inside the stream handler) can build absolute /proxy URLs.
app.use((req, res, next) => als.run({ baseUrl: reqBaseUrl(req) }, next));

// Stream proxy (CORS-open, Range-aware, HLS-rewriting).
app.options('/proxy', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.end();
});
app.get('/proxy', handleProxy);

// Addon protocol routes (manifest, catalog, meta, stream) — CORS handled by the SDK router.
app.use(getRouter(builder.getInterface()));

// Minimal landing page with the install URL (the SDK's serveHTTP normally serves this).
app.get('/', (req, res) => {
  const base = reqBaseUrl(req);
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset="utf-8"><title>${manifest.name}</title>` +
    `<body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px;line-height:1.6">` +
    `<h1>${manifest.name}</h1><p>${manifest.description}</p>` +
    `<p><b>Install URL:</b> <code>${base}/manifest.json</code></p></body>`);
});

app.listen(PORT, () => {
  console.log(`🇬🇪 Georgian Stremio Addon v${manifest.version} running on http://localhost:${PORT}`);
  console.log(`📦 Install URL: http://localhost:${PORT}/manifest.json`);
  console.log(`🌐 PUBLIC_URL: ${PUBLIC_URL || '(unset — using request Host for /proxy links)'}`);
  console.log(`☁️  WORKER_PROXY: ${WORKER_PROXY || '(unset — ge.movie/UAFlix use this origin)'}`);
  console.log(`🔗 Sources (priority order): ${SOURCES.join(', ')}`);
});
