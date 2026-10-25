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
    return admin;
  } catch (error) {
    admin?.stop();
    throw error;
  } finally {
    // Registration is only needed at startup; keep the authenticated client.
    registration.stop();
  }
}
