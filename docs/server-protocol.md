# SelfHost Hub server — protocol v2

The hub server (`apps/server`, Docker image `selfhost-hub-server`) runs next to Navidrome on the home server. It
replaces the PC as the hub of remote control, and keeps everyone's listening data so the phone and the PC share one
Wrapped. Devices sign in with their **Navidrome account**: each account has its own group of devices and its own
listening data.

When no server address is set in an app, the app keeps the old peer-to-peer LAN protocol (PC hub on port 51823,
pairing code) unchanged. When one is set, the app uses only the server: the PC no longer runs its own hub.

## Addresses

The person types the server's address in the app's settings, either:

- `http://192.168.1.10:51823` at home (or through a VPN), or
- `https://hub.example.tld` through a reverse proxy that terminates TLS and forwards WebSocket upgrades.

From that base URL:

| What | URL |
|---|---|
| Health | `GET {base}/api/health` → `{"app":"selfhost-hub-server","version":"0.1.0","name":"<SERVER_NAME>"}` |
| WebSocket | `{base}/ws`, where `http` becomes `ws` and `https` becomes `wss` |

A trailing slash on the base is ignored. The app checks `/api/health` when the address is saved and says whether it answers.

## Frames

Every message is one JSON object in one text frame, with a string `type`. Unknown types are ignored by both sides
(forward compatibility). The server accepts frames up to 16 MiB.

## Sign-in

```
server → {"type":"challenge","v":2,"nonce":"<32 hex chars>","serverName":"Maison","serverVersion":"0.1.0"}
client → {"type":"hello","v":2,"deviceId":"…","deviceName":"Pixel de Max","platform":"mobile","user":"max","token":"<md5 hex>"}
server → {"type":"welcome","accepted":true,"user":"max","deviceId":"…","serverVersion":"0.1.0","features":["remote","listening"]}
     or  {"type":"welcome","accepted":false,"reason":"bad-auth"}   (then the server closes)
```

- `token = md5(navidromePassword + nonce)`, lowercase hex: the Subsonic salt+token scheme with the server's
  nonce as the salt. The server checks it by calling Navidrome
  `GET {NAVIDROME_URL}/rest/ping.view?u=<user>&t=<token>&s=<nonce>&v=1.16.1&c=selfhost-hub-server&f=json`
  and accepting `subsonic-response.status == "ok"`. The password never leaves the device, and a token can't be
  replayed because each connection has a new nonce.
- `platform` is `mobile`, `desktop` or `watch`.
- `deviceId` is chosen once by the device (a random id kept in its storage) and never changes. It is the device's
  identity for remote control and for listening data, so it must survive app updates.
- Reasons for refusal: `bad-auth` (Navidrome said no), `navidrome-unreachable` (the server could not reach Navidrome),
  `update-required` (`v` is missing or below 2), `too-many-attempts` (5 failed sign-ins from one address in 10 minutes
  block it for 10 minutes), `bad-hello` (malformed).
- A client that does not send `hello` within 10 s is disconnected.
- The user key is the Navidrome username, lowercased.
- A second connection with the same `user` + `deviceId` replaces the first one, which is closed with code 4000
  (`replaced`). An admin can also close a connection with code 4001 (`kicked`); clients just reconnect normally
  (with the usual backoff).

## Remote control

The server sends the following only to the devices of the same user.

```
server → {"type":"devices","devices":[{"deviceId":"…","deviceName":"…","platform":"desktop"}]}
```

The server sends `devices` right after `welcome`, and again whenever a device of that user joins or leaves. The list
includes every online device of the user, the receiver included.

```
client → {"type":"state","song":{…}|null,"isPlaying":true,"currentTime":12.3,"duration":201,"shuffle":false,"repeatMode":"off","volume":0.8}
server → the same object with "deviceId":"<sender>" set by the server, to the user's other devices
```

- The fields are the same as `RemoteDeviceState` in `mobile/src/services/remoteControl.ts`, and `song` is
  `RemoteSongInfo`.
- The server keeps the last `state` of each online device. It sends those states to a device right after its
  `devices` message, so a newcomer sees what is playing at once. A device that leaves has its state dropped.

```
client → {"type":"command","targetId":"<deviceId>","action":"seek","payload":12}
server → {"type":"command","targetId":"<deviceId>","fromId":"<sender>","action":"seek","payload":12}   (to the target only)
```

- Allowed actions: `toggle`, `play`, `pause`, `next`, `prev`, `seek`, `setVolume`, `toggleShuffle`,
  `setRepeatMode`, `playMedia`.
- The server drops a command with another action, an unknown target, or a target that belongs to another user, and
  answers it with `error` (`bad-command`).
- There is no `"hub"` target any more: the PC is a device like the others.

## Listening data (Wrapped sync)

