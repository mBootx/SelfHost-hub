# SelfHost Hub for Wear OS

A watch companion for SelfHost Hub: it shows what is playing on the phone or on the PC, controls it, and lets you pick an
album, a playlist or a song from your Navidrome library to play on the phone. It is a remote control and a library
browser; the music itself plays on the phone or the PC, not on the watch.

**The watch only ever talks to the phone app** (over the Wear OS data layer) **and to Navidrome** (for the library and the
covers). It never connects to the PC: the phone is the one link to the PC, as it already was, and it passes on what the
watch asks and what the PC's players are doing.

- Wear OS 3 or later (API 30+), round or square, interface in French.
- Needs SelfHost Hub **2.5.0 or later** on the phone (it has the **Montre** setting and the watch link). The PC needs
  nothing new: to control it from the watch, the phone must be paired with it (Contrôle à distance) as for any remote.
- Package `com.selfhosthub.mobile`, the same as the phone app, signed with the same key. That is required: the
  Wear OS data layer only delivers a message between two apps of the same package and signature.

## What it does

| | |
|---|---|
| **Now Playing** | Cover, title, artist, a seek bar you can tap or drag, previous / play-pause / next, with a vibration on each press. Swipe up for shuffle, repeat, volume, the choice of player, the library and the settings. The crown changes the volume. Tap the cover to see it full screen. |
| **Always-on display** | Pure black, a small grey cover, the title and the elapsed time. Redrawn at most once a second; with burn-in protection the content moves a few pixels each minute. |
| **Library** | Artists → albums → songs, all albums, playlists and search (typed or spoken). Everything is read from the watch's own copy first, so it works without a connection. Tap a song to play its album from there **on the phone**; press and hold for *play next* / *add to queue*. |
| **Players** | The phone's own player, and the PC and the other devices the phone's remote-control link lists. The watch follows whichever is playing, or one you pin. |
| **Chip on the watch face** | When a song starts on a player (the phone tells the watch), an Ongoing Activity chip appears, one tap from the app, with previous / play-pause / next. It goes away by itself at the end of the song if nobody refreshes it. |
| **Offline** | The library (artists, albums, playlists, songs you opened) and the covers (160 px for lists, 320 px for Now Playing, 640 px only on the full-screen cover) are kept in a Room database; refreshed about every hour. |

## Setting up

1. Install the watch app (below).
2. On the phone, signed in to Navidrome: **Réglages → Montre → Envoyer à la montre**.
3. The phone says "Montre configurée" and the watch leaves its setup screen. The first sync starts at once.

Controlling the music needs nothing but the phone app running: the setup is only for the library. If the phone app is
closed the watch says "Appli fermée"; open SelfHost Hub on the phone and it picks up by itself.

What the phone sends at setup: Navidrome's address and user, a salt and the token made from the password and the salt
(Subsonic accepts any salt, so **the password itself never leaves the phone**). Nothing about the PC. It goes through the
data layer to this app only. The watch keeps it in encrypted preferences (Android keystore). "Oublier la configuration" in
the watch's settings wipes it, with the library and the covers.

## Installing

The watch is not on any store. Each GitHub release has the APK as `SelfHost-Hub-Watch-<version>.apk`; you can also build it
(below). Install it over Wi-Fi debugging:

1. On the watch: *Settings → About → Software* and tap *Software version* seven times; then
   *Settings → Developer options → ADB debugging* and *Debug over Wi-Fi*.
2. *Pair new device* shows an address, a port and a code: `adb pair <address>:<port>` and type the code.
3. `adb connect <address>:<debug port>` then `adb install -r SelfHost-Hub-Watch-<version>.apk`
   (or `app/build/outputs/apk/release/app-release.apk` after building, from `wear/`).

The released APK is signed with the phone app's key. A build made without that key (a fresh clone has no
`mobile/android/keystore.properties`) gets the debug key, which installs fine but cannot be configured from the phone.

## Building

JDK 17 and the Android SDK (platform 36, build tools 36), the same toolchain as the rest of the repository's Android work:

```
set JAVA_HOME=C:\Program Files\Java\jdk-17
set ANDROID_HOME=C:\Users\<you>\AppData\Local\Android\Sdk
gradlew.bat :app:assembleDebug :app:assembleRelease
gradlew.bat testDebugUnitTest
gradlew.bat :app:lintDebug
```

