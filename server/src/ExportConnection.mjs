const SCOPES_QUERY = `
  query ExportScopes($filter: [ScopedAttributesInput!], $first: Int, $after: Cursor) {
    scopes(filter: $filter, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id kind createdAt
          attributes(first: 2000) {
            edges { node { key val index current version deletedAt } }
          }
        }
      }
    }
  }
`;

export class ExportStoreTimeout extends Error {}

// SDK 1.12 stop() drops graphql-ws dispose()'s Promise. Observe it explicitly
// before invoking stop, including the throwaway registration connection.
function stopSafely(client, onError) {
  if (!client) return;
  const socket = client._wsClient;
  if (socket) {
    delete client._wsClient;
    try { Promise.resolve(socket.dispose()).catch(onError); } catch (error) { onError(error); }
  }
  client.stop();
}
function reportTransportError(error) {
  // Do not log ErrorEvent objects: they contain sockets and auth headers.
  const code = error?.error?.code ?? error?.code;
  console.warn("[export-server] Tajriba transport error; reconnecting", {
    code: typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "TRANSPORT_ERROR",
  });
}

export async function connectExportAdmin({
  url,
  srtoken,
  clientName = "export-server",
  onTransportError = reportTransportError,
  sdk,
  queryTimeoutMs = 15_000,
}) {
  const { Tajriba, TajribaAdmin } = sdk;
  // Both SDK clients emit EventEmitter 'error' events, including when useHTTP
  // is true. Install listeners BEFORE connecting; createAndAwait/sessionAdmin
  // connect internally before callers can attach a listener.
  const registration = new Tajriba(url);
  registration.useHTTP = true;
  registration.on("error", onTransportError);
  let admin;
  try {
    await registration.connectAndAwait();
    const token = await registration.registerService(clientName, srtoken);
    admin = new TajribaAdmin(url, token);
    admin.useHTTP = true;
    admin.on("error", onTransportError);
    await admin.connectAndAwait();
    // Keep the generated SDK's scope shape, but authenticate and bound HTTP
    // reads explicitly. Never log upstream response bodies or credentials.
    admin.scopes = async (variables) => {
      const signal = AbortSignal.timeout(queryTimeoutMs);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ query: SCOPES_QUERY, variables }),
          signal,
        });
        if (!response.ok) throw new Error(`Export store returned HTTP ${response.status}`);
        const payload = await response.json();
        if (payload.errors?.length || !payload.data?.scopes) throw new Error("Export store scope query failed");
        return payload.data.scopes;
      } catch (error) {
        if (signal.aborted) throw new ExportStoreTimeout("Export store query timed out");
        throw error;
      }
    };
    const stop = admin.stop.bind(admin);
    admin.stop = () => {
      const socket = admin._wsClient;
      delete admin._wsClient;
      try { Promise.resolve(socket?.dispose()).catch(onTransportError); } catch (error) { onTransportError(error); }
      stop();
    };
    return admin;
  } catch (error) {
    stopSafely(admin, onTransportError);
    throw error;
  } finally {
    // Registration is only needed at startup; keep the authenticated client.
    stopSafely(registration, onTransportError);
  }
}
