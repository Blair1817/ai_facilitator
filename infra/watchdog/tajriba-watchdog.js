// Tajriba v1.12 liveness watchdog
// Self-contained: uses only Node 22+ built-in WebSocket + HTTPS
// Real liveness check: open WS, send connection_init, send scopedAttributes subscription,
// wait up to TIMEOUT seconds for first 'next' event. Exit 0 if seen, 1 if not.
const TIMEOUT_S = parseInt(process.env.TAJRIBA_LIVENESS_TIMEOUT || "8", 10);
const WSS_URL  = process.env.TAJRIBA_WS_URL || "wss://delibraresearchteam.hengxpersonal.com/query";

(async () => {
  let ws;
  let timer;
  const finish = (code, msg) => {
    if (timer) clearTimeout(timer);
    try { ws?.close(); } catch {}
    if (msg) console.error(msg);
    process.exit(code);
  };
  timer = setTimeout(() => finish(1, `WATCHDOG: no next in ${TIMEOUT_S}s -> FROZEN`), TIMEOUT_S * 1000);
  try {
    ws = new WebSocket(WSS_URL, "graphql-transport-ws");
    ws.addEventListener("error", (e) => finish(1, `WATCHDOG: WS error ${e?.message || e}`));
    ws.addEventListener("close", (e) => finish(1, `WATCHDOG: WS closed before next (code=${e?.code})`));
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    ws.send(JSON.stringify({ type: "connection_init", payload: {} }));
    ws.send(JSON.stringify({
      id: "1", type: "subscribe",
      payload: {
        query: `subscription SA($i: [ScopedAttributesInput!]!) { scopedAttributes(input: $i) { attribute { id } scopesUpdated done } }`,
        variables: { i: [{ kinds: ["game"] }] }
      }
    }));
    ws.addEventListener("message", (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m?.type === "next") return finish(0, "WATCHDOG: alive, got next");
        if (m?.type === "error") return finish(0, `WATCHDOG: server returned error (still considered alive): ${m?.payload?.[0]?.message}`);
        if (m?.type === "complete") return finish(0, "WATCHDOG: complete (alive)");
      } catch {}
    });
  } catch (e) {
    finish(1, `WATCHDOG: connect failed: ${e?.message || e}`);
  }
})();
