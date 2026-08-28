# Formal-study NAS deployment

This directory prepares Delibra for the user's x86_64 绿联 DXP4600 Pro NAS.
It is a formal-study target, but it is **not yet deployed**. Passing the local
checks or starting the container does not authorize participant recruitment;
all gates in `project-knowledge/open-gates.md` still apply.

## Architecture

- One Empirica process serves Tajriba, callbacks, participant UI, admin UI,
  and the same-origin `/query` endpoint on port 3000.
- Tajriba data is a bind-mounted host file, independent of the container.
- Real credentials are mounted read-only at runtime and never enter the bundle
  or image.
- Every four hours, an in-container script creates AES-256 encrypted snapshots,
  checks them with SHA-256, and writes matching copies to internal NAS storage
  and a separately mounted disk.
- Remote ingress and a true off-site backup remain deferred integrations. Both
  are mandatory before remote formal recruitment, even though neither is part
  of the initial LAN bring-up.

The old four-container Cloudflare/B2 templates are retained only as historical
material (`cloudflared/` and `scripts/backup-tajriba-b2.sh`) and are not used by
the current Compose file.

## Why the bundle is built through the script

Running `empirica bundle` directly in the repository includes files under
`.empirica/backups/` and the local admin configuration. For a formal deployment
that is unacceptable. `scripts/build-nas-bundle.sh` constructs a temporary,
sanitised worktree and rejects a bundle containing local databases, backups,
credentials, `.env`, OS metadata, or stale feature-server files.

## 1. Build and verify on the development Mac

From the repository root:

```sh
chmod +x infra/scripts/*.sh
infra/scripts/build-nas-bundle.sh
cd server && node --test --test-reporter=dot src/**/*.test.mjs
cd ../client && npm run build
```

The generated bundle and manifest are intentionally Git-ignored. Transfer the
repository plus `infra/bundle/delibra.tar.zst` and `manifest.txt` to the NAS over
the trusted LAN; do not email or upload a bundle containing research code.

## 2. Prepare the NAS

Requirements:

- wired Ethernet and a DHCP-reserved/static LAN address;
- current UGOS and Container Manager/Docker Compose;
- UPS covering the NAS and router, with automatic shutdown/start tested;
- one internal data directory and one independently mounted USB/storage disk;
- no router port-forward for port 3000;
- an operator account whose UID/GID owns all deployment directories.

Old UGOS releases may provide Docker Engine without the Compose plugin. For
those systems, use `scripts/build-image-legacy-ugos.sh` and
`scripts/run-legacy-ugos.sh`; these preserve the same image, mounts, limits,
health check, and least-privilege settings as the Compose definition.
`scripts/prepare-legacy-ugos.sh` performs the one-time directory and secret
setup without creating a persistent host login account or overwriting existing
runtime configuration.

Example layout (adapt volume names to the actual NAS):

```text
/volume1/delibra/
  infra/
  data/
  backups/
  logs/
  secrets/
/volume2/delibra-backups/
```

Create `infra/.env` from `.env.example`, fill every placeholder locally, and
set mode 600. Copy `empirica.toml.template` to the path named by
`DELIBRA_CONFIG_FILE`, replace both placeholders with independent outputs from
`openssl rand -hex 32`, and set mode 600.

Create a backup passphrase with at least 32 random bytes, write it only to the
file named by `DELIBRA_BACKUP_KEY_FILE`, and set mode 600. Keep a second offline
copy of that passphrase in the researcher's approved password manager or sealed
recovery record; backups are unrecoverable without it.

## 3. Preflight and LAN bring-up

On the NAS, from `infra/`:

```sh
scripts/preflight-nas.sh
docker compose --env-file .env build --pull
docker compose --env-file .env up -d
docker compose --env-file .env ps
docker compose --env-file .env logs --tail 100 empirica
```

Legacy UGOS equivalent:

```sh
scripts/preflight-nas.sh
scripts/build-image-legacy-ugos.sh
scripts/run-legacy-ugos.sh
docker ps --filter name=delibra-empirica
docker logs --tail 100 delibra-empirica
```

`scripts/run-legacy-ugos.sh --lan-staging` is permitted only for LAN health/UI
validation before the external disk and Supabase persistence are available.
It deliberately mounts the pending external-backup path read-only, so the
backup script fails closed. A staging start is not formal-study readiness.

Acceptance for this stage:

- the container is `healthy` and remains healthy after a NAS reboot;
- `http://<NAS_LAN_IP>:3000/` loads from another LAN device;
- `/admin` requires the new strong credentials;
- the image manifest identifies the intended commit and bundle checksum;
- no production port is forwarded by the router.

## 4. Backup and restore drill

Run a manual backup before installing cron:

```sh
docker compose --env-file .env exec -T empirica /opt/delibra/backup-local-encrypted.sh
```

Select the new archive from the internal backup directory and run a non-
destructive restore drill:

```sh
docker compose --env-file .env exec -T empirica \
  /opt/delibra/restore-backup-for-review.sh \
  /backups/internal/delibra-tajriba-YYYYMMDDTHHMMSSZ.tar.enc
```

