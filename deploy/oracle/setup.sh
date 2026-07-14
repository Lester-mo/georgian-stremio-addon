#!/usr/bin/env bash
# One-shot server setup for the Mercury addon on an Oracle Cloud Always-Free VM
# (Ubuntu 22.04/24.04). Run as root AFTER the app code has been copied to
# /opt/mercury (scp/rsync from the dev machine — the GitHub repo is private).
#
# Usage:
#   sudo DOMAIN=mercury-ge.duckdns.org \
#        DUCKDNS_TOKEN=xxxx DUCKDNS_SUB=mercury-ge \
#        bash /opt/mercury/deploy/oracle/setup.sh
#
#   DOMAIN        (required) public hostname; Caddy gets a Let's Encrypt cert for it
#   DUCKDNS_TOKEN (optional) if set with DUCKDNS_SUB, registers this VM's IP with
#                 DuckDNS now and keeps it updated via a 5-minute cron
#   WORKER_PROXY  (optional) Cloudflare Worker relay; defaults to the current one
set -euo pipefail

APP_DIR=/opt/mercury
PORT=7000
WORKER_PROXY="${WORKER_PROXY:-https://stredio-stream.shonomusicofficial.workers.dev}"

[[ -n "${DOMAIN:-}" ]] || { echo "ERROR: set DOMAIN=<public hostname>"; exit 1; }
[[ -f "$APP_DIR/index.js" ]] || { echo "ERROR: app not found at $APP_DIR (scp the project first)"; exit 1; }

echo "==> Registering DuckDNS IP (if configured)"
if [[ -n "${DUCKDNS_TOKEN:-}" && -n "${DUCKDNS_SUB:-}" ]]; then
  curl -fsS "https://www.duckdns.org/update?domains=${DUCKDNS_SUB}&token=${DUCKDNS_TOKEN}&ip=" && echo
  cat > /etc/cron.d/duckdns <<EOF
*/5 * * * * root curl -fsS "https://www.duckdns.org/update?domains=${DUCKDNS_SUB}&token=${DUCKDNS_TOKEN}&ip=" >/dev/null 2>&1
EOF
fi

echo "==> Installing Node.js 20"
if ! command -v node >/dev/null || [[ "$(node -v | cut -c2-3)" -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Installing Caddy (automatic HTTPS)"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

echo "==> Opening ports 80/443 (Oracle Ubuntu images ship a restrictive iptables ruleset)"
for p in 80 443; do
  iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null \
    || iptables -I INPUT 5 -p tcp --dport $p -m state --state NEW -j ACCEPT
done
apt-get install -y iptables-persistent >/dev/null 2>&1 || true
netfilter-persistent save || true

echo "==> Ensuring swap exists"
# The Always-Free fallback shape (VM.Standard.E2.1.Micro) has only 1 GB of RAM
# and ships with no swap. Node + Caddy + the OS will not fit under load, and
# the first thing to suffer is Caddy's TLS handshake — it keeps the socket open
# but never completes, so the addon looks alive while serving nothing.
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Installing app dependencies"
cd "$APP_DIR"
npm install --omit=dev

# Stable secret for sealing /proxy tokens (AES-256-GCM). Persisted once so it
# survives re-runs — a changing key would only break in-flight playlists on
# redeploy, never anything permanent.
SECRET_FILE=/etc/mercury.secret
if [ ! -s "$SECRET_FILE" ]; then openssl rand -hex 32 > "$SECRET_FILE"; chmod 600 "$SECRET_FILE"; fi
PROXY_SECRET="$(cat "$SECRET_FILE")"

# Give the addon ~45% of RAM: enough headroom for Caddy and the OS on a 1 GB
# box, and it still scales up if you later move to the 6 GB Ampere shape.
MEM_TOTAL_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
MEM_MAX=$(( MEM_TOTAL_MB * 45 / 100 ))
echo "    RAM=${MEM_TOTAL_MB}M -> MemoryMax=${MEM_MAX}M"

echo "==> Writing systemd unit"
cat > /etc/systemd/system/mercury.service <<EOF
[Unit]
Description=Mercury Stremio addon
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=3
Environment=PORT=$PORT
Environment=PUBLIC_URL=https://$DOMAIN
Environment=WORKER_PROXY=$WORKER_PROXY
Environment=PROXY_SECRET=$PROXY_SECRET
# The addon only proxies streams; keep it from ballooning. Sized to the shape:
# a flat 800M left nothing for Caddy or the OS on the 1 GB Micro fallback.
MemoryMax=${MEM_MAX}M
MemoryHigh=$(( MEM_MAX * 8 / 10 ))M

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now mercury

echo "==> Writing Caddyfile"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy 127.0.0.1:$PORT
    encode zstd gzip
}
EOF
systemctl reload caddy || systemctl restart caddy

echo "==> Installing the health watchdog"
# Restart=always only catches a process that EXITS. The failure seen in the
# wild was Caddy staying up but hanging mid-TLS-handshake: systemd saw a
# healthy unit while the addon served nothing to anyone. So probe the real
# path — a full HTTPS request through Caddy — and restart what is actually
# wedged. Checks the addon on localhost first to tell the two apart.
cat > /usr/local/bin/mercury-healthcheck <<EOF
#!/bin/bash
# Addon itself: plain HTTP on the loopback port.
if ! curl -fsS --max-time 10 "http://127.0.0.1:$PORT/manifest.json" >/dev/null 2>&1; then
  logger -t mercury-healthcheck "addon not answering on :$PORT — restarting mercury"
  systemctl restart mercury
  exit 0
fi
# Full TLS path through Caddy, pinned to loopback so it works without egress
# and does not depend on DuckDNS resolving (its NS can take >3s).
if ! curl -fsS --max-time 15 --resolve "$DOMAIN:443:127.0.0.1" \
     "https://$DOMAIN/manifest.json" >/dev/null 2>&1; then
  logger -t mercury-healthcheck "TLS path failed — restarting caddy"
  systemctl restart caddy
fi
EOF
chmod +x /usr/local/bin/mercury-healthcheck

cat > /etc/systemd/system/mercury-healthcheck.service <<'EOF'
[Unit]
Description=Mercury health probe (restarts a wedged addon or Caddy)

[Service]
Type=oneshot
ExecStart=/usr/local/bin/mercury-healthcheck
EOF

cat > /etc/systemd/system/mercury-healthcheck.timer <<'EOF'
[Unit]
Description=Run the Mercury health probe every 2 minutes

[Timer]
OnBootSec=90s
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now mercury-healthcheck.timer

echo "==> Waiting for the addon to answer"
for i in {1..20}; do
  curl -fsS "http://127.0.0.1:$PORT/manifest.json" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/manifest.json" >/dev/null \
  && echo "OK: addon is up." \
  || { echo "ERROR: addon did not start — check: journalctl -u mercury -n 50"; exit 1; }

echo
echo "=================================================================="
echo "  Install URL:  https://$DOMAIN/manifest.json"
echo "=================================================================="
echo "  (HTTPS goes live as soon as Caddy finishes the Let's Encrypt"
echo "   handshake — usually <30s after DNS points at this VM.)"
