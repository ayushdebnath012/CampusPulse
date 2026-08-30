#!/usr/bin/env bash
#
# EC2 user-data: stand up the CampusPulse backend on a free-tier instance.
#
# Paste this into "Advanced details → User data" when launching an Amazon
# Linux 2023 instance, or run it by hand as root on a fresh box. It installs
# Node 20, checks the repo out to /opt/campuspulse, and runs the API under
# systemd so it restarts on crash and on reboot.
#
# It mirrors render.yaml: `npm ci --omit=dev`, `npm start`, health at
# /api/health. Storage is the JSON file (DATABASE_PATH) on the instance disk —
# free, and the app's default. Point DATABASE_URL at an RDS Postgres instead
# for durability (see README.md).
#
# Cloud-init runs user-data only on the FIRST boot. Re-running after that is a
# no-op; to redeploy, see the "update" note in README.md.
set -euxo pipefail

REPO_URL="https://github.com/ayushdebnath012/CampusPulse.git"
APP_DIR="/opt/campuspulse"
DATA_DIR="/var/lib/campuspulse"
ENV_FILE="/etc/campuspulse.env"
SERVICE_USER="campuspulse"
PORT="8787"

# --- packages -------------------------------------------------------------
dnf install -y git
curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
dnf install -y nodejs

# --- unprivileged service account ----------------------------------------
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"

# --- code -----------------------------------------------------------------
if [ ! -d "$APP_DIR/.git" ]; then
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR/backend"
npm ci --omit=dev

# --- configuration --------------------------------------------------------
# Only the essentials. Add email/push/roster secrets here as needed — the full
# list is in README.md. Keep this file 0600; it holds secrets once you add any.
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
HOST=0.0.0.0
PORT=${PORT}
DATABASE_PATH=${DATA_DIR}/campuspulse.json
ALLOWED_ORIGINS=https://ayushdebnath012.github.io,https://localhost,capacitor://localhost,http://localhost
ALLOW_DEV_VERIFICATION_CODE=false
ENV
  chmod 600 "$ENV_FILE"
fi

# --- systemd unit ---------------------------------------------------------
cat > /etc/systemd/system/campuspulse.service <<UNIT
[Unit]
Description=CampusPulse API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}/backend
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=3
# Let the JSON store and nothing else be writable.
ProtectSystem=strict
ReadWritePaths=${DATA_DIR}
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR"
systemctl daemon-reload
systemctl enable --now campuspulse.service

# Give it a moment, then prove it is answering.
sleep 3
curl -fsS "http://127.0.0.1:${PORT}/api/health" && echo " <- CampusPulse is up on :${PORT}"
