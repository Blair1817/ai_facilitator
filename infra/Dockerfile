FROM node:20.12.2-bookworm-slim

ARG EMPIRICA_VERSION="v1.12.5"
ARG EMPIRICA_URL="https://install.empirica.dev/empirica/linux/amd64/version/v1.12.5/empirica"
ARG EMPIRICA_SHA256="43d9d20ead6e1abe177a58ed28aaa94d821db46836a304b9ad9ed27826d27ba9"
ARG VOLTA_VERSION="2.0.2"
ARG VOLTA_URL="https://github.com/volta-cli/volta/releases/download/v2.0.2/volta-2.0.2-linux.tar.gz"
ARG VOLTA_SHA256="6cec054c911fb925b629a09455775af6e95dc0f5694a4c28b63979ab9ef18037"
ARG DELIBRA_UID=10001
ARG DELIBRA_GID=10001

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl openssl tar zstd \
    && test "$(dpkg --print-architecture)" = "amd64" \
    && curl -fsSL "$EMPIRICA_URL" -o /usr/local/bin/empirica \
    && echo "$EMPIRICA_SHA256  /usr/local/bin/empirica" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/empirica \
    && empirica version --json | grep -Eq "\"version\"[[:space:]]*:[[:space:]]*\"$EMPIRICA_VERSION\"" \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid "$DELIBRA_GID" delibra \
    && useradd --uid "$DELIBRA_UID" --gid "$DELIBRA_GID" --create-home delibra \
    && mkdir -p \
      /opt/delibra/bin \
      /data \
      /backups/internal \
      /backups/external \
      /home/delibra/.local/share/empirica/volta/bin \
    && curl -fsSL "$VOLTA_URL" -o /tmp/volta.tar.gz \
    && echo "$VOLTA_SHA256  /tmp/volta.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/volta.tar.gz \
      -C /home/delibra/.local/share/empirica/volta/bin \
    && test "$(/home/delibra/.local/share/empirica/volta/bin/volta --version)" = "$VOLTA_VERSION" \
    && rm -f /tmp/volta.tar.gz \
    && chown -R delibra:delibra /opt/delibra /data /backups /home/delibra

COPY --chown=delibra:delibra infra/bundle/delibra.tar.zst /opt/delibra/delibra.tar.zst
COPY --chown=delibra:delibra infra/bundle/manifest.txt /opt/delibra/manifest.txt
COPY --chown=delibra:delibra infra/scripts/backup-local-encrypted.sh /opt/delibra/backup-local-encrypted.sh
COPY --chown=delibra:delibra infra/scripts/restore-backup-for-review.sh /opt/delibra/restore-backup-for-review.sh
COPY --chown=delibra:delibra infra/scripts/verify-tajriba-integrity.mjs /opt/delibra/verify-tajriba-integrity.mjs
COPY --chown=delibra:delibra infra/scripts/validate-admin-login.mjs /opt/delibra/validate-admin-login.mjs
COPY --chown=delibra:delibra infra/scripts/empirica-entrypoint.sh /opt/delibra/empirica-entrypoint.sh

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
