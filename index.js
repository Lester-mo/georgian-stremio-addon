const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const { AsyncLocalStorage } = require('async_hooks');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────
//  MANIFEST
// ─────────────────────────────────────────
const manifest = {
  id: 'community.georgian.dubbed',
  version: '2.2.0',
  name: '🇬🇪 Georgian / Russian / Ukrainian Dubbed',
  description: 'Dubbed movies & series — 🇬🇪 Georgian (ge.movie) · 🇷🇺 Russian (HDRezka) · 🇺🇦 Ukrainian (UAFlix)',
  logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0f/Flag_of_Georgia.svg/200px-Flag_of_Georgia.svg.png',
  resources: ['stream', 'catalog', 'meta'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'adj_'],
  catalogs: [
    {
      type: 'movie',
      id: 'georgian_movies',
      name: '🇬🇪 Georgian Dubbed Movies',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'genre', isRequired: false, options: ['Action', 'Comedy', 'Drama', 'Horror', 'Animation', 'Family', 'Thriller', 'Romance', 'Crime', 'Adventure', 'Fantasy', 'Documentary'] },
        { name: 'skip', isRequired: false }
      ]
    },
    {
      type: 'series',
      id: 'georgian_series',
      name: '🇬🇪 Georgian Dubbed Series',
      extra: [
        { name: 'search', isRequired: false },
        { name: 'genre', isRequired: false, options: ['Action', 'Comedy', 'Drama', 'Horror', 'Animation', 'Family', 'Thriller', 'Romance', 'Crime', 'Adventure', 'Fantasy', 'Documentary'] },
        { name: 'skip', isRequired: false }
      ]
    }
  ],
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

const PAGE_SIZE = 24;
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
// Stremio genre (English) → Adjaranet genre slug
const GENRE_MAP = {
  Action: 'boeviki', Comedy: 'komedia', Drama: 'drama', Horror: 'sashineleba',
  Animation: 'animaciuri', Family: 'saojaxo', Thriller: 'trileri', Romance: 'melodrama',
  Crime: 'kriminaluri', Adventure: 'satavgadasavlo', Fantasy: 'fantastika', Documentary: 'dokumenturi'
};

function absUrl(base, path) {
  if (!path) return null;
  return /^https?:\/\//.test(path) ? path : base + path;
}

// Adjaranet catalog/search item → Stremio meta-preview
function itemToMeta(item, base) {
  return {
    id: `adj_${item.slug}`,
    type: item.type === 'series' ? 'series' : 'movie',
    name: item.title_en || item.title_ka || item.title || 'Unknown',
    poster: absUrl(base, item.poster),
    posterShape: 'poster',
    background: absUrl(base, item.cover || item.poster),
    description: item.description || '',
    releaseInfo: item.year ? String(item.year) : undefined,
    imdbRating: item.imdb_rating ? String(item.imdb_rating) : undefined,
    genres: Array.isArray(item.genres) ? item.genres.map(g => g.name) : []
  };
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
function encodeProxy(targetUrl, referer) {
  return Buffer.from(JSON.stringify({ u: targetUrl, r: referer || '' }), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeProxy(token) {
  const b64 = String(token || '').replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

// Rewrite a CDN url → this addon's /proxy. Uses the request-scoped base url
// (AsyncLocalStorage survives awaits, so handlers/builders just call this). With
// no base known, returns the url untouched (native app + proxyHeaders path).
function proxify(url, referer) {
  if (!url) return url;
  const store = als.getStore();
  const base = store && store.baseUrl;
  if (!base) return url;
  return `${base}/proxy?d=${encodeProxy(url, referer)}`;
}

// Route a stream through the Cloudflare Worker relay (matches the Worker's
// /stream-proxy?src=&ref=&t=hls contract) so its bytes don't count against this
// host's bandwidth. Only for sources confirmed NOT IP-locked (ge.movie, UAFlix).
// Falls back to the self proxy when no Worker is configured.
function workerProxify(url, referer, isHls) {
  if (!url) return url;
  if (!WORKER_PROXY) return proxify(url, referer);
  return `${WORKER_PROXY}/stream-proxy?src=${encodeURIComponent(url)}` +
    `&ref=${encodeURIComponent(referer || '')}${isHls ? '&t=hls' : ''}`;
}

const HLS_RE = /\.m3u8(\?|$)/i;

// Rewrite an HLS playlist so every variant/segment/key/map URI is itself proxied
// (carrying the same Referer). Relative URIs are resolved against the playlist's
// own URL first. Sub-playlists fetched through /proxy get rewritten recursively.
function rewritePlaylist(text, playlistUrl, referer, base) {
  return text.split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_m, u) => {
        const abs = new URL(u, playlistUrl).toString();
        return `URI="${base}/proxy?d=${encodeProxy(abs, referer)}"`;
      });
    }
    const abs = new URL(t, playlistUrl).toString();
    return `${base}/proxy?d=${encodeProxy(abs, referer)}`;
  }).join('\n');
}

