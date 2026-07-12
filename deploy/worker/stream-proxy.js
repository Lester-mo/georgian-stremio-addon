// stream-proxy relay with origin fallback + sealed tokens
// Contract: GET /stream-proxy?d=<sealed token>
//   token = base64url( iv[12] ‖ authTag[16] ‖ AES-256-GCM(JSON) )
//   JSON  = { u: <url>, r: <referer>, h?: 1 }   (h marks an HLS playlist)
// Legacy (accepted during cutover, no longer emitted): ?src=<url>&ref=<ref>[&t=hls]
//
// The key is sha256(PROXY_SECRET) — the SAME secret + derivation the addon uses
// (/etc/mercury.secret on the Oracle box), so ?d= tokens never expose the
// upstream host or Referer in the URL. Set it as a Worker secret:
//   wrangler secret put PROXY_SECRET      (paste the value from /etc/mercury.secret)
//
// Normally relays the file straight through Cloudflare (free bandwidth).
// Some CDNs (*-videodb.online) are Cloudflare-proxied zones that erratically
// 403 requests coming from Workers (stable per URL). On a 403/429/5xx or network
// error we re-fetch that one file through the addon's own proxy on the origin
// (which those hosts serve reliably) and relay its response instead. Only the
// blocked minority of files ever touches origin bandwidth.

const FALLBACK_PROXY = 'https://mercury-source.duckdns.org/proxy';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    if (url.pathname !== '/stream-proxy') return new Response('Not found', { status: 404, headers: cors() });

    let key;
    try { key = await getKey(env); }
    catch { return new Response('server misconfigured (no PROXY_SECRET)', { status: 500, headers: cors() }); }

    // Sealed token (?d=) is the norm; legacy ?src= is still accepted so the
    // cutover survives an addon/Worker deploy-order mismatch.
    let src, ref, isHls;
    const token = url.searchParams.get('d');
    if (token) {
      let p;
      try { p = await open(key, token); }
      catch { return new Response('bad token', { status: 400, headers: cors() }); }
      src = p.u; ref = p.r || ''; isHls = !!p.h;
    } else {
      src = url.searchParams.get('src');
      ref = url.searchParams.get('ref') || '';
      isHls = url.searchParams.get('t') === 'hls';
    }
    if (!src || !/^https?:\/\//.test(src)) return new Response('bad src', { status: 400, headers: cors() });

    const headers = { 'User-Agent': UA, 'Accept': '*/*' };
    if (ref) headers['Referer'] = ref;
    const range = request.headers.get('Range');
    if (range) headers['Range'] = range;

    let up = null;
    try { up = await fetch(src, { headers, redirect: 'follow' }); } catch { up = null; }

    // Blocked or broken upstream → rescue that one file via the origin proxy.
    if (!up || up.status === 403 || up.status === 429 || up.status >= 500) {
      const rescued = await fetchFallback(key, src, ref, range);
      if (rescued) up = rescued;
    }
    if (!up) return new Response('upstream failed', { status: 502, headers: cors() });

    // HLS playlists: rewrite every URI so it points back at this worker (sealed).
    const ct = up.headers.get('content-type') || '';
    if (isHls || /mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(new URL(src).pathname)) {
      const text = await up.text();
      const h = cors();
      h['Content-Type'] = 'application/vnd.apple.mpegurl';
      return new Response(await rewritePlaylist(key, text, src, ref, url.origin), { status: up.status, headers: h });
    }

    // Media bytes: stream straight through with CORS open.
    const h = new Headers(cors());
    for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
      const v = up.headers.get(k);
      if (v) h.set(k, v);
    }
    if (!h.get('accept-ranges')) h.set('accept-ranges', 'bytes');
    return new Response(up.body, { status: up.status, headers: h });
  },
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
  };
}

// ── AES-256-GCM, byte-compatible with the addon's encodeProxy/decodeProxy ──
// Key = sha256(PROXY_SECRET). Wire = iv[12] ‖ tag[16] ‖ ciphertext. WebCrypto
// returns ciphertext‖tag, so we reorder on both ends to match Node's layout.
let _keyPromise = null;
async function getKey(env) {
  const secret = env && env.PROXY_SECRET;
  if (!secret) throw new Error('no PROXY_SECRET');
  if (!_keyPromise) {
    _keyPromise = (async () => {
      const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
      return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    })();
  }
  return _keyPromise;
}

function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(obj));
  const ctTag = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt));
  const body = ctTag.subarray(0, ctTag.length - 16);   // ciphertext
  const tag = ctTag.subarray(ctTag.length - 16);        // 16-byte GCM tag
  const out = new Uint8Array(12 + 16 + body.length);
  out.set(iv, 0);
  out.set(tag, 12);
  out.set(body, 28);
  return b64urlEncode(out);
}

async function open(key, token) {
  const raw = b64urlDecode(token);
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  const ctTag = new Uint8Array(body.length + 16);       // WebCrypto wants ciphertext‖tag
  ctTag.set(body, 0);
  ctTag.set(tag, body.length);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ctTag);
  return JSON.parse(new TextDecoder().decode(pt));
}

// The origin proxy takes the same sealed token: { u, r }.
async function fetchFallback(key, src, ref, range) {
  if (!FALLBACK_PROXY) return null;
  const d = await seal(key, { u: src, r: ref || '' });
  const headers = {};
  if (range) headers['Range'] = range;
  try {
    const r = await fetch(`${FALLBACK_PROXY}?d=${d}`, { headers });
    return r.ok ? r : null; // r.ok covers 200 and 206
  } catch { return null; }
}

async function rewritePlaylist(key, text, playlistUrl, ref, workerOrigin) {
  const isMaster = /#EXT-X-STREAM-INF/.test(text);
  const route = async (u, asPlaylist) => {
    const abs = new URL(u, playlistUrl).toString();
    const d = await seal(key, { u: abs, r: ref || '', ...(asPlaylist ? { h: 1 } : {}) });
    return `${workerOrigin}/stream-proxy?d=${d}`;
  };
  const lines = await Promise.all(text.split(/\r?\n/).map(async line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      const m = t.match(/URI="([^"]+)"/);
      if (!m) return line;
      const uriIsPlaylist = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF)/.test(t);
      return line.replace(/URI="[^"]+"/, `URI="${await route(m[1], uriIsPlaylist)}"`);
    }
    return route(t, isMaster || /\.m3u8(\?|$)/i.test(t));
  }));
  return lines.join('\n');
}
