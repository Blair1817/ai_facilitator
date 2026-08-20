import React from "react";
import { createRoot } from "react-dom/client";
import "@unocss/reset/tailwind-compat.css";
import "virtual:uno.css";
import "../node_modules/@empirica/core/dist/player.css";
// PILOT-ONLY: must run before App.jsx so the patched Tajriba.prototype is
// in place when the Empirica client constructs its TajribaConnection.
import "./pilot/tajriba-noop-global-attrs";
// DELIBRA-PATCH (2026-08-20): app-level watchdog for the Tajriba v1.12.0
// partial-freeze fault. Run before App.jsx so the patched Tajriba.prototype
// is in place when the Empirica client constructs its TajribaConnection.
import "./pilot/tajriba-reconnect-watchdog";
import App from "./App";
import { ClientErrorBoundary } from "./ClientErrorBoundary";
import "./index.css";

const container = document.getElementById("root");
const root = createRoot(container); // createRoot(container!) if you use TypeScript
root.render(
  <React.StrictMode>
    <ClientErrorBoundary>
      <App />
    </ClientErrorBoundary>
  </React.StrictMode>
);