// The /proxy request handler: fetch the target with the right Referer (+ forward
// Range for seeking), then either rewrite-and-return the HLS playlist or pipe the
// bytes straight through. No fetch timeout here — media bodies stream for minutes.
async function handleProxy(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  let target, referer;
  try { ({ u: target, r: referer } = decodeProxy(req.query.d)); }
  catch { res.status(400).end('bad proxy token'); return; }
  if (!/^https?:\/\//.test(target || '')) { res.status(400).end('bad url'); return; }

  const headers = { 'User-Agent': UA, Accept: '*/*' };
  if (referer) headers.Referer = referer;
  if (req.headers.range) headers.Range = req.headers.range;

  let up;
  try { up = await fetch(target, { headers, redirect: 'follow' }); }
  catch { res.status(502).end('upstream fetch failed'); return; }

  const ct = up.headers.get('content-type') || '';
  if (HLS_RE.test(String(target).split('?')[0]) || /mpegurl/i.test(ct)) {
    const body = await up.text();
    res.status(up.status);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.end(rewritePlaylist(body, target, referer, reqBaseUrl(req)));
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
//  TMDB original-language lookup — used to label HDRezka's "Оригинал" track
//  correctly: it's only English when the title's original language IS English;
//  otherwise it's that original language and must be tagged "Original", not
//  "English". The TMDB credential lives in the sibling STREAMFULL server/.env
//  (TMDB_BEARER preferred, else TMDB_API_KEY); we read it best-effort. With no
//  credential or on any failure we return null → caller treats it as English
//  (safe default for the mostly-Hollywood catalog).
// ─────────────────────────────────────────
function readSiblingEnv() {
  const out = {};
  try {
    const p = path.join(__dirname, '..', 'Movie Website', 'server', '.env');
    if (!fs.existsSync(p)) return out;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      if (/^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* ignore — degrade to English */ }
  return out;
}
const _siblingEnv = readSiblingEnv();
const TMDB_BEARER = (process.env.TMDB_BEARER || _siblingEnv.TMDB_BEARER || '').trim();
const TMDB_KEY = (process.env.TMDB_API_KEY || _siblingEnv.TMDB_API_KEY || '').trim();

// ISO-639-1 → display name (the few we're likely to meet; fall back to the code).
const LANG_NAMES = {
  en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese', fr: 'French',
  es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese', hi: 'Hindi',
  ru: 'Russian', tr: 'Turkish', ka: 'Georgian', uk: 'Ukrainian', pl: 'Polish',
  sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish', nl: 'Dutch',
  th: 'Thai', id: 'Indonesian', ar: 'Arabic', he: 'Hebrew', fa: 'Persian',
};
const langName = code => LANG_NAMES[code] || (code ? code.toUpperCase() : 'Original');

const _origLangCache = new Map();
async function tmdbOriginalLang(tmdbId, type) {
  if (!tmdbId || (!TMDB_BEARER && !TMDB_KEY)) return null;
  const ck = `${type}_${tmdbId}`;
  if (_origLangCache.has(ck)) return _origLangCache.get(ck);
  try {
    const kind = type === 'series' ? 'tv' : 'movie';
    const url = `https://api.themoviedb.org/3/${kind}/${encodeURIComponent(tmdbId)}` +
      (TMDB_BEARER ? '' : `?api_key=${encodeURIComponent(TMDB_KEY)}`);
    const headers = { 'User-Agent': UA, Accept: 'application/json' };
    if (TMDB_BEARER) headers.Authorization = `Bearer ${TMDB_BEARER}`;
    const res = await fetch(url, { headers, timeout: 8000 });
    if (!res.ok) { _origLangCache.set(ck, null); return null; }
    const j = await res.json();
    const lang = j && j.original_language ? String(j.original_language).toLowerCase() : null;
    _origLangCache.set(ck, lang);
    return lang;
  } catch { return null; }
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

// English fallback from em.filmx.my: keep ONLY English-audio entries — an MP4
// labelled English ({ინგლისურად}/English), or an HLS master that carries an
// English EXT-X-MEDIA audio rendition (recorded so the player selects it).
async function gemEnglish(tmdbId, type, season, episode) {
  try {
    const resolved = await gemResolveItem(type, tmdbId, season, episode);
    const out = [];
    for (const r of resolved) {
      if (r.kind === 'mp4') {
        if (r.lang === 'en') out.push(r);
      } else if (r.kind === 'hls') {
        const langs = await hlsAudioLangs(r.url);
        if (langs.includes('en')) out.push({ ...r, audioLangs: langs });
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
      name: '🇬🇪 ge.movie',
      title: `🇬🇪 ქართული აუდიო${r.quality ? ' · ' + r.quality : ''}`,
      url: workerProxify(r.url, r.referer, false),
      subtitles: subsOf(r),
      behaviorHints: { notWebReady: false, proxyHeaders: { request: { Referer: r.referer, 'User-Agent': UA } }, streamType: 'mp4', lang: 'ka', audioLang: 'ka' },
    });
  }
  for (const r of resolved.filter(r => r.kind === 'hls')) {
    streams.push({
      name: '🇬🇪 ge.movie · HLS',
      title: '🇬🇪 ქართული აუდიო',
      url: workerProxify(r.url, r.referer, true),
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
      name: '🇬🇧 ge.movie',
      title: `🇬🇧 English${r.quality ? ' · ' + r.quality : ''}`,
      url: workerProxify(r.url, r.referer, false),
      subtitles: subsOf(r),
      behaviorHints: { notWebReady: false, proxyHeaders: { request: { Referer: r.referer, 'User-Agent': UA } }, streamType: 'mp4', lang: 'en', audioLang: 'en' },
    });
  }
  for (const r of resolved.filter(r => r.kind === 'hls')) {
    streams.push({
      name: '🇬🇧 ge.movie · HLS',
      title: '🇬🇧 English',
      url: workerProxify(r.url, r.referer, true),
      subtitles: subsOf(r),
      behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: r.referer, 'User-Agent': UA } }, streamType: 'hls', lang: 'en', audioLang: 'en' },
    });
  }
  return streams;
}

// ─────────────────────────────────────────
//  HDREZKA — Russian-AUDIO streams (open AJAX, no token, no Cloudflare wall on
//  hdrezka.me). Flow: search by title → film/series page → read the post id +
//  default (active) translator → POST /ajax/get_cdn_series → a quality-tagged
//  stream string. Decoded (it's plaintext now, but kept trash-tolerant) into
//  per-quality direct MP4s on the voidboost CDN. Tagged lang:'ru'.
// ─────────────────────────────────────────
const REZKA = 'https://hdrezka.me';
const REZKA_REF = 'https://hdrezka.me/';

// HDRezka historically base64+junk-encodes the stream string; current builds ship
// it as plaintext ("[360p]http…"). Decode only when it isn't already plaintext.
function rezkaClearTrash(data) {
  if (!data) return '';
  if (data.trim().startsWith('[')) return data;          // already plaintext
  const trashList = ['@', '#', '!', '^', '$'];
  const codes = [];
  for (let len = 2; len <= 4; len++) {
    let combos = [''];
    for (let i = 0; i < len; i++) {
      const next = [];
      for (const c of combos) for (const t of trashList) next.push(c + t);
      combos = next;
    }
    for (const d of combos) codes.push(Buffer.from(d, 'utf-8').toString('base64'));
  }
  let str = data.replace(/#h/g, '').split('//_//').join('');
  for (const code of codes) str = str.split(code).join('');
  try { return Buffer.from(str + '==', 'base64').toString('utf-8'); } catch { return ''; }
}

// "[360p]urlA or urlB,[480p]urlC,…" → [{quality,url}], preferring a clean .mp4
// over the ":hls:manifest.m3u8" wrapper (seekable + browser-native).
function rezkaParseStreams(decoded) {
  const out = [];
  for (const block of (decoded || '').split(',')) {
    const m = block.match(/^\s*\[([^\]]+)\]\s*(.+)$/);
    if (!m) continue;
    // HDRezka wraps premium qualities in HTML (e.g. <span ...>4K<img…></span>) — strip tags.
    const quality = m[1].replace(/<[^>]*>/g, '').trim();
    const urls = m[2].split(' or ').map(u => u.trim()).filter(Boolean);
    let url = urls.find(u => /\.mp4(\?|$)/i.test(u)) || urls.find(u => !/manifest\.m3u8/i.test(u)) || urls[0];
    if (url) url = url.replace(/:hls:manifest\.m3u8.*$/i, '');
    if (url && /^https?:/.test(url)) out.push({ quality, url });
  }
  return out;
}

// Title search → the best film/series page URL (year-matched when possible).
async function rezkaSearch(name, year, wantSeries) {
  if (!name) return null;
  try {
    const res = await fetch(`${REZKA}/engine/ajax/search.php`, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded', Referer: REZKA_REF },
      body: `q=${encodeURIComponent(name)}`, timeout: 9000,
    });
    if (!res.ok) return null;
    const html = await res.text();
    const items = [...html.matchAll(/<a href="(https?:\/\/[^"]+\.html)"[^>]*>([\s\S]*?)<\/a>/g)].map(m => ({ url: m[1], block: m[2] }));
    if (!items.length) return null;
    // HDRezka URL categories: /films|cartoons → movies, /series|animation → series.
    const isSeriesUrl = u => /\/(series|animation)\//i.test(u);
    const pool = items.filter(it => wantSeries ? isSeriesUrl(it.url) : !isSeriesUrl(it.url));
    const list = pool.length ? pool : items;
    const byYear = year ? list.find(it => it.block.includes(String(year))) : null;
    return (byYear || list[0]).url;
  } catch { return null; }
}

// Film/series page → { postId, translatorId (default Russian dub), isSeries }.
async function rezkaPageInfo(pageUrl) {
  try {
    const res = await fetch(pageUrl, { headers: { 'User-Agent': UA, Accept: 'text/html', Referer: REZKA_REF }, timeout: 12000 });
    if (!res.ok) return null;
    const html = await res.text();
    const postId = (html.match(/initCDN(?:Movies|Series)Events\((\d+)/) || html.match(/postId\s*[:=]\s*(\d+)/) || html.match(/data-post_id="(\d+)"/) || [])[1] || null;
    const active = html.match(/b-translator__item[^>]*\bactive\b[^>]*data-translator_id="(\d+)"/i)
      || html.match(/data-translator_id="(\d+)"/);
    const translatorId = (active && active[1]) || '0';
    const isSeries = /initCDNSeriesEvents/.test(html) || /\/(series|animation)\//i.test(pageUrl);
    return postId ? { postId, translatorId, isSeries } : null;
  } catch { return null; }
}

// Resolve Russian-dub streams for a movie or a specific episode.
async function rezkaResolve(name, year, type, season, episode) {
  try {
    const pageUrl = await rezkaSearch(name, year, type === 'series');
    if (!pageUrl) return [];
    const info = await rezkaPageInfo(pageUrl);
    if (!info || !info.postId) return [];
    const body = type === 'series'
      ? `id=${info.postId}&translator_id=${info.translatorId}&season=${season}&episode=${episode}&action=get_stream`
      : `id=${info.postId}&translator_id=${info.translatorId}&action=get_movie`;
    const r = await fetch(`${REZKA}/ajax/get_cdn_series/?t=${Date.now()}`, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded', Referer: pageUrl },
      body, timeout: 14000,
    });
    if (!r.ok) return [];
    const j = await r.json();
    if (!j || !j.success || !j.url) return [];
    return rezkaParseStreams(rezkaClearTrash(j.url));
  } catch { return []; }
}

// → Stremio rows (Russian audio), single best quality (matches ge.movie's clean
// one-row UX). Routed through STREAMFULL's /api/stream-proxy via proxyHeaders so
// the voidboost token (issued to the server's IP) is fetched server-side.
function rezkaToStremio(streams) {
  if (!streams.length) return [];
  const best = streams.slice().sort((a, b) => qualityScore(b.quality) - qualityScore(a.quality))[0];
  return [{
    name: '🇷🇺 HDRezka',
    title: `🇷🇺 Русский${best.quality ? ' · ' + best.quality : ''}`,
    url: proxify(best.url, REZKA_REF),
    behaviorHints: { notWebReady: false, proxyHeaders: { request: { Referer: REZKA_REF, 'User-Agent': UA } }, streamType: 'mp4', lang: 'ru', audioLang: 'ru' },
  }];
}

// HDRezka page → the ORIGINAL-audio translator ("Оригинал (+субтитры)"). For an
// English-language title this original track IS the English audio (HDRezka's other
// tracks are Russian/Ukrainian dub studios). Returns { postId, translatorId }.
async function rezkaEnglishInfo(pageUrl) {
  try {
    const res = await fetch(pageUrl, { headers: { 'User-Agent': UA, Accept: 'text/html', Referer: REZKA_REF }, timeout: 12000 });
    if (!res.ok) return null;
    const html = await res.text();
    const postId = (html.match(/initCDN(?:Movies|Series)Events\((\d+)/) || html.match(/postId\s*[:=]\s*(\d+)/) || html.match(/data-post_id="(\d+)"/) || [])[1] || null;
    if (!postId) return null;
    const items = [...html.matchAll(/data-translator_id="(\d+)"[^>]*(?:title="([^"]*)")?[^>]*>\s*([^<]{0,40})/gi)]
      .map(m => ({ id: m[1], title: (m[2] || m[3] || '').trim() }));
    const orig = items.find(t => /ориг|original/i.test(t.title));
    return orig ? { postId, translatorId: orig.id } : null;
  } catch { return null; }
}

// Resolve HDRezka's original (English) audio for a movie/episode → a 🇬🇧 row.
// Prefers a free numeric quality (360p–1080p) over premium-gated 1080p Ultra/2K/4K.
async function rezkaEnglish(name, year, type, season, episode) {
  try {
    const pageUrl = await rezkaSearch(name, year, type === 'series');
    if (!pageUrl) return [];
    const info = await rezkaEnglishInfo(pageUrl);
    if (!info || !info.postId) return [];
    const body = type === 'series'
      ? `id=${info.postId}&translator_id=${info.translatorId}&season=${season}&episode=${episode}&action=get_stream`
      : `id=${info.postId}&translator_id=${info.translatorId}&action=get_movie`;
    const r = await fetch(`${REZKA}/ajax/get_cdn_series/?t=${Date.now()}`, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded', Referer: pageUrl },
      body, timeout: 14000,
    });
    if (!r.ok) return [];
    const j = await r.json();
    if (!j || !j.success || !j.url) return [];
    const streams = rezkaParseStreams(rezkaClearTrash(j.url));
    if (!streams.length) return [];
    const free = streams.filter(s => /^\d{3,4}p$/i.test(s.quality));
    const best = (free.length ? free : streams).slice().sort((a, b) => qualityScore(b.quality) - qualityScore(a.quality))[0];
    // English subtitles bundled with the original track, if HDRezka shipped any.
    const subs = [];
    if (typeof j.subtitle === 'string') {
      for (const m of j.subtitle.matchAll(/\[([^\]]+)\](https?:\/\/[^,]+)/g)) subs.push({ id: 'rz' + subs.length, url: proxify(m[2], REZKA_REF), lang: m[1] });
    }
    return [{
      name: '🇬🇧 HDRezka',
      title: `🇬🇧 English${best.quality ? ' · ' + best.quality : ''}`,
      url: proxify(best.url, REZKA_REF),
      subtitles: subs,
      behaviorHints: { notWebReady: false, proxyHeaders: { request: { Referer: REZKA_REF, 'User-Agent': UA } }, streamType: 'mp4', lang: 'en', audioLang: 'en' },
    }];
  } catch { return []; }
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
    name: '🇺🇦 UAFlix',
    title: '🇺🇦 Українською',
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
      name: '🇬🇧 UAFlix',
      title: '🇬🇧 English',
      url: workerProxify(file, ZET_REF, true),
      behaviorHints: { notWebReady: true, proxyHeaders: { request: { Referer: ZET_REF, 'User-Agent': UA } }, streamType: 'hls', lang: 'en', audioLang: 'en' },
    }];
  } catch { return []; }
}

