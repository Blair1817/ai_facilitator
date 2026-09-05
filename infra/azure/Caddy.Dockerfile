FROM caddy:2.11.4-alpine

COPY infra/azure/Caddyfile /etc/caddy/Caddyfile

RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
