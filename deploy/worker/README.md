# Cloudflare Worker — stream relay (`stream-proxy.js`)

Unmetered relay for the non-IP-locked sources (ge.movie, UAFlix). Deployed at
`stredio-stream.shonomusicofficial.workers.dev`; the addon points to it via the
`WORKER_PROXY` env var.

## Sealed tokens

The Worker accepts `GET /stream-proxy?d=<token>`, where `token` is the same
AES-256-GCM envelope the addon's `/proxy` uses:

```
token = base64url( iv[12] ‖ authTag[16] ‖ AES-256-GCM(JSON) )
JSON  = { u: <url>, r: <referer>, h?: 1 }
key   = sha256(PROXY_SECRET)
```

So the upstream host and Referer are no longer visible in the URL. The Worker
seals its own child-playlist URLs and the origin-fallback hop the same way.

The legacy plaintext form `?src=<url>&ref=<ref>[&t=hls]` is still accepted for a
smooth cutover; the addon no longer emits it. Drop that branch once you're
confident nothing stale references it.

## Deploy

`PROXY_SECRET` must equal the origin's secret (`/etc/mercury.secret` on the
Oracle box — same value the systemd unit passes to the addon).

```bash
# in a dir containing stream-proxy.js + wrangler.toml
wrangler secret put PROXY_SECRET     # paste the value from /etc/mercury.secret
wrangler deploy
```

Minimal `wrangler.toml`:

```toml
name = "stredio-stream"
main = "stream-proxy.js"
compatibility_date = "2024-11-01"
```

(Or paste `stream-proxy.js` into the dashboard editor and add `PROXY_SECRET`
under Settings → Variables → Encrypt.)