// ─────────────────────────────────────────
//  CATALOG HANDLER
// ─────────────────────────────────────────
builder.defineCatalogHandler(async ({ type, id, extra }) => {
  const base = await getBase();
  const wantType = type === 'series' ? 'series' : 'movie';
  const skip = parseInt(extra && extra.skip ? extra.skip : 0, 10) || 0;
  const page = Math.floor(skip / PAGE_SIZE) + 1;

  try {
    let items = [];

    if (extra && extra.search) {
      const j = await api(`/api/v1/search?q=${encodeURIComponent(extra.search)}`, 9000);
      items = ((j && j.data) || []).filter(it => it.type === wantType);
    } else if (extra && extra.genre && GENRE_MAP[extra.genre]) {
      const j = await api(`/api/v1/genres/${GENRE_MAP[extra.genre]}?page=${page}&per_page=${PAGE_SIZE}`, 9000);
      const data = (j && j.movies && j.movies.data) || [];
      items = data.filter(it => it.type === wantType);
    } else {
      const j = await api(`/api/v1/movies?type=${wantType}&page=${page}&per_page=${PAGE_SIZE}`, 9000);
      items = (j && j.data) || [];
    }

    return { metas: items.map(it => itemToMeta(it, base)) };
  } catch (e) {
    console.error('catalog error:', e.message);
    return { metas: [] };
  }
});

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

