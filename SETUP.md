# Easyskill-Windows — Complete Setup Guide

Everything you need to run this project: local setup, agent on target PCs,
cloud deployment (Render), and the future AWS migration path.

---

## 0. What is in this project

| Part | Folder | Runs where | Purpose |
|------|--------|-----------|---------|
| Dashboard (server) | `dashboard/` | Your PC **or** Render | REST API + web UI, stores data |
| Agent | `agent/` | Every target/monitored PC | Collects apps, websites, files, USB, screenshots and sends them to the dashboard |
| Config template | `config.example.json` | — | Copied to `config.json` by `setup.bat` |
| Env template | `.env.example` | — | Copied to `.env` by `setup.bat` |
| Render guide | `deploy.txt` | — | Step-by-step Render deployment |

**Data flow:** `agent (target PC)` → `https://…/api/agent/*` → `dashboard` → `MongoDB` (data) + `Cloudinary` (screenshot files)

**Config precedence (dashboard/config.js):**
```
environment / .env   >   config.json   >   built-in defaults
```
So on Render you only need environment variables — `config.json` is optional.

---

## 1. First-time setup (your machine)

### Option A — automatic (recommended)
Double-click **`setup.bat`** (or run it from a terminal).

It will:
1. Check Node.js + npm
2. Create `.env` from `.env.example` if missing
3. Create `config.json` from `config.example.json` if missing (generates a random `jwtSecret`)
4. `npm install` for `dashboard/` and `agent/`
5. Validate the config and optionally start the dashboard

### Option B — manual
```bat
copy .env.example .env
copy config.example.json config.json
cd dashboard && npm install && cd ..
cd agent    && npm install && cd ..
cd tools    && npm install && cd ..    # build tooling, only for the single-file exe
```
Then edit `.env` and `config.json` (see section 2).

