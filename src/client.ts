import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";

const el = (id: string) => document.getElementById(id)!;
const termEl = el("terminal");
const statusDot = el("status-dot");
const statusText = el("status-text");

const params = new URLSearchParams(location.search);
const token = params.get("token") ?? "";

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const base = `${proto}://${location.host}/ws`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

const term = new Terminal({
  cursorBlink: true,
  fontSize: 14,
  fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
  theme: {
    background: "#0b0e14",
    foreground: "#e6e6e6",
    cursor: "#7dd3fc",
    selectionBackground: "#334155",
  },
  allowProposedApi: true,
});

const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon());
term.open(termEl);
fit.fit();
term.focus();
term.writeln("\x1b[1;36mrtx webterminal\x1b[0m — connecting…");

let ws: WebSocket | null = null;
let wantClose = false;

function setStatus(ok: boolean, text: string) {
  statusDot.className = "dot " + (ok ? "on" : "off");
  statusText.textContent = text;
}

function sendResize() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const d = fit.proposeDimensions();
  if (!d) return;
  ws.send(JSON.stringify({ type: "resize", cols: d.cols, rows: d.rows }));
}

function connect() {
  wantClose = false;
  setStatus(false, "connecting…");
  ws = new WebSocket(wsUrl());
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    setStatus(true, "connected");
    term.writeln("\x1b[32mconnected.\x1b[0m");
    fit.fit();
    sendResize();
  };

  ws.onmessage = async (ev) => {
    const msg = ev.data as string | ArrayBuffer | Blob;
    if (typeof msg === "string") {
      // control frames are JSON, everything else is raw PTY text
      if (msg.startsWith("{")) {
        try {
          const o = JSON.parse(msg) as { type: string; code?: number };
          if (o.type === "exit") {
            term.writeln(`\r\n\x1b[33m[shell exited code=${o.code ?? "?"}]\x1b[0m`);
            return;
          }
          if (o.type === "pong" || o.type === "info") return;
        } catch {
          /* not JSON */
        }
      }
      term.write(msg);
    } else if (msg instanceof Blob) {
      const buf = new Uint8Array(await msg.arrayBuffer());
      term.write(buf);
    } else if (msg instanceof ArrayBuffer) {
      term.write(new Uint8Array(msg));
    }
  };

  ws.onclose = (e) => {
    setStatus(false, `disconnected (${e.code})`);
    term.writeln(`\r\n\x1b[31m[disconnected ${e.code}]\x1b[0m`);
    if (!wantClose) {
      setTimeout(() => {
        if (!wantClose) connect();
      }, 1500);
    }
  };

  ws.onerror = () => setStatus(false, "error");
}

term.onData((data) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "input", data }));
  }
});

window.addEventListener("resize", () => {
  fit.fit();
  sendResize();
});

// toolbar
el("btn-reconnect").addEventListener("click", () => {
  try {
    wantClose = true;
    ws?.close();
  } catch { /* ignore */ }
  term.clear();
  connect();
});
el("btn-clear").addEventListener("click", () => {
  term.clear();
  term.focus();
});
el("btn-fit").addEventListener("click", () => {
  fit.fit();
  sendResize();
  term.focus();
});

// heartbeat keeps reverse proxies / idle sockets alive
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "ping" }));
  }
}, 25000);

connect();
