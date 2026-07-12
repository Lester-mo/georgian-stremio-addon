# Deploying to Oracle Cloud (Always Free)

Why Oracle: the Always-Free tier includes **10 TB/month of egress**, so proxying
video bytes (HDRezka is IP-locked to the serving host and can't ride the
Cloudflare Worker) fits comfortably — unlike Render's tiny bandwidth quota.

## 1. Create the account + VM (manual, one time)

1. Sign up at <https://oracle.com/cloud/free> (card required for identity
   verification; Always-Free resources never charge it).
2. Console → **Compute → Instances → Create instance**:
   - Image: **Ubuntu 24.04** (or 22.04)
   - Shape: **Ampere A1.Flex, 1 OCPU / 6 GB** (Always Free). If you get an
     "out of capacity" error, retry with **VM.Standard.E2.1.Micro** or try
     another availability domain / later in the day.
   - Networking: default VCN with a **public IPv4** assigned.
   - SSH keys: paste the contents of `~/.ssh/id_ed25519.pub` from the dev PC.
3. VCN → the subnet's **Security List → Add Ingress Rules**: allow TCP **80**
   and **443** from `0.0.0.0/0` (port 22 is open by default).

## 2. Get a hostname (free, one time)

Browser clients require HTTPS, so the VM needs a hostname a certificate can be
issued for. Easiest: <https://duckdns.org> (sign in with GitHub), create a
subdomain (e.g. `mercury-ge`), note your **token**. No need to set the IP by
hand — `setup.sh` registers it and installs a cron to keep it updated.

## 3. Copy the code + run setup (from the dev PC)

```powershell
$VM = "ubuntu@<public-ip>"
scp -r * "${VM}:/tmp/mercury"          # from the project folder, or use rsync
ssh $VM "sudo mkdir -p /opt && sudo mv /tmp/mercury /opt/mercury"
ssh $VM "sudo DOMAIN=mercury-ge.duckdns.org DUCKDNS_TOKEN=<token> DUCKDNS_SUB=mercury-ge bash /opt/mercury/deploy/oracle/setup.sh"
```

Do **not** copy `node_modules` (Windows binaries won't run on Linux) — the
script runs `npm install` on the VM.

Install URL after setup: `https://<sub>.duckdns.org/manifest.json`

## Operations

```bash
journalctl -u mercury -f          # live addon logs
systemctl restart mercury         # restart after updating the code
```

To update the code later: scp the changed files into `/opt/mercury` and
`systemctl restart mercury`.
