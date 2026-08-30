# Move the database off CockroachDB Cloud onto AWS RDS

**Why now:** the CockroachDB Cloud free trial deletes the cluster when it ends,
and that cluster holds the live student records. This copies them to a free-tier
**RDS Postgres** and repoints the app. Do the copy *before* the trial expires —
once the cluster is deleted the data is gone.

The whole database is a single JSONB row (`campuspulse_store`, id 1), and
[`backend/scripts/migrate-postgres.js`](../../backend/scripts/migrate-postgres.js)
already copies and verifies it between any two Postgres-wire databases.
CockroachDB and RDS both qualify, so this is a straight copy, not a schema
conversion.

## 1. Create the RDS Postgres (free tier)

RDS → Create database → **Standard create**, engine **PostgreSQL**:

- Templates: **Free tier** (gives `db.t3.micro` / `db.t4g.micro`, 20 GB, single-AZ).
- Set a master username and password; DB name `campuspulse`.
- **Connectivity:** put it in the **same VPC** as the EC2 instance. Do **not**
  make it publicly accessible — instead, in its security group allow inbound
  **5432 from the EC2 instance's security group only**. The API reaches it
  privately; nothing on the internet can.
- Leave "Encrypt connections" / TLS on (RDS default). The app connects with
  `DATABASE_SSL=true`.

Note the endpoint: `campuspulse.xxxx.<region>.rds.amazonaws.com:5432`. The
connection string is:

```
postgresql://<master-user>:<password>@<endpoint>:5432/campuspulse
```

### Or via AWS CLI

Same thing without the console. Fill in your VPC id and the EC2 instance's
security group id (`<sg-ec2>`), and pick a master password (8–128 chars, avoid
`/ @ " ' `). This keeps RDS private — reachable only from the EC2 security group.

```bash
# 1. A security group for the database, open on 5432 to the EC2 SG only.
SG_RDS=$(aws ec2 create-security-group \
  --group-name campuspulse-rds --description "CampusPulse RDS" \
  --vpc-id <vpc-id> --query GroupId --output text)
aws ec2 authorize-security-group-ingress \
  --group-id "$SG_RDS" --protocol tcp --port 5432 --source-group <sg-ec2>

# 2. The instance itself: free-tier db.t3.micro, 20 GB, single-AZ, not public.
#    (Use db.t4g.micro where t3 is not free-tier eligible.)
aws rds create-db-instance \
  --db-instance-identifier campuspulse \
  --engine postgres \
  --db-instance-class db.t3.micro \
  --allocated-storage 20 --storage-type gp2 --no-multi-az \
  --db-name campuspulse \
  --master-username campuspulse \
  --master-user-password '<password>' \
  --vpc-security-group-ids "$SG_RDS" \
  --no-publicly-accessible \
  --backup-retention-period 7

# 3. Wait for it, then print the endpoint host for the connection string.
aws rds wait db-instance-available --db-instance-identifier campuspulse
aws rds describe-db-instances --db-instance-identifier campuspulse \
  --query 'DBInstances[0].Endpoint.Address' --output text
```

If the EC2 box is **not** in your account's default VPC, RDS needs a subnet
group first: `aws rds create-db-subnet-group --db-subnet-group-name campuspulse
--db-subnet-group-description CampusPulse --subnet-ids <subnet-a> <subnet-b>`,
and add `--db-subnet-group-name campuspulse` to `create-db-instance`. In the
default VPC this is not needed.

## 2. Run the copy from the EC2 box

The EC2 instance already has Node and the `pg` module (from
`npm ci` in the bootstrap), and it can reach both databases — Cockroach over the
internet, RDS over the private VPC link. SSH in and run
[`run-migration.js`](../../backend/scripts/run-migration.js), which handles the
TLS both managed providers require:

```bash
cd /opt/campuspulse/backend

# The Cockroach URL is your current production DB secret — the value of
# TARGET_DATABASE_URL in the Vercel/backend environment today.
SOURCE_DATABASE_URL='postgresql://…@…cockroachlabs.cloud:26257/defaultdb?sslmode=require' \
TARGET_DATABASE_URL='postgresql://<user>:<pass>@<rds-endpoint>:5432/campuspulse' \
MIGRATION_CONFIRM=copy-campuspulse \
node scripts/run-migration.js
```

Success prints `copied and verified at revision <n>`. The script reads one row,
writes it in a transaction, then re-reads and `deepEqual`-checks it against the
source before reporting success, so a partial copy fails loudly rather than
silently. If you must re-run after a partial attempt, add
`ALLOW_TARGET_OVERWRITE=true`.

> Keep the Cockroach cluster alive until step 4 confirms the app is happily on
> RDS. The copy is non-destructive — it never touches the source — so you can
> repeat it.

## 3. Repoint the app at RDS

The app connects to `TARGET_DATABASE_URL || DATABASE_URL`
([app.js:986](../../backend/src/app.js#L986)); the label "CockroachDB" is only
cosmetic. Switch the environment to RDS and **remove the Cockroach secret** so
there is no ambiguity:

- On **EC2** (recommended — same VPC as RDS): edit `/etc/campuspulse.env`:
  ```
  DATABASE_URL=postgresql://<user>:<pass>@<rds-endpoint>:5432/campuspulse
  DATABASE_SSL=true
  ```
  remove any `TARGET_DATABASE_URL` line, then `sudo systemctl restart campuspulse`.
- If instead you keep the backend on **Vercel**: set `DATABASE_URL` + `DATABASE_SSL=true`
  there, delete `TARGET_DATABASE_URL`, and redeploy. But Vercel is outside the
  VPC, so this forces RDS to be **publicly accessible** with 5432 open to the
  internet — a much weaker posture than the EC2 path. Prefer moving compute to
  EC2 so RDS can stay private.

## 4. Verify, then decommission Cockroach

```bash
curl https://<your-domain-or-ec2>/api/health     # {"status":"ok"}
```

Then sign in and spot-check real data — a course roster, a past attendance
register — to confirm it is the migrated data, at the revision step 2 reported.
Only once that checks out, let the CockroachDB trial lapse (or delete the
cluster). Keep the connection string until you are certain; a re-copy is
impossible after the cluster is gone.

## Insurance: take a file backup too

Because this is irreversible once Cockroach is deleted, it is worth also dumping
the row to a file you keep off any cloud. From the EC2 box:

```bash
cd /opt/campuspulse/backend
node -e '
  const { Client } = require("pg");
  const c = new Client({ connectionString: process.env.SOURCE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  c.connect()
    .then(() => c.query("SELECT data, revision FROM campuspulse_store WHERE id = 1"))
    .then(r => { process.stdout.write(JSON.stringify(r.rows[0])); return c.end(); })
    .catch(e => { console.error(e.message); process.exit(1); });
' SOURCE_DATABASE_URL='postgresql://…cockroachlabs.cloud…?sslmode=require' > campuspulse-backup.json
```

`campuspulse-backup.json` is the entire database. Copy it off the instance
(`scp`) and keep it until the RDS deployment has proven itself.
