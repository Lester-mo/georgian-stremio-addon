# 🇬🇪 Georgian Dubbed Stremio Addon

A Stremio addon that brings **12,000+ Georgian dubbed movies and series** directly into Stremio, sourced from:
- **Adjaranet** (primary) — largest Georgian dubbed content library
- **GEMovie** (fallback) — secondary source

---

## Features

- 🎬 Browse Georgian dubbed movies & series
- 🔍 Search by title
- 🎭 Filter by genre
- 📺 Watch directly inside Stremio — no browser needed
- 🔗 Works with IMDB IDs (so Georgian audio shows up on any movie in Stremio)

---

## Setup (5 minutes)

### Requirements
- [Node.js](https://nodejs.org) v16 or higher
- [Stremio](https://www.stremio.com) installed

### Steps

**1. Install dependencies**
```bash
cd georgian-stremio-addon
npm install
```

**2. Start the addon**
```bash
npm start
```
You'll see:
```
🇬🇪 Georgian Stremio Addon running on http://localhost:7000
📦 Install URL: http://localhost:7000/manifest.json
```

**3. Install in Stremio**
- Open Stremio
- Go to **Settings → Addons**
- Click **"+ Add addon"**
- Paste: `http://localhost:7000/manifest.json`
- Click **Install**

---

## Usage

### Browse
- In Stremio, go to **Discover**
- Select **"🇬🇪 Georgian Dubbed Movies"** or **"🇬🇪 Georgian Dubbed Series"**
- Browse or filter by genre

### Search
- Use the search bar in Stremio — Georgian dubbed results will appear

### Watch any movie in Georgian
- Open *any* movie in Stremio (even from other addons/IMDB)
- Click **Streams**
- If a Georgian dubbed version exists on Adjaranet, it will appear as **"🇬🇪 Adjaranet"**

---

## Use in a browser client (e.g. stredio.vercel.app) via a tunnel

Browser-based clients are served over **HTTPS** and can't load an addon from
plain `http://` on another device, and their in-browser player can't send the
`Referer` headers the stream CDNs require. This addon proxies every stream
server-side (adding the right `Referer`, rewriting HLS playlists, serving with
open CORS + range/seek). The byte-heavy sources (ge.movie, UAFlix, kkphim) are
relayed through a **Cloudflare Worker** (`WORKER_PROXY`) on Cloudflare's
unmetered bandwidth, so the host serves only tiny JSON. For local use you just
need to expose the addon over HTTPS with a tunnel.

**1. Start a tunnel** (free, no account — [install cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)):
```bash
cloudflared tunnel --url http://localhost:7000
```
Copy the `https://<random>.trycloudflare.com` URL it prints.

**2. Start the addon with that URL as `PUBLIC_URL`** so the proxy builds correct
absolute stream links (PowerShell):
```powershell
$env:PUBLIC_URL="https://<random>.trycloudflare.com"; npm start
```
> `PUBLIC_URL` is strongly recommended. Without it the addon guesses its origin
> from the request `Host` header, which some tunnels rewrite — leading to broken
> stream links.

**3. Install in the browser client** — paste into the "Install new addon" field:
```
https://<random>.trycloudflare.com/manifest.json
```

The trycloudflare URL changes every time you restart the tunnel; re-run steps
1–3 (or use a named cloudflared tunnel / paid ngrok domain for a stable URL).

---

## Run on a Server (optional, so you don't need to keep your PC on)

You can deploy this to any free Node.js host like [Railway](https://railway.app) or [Render](https://render.com):

1. Push the folder to a GitHub repo
2. Connect to Railway/Render
3. Set start command: `node index.js`
4. Use the public URL instead of `localhost:7000` when installing in Stremio

---

## Troubleshooting

**No streams showing?**
- Make sure the addon server is running (`npm start`)
- Try searching the movie in the Georgian catalog first to confirm it exists on Adjaranet

**Addon not installing?**
- Make sure Stremio is open and the server is running
- Try opening `http://localhost:7000/manifest.json` in your browser — you should see JSON

---

## Technical Notes

- Uses the **official Adjaranet API** (`api.adjaranet.com/api/v1`)
- Filters for Georgian language (`ka`) audio
- Falls back to GEMovie via HTML scraping if Adjaranet has no result
- IMDB ID matching lets Georgian audio appear on standard Stremio content pages
