/**
 * rtx-webterminal — remote web terminal
 * Runtime: Bun + TypeScript
 * PTY: native Bun.spawn({ terminal }) — no native deps, no bun-pty needed
 * Frontend: locally bundled xterm.js (fully offline, no CDN)
 *
 * Env:
 *   PORT=3000  HOST=0.0.0.0  SHELL=/bin/bash
 *   AUTH_TOKEN=secret  (empty = no auth, for LAN use set a token)
 *   CWD=/home/user
 */

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const SHELL = process.env.SHELL ?? "/bin/bash";
const AUTH_TOKEN = process.env.AUTH_TOKEN ?? "";
const CWD = process.env.CWD ?? process.cwd();

type WsData = {
  token: string;
  proc?: ReturnType<typeof Bun.spawn>;
  alive: boolean;
};

function isAuthorized(req: Request): boolean {
  if (!AUTH_TOKEN) return true;
  const url = new URL(req.url);
  // token via query ?token= or Authorization: Bearer
  const q = url.searchParams.get("token") ?? "";
  const h = req.headers.get("authorization") ?? "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7) : "";
  return q === AUTH_TOKEN || bearer === AUTH_TOKEN;
}

async function serveStatic(path: string): Promise<Response | null> {
  const routes: Record<string, string> = {
    "/": "public/index.html",
    "/index.html": "public/index.html",
    "/client.js": "public/client.js",
    // serve xterm css offline straight from node_modules
    "/xterm.css": "node_modules/@xterm/xterm/css/xterm.css",
  };
  const file = routes[path];
  if (!file) return null;
  const f = Bun.file(file);
  if (!(await f.exists())) return null;
  const contentType = file.endsWith(".html")
    ? "text/html"
    : file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "application/octet-stream";
  return new Response(f, { headers: { "Content-Type": contentType } });
}

const server = Bun.serve<WsData>({
  hostname: HOST,
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, shell: SHELL, auth: AUTH_TOKEN !== "" });
    }

    // WebSocket endpoint for the terminal
    if (url.pathname === "/ws") {
      if (!isAuthorized(req)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const token = url.searchParams.get("token") ?? "";
      const upgraded = server.upgrade(req, { data: { token, alive: true } });
      if (upgraded) return undefined as unknown as Response;
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    const staticRes = await serveStatic(url.pathname);
    if (staticRes) return staticRes;
    return new Response("Not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      const data = ws.data as WsData;
      console.log(`[+] ws connected ${ws.remoteAddress}`);

      const cols = 80;
      const rows = 24;

      // Native PTY via Bun. Inline `terminal:` form makes the child
      // a session leader so Ctrl+C / /dev/tty work correctly.
      const proc = Bun.spawn([SHELL, "-i"], {
        cwd: CWD,
        env: {
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        } as Record<string, string>,
        terminal: {
          cols,
          rows,
          name: "xterm-256color",
          data(_term, ptyData) {
            // ptyData is Uint8Array — forward raw to browser
            if ((data as WsData).alive) {
              try {
                ws.send(ptyData as unknown as Uint8Array);
              } catch {
                /* socket gone */
              }
            }
          },
          exit(_term, exitCode) {
            try {
              ws.send(JSON.stringify({ type: "exit", code: exitCode ?? 0 }));
            } catch {
              /* ignore */
            }
            // give client a moment to render, then close
            setTimeout(() => {
              try {
                ws.close(1000, "shell exited");
              } catch {
                /* ignore */
              }
            }, 250);
          },
        },
      });

      data.proc = proc;
      data.alive = true;

      // greet (optional, helps verify pipe)
      ws.send(JSON.stringify({ type: "info", shell: SHELL }));
    },

    message(ws, msg) {
      const data = ws.data as WsData;
      const term = data.proc?.terminal;
      if (!term || term.closed) return;

      // Client protocol: JSON {type:"input",data} | {type:"resize",cols,rows}
      // or raw string = direct input (back-compat)
      if (typeof msg === "string") {
        if (msg.startsWith("{")) {
          try {
            const parsed = JSON.parse(msg) as
              | { type: "input"; data: string }
              | { type: "resize"; cols: number; rows: number }
              | { type: "ping" };
            if (parsed.type === "input") {
              term.write(parsed.data);
              return;
            }
            if (parsed.type === "resize") {
              const c = Math.min(400, Math.max(20, parsed.cols | 0));
              const r = Math.min(200, Math.max(5, parsed.rows | 0));
              try {
                term.resize(c, r);
              } catch {
                /* ignore */
              }
              return;
            }
            if (parsed.type === "ping") {
              ws.send(JSON.stringify({ type: "pong" }));
              return;
            }
          } catch {
            // not JSON — fall through to raw write
          }
        }
        term.write(msg);
      } else if (msg instanceof Uint8Array || msg instanceof ArrayBuffer) {
        term.write(msg as Uint8Array);
      } else {
        // Buffer / other binary
        term.write(msg as unknown as Uint8Array);
      }
    },

    close(ws, code, reason) {
      const data = ws.data as WsData;
      data.alive = false;
      console.log(`[-] ws closed ${code} ${reason}`);
      try {
        data.proc?.kill();
      } catch {
        /* already dead */
      }
      try {
        data.proc?.terminal?.close();
      } catch {
        /* ignore */
      }
    },
  },
});

console.log(`rtx webterminal listening on http://${server.hostname}:${server.port}`);
console.log(`shell=${SHELL}  auth=${AUTH_TOKEN ? "TOKEN-REQUIRED" : "open (set AUTH_TOKEN!)"}`);
if (!AUTH_TOKEN) {
  console.warn("WARNING: no AUTH_TOKEN set — anyone who can reach this port gets a shell. Set AUTH_TOKEN for remote use.");
}
