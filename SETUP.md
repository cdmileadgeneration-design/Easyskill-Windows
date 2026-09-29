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
```
Then edit `.env` and `config.json` (see section 2).

### Requirements
- **Node.js 18+** (https://nodejs.org LTS) — `node -v` to verify
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
| `DATA_RETENTION_DAYS` | — | Purge old rows after N days | `90` |
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
  "monitoring": { "dataRetentionDays": 90 },
  "database":  { "provider": "mongodb", "dbName": "windows_monitoring" },
  "storage":   { "provider": "cloudinary" }
}
```

### 2.3 `agent/config.json` (target PC)

```jsonc
{
  "serverUrl": "https://easyskill-windows.onrender.com",  // dashboard URL
  "agentKey":  "e67279936040e5f781500265df6338e427e0a323d7c29d01", // must match server AGENT_KEY
  "machineName": "",
  "sendInterval": 10000,
  "screenshotInterval": 300000,
  "enableScreenshots": true
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

## 4. Install the agent on a target PC

**One script does everything:** `agent\deploy.ps1`

1. Copy the **`agent` folder** to the target PC.
2. Make sure **Node.js 18+** is installed there (`node -v`). No Node? The
   installer downloads a portable copy to `%ProgramData%` by itself.
3. Right-click **`agent\install.bat`** → **Run as administrator**
   (it just launches `deploy.ps1` with UAC).

Or from an elevated prompt, with optional flags:

```powershell
# defaults: server = https://easyskill-windows.onrender.com, key from agent\config.json
powershell -NoProfile -ExecutionPolicy Bypass -File agent\deploy.ps1

# explicit values, screenshots off
powershell -NoProfile -ExecutionPolicy Bypass -File agent\deploy.ps1 `
    -ServerUrl https://easyskill-windows.onrender.com `
    -AgentKey <same as server AGENT_KEY> -DisableScreenshots

# non-interactive (no prompts) - good for RMM / bulk rollout
powershell -NoProfile -ExecutionPolicy Bypass -File agent\deploy.ps1 -NonInteractive
```

What `deploy.ps1` does:
- copies files to `%ProgramData%\EasyskillMonitor` and writes `config.json` (no BOM)
- `npm install` if dependencies are missing
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
C:\ProgramData\EasyskillMonitor\supervisor.log  → supervisor started
C:\ProgramData\EasyskillMonitor\agent-<user>.log → All monitors started
                                                    Delivered N events
dashboard                                         → GET /api/agents lists the machine
```

**Update an already-installed agent** (after changing the URL/key):
```bat
:: on the target PC, as Admin - re-copies files, rewrites config, restarts
agent\install.bat
:: or by hand: edit %ProgramData%\EasyskillMonitor\config.json
:: then: powershell -ExecutionPolicy Bypass -File agent\deploy.ps1 -Status
```

**Uninstall:** `agent\uninstall.bat` (Run as administrator), or
`powershell -ExecutionPolicy Bypass -File agent\deploy.ps1 -Uninstall`
(stops the processes, removes both tasks and the install folder).

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
   AGENT_KEY=e67279936040e5f781500265df6338e427e0a323d7c29d01
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
| Screenshots on Amazon S3 | `STORAGE_PROVIDER=s3` + `S3_BUCKET`, `S3_REGION`, `S3_PREFIX`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (on EC2/ECS/Lambda the IAM role is used automatically) |
| Database on MongoDB Atlas | `DB_PROVIDER=mongodb` + `MONGODB_URI` |
| Database on local SQLite (offline/dev) | `DB_PROVIDER=sqlite` |

No code changes are needed — `dashboard/lib/db/*` and `dashboard/lib/storage/*`
are interchangeable adapters.

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
| Agent `401 authentication rejected - check agentKey` | `agentKey` ≠ server `AGENT_KEY`. Confirm the key the **server** is actually using: `curl https://easyskill-windows.onrender.com/api/agents` won't help - instead check the `AGENT_KEY` env var in the Render dashboard (it overrides `config.json` `security.agentKey`). Then re-run `deploy.ps1 -AgentKey <that value>` on the agent. |
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

:: ---- target PC (Admin) ----
agent\install.bat                         :: install / update agent (deploy.ps1)
agent\uninstall.bat                       :: remove agent + tasks
powershell -File agent\deploy.ps1 -Status :: agent health / task state
node monitor.js                           :: run agent in foreground (test)

:: ---- git ----
git add -A
git commit -m "message"
git push origin main                      :: triggers Render auto-deploy
```

**API smoke test**
```bash
curl https://easyskill-windows.onrender.com/api/health
curl -X POST https://easyskill-windows.onrender.com/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"username":"admin","password":"<ADMIN_PASSWORD>"}'
```
