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

- **Node.js, Git and GitHub CLI are installed, but not on PATH** for this shell. Use full paths:
  `C:\Program Files\nodejs\node.exe` (and `npm` after prepending `C:\Program Files\nodejs` to `$env:Path`),
  `C:\Program Files\Git\cmd\git.exe`, and `C:\Program Files\GitHub CLI\gh.exe`. Cargo works.
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

- **3.5.0 built and tested on the home server (2026-11-25):** merged GitHub 3.4.0 (`cb194213`) into `local-work`,
  including the audio glitch fix, Settings sub-pages, Wrapped rework, hub clients, and the watch update confirmation
  fix (`PendingConfirm.kt` + phone prompt). Phone tests (40/40), phone `tsc`, desktop `typecheck`, watch Gradle
  `test`, and APK signature verification passed.
- **Hub server deployed 2026-11-25:** ships the task-manager admin panel (`Performances` 1 s live / 1 h history,
  `Processus`, `Conteneurs`, `Disques`, `Réseau`, `Hub`, `Terminal`), the TOTP-protected SSH terminal
  (`SHELL_ENABLED=true`, `SHELL_SSH_USER=mboot`), and the multi-domain sign-in gate
  (`GATE_DOMAIN=goofysound.duckdns.org,goofydownloader.duckdns.org`).
- **Still pending for the owner:**
  - Add the hub SSH key line (shown in the Terminal tab) to `~/.ssh/authorized_keys` and set up TOTP.
  - Paste the Nginx Proxy Manager **Advanced** snippet from `deploy/README.md` into `goofydownloader.duckdns.org`
    and check whether router port 8087 is forwarded externally.
  - Change the weak server password and disable SSH password login / `PermitRootLogin`.
  - Test the admin login, Terminal, `/gate`, watch update flow, and remote/sync flows end to end with real devices.
