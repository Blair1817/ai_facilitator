// Keep graphql-ws alive as an object: terminate() retries its existing
// operations, whereas dispose()+a new client strands their subscriptions.
export function monitorTajribaTransport(client, {
  pongTimeoutMs = 20_000,
  connectTimeoutMs = 30_000,
  probeIntervalMs = 30_000,
  probeTimeoutMs = 8_000,
  probe = null,
  isSuspended = () => false,
  report = (reason) => console.warn(`[delibra-recovery] ${reason}; retrying connection`),
} = {}) {
  let stopped = false;
  let connected = false;
  let generation = 0;
  let connectTimer, pongTimer, probeTimer;
  let pendingProbe;
  const clear = (timer) => clearTimeout(timer?.id ?? timer);
  const finishProbe = () => {
    const pending = pendingProbe;
    pendingProbe = undefined;
    if (pending) {
      clear(pending.timer);
      pending.cancel?.();
    }
  };
  const retry = (reason) => {
    if (stopped) return;
    clear(connectTimer);
    clear(pongTimer);
    pongTimer = undefined;
    clear(probeTimer);
    finishProbe();
    report(reason);
    client.terminate();
  };
  // Background tabs and offline devices cannot satisfy a timed network check.
  // Defer instead of churning connections while the browser throttles timers.
  const deadline = (ms, action) => {
    const epoch = generation;
    const timer = {};
    const run = () => {
      if (stopped || epoch !== generation) return;
      if (isSuspended()) { timer.id = setTimeout(run, ms); return; }
      action();
    };
    timer.id = setTimeout(run, ms);
    return timer;
  };
  const scheduleProbe = () => {
    clear(probeTimer);
    if (!stopped && connected && probe) {
      probeTimer = setTimeout(check, probeIntervalMs);
    }
  };
  function check() {
    if (stopped || !connected || !probe || pendingProbe) return;
    if (isSuspended()) return scheduleProbe();
    const pending = {};
    pendingProbe = pending;
    const settle = () => {
      if (pendingProbe !== pending) return;
      finishProbe();
      scheduleProbe();
    };
    pending.timer = deadline(probeTimeoutMs, () => retry("subscription response timed out"));
    try {
      // GraphQL errors are responses, not evidence of a frozen dispatcher.
      // Do not recycle valid sessions because a probe lacks authorization.
      pending.cancel = probe({ next: settle, error: settle, complete: settle });
      if (pendingProbe !== pending) pending.cancel?.();
    } catch {
      settle();
    }
  }
  const reset = () => {
    generation++;
    connected = false;
    clear(connectTimer);
    clear(pongTimer);
    pongTimer = undefined;
    clear(probeTimer);
    finishProbe();
  };
  const connecting = () => {
    reset();
    connectTimer = deadline(connectTimeoutMs, () => retry("connection acknowledgement timed out"));
  };
  const listeners = [
    client.on("connecting", connecting),
    client.on("connected", () => {
      clear(connectTimer);
      connected = true;
      scheduleProbe();
    }),
    client.on("ping", (received) => {
      if (received || pongTimer) return;
      pongTimer = deadline(pongTimeoutMs, () => retry("heartbeat response timed out"));
    }),
    client.on("pong", (received) => {
      if (received) { clear(pongTimer); pongTimer = undefined; }
    }),
    client.on("closed", reset),
  ];
  // graphql-ws starts a non-lazy connection before these listeners attach.
  connecting();
  return {
    check,
    stop() {
      stopped = true;
      reset();
      for (const unsubscribe of listeners) unsubscribe();
    },
  };
}
