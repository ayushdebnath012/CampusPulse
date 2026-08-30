#!/usr/bin/env bash
#
# Put CampusPulse behind HTTPS on a domain you own.
#
# Run this ON the EC2 instance, as root, AFTER:
#   1. ec2-userdata.sh has the API answering on 127.0.0.1:8787, and
#   2. an A record for your domain points at this instance's public IP, and
#   3. the security group allows inbound 80 and 443 from 0.0.0.0/0.
#
# It installs nginx as a TLS reverse proxy in front of the Node service, gets a
# free Let's Encrypt certificate, forces http->https, and schedules renewal.
# After this the API is reachable at https://<your-domain>/api/health and the
# raw :8787 port no longer needs to be open to the world.
#
# Usage:
#   sudo ./enable-https.sh api.example.edu you@example.edu
#   sudo DOMAIN=api.example.edu LE_EMAIL=you@example.edu ./enable-https.sh
set -euxo pipefail

DOMAIN="${1:-${DOMAIN:-}}"
LE_EMAIL="${2:-${LE_EMAIL:-}}"
APP_PORT="8787"

if [ -z "$DOMAIN" ] || [ -z "$LE_EMAIL" ]; then
  echo "Usage: sudo ./enable-https.sh <domain> <email-for-letsencrypt>" >&2
  echo "  The domain's A record must already point at this instance." >&2
  exit 1
fi

# Fail early with a clear message if DNS is not pointed here yet, rather than
# letting certbot's HTTP-01 challenge fail with a cryptic error.
this_ip="$(curl -fsS http://169.254.169.254/latest/meta-data/public-ipv4 || true)"
dns_ip="$(getent hosts "$DOMAIN" | awk '{print $1; exit}' || true)"
if [ -n "$this_ip" ] && [ -n "$dns_ip" ] && [ "$this_ip" != "$dns_ip" ]; then
  echo "✖ $DOMAIN resolves to ${dns_ip}, but this instance is ${this_ip}." >&2
  echo "  Point the A record at ${this_ip}, wait for it to propagate, then re-run." >&2
  exit 1
fi

# --- nginx reverse proxy --------------------------------------------------
dnf install -y nginx
cat > /etc/nginx/conf.d/campuspulse.conf <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
# Drop the stock welcome server so it does not shadow ours on port 80.
[ -f /etc/nginx/nginx.conf ] && sed -i '/# Settings for a TLS enabled server/,$!b' /etc/nginx/nginx.conf || true
nginx -t
systemctl enable --now nginx
systemctl reload nginx

# --- certbot (in its own venv; AL2023 has no distro certbot) ---------------
if ! command -v certbot >/dev/null 2>&1; then
  dnf install -y python3 python3-pip augeas-libs
  python3 -m venv /opt/certbot
  /opt/certbot/bin/pip install --upgrade pip
  /opt/certbot/bin/pip install certbot certbot-nginx
  ln -sf /opt/certbot/bin/certbot /usr/bin/certbot
fi

# Obtain + install the cert, and add the http->https redirect, in one shot.
certbot --nginx \
  -d "$DOMAIN" \
  -m "$LE_EMAIL" \
  --agree-tos --no-eff-email --non-interactive --redirect

# --- auto-renewal ---------------------------------------------------------
# The venv certbot ships no timer of its own, so add one. Renews twice daily;
# certbot only acts when a cert is within 30 days of expiry.
cat > /etc/systemd/system/certbot-renew.service <<'UNIT'
[Unit]
Description=Renew Let's Encrypt certificates
[Service]
Type=oneshot
ExecStart=/usr/bin/certbot renew --quiet --deploy-hook "systemctl reload nginx"
UNIT
cat > /etc/systemd/system/certbot-renew.timer <<'UNIT'
[Unit]
Description=Twice-daily Let's Encrypt renewal check
[Timer]
OnCalendar=*-*-* 03,15:00:00
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now certbot-renew.timer

sleep 2
curl -fsS "https://${DOMAIN}/api/health" && echo " <- CampusPulse is up on https://${DOMAIN}"
echo
echo "Done. You can now close public access to :${APP_PORT} in the security group —"
echo "nginx reaches the app over localhost, so only 80 and 443 need to be open."