`testDebugUnitTest` runs 183 tests (core 33, data 52, service 62, ui 36). Eight of them run **the phone app's real watch
link** (`mobile/src/services/watchLink.ts`, through Node and the repository's esbuild, see `testing/real-phone.js`) and
talk to it from the watch's real code, so that the two cannot drift apart; they are skipped where Node is missing. The
messages are also held to the sample files in `core/src/test/resources`, which the phone's own tests read too
(`mobile/tests/watchlink.test.js`, `watchsync.test.js`). The UI tests draw every screen on a round 227 dp display and save
a picture of each under `ui/build/screenshots` (they are for looking at, not compared with anything).

## How it is built

```
app/      Application, MainActivity (ambient mode, permissions), manifest, icon, R8 rules
core/     what both sides of every wire agree on, with no UI: the link protocol, the setup message,
          Subsonic token, secret storage, which addresses are on the home network
data/     Room (artists, albums, tracks, playlists, artwork at three sizes, sync log), the Subsonic client,
          the library sync, the repositories
service/  the phone link, the listener for what the phone sends, the hourly sync job, notifications
ui/       Compose for Wear OS: Now Playing, ambient, library, search, players, settings, setup
```

- **Link protocol** (`core/LinkProtocol.kt`, the phone's side is `mobile/src/services/watchLink.ts`): JSON messages over the
  data layer, on four paths. The watch sends `/selfhost/link/request` (answered with a snapshot) and
  `/selfhost/link/command`; the phone sends `/selfhost/link/snapshot` (the answer, and again by itself whenever something
  changes: a song, play/pause, a seek, the volume, the PC coming or going) and `/selfhost/link/closed` (its app's process
  is there but its JavaScript is not running). A snapshot lists the players, the phone first as `local`, then the PC
  (`hub`) and the other devices the phone's hub link shows, each with its state; times are in seconds.
- **Commands**: `toggle`, `play`, `pause`, `next`, `prev`, `seek`, `setVolume` (0 to 1), `toggleShuffle`,
  `setRepeatMode`, each with the player it is for (`targetId`: `local` or what the hub lists), which the phone applies to
  its own player or forwards to the hub; and `playMedia` (`kind` song/album/playlist, `id`, optional `songId`/`index`,
  `mode` now/next/last), which the phone always plays itself, looking the item up in its own Navidrome (so a request cannot
  point it at another server). The old PC hub cannot be asked to play from the library.
- **Staying in touch**: while a screen is shown the watch asks every 30 s, which is also how it learns that the phone has
  gone (no phone connected: "Pas de téléphone"; connected but silent: "Appli fermée"). Between two messages the progress of
  a playing song is moved along by the watch's clock. Nothing keeps a connection open in the background: the system starts
  the listener service when the phone sends something, and the phone only pushes when something changed.
- **Library sync** (`data/LibrarySync.kt`): one request for the artists, which carries the server's "library last
  modified" stamp. While that stamp is unchanged only the newest albums are read; a full pass (which also removes
  what the server dropped) happens when it moves and at least once a day. Songs are read when an album or playlist is
  opened. A pass that fails half way removes nothing.
- **Reaching Navidrome**: a watch paired to a phone often reaches the internet only through the phone, over Bluetooth, and
  a socket opened that way may never reach `192.168.x.x`. For a Navidrome on the home network (a private address, a name
  with no dot or ending in `.local`...) the watch binds its connection to its Wi-Fi when it has one
  (`core/WifiSocketFactory.kt`); for any other address the system chooses.
- **Room**: schema version 1, exported to `data/schemas`; `Migrations.ALL` is where steps go once there is a version 2.
  The library is a cache of the server, so wiping it is always a correct fallback.

## What it cannot do, and what was not seen

- **It was built and tested without a watch.** What is verified: the link against the phone app's real code, the Subsonic
  client and the sync against a scripted server, Room under Robolectric, the notification and the listener services under
  Robolectric, every screen drawn as a picture, the release build (R8) and its manifest. What no test can show: how it feels
  on a wrist, the crown, the vibrations, the Always-On Display on a real panel, battery use, and the real data layer between
  a phone and a watch (delivery when the phone is locked or its app was swiped away, how fast Android freezes the phone
  app). Try those first.
- **The phone app has to be running to control anything.** It is the phone that talks to the PC and plays the music. The
  watch cannot start it (a watch can ask the phone to open an app, but that is not built in).
- **Opening itself when music starts is limited by Android, not by this app.** Since Android 10 a background app cannot
  open its own screen; the offer is the chip on the watch face (Ongoing Activity), which the app posts when a player starts
  (the phone pushes that, so it works with the watch app closed).
- **The watch does not play music** and does not use Bluetooth sockets of its own: the phone's data layer is how it
  reaches the phone. Raw Bluetooth would have meant implementing pairing and encryption by hand, for nothing the data
  layer does not already do.
- The optional Wear OS **tile / complication** and Nearby Connections are not included.

## Troubleshooting

- *"Installez d'abord l'application … pour montre"* on the phone: the phone does not see the app on the watch. Check
  the watch is connected to the phone in the Wear OS companion app, that the APK is installed, and that it was built
  with the phone app's key (the data layer matches by package and signature).
- *"Pas de téléphone"* on the watch: no phone is connected (Bluetooth off on either side, or out of range).
- *"Appli fermée"*: the phone is there but SelfHost Hub is not running on it, or is older than 2.5.0. Open it.
- *"Versions incompatibles"*: update the phone app and the watch app together.
- The PC is shown as *non connecté* in the watch's settings: the phone's remote-control link is down or off. The phone
  retries it when the watch asks, at most every minute and a half; Contrôle à distance on the phone shows why.