// Relabel an HDRezka original-audio row as "Original · <Language>" (not English)
// when the title's original language is NOT English. Stays tagged lang:'en' so it
// still surfaces under STREAMFULL's English tab as the closest-to-source option,
// but audioLang carries the real code and the title is honest about the language.
function relabelOriginal(rows, code) {
  const nm = langName(code);
  return rows.map(r => ({
    ...r,
    name: (r.name || '').replace('🇬🇧', '🌐'),
    title: (r.title || '').replace('🇬🇧 English', `🌐 Original · ${nm}`),
    behaviorHints: { ...r.behaviorHints, audioLang: code || 'original' },
  }));
}

// English (en) cascade — ORDERED to keep English bytes off the origin's bandwidth.
// ge.movie and UAFlix stream through the Cloudflare Worker (unmetered), so we try
// them FIRST; HDRezka (origin-bound, IP-locked to this server) is the last resort.
//   • ge.movie English track → UAFlix English → HDRezka "Оригинал".
//   • HDRezka's original is real English only when the title's original language IS
//     English (TMDB); for a non-English-origin title with no real English dub it is
//     surfaced RELABELLED "Original · <Language>" rather than mislabelled English.
// This means when ge.movie/UAFlix carry an English track we never touch HDRezka,
// shifting most English traffic onto the Worker.
async function resolveEnglishCascade(meta, type, season, episode) {
  const { name, year, tmdb } = meta;
  const origLang = await tmdbOriginalLang(tmdb, type);   // 'en' | 'ko' | … | null
  const englishOrigin = !origLang || origLang === 'en';  // null (unknown) → treat as English

  // Worker-able English first: ge.movie, then UAFlix.
  if (tmdb) {
    const en = gemEnglishToStremio(await gemEnglish(tmdb, type, season, episode).catch(() => []));
    if (en.length) return en;
  }
  if (name) {
    const en = await uafixEnglish(name, year, type, season, episode).catch(() => []);
    if (en.length) return en;
  }

  // Last resort: HDRezka's original track (origin-bound). For an English-origin
  // title that IS the English audio; otherwise relabel it honestly as Original.
  const rez = name ? await rezkaEnglish(name, year, type, season, episode).catch(() => []) : [];
  if (rez.length) return englishOrigin ? rez : relabelOriginal(rez, origLang);
  return [];
}

