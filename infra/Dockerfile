FROM node:20.12.2-bookworm-slim

ARG EMPIRICA_URL="https://install.empirica.dev/proxy/linux/amd64/latest/empirica"
ARG EMPIRICA_SHA256="3beb8adde5a1d29d72db1b8f3530f537168ae276615c570d4f81961f40a33018"
ARG VOLTA_VERSION="2.0.2"
ARG DELIBRA_UID=10001
ARG DELIBRA_GID=10001

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl openssl tar zstd \
    && curl -fsS "$EMPIRICA_URL" -o /usr/local/bin/empirica \
    && echo "$EMPIRICA_SHA256  /usr/local/bin/empirica" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/empirica \
    # Pre-bake Volta so the Empirica runtime does not need outbound HTTPS
    # to github.com at every container start (the NAS has no public
    # internet; only Tailscale). Empirica's `serve` re-runs `npm run
    # build` per start, which on a fresh image would otherwise
    # install Volta from github.com and time out.
    # NOTE (2026-08-20): this /opt/volta no-op shim does NOT stop empirica
    # serve's own Volta bootstrap (the Go binary runs the get.volta.sh
    # installer directly and installs to ~/.local/share/empirica/volta).
    # The real offline fix is the prewarm COPY below; the shim remains only
    # to keep npm/pnpm-side `volta install node` attempts no-op.
    && curl -fsSL "https://github.com/volta-cli/volta/releases/download/v${VOLTA_VERSION}/volta-${VOLTA_VERSION}-linux.tar.gz" \
         -o /tmp/volta.tar.gz \
    && tar -xzf /tmp/volta.tar.gz -C /opt/ \
    # Replace the pre-baked volta binary with a no-op shim. The package
    # managers Empirica v1.12 invokes (pnpm via npm callback build)
    # detect volta on PATH and run \`volta install node\` to pin the
    # node version; that fetch targets github.com, which the NAS
    # cannot reach (only Tailscale is exposed). A no-op shim makes
    # the volta-aware code path succeed immediately and the system
    # node 20.12.2 (the image base) is what actually serves the
    # callbacks.
    && mv /opt/volta /opt/volta.real \
    && printf '#!/bin/sh\nexit 0\n' > /opt/volta \
    && chmod 0755 /opt/volta \
    && ln -sf /opt/volta /usr/local/bin/volta \
    && rm -f /tmp/volta.tar.gz \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid "$DELIBRA_GID" delibra \
    && useradd --uid "$DELIBRA_UID" --gid "$DELIBRA_GID" --create-home delibra \
    && mkdir -p /opt/delibra /opt/delibra/bin /data /backups/internal /backups/external \
    && chown -R delibra:delibra /opt/delibra /data /backups /home/delibra \
    # Make the unbundled volta binary readable for debug access; it is
    # not on PATH by design (see the comment in the previous RUN).
    && chmod a+rx /opt /opt/volta /opt/volta-migrate /opt/volta-shim

COPY --chown=delibra:delibra infra/bundle/delibra.tar.zst /opt/delibra/delibra.tar.zst
COPY --chown=delibra:delibra infra/bundle/manifest.txt /opt/delibra/manifest.txt
COPY --chown=delibra:delibra infra/scripts/backup-local-encrypted.sh /opt/delibra/backup-local-encrypted.sh
COPY --chown=delibra:delibra infra/scripts/restore-backup-for-review.sh /opt/delibra/restore-backup-for-review.sh
COPY --chown=delibra:delibra infra/scripts/verify-tajriba-integrity.mjs /opt/delibra/verify-tajriba-integrity.mjs
COPY --chown=delibra:delibra infra/scripts/validate-admin-login.mjs /opt/delibra/validate-admin-login.mjs
COPY --chown=delibra:delibra infra/scripts/empirica-entrypoint.sh /opt/delibra/empirica-entrypoint.sh

# DELIBRA-PATCH (2026-08-20): pre-bake the entire Empirica toolchain state
# (Volta 2.0.2 + Node 24.19.0 + empirica v1.12.0/v1.12.5 binaries) captured
# from a known-good running container. Without this, every NEW container
# re-downloads volta (~11MB) + node 24.19.0 (~30MB) + the empirica release
# binary (~18MB) from github.com / install.empirica.dev at first start.
# The empirica Go binary bootstraps Volta UNCONDITIONALLY on `serve`
# (it runs the get.volta.sh installer directly and ignores the /opt/volta
# PATH shim), so when the NAS's egress is flaky the startup hangs forever.
# `docker restart` preserves the writable layer (so watchdog restarts were
# safe), but any NEW container (upgrade, rebuild, recovery) hit the
# download roulette. Baking the state makes startup offline-deterministic.
#
# The prewarm/ directory is produced by:
#   docker exec delibra-empirica tar -czf /tmp/prewarm-volta.tgz \
#     -C /home/delibra/.local/share/empirica volta
#   docker exec delibra-empirica tar -czf /tmp/prewarm-cache.tgz \
#     -C /home/delibra/.cache empirica
# and extracting both into infra/prewarm/ on the build host.
COPY --chown=delibra:delibra infra/prewarm/volta /home/delibra/.local/share/empirica/volta
COPY --chown=delibra:delibra infra/prewarm/empirica /home/delibra/.cache/empirica

# Tajriba v1.12.0 partial-freeze auto-recovery (2026-08-19). The
# host's `*/1` host-watchdog.sh and `*/4` host-reopen.sh crons
# `docker exec` into these paths; if they are missing the host
# wrappers misread "file not found" as "Tajriba frozen" and start
# a `docker restart` loop every 5 min. Bake them in so the image
# is self-contained across rebuilds.
COPY --chown=delibra:delibra infra/watchdog/tajriba-watchdog.js /opt/delibra/bin/tajriba-watchdog.js
COPY --chown=delibra:delibra infra/watchdog/tajriba-reopen-experiment.js /opt/delibra/bin/tajriba-reopen-experiment.js
RUN chmod 0555 \
  /opt/delibra/backup-local-encrypted.sh \
  /opt/delibra/restore-backup-for-review.sh \
  /opt/delibra/verify-tajriba-integrity.mjs \
  /opt/delibra/validate-admin-login.mjs \
  /opt/delibra/empirica-entrypoint.sh \
  /opt/delibra/bin/tajriba-watchdog.js \
  /opt/delibra/bin/tajriba-reopen-experiment.js

USER delibra
WORKDIR /home/delibra
ENV HOME=/home/delibra NODE_ENV=production

# D-014: the research-data export server binds here on loopback only.
# Cloudflared forwards the public `exports.*` route to it. The 3000
# port is Empirica itself.
EXPOSE 3000 3001

ENTRYPOINT ["/opt/delibra/empirica-entrypoint.sh"]
CMD ["serve", "/opt/delibra/delibra.tar.zst", "--config", "/run/secrets/empirica.toml", "--addr", ":3000", "--tajriba.store.file", "/data/tajriba.json", "--log.json", "--log.level", "warn", "--tajriba.log.level", "warn"]
