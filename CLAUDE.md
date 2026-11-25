# SelfHost Hub — context for Claude

The owner is French: app UI text is French. Replies to the owner are short. Ignore the `BITCOIN/` folder.
Model use: Sonnet subagents for light coding, Haiku subagents for file reading.

## Repo layout

- `mobile/`: Expo SDK 57 / React Native 0.86 app (expo-router, zustand, expo-audio). See `mobile/AGENTS.md`.
  - expo-audio is patched: `mobile/patches/expo-audio`, copied in by `scripts/patch-expo-audio.js` at npm postinstall,
    and pinned to 57.0.5.
  - Tests: `node tests/run-all.js`, which bundles the code with stubs from `tests/stubs`.
- `wear/`: the watch app. It relays commands through the phone (`mobile/src/services/watchLink.ts`).
- `src/`: Electron desktop app (main, preload, renderer: React, TS, Zustand, Tailwind).
- Rust workspace (edition 2024): `crates/*`, `apps/desktop` (slint, a Rust rewrite in progress), and `apps/server`.
- `apps/server`: the hub server (package `selfhost-hub-server`), built with axum, tokio and rusqlite. The spec is
  `docs/server-protocol.md`: protocol v2, Navidrome login, remote control relay, listening (Wrapped) sync, and the
  admin API.
- `deploy/`: `docker-compose.yml` and a French README for the hub. The `Dockerfile` and `.dockerignore` are at the
  repo root.

## Machine quirks (this Windows PC)

- **Node.js and git are not on PATH.** JS/TS can't be type-checked, tested or built here, and `git status` doesn't
  work. Cargo works.
- There's no Docker here: images are built on the home server.
- The shell is PowerShell 5.1. To run a script on the server, write it to a file and pipe it:
  `Get-Content -Raw f.sh | ssh host "tr -d '\r' | sed '1s/^\xEF\xBB\xBF//' | bash -s"`. Inline `$` and quotes get
  mangled.
- `!` commands in the Claude prompt can't answer password prompts. Anything that needs `sudo` or a password must be
  run by the owner in their own PowerShell window, without the `!`.

## Home server (details in auto-memory: home-server)

- SSH key login from this PC as `mboot`. The user is in the docker group. `sudo` needs the owner.
- The server has an i5-6400, 7.7 GB RAM and a 430 GB disk.
- Running there: Navidrome (`navidrome_default` network), Nginx Proxy Manager (admin on :81, reachable only through
  an SSH tunnel: `ssh -N -L 8181:127.0.0.1:81 ...`), downtify, dashy, the stoat stack, the hub and Crafty.
- Public names are DuckDNS (`*.goofysound.duckdns.org` all resolve to the server). Nginx Proxy Manager forwards to
  `172.17.0.1:<port>`, and hosts need **Websockets Support**.
- Docker builds need `build.network: host`, because the server's DNS is systemd-resolved on 127.0.0.53.

### Hub (deployed 2026-11-25)

- Lives in `~/selfhost-hub` (container `selfhost-hub`, volume `deploy_hub-data`), plus `selfhost-hub-docker-proxy`,
  which lets the hub read container info but never change it.
- URL: https://hub.goofysound.duckdns.org. Health is at `/api/health`. The admin panel is at `/admin`: Navidrome
  admins only, and it shows system info, containers, processes, disks, network and hub devices.
- Deploy:
  1. Build the archive:
     `tar -czf selfhost-hub-server.tar.gz --exclude=target --exclude=node_modules Dockerfile .dockerignore Cargo.toml Cargo.lock crates apps deploy`
  2. Copy it to the server with `scp`.
  3. On the server, unpack it into `~/selfhost-hub`.
  4. In `~/selfhost-hub/deploy`, run `docker compose up -d --build`. The build takes about 2 minutes.

### Crafty (deployed 2026-11-25)

- Lives in `~/crafty` (compose file there, not in this repo), Crafty 4.11.1.
- Web: https://crafty.goofysound.duckdns.org. Nginx Proxy Manager forwards it to **https**://172.17.0.1:8443, which
  is published on the docker0 address only.
- Minecraft: router port 16300 maps to host 16300, then to container port 25565. Ports 25566-25570 work on the LAN
  only.
- The first admin password is in `~/crafty/docker/config/default-creds.txt`. The owner reads it themselves; never put
  it in chat.

## State of work / pending

- **Not compiled or run** (written while there was no Node):
  - mobile: audio glitch fix (ExoPlayer wake mode, WAKE_LOCK, diagnostics logging), Settings split into sub-pages
    (`src/app/settings/[section].tsx`), Wrapped rework (periods, range picker, drillable chart), hub-server client
    (`src/services/hubServer.ts`, `listeningSync.ts`, server card in `src/app/devices/index.tsx`);
  - desktop: hub client (`src/main/hubServerClient.ts`), listening recorder (`src/renderer/src/services/listeningLog.ts`),
    `Settings/HubServerSection.tsx`.

  Once Node is installed:
  1. Run `npm install` in `mobile/`, so the expo-audio patch is copied in again.
  2. Run `node tests/run-all.js`.
  3. Run `tsc` on both apps.
  4. Rebuild the APK and the desktop app.
- **Admin web shell (Terminal tab): deployed 2026-11-25, enabled** (`SHELL_ENABLED=true`, `SHELL_SSH_USER=mboot`).
  Code: `apps/server/src/{shell,terminal,totp}.rs`, panel tab in `admin/index.html`. Tests and clippy pass; panel JS
  was checked with `node --check` (in a Docker node container on the server). Not yet tried in a browser. The owner
  still has to add the hub key line (shown in the tab) to `~/.ssh/authorized_keys` and set up TOTP.
- **This folder is behind GitHub.** Local HEAD is v3.2.0 (`12dfacaf`) plus uncommitted work; GitHub `main` has
  3.2.1, 3.3.0 and 3.4.0 (`cb194213`, 4 commits and 117 files ahead). Merge before building or releasing anything.
- The owner was asked to change the server password, which was weak and was shared in chat. Turning off SSH
  password login was recommended.
- The admin login and the remote/sync flows haven't been tested end to end with real devices yet.
