# Deploy the CampusPulse backend on AWS free tier

The backend is a plain Node 20 / Express app that listens on `PORT` and stores
data either in a JSON file (`DATABASE_PATH`, the default) or Postgres
(`DATABASE_URL`). That makes a single **EC2 t3.micro** (or `t2.micro`) the
cheapest home for it: the 12-month free tier covers 750 instance-hours a month —
one instance running around the clock — plus 30 GB of EBS. The JSON store lives
on that disk, so no database bill.

[`ec2-userdata.sh`](./ec2-userdata.sh) does the whole install: Node 20, checkout
to `/opt/campuspulse`, `npm ci --omit=dev`, and a systemd service that restarts
on crash and on reboot. It mirrors `render.yaml`.

## Full cutover off Vercel + CockroachDB

Today the API runs on **Vercel** (`campuspulse-api-ayush.vercel.app`) against a
**CockroachDB Cloud** trial that is expiring. This moves both onto AWS free tier:
compute to EC2, data to RDS Postgres. No code changes — Vercel runs the app
through `backend/api/*.js`, EC2 runs the same `createApp` through
`backend/src/server.js`. Do it in this order so nothing is lost and there is no
window where the apps point at a dead host:

1. **RDS Postgres** — create it first (see
   [migrate-cockroach-to-rds.md](./migrate-cockroach-to-rds.md) step 1), in the
   VPC the EC2 box will share.
2. **EC2 backend** — launch with [`ec2-userdata.sh`](./ec2-userdata.sh) (the
   console/CLI steps below). It comes up on the JSON store; that is fine, it is
   about to be repointed.
3. **Migrate the data** — run the copy from the EC2 box
   ([migrate-cockroach-to-rds.md](./migrate-cockroach-to-rds.md) step 2), then
   set `DATABASE_URL` + `DATABASE_SSL=true` in `/etc/campuspulse.env` and restart
   (step 3). The API is now EC2 + RDS, still on `http://<ip>:8787`.
4. **HTTPS** — point a domain at the instance and run
   [`enable-https.sh`](./enable-https.sh) (see "Put it on HTTPS"). The apps
   require `https://`, so this is what makes the new host usable by them.
5. **Repoint the apps** — `defaultApiBase` in `public/config.js` is already set
   to `https://campuspulse.duckdns.org`; register that exact DuckDNS name (or
   change the one line to the name you get). Then `npm run android:sync`,
   `npm run ios:sync`, and redeploy GitHub Pages. Until this ships, installed
   apps still call Vercel.
6. **Decommission** — only after step 5 is live and verified: remove the
   `TARGET_DATABASE_URL`/other secrets from the Vercel project (or delete the
   project), and let the CockroachDB trial lapse. Keep the Cockroach connection
   string until you are certain — a re-copy is impossible once the cluster is
   deleted.

The rest of this file details each piece.

## Launch it (console)

1. **EC2 → Launch instance.**
   - AMI: **Amazon Linux 2023**.
   - Type: **t3.micro** (free-tier eligible in most regions; use `t2.micro`
     where t3 is not).
   - Key pair: create or pick one so you can SSH in.
   - Network → **Security group**, allow inbound:
     - TCP **22** from *your IP only* (SSH).
     - TCP **80** and **443** from `0.0.0.0/0` (HTTPS — see below).
     - TCP **8787** from *your IP only* while you test before TLS is set up;
       once nginx is in front you can remove it (nginx reaches the app over
       localhost).
   - **Advanced details → User data**: paste the contents of
     `ec2-userdata.sh`.
2. Launch. First boot runs the script (~2–3 min). Then from your machine:
   ```bash
   curl http://<EC2_PUBLIC_IP>:8787/api/health
   ```
   `{"status":"ok"}` means you are live.

## Launch it (AWS CLI)

With the CLI configured (`aws configure`) and a key pair and security group id
in hand:

```bash
aws ec2 run-instances \
  --image-id resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 \
  --instance-type t3.micro \
  --key-name <your-key> \
  --security-group-ids <sg-id> \
  --user-data file://deploy/aws/ec2-userdata.sh \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=campuspulse-api}]'
```

## Give it a stable IP (Elastic IP)

A plain instance's public IP changes every stop/start, which would break the
DuckDNS record and the cert. An **Elastic IP** pins it — and it is free while
associated with a running instance (AWS only bills an EIP that is allocated but
not attached). Do this once, before pointing DuckDNS:

```bash
ALLOC=$(aws ec2 allocate-address --domain vpc \
  --tag-specifications 'ResourceType=elastic-ip,Tags=[{Key=Name,Value=campuspulse}]' \
  --query AllocationId --output text)
aws ec2 associate-address --instance-id <i-xxxx> --allocation-id "$ALLOC"
aws ec2 describe-addresses --allocation-ids "$ALLOC" \
  --query 'Addresses[0].PublicIp' --output text     # -> point DuckDNS at this
```

