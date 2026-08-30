#!/usr/bin/env bash
#
# EC2 user-data: run the CampusPulse backend on a free-tier instance IN DOCKER.
#
# The Docker alternative to ec2-userdata.sh. Paste it into "Advanced details →
# User data" when launching an Amazon Linux 2023 instance. It installs Docker,
# builds the image from the repo, and runs it as a container that restarts on
# crash and on reboot. Config comes from /etc/campuspulse.env; the JSON store
# lives in a named volume so it survives container rebuilds. Point DATABASE_URL
# at RDS in that env file to use Postgres instead.
#
# Cloud-init runs user-data only on first boot. To redeploy later, see the
# "update" note in README.md (git pull, rebuild, restart the container).
set -euxo pipefail

REPO_URL="https://github.com/ayushdebnath012/CampusPulse.git"
APP_DIR="/opt/campuspulse"
ENV_FILE="/etc/campuspulse.env"
IMAGE="campuspulse-api"
CONTAINER="campuspulse"
PORT="8787"

# --- Docker ---------------------------------------------------------------
dnf install -y docker git
systemctl enable --now docker

# --- code -----------------------------------------------------------------
if [ ! -d "$APP_DIR/.git" ]; then
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

# --- configuration --------------------------------------------------------
# Only the essentials; the full list is in README.md and backend/.env.example.
# Set DATABASE_URL + DATABASE_SSL=true here to run against RDS. Keep 0600 — it
# holds secrets once you add any.
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
PORT=${PORT}
DATABASE_PATH=/data/campuspulse.json
ALLOWED_ORIGINS=https://ayushdebnath012.github.io,https://localhost,capacitor://localhost,http://localhost
ALLOW_DEV_VERIFICATION_CODE=false
ENV
  chmod 600 "$ENV_FILE"
fi

# --- build + run ----------------------------------------------------------
docker build -t "$IMAGE" "$APP_DIR/backend"
docker rm -f "$CONTAINER" 2>/dev/null || true
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  -p "${PORT}:${PORT}" \
  -v campuspulse-data:/data \
  "$IMAGE"

# Prove it is answering (the image's own HEALTHCHECK will also track this).
sleep 5
curl -fsS "http://127.0.0.1:${PORT}/api/health" && echo " <- CampusPulse (Docker) is up on :${PORT}"
