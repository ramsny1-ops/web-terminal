# rtx webterminal

Remote web terminal built on **Bun + TypeScript** with native PTY and a fully **offline** xterm.js frontend (no CDN).

## How it works

- `src/server.ts` — `Bun.serve` + WebSocket `/ws`, one native PTY per connection via `Bun.spawn([SHELL], { terminal: {...} })`. Full TTY: colors, `vim`, `top`, Ctrl+C work.
- `src/client.ts` — xterm.js + Fit + WebLinks, bundled locally to `public/client.js`.
- `public/index.html` — toolbar (fit / clear / reconnect), status dot, auto-reconnect.
- `/xterm.css` is served from local `node_modules`, not a CDN.

## Quick start (local)

```bash
bun install
bun run build:client
bun run dev
# open http://localhost:3000
```

## Remote access

```bash
cp .env.example .env   # edit AUTH_TOKEN
HOST=0.0.0.0 PORT=3000 AUTH_TOKEN=long-random-secret SHELL=/bin/bash bun run src/server.ts
# open http://<server-ip>:3000/?token=long-random-secret
```

Security notes for remote use:
- Always set `AUTH_TOKEN` (query `?token=` or `Authorization: Bearer`).
- Put behind TLS (Caddy / Nginx / Tailscale) — the app itself is plain HTTP + WS.
- Each connection gets its own shell as the server user. Don't run as root.
- Firewall the port to known IPs / VPN where possible.

## Protocol (WS `/ws?token=...`)

Client → server (JSON):
- `{"type":"input","data":"ls\n"}` — keystrokes
- `{"type":"resize","cols":120,"rows":32}`
- `{"type":"ping"}` — heartbeat

Server → client:
- raw PTY bytes (binary) — terminal output
- `{"type":"info","shell":"/bin/bash"}`
- `{"type":"exit","code":0}` then socket closes

## Scripts

- `bun run dev` / `bun run start` — run server
- `bun run build:client` — rebundle frontend after editing `src/client.ts`
