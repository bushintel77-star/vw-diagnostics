// Inter, bundled locally via Fontsource — no Google Fonts request at runtime.
import "@fontsource-variable/inter";

import "./assets/index.css";

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ensureContext } from "./web/liveBridge";

// In a plain web browser there is no preload bridge; connect to the live
// monitor server when available, or fall back to a page-local demo.
ensureContext().finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
