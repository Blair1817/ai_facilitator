# NAS Deployment Artefacts (D-008)

This directory contains the **template** deployment artefacts for the
formal-study run on the user's home NAS (绿联 DXP4600 Pro, UGOS, 8 GB,
Docker). Nothing here is deployed yet — see `project-knowledge/open-gates.md`
for the items that must be resolved before first container start.

> **Do not commit real secrets to this directory.** Every secret value is
> written as `__REGENERATE__` and must be replaced locally before
> `docker compose up`. The `__REGENERATE__` strings are intended to fail
> loudly if a `docker compose` command reads them.

## D-008 step → file mapping

| D-008 step | Owner | File(s) in this directory |
| --- | --- | --- |
| 1. NAS prep (ssh, Container Manager, `docker run hello-world`) | user | not in repo (physical device) |
| 2. Cloudflare account + domain | user | not in repo (account) |
| 3. `docker-compose.yml` + `.env` | Chloe | `docker-compose.yml`, `.env.example` |
| 4. Supabase new project + `research` migration | user | not in repo (account) |
| 5. Cloudflare Tunnel + Access policy | Chloe | `cloudflared/config.yml` |
| 6. Backblaze B2 + daily backup cron | Chloe | `scripts/backup-tajriba-b2.sh`, `crontab.example` |
| 7. 3-person rehearsal + SOP | joint | not in repo (operational) |

D-008 source-of-truth: `project-knowledge/deployment-analysis-2026-08-13.html`.

## File index

| File | Purpose |
| --- | --- |
| `.env.example` | Every env var the 4 containers need, with `__REGENERATE__` placeholders for secrets |
| `docker-compose.yml` | 4-service compose (tajriba, callbacks, client, cloudflared) with health checks and `${VAR:?msg}` fail-fast |
| `cloudflared/config.yml` | Tunnel + 3 ingress rules (`tajriba.*`, `game.*`, `api.*`) |
| `empirica.toml.template` | Tajriba admin / service credentials template; `openssl rand -hex 32` for every secret |
| `scripts/backup-tajriba-b2.sh` | Extends the local `scripts/backup-tajriba.sh` with rclone push to Backblaze B2 + SHA256 verify |
| `crontab.example` | `/etc/cron.d/delibra-backup` for daily 03:00 backup |
| `README.md` | This file |

## Bring-up checklist (Chloe-side)

```sh
# 0. From the repo root on the NAS, after `git clone` / `git pull`.
cd /opt/delibra/infra

# 1. Generate the env file from the template. Edit values as you go.
cp .env.example .env
$EDITOR .env   # fill in every __REGENERATE__ value; see below for the source of each

# 2. Generate Tajriba admin credentials. Mount the result into the tajriba container.
cp empirica.toml.template empirica.toml
# Replace every __REGENERATE_*__ placeholder with the output of `openssl rand -hex 32`.
chmod 600 empirica.toml   # Tajriba refuses to start if this is world-readable

# 3. Cloudflare tunnel. After creating the tunnel in the Cloudflare Zero Trust dashboard
#    (https://one.dash.cloudflare.com), download the tunnel credentials JSON to
#    /etc/cloudflared/<tunnel-uuid>.json and put the token in .env as CLOUDFLARE_TUNNEL_TOKEN.
#    Then copy the rendered config:
cp cloudflared/config.yml /etc/cloudflared/config.yml   # adjust the credentials-file path

# 4. Bring up. The compose file will fail loudly if any required env is missing.
docker compose --env-file .env up -d

# 5. Verify all 4 services are healthy.
docker compose ps   # all 4 must show "healthy" after ~30 s
curl localhost:3000   # tajriba admin (or via Cloudflare Access)
curl localhost:8080   # callbacks health endpoint
curl localhost:5173   # client dev server (production build will be a different port)

# 6. Install the backup cron.
sudo cp crontab.example /etc/cron.d/delibra-backup
sudo systemctl restart cron   # or `crontab /etc/cron.d/delibra-backup` on some distros

# 7. Hand off to the user + user runs the 3-person rehearsal (D-008 step 7).
```

## Secret rotation rule

Every secret in this directory is intended to be rotated before the formal
study starts. The rotation procedure is the same as the initial generation:

```sh
openssl rand -hex 32
```

The 32-byte (64 hex char) output is a CSPRNG-quality random string. Use it
verbatim; do not edit it; do not share it in chat, screenshots, or commit
messages.

## What this directory does NOT do

- It does not create the Cloudflare account, the B2 bucket, the Supabase
  project, or the NAS itself. Those are user-owned (see D-008).
- It does not run the 3-person rehearsal. That is gate 2 in
  `open-gates.md`.
- It does not file IRB paperwork. That is gate 1 in `open-gates.md`.
- It does not push to any registry. The 4 services are built from
  `Codes/ai_facilitator-main/{server,client}` on the NAS itself; if the
  user prefers pre-built images, the compose file's `build:` lines can be
  replaced with `image:` references.

## Updating this directory

When a deployment artefact changes:

1. Edit the template under `infra/`. Real secrets never go in this
   directory.
2. Commit the template change with a message that names the D-008 step
   and the change (e.g. `infra(docker-compose): add 5-pt healthcheck
   timeout for callbacks`).
3. Update the corresponding section of
   `project-knowledge/deployment-analysis-2026-08-13.html` if the
   D-008 plan itself changed.
4. Do not change the NAS-side `.env` or `empirica.toml` from a git
   operation — those live on the NAS, not in the repo.