Each device owns its own ledger. That is the `Ledger` / `WeekLog` from `mobile/src/services/wrapped.ts`: weeks keyed
by their Monday (`yyyy-mm-dd`), with `days`, `songs`, and optionally `hours` and `daySongs`. A device uploads its own
weeks and downloads the other devices' weeks. What it shows is its own ledger plus all the others, added together
with `mergeLedgers`. Nothing is ever counted twice, because each device's weeks are stored separately and replaced
whole on every upload.

```
client → {"type":"listening.push","weeks":{"2026-11-23":{WeekLog},"2026-11-16":{WeekLog}}}
server → {"type":"listening.ack","weeks":["2026-11-23","2026-11-16"],"rev":1042}
```

- `listening.push` upserts the rows `(user, deviceId, week)` with the given logs, replacing them whole. Each row
  written gets the next value of a server-wide revision counter, and `listening.ack.rev` is the highest one.
- Send at most 8 weeks per push. A week whose JSON is over 2 MiB is refused with `error` (`too-large`), and the other
  weeks of that push are still stored.
- After a push, the server sends `{"type":"listening.changed","rev":1042}` to the user's other online devices.

```
client → {"type":"listening.pull","since":1000}
server → {"type":"listening.data","rev":1042,"entries":[{"deviceId":"…","deviceName":"…","platform":"desktop","week":"2026-11-23","log":{WeekLog},"rev":1041}],"more":false}
```

- `listening.pull` returns the rows of the user's **other** devices with `rev > since`, oldest first, at most 200
  per page.
- `more: true` means "pull again with `since` = the last entry's `rev`". `rev` is the server's current highest
  revision.
- Rows are never deleted by the server. A device that is reinstalled with a new `deviceId` keeps its old data as one
  of the "other" devices, so nothing is lost.

### What a client does

1. It keeps, in its storage: its `deviceId`, the weeks it changed since the last `listening.ack` (the "dirty" weeks),
   the highest `rev` it has pulled, and the other devices' weeks (`deviceId → Ledger`).
2. After `welcome`, it pushes its dirty weeks in batches of 8, then pulls with `since` = the stored rev, page by
   page.
3. While connected, it pushes a week some seconds after it changes: at most every 60 s, plus at once when the app
   goes to the background. It pulls whenever it receives `listening.changed`.
4. It prunes the others' weeks locally with the same `KEEP_WEEKS` as its own.

## Errors and keep-alive

- `{"type":"error","code":"bad-command"|"too-large"|"bad-message","message":"…"}` reports a problem with one message.
  The connection stays open.
- The server sends a WebSocket ping every 30 s and drops a connection that hasn't answered in 75 s. Clients reconnect
  with a backoff of 1 s, 2 s, 5 s, 10 s, then 30 s.

## Server configuration (environment)

| Variable | Default | |
|---|---|---|
| `NAVIDROME_URL` | (required) | How the server reaches Navidrome, e.g. `http://navidrome:4533` |
| `PORT` | `51823` | |
| `DATA_DIR` | `/data` | Holds `hub.db` (SQLite). Mount a volume here. |
| `SERVER_NAME` | `SelfHost Hub` | Shown in the apps |
| `TRUST_PROXY` | `false` | `true`: the client address for the sign-in limit is read from `X-Forwarded-For` |
| `RUST_LOG` | `info` | |
| `HOST_PROC` | `/proc` | Admin system monitor: where the host's `/proc` is mounted |
| `HOST_SYS` | `/sys` | Admin system monitor: where the host's `/sys` is mounted (temperatures) |
| `HOST_ROOT` | (unset) | Host root mounted read-only; disks are `statvfs`ed at `HOST_ROOT` + mountpoint. Unset: the container's own mounts |
| `DOCKER_URL` | (unset) | Read-only Docker API (e.g. `http://docker-proxy:2375`). Unset: containers section says "non configuré" |
| `SHELL_ENABLED` | `false` | `true`: the admin Terminal tab opens an SSH shell on the host |
| `SHELL_SSH_USER` | (required if enabled) | Host account the terminal signs in as |
| `SHELL_SSH_HOST` | `host.docker.internal` | |
| `SHELL_SSH_PORT` | `22` | |

## Admin API

For the admin page at `GET /admin` (one embedded HTML file, French UI). Admins of Navidrome only. All responses
are `Cache-Control: no-store` JSON; errors are `{"error":"<code>"}`.

Sign-in (the password never leaves the browser):

```
GET  /api/admin/challenge                          -> {"nonce":"<32 hex>"}      single use, valid 2 min
POST /api/admin/login {"user","token","nonce"}     token = md5(password + nonce), as in Subsonic
```

The server consumes the nonce (`400 bad-nonce` if unknown, reused or expired), applies the same failed-sign-in
limiter and client-address logic as `/ws` (`429 too-many-attempts`), then checks `ping.view` and
`getUser.view?username=<user>` with the same `u`/`t`/`s`. Answers: `200 {"ok":true,"user"}` plus the cookie,
`401 bad-auth`, `403 not-admin` (valid account without `adminRole`), `502 navidrome-unreachable`.