The restore is written under `/data/restore-review/`; the active database is
never replaced. Confirm the restored file and metadata exist, then install
`crontab.example`. Also run a manual backup immediately after every completed
formal session instead of relying only on the four-hour schedule.

## Formal recruitment gates

Do not recruit formal participants until all of these have evidence:

1. ethics/data-hosting approval for the NAS and every external processor;
2. UPS shutdown, reboot, container auto-recovery, and disk-health monitoring;
3. manual backup plus restore drill from both storage devices;
4. approved remote HTTPS ingress with the admin route access-controlled;
5. encrypted off-site backup with a tested restore;
6. one callbacks instance only;
7. three-person remote rehearsal covering assignment, reconnect, full workflow,
   LLM latency/context drift, Supabase mirror, Tajriba persistence, and backup;
8. a written operator stop/recovery SOP and recruitment-day health checklist.

## Files

| File | Purpose |
| --- | --- |
| `Dockerfile` | pinned Empirica Linux image with least-privilege runtime |
| `docker-compose.yml` | single-process, same-origin NAS deployment |
| `.env.example` | non-secret runtime and host-path template (NAS) |
| `env.azure.example` | non-secret runtime template (Azure Container Apps) |
| `empirica.toml.template` | public placeholder admin configuration |
| `scripts/build-nas-bundle.sh` | sanitised bundle builder and provenance manifest |
| `scripts/build-for-azure.sh` | build + tag for Azure; optional `--push` to ACR |
| `scripts/capture-prewarm-from-running.sh` | populate `prewarm/` from a running v1.12.5 container |
| `scripts/preflight-nas.sh` | fail-closed NAS configuration checks |
| `scripts/backup-local-encrypted.sh` | encrypted dual-destination snapshot and rotation |
| `scripts/restore-backup-for-review.sh` | non-destructive integrity/restore drill |
| `crontab.example` | four-hour backup schedule |

## Azure deployment (parallel target to NAS)

The Docker image is identical between NAS and Azure; only the destination
registry and the data dir mount differ. Azure Container Apps has outbound
internet, so the in-container first-start of `empirica serve` can fetch
`get.volta.sh` if the prewarm cache is empty — the offline-pinned build
path that the NAS relies on is no longer mandatory, but capturing
`prewarm/` from a known-good v1.12.5 container is still recommended for
deterministic first starts.

### One-time setup (every build host)

1. `cp infra/env.azure.example infra/.env` and edit
   `ACR_LOGIN_SERVER` / `ACR_NAME` / `DELIBRA_IMAGE_TAG`.
2. `infra/scripts/capture-prewarm-from-running.sh` — pulls the Tajriba
   v1.12.0 and v1.12.5 binaries (and optionally the Volta runtime) out
   of the running NAS container into `infra/prewarm/`. This directory
   is gitignored; it must be present on the build host before
   `docker build` runs.
3. `az login` (or enable the ACR admin user in the portal and set
   `ACR_USERNAME` / `ACR_PASSWORD` in the env when pushing).

### Build (Mac or CI runner)

```sh
infra/scripts/build-for-azure.sh            # build only
infra/scripts/build-for-azure.sh --push     # build + push to ACR
infra/scripts/build-for-azure.sh --tag=mybuild-20260829  # custom tag
```

### Provision the Azure side (portal)

See `azure-deployment-guide.md` in the project root for the
portal walkthrough covering:

- Resource Group, ACR, Storage Account + File Share, Log Analytics,
  Container Apps Environment, Container App, AcrPull role.
- Health probe: TCP/3000, 30s period, failure threshold 3.
- `/data` volume mount pointing at the File Share (Tajriba writes
  its JSONL state there — without this mount the container
  effectively starts fresh on every restart).

### Operational differences from NAS

- The `*/5` host-watchdog / `*/4` host-reopen crons on the NAS
  **do not apply on Azure** — the built-in TCP health probe (failure
  threshold 3) replaces them. Do not deploy the watchdog/reopen
  scripts as Container Apps Jobs.
- The `crontab.example` four-hour backup schedule also does not
  apply. Backups on Azure are file-share snapshots triggered manually
  or via an Azure Automation runbook; see the
  `delibra-azure-handoff/scripts/backup-state.sh` reference in the
  project root.
- Secrets: Tajriba admin user / password / SRToken live in
  `empirica.toml` (mounted as a Container App secret), not on a host
  bind path. The host `secrets/` directory under
  `DELIBRA_CONFIG_FILE` does not exist in the Azure layout.

### What is identical

- Empirica v1.12.5 framework version (the partial-freeze is fixed
  at the framework level, so the image carries the fix on either
  target).
- Tajriba v1.12.5 state store (paired with the framework).
- 24-hour `lobbyConfig.duration` rule for human-pilot batches
  (`86400000000000` ns) — create new batches via the GraphQL
  `addScopes` mutation; do not extend an existing batch.
- Bundle construction: still `scripts/build-nas-bundle.sh` (the
  bundle format is the same; only the destination registry differs).
