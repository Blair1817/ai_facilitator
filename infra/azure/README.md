# Azure Export gateway (Phase 2)

This directory describes the incremental Azure Container Apps change that puts
the existing Empirica and ExportServer listeners behind one same-origin Caddy
gateway. It does not contain credentials and must not be applied as a complete
replacement for the live Container App definition.

## Checked-in, non-secret artifacts

- `Caddyfile`: routes `/exports` and `/exports/*` to the loopback ExportServer;
  all other traffic goes to Empirica. It does not authenticate users.
- `Caddy.Dockerfile`: a dedicated gateway image based on the pinned official
  `caddy:2.11.4-alpine` image. It copies only the Caddyfile and validates it.
- `containerapp-export-sidecar.fragment.yaml`: the exact ingress, sidecar,
  ExportServer environment, and secret-reference changes to merge into an
  export of the current live Container App YAML.
- `proxy-routing.test.mjs`: static contract checks plus a real-Caddy HTTP and
  WebSocket integration test when `CADDY_BIN` is supplied.

The dedicated gateway image is necessary because Container Apps does not mount
files directly from this Git repository. Baking the non-secret Caddyfile into a
small sidecar image avoids storing configuration in credential secrets and does
not modify the Empirica application image.

## Routing and isolation

Caddy listens on `0.0.0.0:8080`, behind Azure HTTPS termination. Its `path`
matcher and `handle` directive do not rewrite the URI, so `/exports` remains in
the request forwarded to `127.0.0.1:3001`. Caddy forwards WebSocket upgrades by
default, so `/query` remains a bidirectional Empirica connection through
`127.0.0.1:3000`.

The `/exports` handler preserves the incoming `Authorization` header for
ExportServer Basic Auth. The catch-all Empirica handler deletes that header
before proxying, preventing a researcher credential accidentally sent to `/`,
`/admin/`, `/query`, or a static asset from reaching Empirica.

Only port 8080 is an Azure ingress target. Do not add port 3001 as HTTP ingress
or an additional TCP port. If ExportServer is unavailable, `/exports` returns a
gateway error while Participant/Admin traffic continues to use Empirica.

## Out-of-band secrets

Create or update these Container App secrets without putting their values in a
file under source control:

```sh
az containerapp secret set \
  --resource-group "<RESOURCE_GROUP>" \
  --name "<CONTAINER_APP>" \
  --secrets \
    "export-auth-username=<RESEARCHER_USERNAME>" \
    "export-auth-password=<LONG_RANDOM_PASSWORD>"
```

Prefer supplying the two placeholder values from a protected shell/CI secret
store so they do not enter shell history. The application environment must use
`secretRef: export-auth-username` and `secretRef: export-auth-password`, as in
the fragment. Do not put Basic Auth in Caddy.

The existing Empirica configuration secret volume remains mounted at
`/run/secrets/empirica.toml`. Set `TAJRIBA_CONFIG` to that path; do not copy the
file contents into an environment variable.

## Prepare a revision (do not run until deployment is approved)

1. Choose immutable tags for both images. Build the gateway separately from the
   main experiment image:

   ```sh
   docker build --platform linux/amd64 \
     --file infra/azure/Caddy.Dockerfile \
     --tag "<ACR_LOGIN_SERVER>/delibra-export-gateway:<IMMUTABLE_TAG>" .
   docker push "<ACR_LOGIN_SERVER>/delibra-export-gateway:<IMMUTABLE_TAG>"
   ```

2. Save the exact live definition and its current revision name for rollback:

   ```sh
   az containerapp show \
     --resource-group "<RESOURCE_GROUP>" \
     --name "<CONTAINER_APP>" \
     --output yaml > /tmp/delibra-containerapp.before.yaml

   az containerapp revision list \
     --resource-group "<RESOURCE_GROUP>" \
     --name "<CONTAINER_APP>" \
     --output table
   ```

3. Copy the saved YAML to a new temporary file. Merge the checked-in fragment,
   replacing the gateway image placeholders. Retain every existing application
   image, environment variable, secret reference, `/data` and Empirica-config
   volume mount, registry setting, probe, scale rule, and traffic setting.
   Container arrays are replacement-sensitive; do not pass the fragment itself
   to `az containerapp update`.

4. Confirm the merged revision has exactly these Export values:

   ```text
   EXPORT_BASE_PATH=/exports
   EXPORT_BIND_HOST=127.0.0.1
   EXPORT_PORT=3001
   EXPORT_ALLOW_RAW=0
   TAJRIBA_CONFIG=/run/secrets/empirica.toml
   EXPORT_AUTH_USERNAME=secretref:export-auth-username
   EXPORT_AUTH_PASSWORD=secretref:export-auth-password
   ```

5. Confirm external HTTPS ingress has `targetPort: 8080`, `transport: auto`,
   and `allowInsecure: false`, then apply the complete reviewed temporary YAML:

   ```sh
   az containerapp update \
     --resource-group "<RESOURCE_GROUP>" \
     --name "<CONTAINER_APP>" \
     --yaml /tmp/delibra-containerapp.with-export-gateway.yaml
   ```

6. Before shifting production traffic, verify `/`, `/admin/`, a real `/query`
   WebSocket, unauthenticated and authenticated `/exports/`, one redacted file,
   and an unknown root-level `/games/...` path. Confirm there is no additional
   ingress port for 3001 and no real credential appears in revision logs/YAML.

## Rollback

Keep the previous revision active until gateway validation passes. On failure,
route 100% traffic back to its saved revision with `az containerapp ingress
traffic set`, then investigate offline. If revision rollback is unavailable,
restore `/tmp/delibra-containerapp.before.yaml`; this returns ingress to port
3000 and removes the gateway sidecar. Do not create a temporary port-3001
ingress as a workaround. Secret deletion can wait until the rolled-back
revision is confirmed healthy.

## Remaining deployment risks

- The checked-in file is an incremental fragment because the repository has no
  authoritative ACA definition. A live YAML merge must be reviewed carefully
  to avoid dropping existing environment, volume, probe, scale, or registry
  settings.
- Basic Auth is one shared researcher identity unless separate deployments or a
  stronger identity layer are introduced later. Always use Azure HTTPS ingress.
- Gateway health does not prove ExportServer health. This is intentional for
  experiment isolation; monitor `/exports` and ExportServer logs separately.
- Keep the gateway image tag immutable and review upstream Caddy security
  releases before each deployment.

References: [Azure multi-container apps](https://learn.microsoft.com/azure/container-apps/containers),
[Azure Container Apps ingress](https://learn.microsoft.com/azure/container-apps/ingress-overview),
[Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