The session is an in-memory random 256-bit id in the cookie `hub_admin` (`HttpOnly; SameSite=Strict; Path=/;
Max-Age=43200`, plus `Secure` when `TRUST_PROXY=true` and `X-Forwarded-Proto: https`). It expires 12 h after sign-in
and on restart. Every endpoint below answers `401 unauthorized` without a valid session. `POST` endpoints (except
login) also need the header `X-Requested-With: hub-admin`, otherwise `403 csrf`. `GET /admin` is served with a strict
`Content-Security-Policy`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

| Endpoint | |
|---|---|
| `GET /api/admin/me` | `{"user"}` |
| `POST /api/admin/logout` | ends the session, clears the cookie |
| `GET /api/admin/hub` | `server` (name, version, uptime), `navidrome` (url, `ok` of the last check, `checkedAt`), `dbBytes`, and `users[]`: `online[]` (deviceId, deviceName, platform, `ip`, `connectedAt`, `state` = `{title, artist, isPlaying}` or null), `known[]` (from the devices table, `lastSeen`), `listening[]` (per device: `weeks`, `totalSeconds` = sum of the numbers in each week's `days`, `rev`) |
| `POST /api/admin/disconnect {"user","deviceId"}` | closes that connection with code 4001 `kicked`; `404 not-online` if it is not connected |
| `GET /api/admin/system` | read-only host monitor, below |

`GET /api/admin/system` returns `ready`, `sampledAt`, and the sections `host` (hostname, kernel, uptime, load,
cores), `cpu` (total and per-core %), `memory` (bytes; used = total - available), `temps` (hwmon and thermal zones,
with `high`/`crit` when the files exist), `disks` (ext2/3/4, xfs, btrfs, vfat, exfat, zfs, ntfs, f2fs, one per device),
`network` (rates in bytes/s from `HOST_PROC/1/net/dev`; `virtual: true` for `lo`, `veth*`, `br-*`, `docker0`),
`processes` (top 10 by RSS and by CPU), `containers` (from `DOCKER_URL`, refreshed every 15 s, GET only), and
`history` (one point per 10 s for the last hour: cpu, mem, temp, rx, tx). A section that cannot be read is
`{"unavailable":"<reason>"}` (for `network`, `interfaces` is `[]` next to `unavailable`). Host values are sampled
every 5 s by a background task.

### Terminal

An interactive shell on the host, over SSH from the hub (pure-Rust client, key `DATA_DIR/shell_ed25519`, created at
start). The host key is pinned on first use (`hostkey-mismatch` after that if it changes). Opening a shell needs a
session, `SHELL_ENABLED`, a TOTP secret for the user, and a recent correct code ("elevation", 10 min).

| Endpoint | |
|---|---|
| `POST /api/admin/totp/setup {"code"?}` | new secret: `{"secret","otpauth","qrSvg"}`, pending 10 min. Replacing an existing secret needs a current `code` (`403 code-required`) |
| `POST /api/admin/totp/confirm {"code"}` | stores the pending secret and elevates the session; `409 no-pending-setup` |
| `POST /api/admin/shell/unlock {"code"}` | elevates the session; `409 totp-not-set` |
| `GET /api/admin/shell/info` | `enabled`, `host`, `port`, `sshUser`, `authorizedKey` (line for `authorized_keys`), `keyFingerprint`, `hostKey` (pinned SHA256), `totp`, `elevatedFor` (s), `active`, `max`, `idleSeconds`, `maxSeconds` |
| `GET /api/admin/shell/audit` | last 50 sessions: user, ip, start/end, bytes, `endReason` |
| `GET /api/admin/shell/ws?cols&rows` | the shell WebSocket |

Codes are RFC 6238 (SHA-1, 6 digits, 30 s, +-1 step); a step is accepted once. A wrong code is `403 bad-code` with
`attemptsLeft`; the fifth in a session destroys it (`401 session-destroyed`); failures also feed the IP limiter
(`429`). The WebSocket refuses with `403 bad-origin` (Origin must be this site), `shell-disabled`, `not-elevated`,
`409 totp-not-set`, `429 too-many-shells` (2 at once). Over the socket: binary frames are terminal bytes both ways;
client text `{"type":"resize","cols","rows"}`; server text `{"type":"ready"}`, `{"type":"error","code","message"}`
(`ssh-unreachable`, `hostkey-mismatch`, `ssh-auth-failed`, `ssh-error`), then `{"type":"closed","reason"}`. A shell
ends after 15 min idle, 4 h total, on sign-out or server shutdown. CLI: `--reset-totp <user>`, `--reset-shell-hostkey`.