// ─────────────────────────────────────────
//  STREAM HANDLER
// ─────────────────────────────────────────
builder.defineStreamHandler(async ({ type, id }) => {
  try {
    if (type !== 'movie' && type !== 'series') return { streams: [] };

    // One id → title/year/tmdb, then resolve all four language sources in parallel:
    //   ka → ge.movie (tmdb) · ru → HDRezka · uk → UAFlix · en → cascade (HDRezka
    //   original → ge.movie → UAFlix). Each row is lang-tagged; STREAMFULL's
    //   per-language fallback chain plays it and advances to a torrent on failure.
    const baseId = type === 'series' ? id.split(':')[0] : id;
    const season = type === 'series' ? parseInt(id.split(':')[1] || '1', 10) : 1;
    const episode = type === 'series' ? parseInt(id.split(':')[2] || '1', 10) : 1;

    const meta = await metaForId(baseId, type);
    const { name, year, tmdb } = meta;

    const [ka, ru, uk, en] = await Promise.all([
      tmdb ? (type === 'series' ? gemEpisode(tmdb, season, episode) : gemMovie(tmdb)) : Promise.resolve([]),
      name ? rezkaResolve(name, year, type, season, episode) : Promise.resolve([]),
      name ? uafixResolve(name, year, type, season, episode) : Promise.resolve([]),
      resolveEnglishCascade({ name, year, tmdb }, type, season, episode),
    ]);

    return {
      streams: [
        ...en,                   // 🇬🇧 English (HDRezka original → ge.movie → UAFlix)
        ...gemToStremio(ka),     // 🇬🇪 Georgian
        ...rezkaToStremio(ru),   // 🇷🇺 Russian
        ...uafixToStremio(uk),   // 🇺🇦 Ukrainian
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