Then set the DuckDNS A record to that IP (see "Put it on HTTPS"). If you later
tear the stack down, release the address (`aws ec2 release-address
--allocation-id "$ALLOC"`) so it does not accrue charges while detached.

## Run it with Docker (alternative)

Instead of installing Node on the host, you can run the API as a container. The
image is [`backend/Dockerfile`](../../backend/Dockerfile) (Node 20 Alpine,
non-root, its own `/api/health` HEALTHCHECK, JSON store on a `/data` volume).

- **Locally**, from the repo root:
  ```bash
  docker compose up --build            # JSON store, http://localhost:8787
  # or against a database:
  DATABASE_URL='postgresql://user:pass@host:5432/campuspulse' DATABASE_SSL=true \
    docker compose up --build
  # or spin a throwaway local Postgres to exercise the DB path:
  DATABASE_URL='postgresql://campuspulse:campuspulse@db:5432/campuspulse' DATABASE_SSL=false \
    docker compose --profile local up --build
  ```
- **On EC2**, use [`ec2-userdata-docker.sh`](./ec2-userdata-docker.sh) as the
  user-data instead of `ec2-userdata.sh`. It installs Docker, builds the image,
  and runs it with `--restart unless-stopped` and the `campuspulse-data` volume,
  reading config from `/etc/campuspulse.env`. Everything else in this guide —
  security group, HTTPS, RDS, migration — is identical; only how the process is
  supervised changes. To update: `git pull`, `docker build -t campuspulse-api
  backend`, then `docker rm -f campuspulse && docker run …` (same flags), or
  `docker compose up -d --build` if you copy the compose file to the box.

## Configuration

The service reads `/etc/campuspulse.env`. The bootstrap writes the essentials;
add any of these and `sudo systemctl restart campuspulse` to apply:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. Set it to move off the JSON file onto RDS. |
| `DATABASE_SSL` | `true` when RDS enforces TLS. |
| `RESEND_API_KEY` / `BREVO_API_KEY` / `SMTP_*` | Email delivery for sign-up codes and password reset. Without one, those routes return 503. |
| `EMAIL_FROM` | Sender address for the above. |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Android/iOS push. Optional. |
| `COURSE_OWNER_EMAILS_JSON`, `PROFESSOR_PROFILE_OVERRIDES_JSON` | Private roster/profile seeding. Optional. |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist. Preset for GitHub Pages + Capacitor. |

The full list lives in `backend/.env.example`.

## Put it on HTTPS

The installed Android/iOS apps talk to `https://`, and browsers block mixed
content, so a bare `http://<ip>:8787` endpoint is fine for testing but will not
drop in as the API the shipped apps use until it has TLS.
[`enable-https.sh`](./enable-https.sh) does that with nginx + a free Let's
Encrypt certificate. It runs on the instance, *after* the API is up, and needs a
domain you control:

1. Point an **A record** for your domain at the instance's public IP, and
   confirm the security group allows inbound **80** and **443**.

   Using a free **DuckDNS** name (`campuspulse.duckdns.org`)? Register it at
   duckdns.org, then set its A record straight from the instance — an empty `ip`
   makes DuckDNS use the caller's address, which is the EC2 public IP:
   ```bash
   curl "https://www.duckdns.org/update?domains=campuspulse&token=<your-duckdns-token>&ip="
   ```
   Re-run that after any stop/start, since a plain instance's public IP changes;
   an Elastic IP avoids that.
2. On the instance:
   ```bash
   sudo /opt/campuspulse/deploy/aws/enable-https.sh campuspulse.duckdns.org you@example.edu
   ```
   It installs nginx as a reverse proxy to `127.0.0.1:8787`, obtains and installs
   the cert, forces `http → https`, and schedules twice-daily renewal. It refuses
   to run (with a clear message) if DNS is not yet pointing at the box, so a
   mistyped record fails fast instead of burning a Let's Encrypt rate-limit.
3. Verify: `curl https://campuspulse.duckdns.org/api/health`. Then you can remove public
   `:8787` from the security group — nginx reaches the app over localhost.

Add that origin to CORS if a browser app will be served from it: set
`ALLOWED_ORIGINS` in `/etc/campuspulse.env` and
`sudo systemctl restart campuspulse`.

(No domain? The ALB + ACM route also gives HTTPS, but the load balancer is not
free-tier.)

## A fresh instance starts empty

- **It comes up with no data.** No courses, no rosters — a professor creates
  those in the app after sign-up. This is a *new* deployment, separate from the
  data on `campuspulse-api-ayush.vercel.app`; it does not copy anything from
  there. To carry real data over, migrate the Postgres database, not the server —
  including **off the CockroachDB Cloud trial before it deletes the cluster**:
  see [migrate-cockroach-to-rds.md](./migrate-cockroach-to-rds.md).

## Update an already-running instance

User-data runs only on first boot, so redeploys are a pull:

```bash
ssh ec2-user@<EC2_PUBLIC_IP>
cd /opt/campuspulse && sudo git pull
cd backend && sudo npm ci --omit=dev
sudo systemctl restart campuspulse
```
