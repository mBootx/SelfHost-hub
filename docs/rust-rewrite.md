# Rust rewrite plan

Goal: replace all three apps (Electron desktop in `src/`, Expo phone app in `mobile/`, Kotlin Wear OS app in `wear/`) with Rust, UI included.

Status: Phase 0 partly done, Phase 1 started.
- Done: Cargo workspace (`Cargo.toml`, `crates/`, `apps/desktop`), Rust CI job, desktop shell window (Slint 1.18.1, Rust 1.100) that builds and runs on Windows. Spikes 1 and 2 (results below).
- Not started: spike 3 (Android audio and media session), spike 4 (video).
- Phase 1 was started before spikes 3 and 4 because its crates (protocols, clients, storage) do not depend on the UI or audio stack those spikes decide.
- Phase 1 so far, all in `hub-core` with 81 tests and golden tests against every sample in `wear/core/src/test/resources/`:
  - `pairing`: port of `src/main/pairing.ts`.
  - `protocol::link`, `protocol::update`, `protocol::downtify`, `protocol::setup`: ports of the watch's `LinkProtocol.kt`, `UpdateProtocol.kt`, `DowntifyProtocol.kt`, `WatchSetup.kt`.
  - `subsonic`: Subsonic token auth, merging `SubsonicAuth.kt` and the auth part of both `navidrome.ts` clients.
  - `palette` (`CoverPalette.kt`), `home_network` (`PrivateAddress.kt`), `format` (`Formatting.kt`), `watch` (`WatchPrefs.kt` settings and `AutoOpenPolicy.kt`).
  - `wear/core` is now fully ported except its Android-only parts (`SetupStore`'s encrypted store, `WifiSocketFactory`).
- `hub-net::subsonic`: the Subsonic client, port of the watch's `SubsonicApi.kt` (28 tests, with an in-memory port of `FakeNavidrome.kt`). It sends requests through a `Transport` trait, so it builds without any HTTP library; the desktop/phone calls of both `navidrome.ts` (playlist editing, scrobbling, lyrics, admin) are added as their screens are ported.
- `hub-net::HttpTransport` (feature `http`): the real transport. reqwest 0.13 with `rustls-no-provider`, rustls on the `ring` provider (reqwest's default `rustls` feature uses aws-lc, which needs CMake and NASM on Windows), and `rustls-platform-verifier`, so each device trusts what it trusts today: the Windows store on the desktop (as Chromium does), the Android system store on the phone and watch. Plain `http://` stays allowed, as both Android apps allow it now (`usesCleartextTraffic`). Timeouts are the watch's OkHttp ones (connect 8 s, read 20 s, call 40 s). Tested against a local HTTP server, including a Subsonic ping end to end; HTTPS itself is not tested yet (needs a test certificate). First build: 1 min 46 s at 2 jobs.
- Open for the Android apps: the verifier needs its Java part and a JNI init in the shim; and the watch's "home" client must be bound to its Wi-Fi (`WifiSocketFactory.kt` today). reqwest's `interface()` uses `SO_BINDTODEVICE`, which Android apps may not use, so the binding needs `android_setsocknetwork` through a custom connector.
- `hub-net::filebrowser`: port of `mobile/src/services/filebrowser.ts` (login by cookie, sources, listing, thumbnails with the old route as fallback, bulk delete and move with 207 partial failures, rename, share links, search, folders, disk usage, text preview), with its tests ported. Big uploads and downloads stream through each app's own code using the client's addresses and `upload_result`; a streaming transport for them is still to do.
- `hub-net::downtify`: port of `mobile/src/services/downtify.ts`. Settings are kept as the server's whole JSON object, so saving them back loses nothing. `queueByQuery` became `resolve_query` + `download_targets`: the caller starts the downloads, as each one answers only when finished.
- `hub-core::paths`: `fileNames.ts` and the FileBrowser path helpers.
- `Transport` now carries any method, headers, a body and a per-request timeout, and returns every reply header (FileBrowser's login token comes in `Set-Cookie`).
- Test counts: `hub-core` 85, `hub-net` 65 (with `--all-features`).
- Next: Navidrome admin and lyrics clients, then `hub-store`.
- The phone's `coverColor.ts` must be compared with `palette` before the phone port: the watch version claims to follow it, but they are separate code.
- When `wear/` is deleted (Phase 5), its sample files in `wear/core/src/test/resources/` must move first: the Rust tests include them by path.

## Ground rules

1. **Wire compatibility first.** Each app is replaced one at a time. During the transition a Rust app must talk to the old apps unchanged: the PC hub protocol (`src/main/remoteHub.ts`, `src/main/pairing.ts`), the phone/watch link (`wear/core/.../LinkProtocol.kt`, `mobile/src/services/watchLink.ts`), the watch update and Downtify protocols. The JSON samples in `wear/core/src/test/resources/` become golden tests for the Rust codecs.
2. **Same identities.** The Rust phone and watch apps keep the current `applicationId`s and signing key, so they install as updates. The desktop installer keeps the NSIS name `SelfHost-Hub-Setup-<version>.exe` and the GitHub release feed, so the last Electron build can update itself into the Rust build.
3. **Port the tests with the code.** `mobile/tests/*.test.js` (40 suites) and the Kotlin unit tests in `wear/*/src/test` are ported to `cargo test` before the code they cover is deleted.
4. **Old code is deleted only when its replacement ships.**

## What cannot be pure Rust

Android only lets Java/Kotlin classes be declared as services, receivers and widgets in the manifest, and several SDKs the apps use only exist as Java libraries. Each Android app therefore keeps a thin Kotlin shim that forwards to Rust over JNI and holds no app logic. Expected shim contents:

| App | Kotlin shim pieces | Why |
|---|---|---|
| Phone | `MediaSessionService` + media notification | Now Bar, lock screen, Bluetooth and car controls go through `androidx.media3` |
| Phone | Audio focus listener | Java-only API (`MusicFocus.kt` today) |
| Phone | `AppWidgetProvider` | Home-screen player widget |
| Phone | `WearableListenerService` + `MessageClient` + `RemoteActivityHelper` | Watch link uses Google Play Services Data Layer, Java only |
| Phone | CameraX + MediaPipe hand landmarker | Car-mode gestures. Landmarks are passed to Rust; the gesture recognizer itself is ported to Rust |
| Phone | MediaStore, WorkManager / background task, BiometricPrompt, share intents, file picker | Camera backup, background sync, app lock, sharing |
| Phone | Android Keystore | Encrypting saved credentials |
| Watch | `TileService` (ProtoLayout) | Now Playing tile |
| Watch | `WearableListenerService` + `MessageClient` | Phone link |
| Watch | Ambient mode callbacks, rotary input forwarding (if Slint does not receive rotary scroll events) | Always-on clock page, crown/bezel volume |

Estimated shim size: under 1,500 lines of Kotlin in total, against ~52,000 lines of TypeScript and Kotlin today.

## Stack

| Concern | Choice | Reason |
|---|---|---|
| UI, all three apps | **Slint** | Only mature Rust toolkit that renders natively on Windows/macOS/Linux **and** Android, including Wear OS. Dioxus and Tauri need a WebView, which Wear OS does not ship. Royalty-free licence requires a "Made with Slint" attribution (About screen). |
| Async runtime | tokio | Needed by reqwest, axum, tungstenite |
| HTTP clients | reqwest + rustls | Subsonic, FileBrowser, Downtify, lyrics. No CORS problem outside a browser, so the Electron `net:request` proxy disappears |
| PC hub server | axum + tokio-tungstenite | Same port 51823, same `/selfhosthub/ping`, same challenge/hello flow |
| Pairing crypto | hmac + sha2 + subtle + rand | Same HMAC-SHA256 proof, constant-time compare |
| Audio decode | symphonia | MP3, FLAC, AAC/ALAC (MP4), Vorbis, WAV. Opus needs libopus: check the library's formats in the spike |
| Audio output | cpal (WASAPI / CoreAudio / ALSA / AAudio) | One engine for desktop and phone; gapless and crossfade written once |
| Local data | rusqlite (bundled SQLite) | Replaces electron-store, AsyncStorage and the watch's Room database |
| Secrets | `keyring` crate on desktop; Keystore via shim on Android | Replaces Electron `safeStorage` and `expo-secure-store` |
| Images | `image` + `fast_image_resize` | Cover palette, pre-blurred backdrops (Slint has no blur filter) |
| Desktop tray | `tray-icon` | Replaces `src/main/tray.ts` |
| Desktop packaging and updates | `cargo-packager` (NSIS / dmg / AppImage) + its updater | Keeps the installer format and GitHub feed |
| Android build | `cargo-ndk`, Gradle only for the shim and APK signing | Targets `aarch64-linux-android`, `armv7-linux-androideabi` (many Wear OS watches run a 32-bit userspace), `x86_64-linux-android` for the emulator |

## Workspace layout

```
Cargo.toml                 workspace root
crates/
  hub-core/                pure logic, no I/O: models, link/update/Downtify protocols, pairing, queue and shuffle,
                           cover palette, lyrics parsing, scrobble rules, wrapped stats, photo-vault path rules,
                           gesture recognizer, drag/zoom maths, plurals
  hub-net/                 HTTP clients: Subsonic (salt+token auth), Navidrome admin, FileBrowser, Downtify, lyrics
  hub-store/               SQLite schemas, settings, offline library cache, listening log, Secret trait
  hub-audio/               streaming source (HTTP range reads), symphonia decode, cpal output, gapless, crossfade,
                           loudness, sleep timer
  hub-link/                PC hub server and phone hub client (WebSocket), watch link codec and relay
  hub-ui/                  shared Slint components: theme and accent colour, cover image, seek bar, lyric lines,
                           dialogs, bottom sheet, toasts
apps/
  desktop/                 replaces src/
  phone/                   Rust cdylib + android/ (Kotlin shim, Gradle, manifest). Replaces mobile/
  watch/                   Rust cdylib + android/ (Kotlin shim, Gradle, manifest). Replaces wear/
```

## Where today's code goes

| Today | Rust home |
|---|---|
| `src/renderer/src/services/navidrome.ts`, `mobile/src/services/navidrome.ts`, `wear/data/.../SubsonicApi.kt`, `wear/core/.../SubsonicAuth.kt` | `hub-net::subsonic` (three copies become one) |
| `*/services/filebrowser.ts`, `mobile/src/services/photoVault.ts`, `cameraBackup.ts`, `uploadConflicts.ts`, `fileNames.ts` | `hub-net::filebrowser` + `hub-core::vault` |
| `*/services/downtify.ts`, `wear/core/.../DowntifyProtocol.kt`, `mobile/src/services/watchDowntify.ts` | `hub-net::downtify` + `hub-core::protocol::downtify` |
| `src/main/remoteHub.ts`, `src/main/pairing.ts`, `*/store/remoteStore.ts`, `mobile/src/services/remoteControl.ts` | `hub-link::hub` (server) and `hub-link::client` |
| `wear/core/.../LinkProtocol.kt`, `UpdateProtocol.kt`, `mobile/src/services/watchLink.ts`, `watchUpdateProtocol.ts` | `hub-core::protocol::{link, update}` |
| `*/services/audioEngine.ts`, `playbackEngine.ts`, `playbackMemory.ts`, `offlinePriority.ts`, `loudness.ts`, `sleepTimer.ts` | `hub-audio` |
| `*/services/lyrics.ts`, `scrobbler.ts`, `wrapped.ts`, `listeningLog.ts`, `coverColor.ts`, `wear/core/.../CoverPalette.kt`, `gestureRecognizer.ts` | `hub-core` |
| `wear/data/.../db/*` (Room), `LibrarySync.kt`, `*/store/offlineStore.ts`, `coverStore.ts` | `hub-store` |
| React and Compose screens | Slint `.slint` files in each app, shared widgets in `hub-ui` |
| `mobile/modules/selfhost-native/*.kt` | Phone Kotlin shim (kept, trimmed to forwarding only) |

## Phases

Each phase ends with something that ships or is tested; nothing is half-ported across phases.

### Phase 0: toolchain and spikes
- Install the toolchain (see Prerequisites). Add the workspace skeleton and a CI job: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, Android cross-builds.
- Spikes, each a throwaway proof before the stack is locked in:
  1. Slint app on a round Wear OS emulator: round-screen insets, rotary/bezel events, ambient mode.
  2. Slint app on the phone: IME text input, scrolling a 5,000-row list smoothly, back gesture.
  3. Audio on Android: symphonia + cpal (AAudio) streaming from Navidrome, controlled from a `MediaSessionService` shim over JNI, shown on the Samsung Now Bar.
  4. Video: Slint has no video widget. Decide between handing video to the system player (Android intent / desktop default app) or an ffmpeg-based frame renderer. Affects FileBrowser previews and the Photos viewer.
- **Exit:** every spike works, or this plan is revised before more code is written.

#### Results of spikes 1 and 2 (2026-11-15)

Code: `spikes/android/` (Rust/Slint library in `rust/`, APK packaging in `app/`, `build.ps1`). One APK runs on both emulators and shows a watch page under 300 logical px wide.

Spike 1, watch (Wear OS 6.0 emulator, round, 454×454 px, scale 2):

| Check | Result |
|---|---|
| Rendering on a round screen | Works. Cold start 1.4 s, 63.6 MB PSS. |
| Crown / bezel | **Slint 1.18.1 panics**: its Android backend has `todo!()` for scroll events (`androidwindowadapter.rs:443`). The patched copy in `spikes/android/vendor/i-slint-backend-android-activity` (about 30 lines) makes the crown scroll lists: clockwise scrolls down, 64 px per step. Needs an upstream fix or a maintained patch. |
| Back button | Arrives as key `U+F748`; the app decides what it does. |
| Swipe to dismiss | **Does not work.** NativeActivity takes input before the window's swipe-dismiss layer, so the app must detect the swipe itself and close the activity. |
| Ambient mode | Not tested: needs the Kotlin shim. |
| Size | `.so` 19.4 MB (x86_64, release); 14.0 MB with `opt-level = "s"`, LTO and strip, but a 9-minute build. Slint's Android backend always links Skia. Today's whole watch APK is 3.9 MB. |

Spike 2, phone (API 37 emulator, 1080×2400 px, scale 2.62):

| Check | Result |
|---|---|
| Rendering, system bars | Works. The app is drawn edge to edge and must pad itself with `Window.safe-area-insets` (24 px top and bottom here); doing so works. |
| Keyboard | Gboard opens, typing works with auto-capitals and composition, and `Window.virtual-keyboard-size` lets the layout shrink above it. |
| 5,000-row list | Fling with momentum works; 66.9 MB PSS. Frame timing not measured. |
| Back key and back gesture | Both arrive as `U+F748`. |
| Start-up | **Slow first frame**: 3.9 s cold start, and the window stays black for about 2 s after the activity is shown. To investigate (Skia warm-up is the likely cause). |
| Not checked | Accents by long-press and emoji from Gboard (the emulator's Gboard gave numbers and an empty emoji panel); font fallback for CJK, Arabic and emoji titles (rows added, screenshot never taken). |

Build notes: Slint's Java helper needs `ANDROID_JAR` when the SDK platform folder is named like `android-37.0`; Windows PowerShell 5.1 scripts must not use `$ErrorActionPreference = "Stop"` around cargo. Both handled in `build.ps1`.

Verdict so far: Slint is usable on both, but only with a patched Android backend (crown), app-side swipe-to-dismiss, and a watch APK several times larger than today's.

### Phase 1: `hub-core`, `hub-net`, `hub-store`
- Port all pure logic and the HTTP clients. Port the matching tests from `mobile/tests/` and `wear/*/src/test/`. Port `wear/data/src/test/.../FakeNavidrome.kt` as an axum test server.
- Golden tests: Rust codecs read and write every file in `wear/core/src/test/resources/` exactly as the Kotlin and TypeScript sides do.
- **Exit:** `cargo test` green; no UI yet.

### Phase 2: desktop app (replaces `src/`)
- `hub-audio` on desktop, `hub-link::hub` server, Slint screens for Navidrome (including Big Picture and synced lyrics), FileBrowser, Downtify, Server admin, Settings. Tray, Wake-on-LAN, updater.
- Settings migration: import the electron-store JSON on first run. Saved passwords are encrypted with Electron's `safeStorage` and are not migrated; users sign in once again.
- **Exit:** the Rust desktop build works with the current phone (3.2.x) and watch; the last Electron build updates into it through the GitHub feed.

### Phase 3: watch app (replaces `wear/`)
- Smallest Android app, cleanest module split, and fully covered by tests: the right one to prove Rust on Android.
- `hub-store` replaces Room; Slint screens replace Compose; Kotlin shim for tile, listener service, ambient, rotary.
- **Exit:** installs over the current watch app with the same signing key; works with the current phone app.

### Phase 4: phone app (replaces `mobile/`)
- Largest piece: player, library, playlists admin, FileBrowser, Photos and camera backup, Downtify, car mode, app lock, weekly recap, diagnostics, tab animation settings, widget, watch link.
- Data migration: read AsyncStorage's `RKStorage` SQLite and the expo-secure-store entries (through the Keystore shim) on first launch; keep downloaded songs and covers in place.
- **Exit:** installs over 3.2.x; downloads, covers, settings and logins survive the update.

### Phase 5: clean-up
- Delete `src/`, `mobile/`, `wear/`, `package.json`, `package-lock.json` and the Node config files. Update `README.md`, `.github/workflows/ci.yml` and the release steps.

## Risks

| Risk | Effect | Handling |
|---|---|---|
| Slint on Wear OS is not a documented target | Watch rewrite could stall | Spike 1 before any watch work |
| No video widget in Slint | Inline video previews lost | Spike 4 picks the replacement before Phase 2 |
| JNI shim bugs in media session / audio focus | Repeat of the Now Bar bugs fixed in 2.7.0 | Port `mobile/tests/nowbar.test.js` cases; test on a Samsung device |
| MediaPipe has no Rust binding | Car-mode gestures need the Kotlin shim | Shim sends landmarks only; recognizer and its tests live in Rust |
| Saved passwords not migrated on desktop | One extra sign-in per user | Announce in the release notes |
| Size of the work | The phone app alone is ~29,000 lines of TypeScript | Phases ship independently; no app is left half-ported |

## Prerequisites (dev PC, Windows)

- Rust via rustup (`stable-x86_64-pc-windows-msvc`) and Visual Studio 2022 Build Tools with the "Desktop development with C++" workload.
- git.
- For Phases 0, 3 and 4: JDK 17, Android SDK + NDK (Android Studio installs both), `cargo install cargo-ndk`, and
  `rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android`.