### Requirements
- **Node.js 18+** (https://nodejs.org LTS) — `node -v` to verify (your dev
  machine only; a target PC with `agent\dist\` needs none of this)
- Internet for `npm install` and for MongoDB/Cloudinary access

---

## 2. Configuration reference

### 2.1 `.env` (secrets & cloud services) — used by the dashboard

| Key | Required | Meaning | Example / default |
|-----|----------|---------|-------------------|
| `DB_PROVIDER` | ✅ | `mongodb` or `sqlite` | `mongodb` |
| `MONGODB_URI` | ✅ if mongodb | Atlas/connection string | `mongodb+srv://user:pass@cluster0…` |
| `MONGODB_DB` | ✅ | Database name | `windows_monitoring` |
| `STORAGE_PROVIDER` | ✅ | `cloudinary` / `local` / `s3` | `cloudinary` |
| `CLOUDINARY_CLOUD_NAME` | ✅ if cloudinary | Cloud name | `dxxxxxxxx` |
| `CLOUDINARY_API_KEY` | ✅ if cloudinary | API key | |
| `CLOUDINARY_API_SECRET` | ✅ if cloudinary | API secret | |
| `CLOUDINARY_FOLDER` | — | Folder in Cloudinary | `windows-monitoring/screenshots` |
| `PORT` | — | **Do not set on Render** (Render assigns it) | `3000` locally |
| `HOST` | — | Bind address | `0.0.0.0` |
| `JWT_SECRET` | ⚠️ | Overrides `config.json` `security.jwtSecret` | long random string |
| `AGENT_KEY` | ⚠️ | Overrides `config.json` `security.agentKey` | must match agent |
| `ADMIN_USER` / `ADMIN_PASSWORD` | — | Dashboard login | `admin` / `admin` (change it!) |
| `ADMIN_PASSWORD_HASH` | — | bcrypt hash instead of plaintext | `$2a$12$…` |
| `DATA_RETENTION_DAYS` | — | Purge old rows after N days | `15` |
| `S3_BUCKET`, `S3_REGION`, `S3_PREFIX`, `AWS_*` | only for S3 | AWS storage | |

> `.env` and `config.json` are **git-ignored** — never commit real secrets.

### 2.2 `config.json` (local defaults)

```jsonc
{
  "dashboard": { "port": 3000, "host": "0.0.0.0" },
  "security": {
    "jwtSecret": "<random>",
    "agentKey": "<must equal agent/config.json agentKey>",
    "adminUser": "admin",
    "adminPassword": "admin",       // or adminPasswordHash
    "sessionTimeout": 86400000
  },
  "monitoring": { "dataRetentionDays": 15 },
  "database":  { "provider": "mongodb", "dbName": "windows_monitoring" },
  "storage":   { "provider": "cloudinary" }
}
```

### 2.3 `agent/config.json` (target PC)

```jsonc
{
  "serverUrl": "http://3.111.38.240",  // dashboard URL
  "agentKey":  "6138abd7e31445f9e92c04a55087517fc1869699d2128b04b78cd18381506545", // must match server AGENT_KEY
  "machineName": "",
  "sendInterval": 10000,
  "screenshotInterval": 120000,
  "enableScreenshots": true,
  "screenshotMaxWidth": 1920,  // screenshots are downscaled to this width
  "screenshotQuality": 70      // JPEG quality (30-90)
}
```

---

## 3. Run the dashboard locally

```bat
cd dashboard
npm start          # production
npm run dev        # auto-reload (nodemon)
```

Open **http://localhost:3000** → login `admin / admin` (change it!).

Verify:
```
GET http://localhost:3000/api/health
   → {"status":"ok","db":"mongodb","storage":"cloudinary"}
```

Useful scripts:
```bat
node dashboard/set-password.js admin "YourNewStrongPass"   // change admin password
node dashboard/check-db.js                                  // inspect sqlite schema (sqlite mode)
```

---

## 3b. Build the single-file agent executable (recommended)

Turns the agent into **one Windows executable**, so the employee's machine gets
no Node.js runtime, no `node_modules\` and no process named `node.exe`:

```bat
cd tools
npm install
node build.js
```

Output: `agent\dist\TelemetryHost.exe` (~88 MB - most of it *is* the embedded
Node.js runtime).

- `deploy.ps1` picks it up automatically from `dist\` and skips the Node/npm
  path completely. Delete `dist\` to fall back to a source install.
- Rename what shows up in Task Manager with `set EASYSKILL_EXE_NAME=YourName.exe`
  before building. Keep it bland and **never** copy a real Windows system
  binary name - that trips antivirus and is a bad idea anyway.
- The SEA fuse sentinel is read out of `node.exe` at build time, so rebuilding
  after a Node upgrade does not need a script change.
- Rebuild whenever anything under `agent\` changes.

Next to the exe the installer also ships `scripts\*.ps1` (session launcher),
`sql-wasm.wasm` (browser history reader), `config.json` and `state\`.

Not hideable: a running process still appears in Task Manager - only a kernel
driver could change that and it would look like malware. There is no window,
no tray icon and no installer UI.

---

## 4. Install the agent on a target PC

**One script does everything:** `agent\deploy.ps1`

1. Build the single-file executable once on your dev machine:
   `node tools\build.js` → `agent\dist\TelemetryHost.exe`
   (skip this only if you want a plain Node.js install instead).
2. Copy the **`agent` folder** (including `dist\`) to the target PC.
3. Right-click **`agent\install.bat`** → **Run as administrator**
   (it just launches `deploy.ps1` with UAC). It asks you for the **PC name**
   to show on the dashboard (Enter keeps the current default), then to set an
   **uninstall password** - write it down, it is needed to remove the agent.

The target PC needs **no Node.js, no npm and no internet to install** when
`dist\` is present - the installer just copies one executable. Without `dist\`
it falls back to Node.js: install Node 18+ there, or let the script download a
portable copy to `%ProgramData%` by itself.

Or from an elevated prompt, with optional flags:

```powershell
# defaults: server = http://3.111.38.240, key from agent\config.json,
# screenshots every 120 s (2 minutes), PC name prompted
powershell -NoProfile -ExecutionPolicy Bypass -File agent\deploy.ps1

# explicit values, custom PC name, screenshots off
powershell -NoProfile -ExecutionPolicy Bypass -File agent\deploy.ps1 `
    -ServerUrl http://3.111.38.240 `
    -AgentKey <same as server AGENT_KEY> `
    -MachineName "OFFICE-PC-01" -DisableScreenshots

# non-interactive (no prompts) - good for RMM / bulk rollout.
# -SetUninstallPassword is required here; without it a random one is
# generated and printed once at the end of the output.
powershell -NoProfile -ExecutionPolicy Bypass -File agent\deploy.ps1 -NonInteractive `
    -MachineName "OFFICE-PC-01" `
    -SetUninstallPassword 'your-kept-secret'

# change the uninstall password on an already-installed PC
powershell -NoProfile -ExecutionPolicy Bypass -File agent\deploy.ps1 -SetUninstallPassword 'new-secret'
```

What `deploy.ps1` does:
- copies files to `%ProgramData%\EasyskillMonitor` and writes `config.json` (no BOM)
- with `dist\` present: installs the single executable (no runtime, no
  `node_modules`, no process called `node.exe` on the employee's machine);
  otherwise `npm install` if dependencies are missing
- **locks the install folder down**: the logged-in employee gets read+execute
  only on everything except `state\`, so they cannot create, overwrite or
  delete any agent file (details below)
- registers two scheduled tasks under `\Easyskill\`:
  - **AgentSupervisor** - runs at boot *and* at every logon, restarts on
    failure (999 retries, 1 min apart), never times out
  - **AgentKeeper** - every 60 s, restarts the supervisor if it is missing
- the supervisor starts a **separate agent inside each logged-in user's
  session** (a service alone cannot see that user's Chrome history or the
  foreground window), and relaunches it if it dies
- starts everything now and verifies processes + dashboard reachability

Why scheduled tasks instead of a Windows service: a service runs in
session 0 and cannot read another user's Chrome history, clipboard or the
foreground window. The SYSTEM task only acts as a supervisor; the actual
collector is launched into the interactive session via `CreateProcessAsUser`.

**Folder permissions (tamper resistance)**

| Path | Owner / rights |
|---|---|
| `%ProgramData%\EasyskillMonitor` and everything in it | SYSTEM + Administrators: full. **Users: read + execute only** (no create, no write, no delete) |
| `%ProgramData%\EasyskillMonitor\state\` | Users: **modify** - the only place the agent writes (logs, event outbox) |

Inheritance is disabled, so a file the employee drops anywhere else in the
folder is impossible, and `CREATOR OWNER` cannot hand them control of files
the agent creates. `deploy.ps1` also runs `takeown` first: files written by
the SYSTEM supervisor are owned by SYSTEM and would otherwise be
un-editable by the installer.

Killing the agent only buys a few seconds - the supervisor relaunches it
within 10 s and the keeper within 60 s. A user can always terminate their
own process (a Windows rule no installer can override), but it comes back.

Quick test without installing anything:
```bat
cd agent
node monitor.js
```

**Check it is connected**
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File agent\deploy.ps1 -Status
```
```
C:\ProgramData\EasyskillMonitor\supervisor.log         → supervisor started
C:\ProgramData\EasyskillMonitor\state\agent-<user>.log → All monitors started
                                                         Delivered N events
dashboard                                              → GET /api/agents lists the machine
```

**Update an already-installed agent** (after changing the URL/key):
```bat
:: on the target PC, as Admin - re-copies files, rewrites config, restarts
agent\install.bat
:: or by hand: edit %ProgramData%\EasyskillMonitor\config.json
:: then: powershell -ExecutionPolicy Bypass -File agent\deploy.ps1 -Status
```
Re-running the installer keeps the existing uninstall password; pass
`-SetUninstallPassword` only if you want to change it.

**Uninstall (password-protected):** `agent\uninstall.bat` (Run as
administrator), or
`powershell -ExecutionPolicy Bypass -File agent\deploy.ps1 -Uninstall`
- prompts for the uninstall password (mask the input; only a salted
  SHA-256 hash of it is stored, in `config.json` → `security`)
- refuses without it: `-NonInteractive` with no `-UninstallPassword`, or a
  wrong password, exits with code 1 and removes nothing
- stops the processes, removes both tasks and the install folder
- if a password was ever set, `-Force` will *not* bypass it - delete
  `config.json` first if it is genuinely lost (that needs admin anyway)

> Agent features: application usage, website visits, file activity, USB events,
> processes, network connections, system/idle events, screenshots (encrypted
> before they leave the PC), disk outbox with retry/backoff and exactly-once
> batch delivery (a retry never duplicates data).

---

## 5. Deploy on Render (live)

Full detail with the exact screen fields is in **`deploy.txt`**. Short version:

1. Render → **New → Web Service** → connect this repo
2. Root Directory `dashboard/` · Build `npm install` · Start `node server.js`
3. Health Check Path `/api/health`
4. Environment variables:
   ```
   DB_PROVIDER=mongodb
   MONGODB_URI=...
   MONGODB_DB=windows_monitoring
   STORAGE_PROVIDER=cloudinary
   CLOUDINARY_CLOUD_NAME=...
   CLOUDINARY_API_KEY=...
   CLOUDINARY_API_SECRET=...
   JWT_SECRET=<random>
   AGENT_KEY=6138abd7e31445f9e92c04a55087517fc1869699d2128b04b78cd18381506545
   ADMIN_USER=admin
   ADMIN_PASSWORD=<strong>
   ```
   (Do **not** set `PORT` — Render provides it.)
5. Deploy → open `https://<service>.onrender.com`
6. Point agents: `agent/config.json` → `"serverUrl": "https://<service>.onrender.com"`

**Why you cannot use the defaults on Render**
- Render's disk is **ephemeral** → `DB_PROVIDER=sqlite` and
  `STORAGE_PROVIDER=local` would lose everything on each deploy.
  Use `mongodb` + `cloudinary` (or `s3`).
- Free tier sleeps → first request after idle takes 30–60 s (agents retry automatically).

---

## 6. Switching storage / database

| Goal | Change |
|------|--------|
| Screenshots on Cloudinary (default) | `STORAGE_PROVIDER=cloudinary` + 3 Cloudinary keys |
| Screenshots on local disk (dev only) | `STORAGE_PROVIDER=local` |
| Screenshots on Amazon S3 | `npm run setup-s3` (see below), or `STORAGE_PROVIDER=s3` + `S3_BUCKET`, `S3_REGION`, `S3_PREFIX` and an IAM role / `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` |
| Database on MongoDB Atlas | `DB_PROVIDER=mongodb` + `MONGODB_URI` |
| Database on local SQLite (offline/dev) | `DB_PROVIDER=sqlite` |

No code changes are needed — `dashboard/lib/db/*` and `dashboard/lib/storage/*`
are interchangeable adapters.

### Screenshots on S3 with automatic 15-day deletion

One command creates the bucket, blocks public access, enables encryption and
adds a lifecycle rule that deletes screenshots N days (default 15) after upload:

```bash
cd dashboard
npm run setup-s3 -- --region ap-south-1 --days 15
```

It reuses your bucket if you already have one (`--bucket my-shots`), reads the
lifecycle rule back to confirm it, then writes `STORAGE_PROVIDER=s3`,
`S3_BUCKET`, `S3_REGION`, `S3_PREFIX` and `DATA_RETENTION_DAYS` into `.env`.
Restart the dashboard afterwards.

Existing screenshots keep working: every stored blob records the provider it
was written to, so history on local disk / Cloudinary still opens and is still
deleted by the retention purge. Only new captures go to S3.

On EC2 attach an IAM role with `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`
on `<bucket>/screenshots/*` plus `s3:ListBucket` on `<bucket>` — no keys needed
in `.env` (the script prints the exact policy JSON).

Already have a bucket and rule? Point the dashboard at it instead of creating a
new one — this only rewrites `.env` and re-checks the bucket:

```bash
cd dashboard
npm run setup-s3 -- --bucket your-bucket-name --region ap-south-1 --days 15
```

Then restart the dashboard and prove the wiring works from that same machine:

```bash
npm run verify-s3
```

It checks credentials and the bucket, prints the lifecycle rule it finds, and
writes/reads/deletes one throwaway object through the dashboard's own S3
adapter. `RESULT: PASS` means new captures are going to S3; the command names
the exact fix when something is wrong (missing IAM permissions, wrong region,
no credentials, unreachable endpoint).

Retention runs twice: S3 deletes the objects after N days, and the dashboard's
hourly purge removes the matching database rows and blobs older than
`DATA_RETENTION_DAYS` (the *Purge Old Data* button in Settings does it on demand).

---

## 7. AWS migration (future)

The project is already written for it:

- **Storage:** set `STORAGE_PROVIDER=s3` → `dashboard/lib/storage/s3.js` (AWS SDK v3,
  default credential chain: env keys locally, IAM role on AWS).
- **Database:** keep `DB_PROVIDER=mongodb` (Atlas works from AWS), or add a new
  backend next to `dashboard/lib/db/mongo.js` / `sqlite.js` implementing the same
  methods.
- **Secrets:** all config comes from environment variables → AWS Secrets Manager /
  ECS task env vars work with zero code change.
- **Hosting:** build command `npm install`, start `node server.js`, health check
  `/api/health` — same commands work on ECS/Fargate, Elastic Beanstalk or Lambda+API Gateway.
- Set `HOST=0.0.0.0` and read `PORT` from the environment (already supported).

---

## 8. Security checklist

- [ ] Change `admin/admin` → `node dashboard/set-password.js admin "StrongPass"`
      (then set `ADMIN_PASSWORD_HASH` in Render, or `ADMIN_PASSWORD`)
- [ ] Set a strong `JWT_SECRET` (64+ hex chars)
- [ ] `AGENT_KEY` identical on server (`AGent_KEY` env / `config.json`) and every `agent/config.json`
- [ ] MongoDB: strong password, restrict Atlas IP access where possible
- [ ] `.env` and `config.json` stay out of git (already git-ignored)
- [ ] Serve only over HTTPS (Render gives you this automatically)

---

## 9. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `Cannot read config.json` / weak jwtSecret warning | Run `setup.bat` to generate `config.json`, or set `JWT_SECRET` in `.env` |
| `DB_PROVIDER=mongodb but MONGODB_URI is empty` | Fill `MONGODB_URI` in `.env` / Render env |
| MongoDB "server selection timed out" | Atlas Network Access must allow your IP (`0.0.0.0/0` for Render) |
| `[Storage] cloudinary … credentials are incomplete` | `CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET` not all set → falls back to local disk |
| Agent `401 authentication rejected - check agentKey` | `agentKey` ≠ server `AGENT_KEY`. Confirm the key the **server** is actually using: `curl http://3.111.38.240/api/agents` won't help - instead check the `AGENT_KEY` env var on the server (it overrides `config.json` `security.agentKey`). Then re-run `deploy.ps1 -AgentKey <that value>` on the agent. |
| Agent shows no data | Check `agent/agent.log`; confirm `/api/health` and `/api/agents` |
| Screenshot `404 File not found` | Blob missing/retention-deleted in Cloudinary, or wrong keys |
| Login always fails | `ADMIN_USER`/`ADMIN_PASSWORD`/`ADMIN_PASSWORD_HASH` mismatch → restart service after changing |
| Render restarts the service | Health check failing → set Health Check Path to `/api/health` |
| Cold start slow (30–60 s) | Render free tier sleeps → use a paid instance or a keep-alive ping |
| `node-windows` install error | obsolete - `agent/package.json` no longer uses `node-windows`; use `deploy.ps1` |

---

## 10. Everyday commands

```bat
:: ---- your machine ----
setup.bat                                 :: first-time setup / reinstall deps
cd dashboard && npm start                 :: run dashboard locally
node dashboard/set-password.js admin "X"  :: change admin password
cd tools && node build.js                 :: rebuild agent\dist\TelemetryHost.exe

:: ---- target PC (Admin) ----
agent\install.bat                         :: install / update agent (deploy.ps1)
agent\uninstall.bat                       :: remove agent + tasks
powershell -File agent\deploy.ps1 -Status :: agent health / task state
node monitor.js                           :: run agent from source (test)

:: ---- git ----
git add -A
git commit -m "message"
git push origin main                      :: triggers Render auto-deploy
```

**API smoke test**
```bash
curl http://3.111.38.240/api/health
curl -X POST http://3.111.38.240/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"username":"admin","password":"<ADMIN_PASSWORD>"}'
```
