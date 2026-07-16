#!/usr/bin/env bash
# Apply the anti-wedge hardening to a VM that is ALREADY running Mercury,
# without redeploying the app. Safe to re-run.
#
# Fixes the failure seen on 2026-07-14: Caddy stayed "active" while hanging
# mid-TLS-handshake, so Restart=always never fired and the addon served
# nothing for days until a manual reboot.
#
# Usage (as root, e.g. via Oracle Console -> Run command):
#   sudo DOMAIN=mercury-source.duckdns.org bash harden.sh
set -euo pipefail

DOMAIN="${DOMAIN:-mercury-source.duckdns.org}"
PORT="${PORT:-7000}"

echo "==> 1/4 swap"
# 1 GB Micro shape ships with no swap; Node + Caddy + OS do not fit.
if swapon --show | grep -q .; then
  echo "    swap already present, leaving it alone"
else
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "    2G swap added"
fi

echo "==> 2/4 memory cap sized to this shape"
MEM_TOTAL_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
MEM_MAX=$(( MEM_TOTAL_MB * 45 / 100 ))
MEM_HIGH=$(( MEM_MAX * 8 / 10 ))
mkdir -p /etc/systemd/system/mercury.service.d
cat > /etc/systemd/system/mercury.service.d/10-memory.conf <<EOF
# Drop-in overrides the flat MemoryMax=800M, which left nothing for Caddy
# or the OS on the 1 GB VM.Standard.E2.1.Micro fallback shape.
[Service]
MemoryMax=${MEM_MAX}M
MemoryHigh=${MEM_HIGH}M
EOF
echo "    RAM=${MEM_TOTAL_MB}M -> MemoryMax=${MEM_MAX}M MemoryHigh=${MEM_HIGH}M"

echo "==> 3/4 health watchdog"
# Bake the shape-specific values, then append the rest of the probe verbatim
# (quoted heredoc) so its runtime shell vars are not expanded at write time.
cat > /usr/local/bin/mercury-healthcheck <<EOF
#!/bin/bash
PORT=${PORT}
DOMAIN=${DOMAIN}
EOF
cat >> /usr/local/bin/mercury-healthcheck <<'EOF'
STATE=/run/mercury-healthcheck.fails
# Probe the real path, not just liveness: a hung Caddy still looks "active".
if ! curl -fsS --max-time 10 "http://127.0.0.1:$PORT/manifest.json" >/dev/null 2>&1; then
  logger -t mercury-healthcheck "addon not answering on :$PORT — restarting mercury"
  systemctl restart mercury
  exit 0
fi
# Full TLS handshake through Caddy, pinned to loopback: no egress needed and
# no dependency on DuckDNS resolving (its nameservers can take >3s).
if curl -fsS --max-time 15 --resolve "$DOMAIN:443:127.0.0.1" \
     "https://$DOMAIN/manifest.json" >/dev/null 2>&1; then
  rm -f "$STATE"        # healthy — reset the failure streak
  exit 0
fi
# TLS is wedged. Restart Caddy and count how many cycles it stays broken.
fails=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$fails" > "$STATE"
logger -t mercury-healthcheck "TLS path failed (streak=$fails) — restarting caddy"
systemctl restart caddy
# Restarting Caddy does not always clear the memory-pressure wedge. If TLS has
# stayed broken ~3 cycles (~6 min) and the box is past its post-boot blip,
# reboot — the only thing that reliably recovers it. STATE lives in /run
# (tmpfs, wiped on boot) and the uptime guard caps reboots at ~1 per 10 min,
# so this cannot become a tight reboot loop.
if [ "$fails" -ge 3 ] && [ "$(awk '{print int($1)}' /proc/uptime)" -ge 600 ]; then
  logger -t mercury-healthcheck "TLS still failing after $fails cycles — rebooting"
  rm -f "$STATE"
  systemctl reboot
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

echo "==> 4/4 applying"
systemctl daemon-reload
systemctl enable --now mercury-healthcheck.timer >/dev/null 2>&1
systemctl restart mercury

echo
echo "=== RESULT ==="
free -m | head -2
systemctl is-active mercury caddy mercury-healthcheck.timer | paste -sd' ' -
/usr/local/bin/mercury-healthcheck && echo "healthcheck: PASS"
curl -fsS --max-time 15 "https://${DOMAIN}/manifest.json" >/dev/null \
  && echo "public HTTPS: OK" || echo "public HTTPS: FAILED"
