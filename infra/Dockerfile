FROM node:20.12.2-bookworm-slim

ARG EMPIRICA_URL="https://install.empirica.dev/proxy/linux/amd64/latest/empirica"
ARG EMPIRICA_SHA256="3beb8adde5a1d29d72db1b8f3530f537168ae276615c570d4f81961f40a33018"
ARG DELIBRA_UID=10001
ARG DELIBRA_GID=10001

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl openssl tar zstd \
    && curl -fsS "$EMPIRICA_URL" -o /usr/local/bin/empirica \
    && echo "$EMPIRICA_SHA256  /usr/local/bin/empirica" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/empirica \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid "$DELIBRA_GID" delibra \
    && useradd --uid "$DELIBRA_UID" --gid "$DELIBRA_GID" --create-home delibra \
    && mkdir -p /opt/delibra /data /backups/internal /backups/external \
    && chown -R delibra:delibra /opt/delibra /data /backups /home/delibra

COPY --chown=delibra:delibra infra/bundle/delibra.tar.zst /opt/delibra/delibra.tar.zst
COPY --chown=delibra:delibra infra/bundle/manifest.txt /opt/delibra/manifest.txt
COPY --chown=delibra:delibra infra/scripts/backup-local-encrypted.sh /opt/delibra/backup-local-encrypted.sh
COPY --chown=delibra:delibra infra/scripts/restore-backup-for-review.sh /opt/delibra/restore-backup-for-review.sh
COPY --chown=delibra:delibra infra/scripts/verify-tajriba-integrity.mjs /opt/delibra/verify-tajriba-integrity.mjs
COPY --chown=delibra:delibra infra/scripts/validate-admin-login.mjs /opt/delibra/validate-admin-login.mjs
COPY --chown=delibra:delibra infra/scripts/empirica-entrypoint.sh /opt/delibra/empirica-entrypoint.sh
RUN chmod 0555 \
  /opt/delibra/backup-local-encrypted.sh \
  /opt/delibra/restore-backup-for-review.sh \
  /opt/delibra/verify-tajriba-integrity.mjs \
  /opt/delibra/validate-admin-login.mjs \
  /opt/delibra/empirica-entrypoint.sh

USER delibra
WORKDIR /home/delibra
ENV HOME=/home/delibra NODE_ENV=production

# D-014: the research-data export server binds here on loopback only.
# Cloudflared forwards the public `exports.*` route to it. The 3000
# port is Empirica itself.
EXPOSE 3000 3001

ENTRYPOINT ["/opt/delibra/empirica-entrypoint.sh"]
CMD ["serve", "/opt/delibra/delibra.tar.zst", "--config", "/run/secrets/empirica.toml", "--addr", ":3000", "--tajriba.store.file", "/data/tajriba.json", "--log.json", "--log.level", "warn", "--tajriba.log.level", "warn"]
