# Changelog

## Unreleased

### Added
- **Cover art in the Now Bar (Android):** the current song's cover is now the Now Bar's background and the lock screen picture. The next song's cover is downloaded in advance, so skipping shows it straight away instead of a moment later.

### Fixed
- **Samsung Now Bar and lock screen controls (Android):**
  - Skipping a song no longer closes the Now Bar, and it keeps working after many skips. Before, every song change rebuilt the media session and Android's media service refused the new one, so the Now Bar was left showing a dead session: no buttons, and play/pause did nothing.
  - One session now lasts the whole listening session and follows the music from one player to the next, including on crossfades and gapless changes.
  - "Stop" from a headset or the Now Bar now pauses, instead of leaving the song unable to play again.
  - Clearing the queue takes the Now Bar down with it.

## 2.2.0 — 2026-09-29

### Added
- **App icon:** SelfHost Hub has its own logo, a roof over a play button made of three linked nodes (music, files, downloads).
  - **Windows:** on the app, the installer, the taskbar and the window. The sidebar shows it in your accent colour.
  - **Android:** on the launcher (adaptive, round and themed icons) and the splash screen.
- **Plays sync with Navidrome:** a song counts once you've heard half of it, or 4 minutes. Seeking and pauses don't count. Play counts and "Récemment écouté" on the home screen now follow you from one device to the other, and on to Last.fm or ListenBrainz if your server forwards them. Plays made offline are kept and sent when the server is back.
- **New downloads show up right away:** when Downtify finishes a download, Navidrome is asked to scan for it, and the library reloads with a "Nouveaux titres ajoutés" message. An album finishing at once triggers a single scan. This needs a Navidrome admin account.
- **Server dashboard** (only for the server owner's account):
  - Each service's status, response time and version.
  - Disk space, library size, and when the library was last scanned, with a button to scan now.
  - Who is listening to what, and the Downtify queue.
  - A Wake-on-LAN button to wake a sleeping server; the page then watches for it to come back.
  - **Desktop:** "Serveur" in the sidebar. **Android:** Settings → Services → Serveur.
- **Windows media controls:** the current song and its cover appear in the Windows volume panel, and the keyboard media keys (play/pause, next, previous) work even when the app isn't focused.
- **System tray (desktop):**
  - Closing the window keeps the music playing. The icon near the clock plays/pauses, skips, reopens the window or quits.
  - Opening the app again brings the existing window back.
  - A new option starts SelfHost Hub with Windows, straight into the tray. Both options are in Settings → Application.
- **Camera backup (Android):** new photos and videos from the camera are uploaded to FileBrowser, sorted by year and month.
  - Runs when you open the app, and in the background about every 15 minutes (Android decides exactly when).
  - Wi-Fi only by default; photo locations are kept.
  - When you turn it on, you choose between only the next photos or everything already on the phone.
  - A file the server refuses is retried twice more, then skipped; a dropped connection just waits for the next run.
- **App lock (Android):** a code (4 to 8 digits) or a pattern, drawn on the app's own screens.
  - Optional fingerprint unlock. Face recognition is never used.
  - Choose when it locks: immediately, or after 1, 5 or 15 minutes away. Opening a file, sharing or picking a file doesn't lock it.
  - Five wrong tries pause input for 30 seconds, doubling each time after that.
  - Forgot the code? The Navidrome or FileBrowser password saved on the phone turns the lock off.
  - Music keeps playing while the app is locked.

## 2.1.0 — 2026-09-29

### Added
- **Pick up where you left off:** closing and reopening the app brings back your queue and the track you were on, paused at the same second. Shuffle and repeat come back too.
  - **Desktop:** the position is saved every second while playing, and again as the window closes.
  - **Android:** the position is saved every two seconds while playing, and whenever you leave the app.
- **"Nouveautés" window:** after each update, both apps show once what changed in the new version. You can reopen it from Settings → Application.

### Improved
- **French text now has its accents** in both apps: Réglages, Égaliseur, Bibliothèque, Mettre à jour...

### Fixed
- **Desktop:** the switches in Settings (Lecture sans blanc, Activer l'égaliseur, Contrôle à distance) no longer stick out of their track, and the knob now sits on the left when a switch is off.

## 2.0.0 — 2026-09-28

### Added
- **Colour schemes:** pick an accent colour (8 presets or your own) and a background style (Sombre, AMOLED, Ardoise, Moka) in Settings → Apparence.
  - **Desktop:** changes apply live.
  - **Android:** the app restarts to apply them.
- **Crossfade:** set how long songs overlap when one ends and the next starts, from 0 to 12 s, in Settings → Lecture. Manual skips stay instant.
- **Gapless playback:** the next song is preloaded so it starts the moment the current one ends. That also makes skipping to the next song instant.
- **Equalizer** in Settings → Egaliseur: 10 presets (Graves +, Voix, Rock, Electro...) or your own curve.
  - **Desktop:** 10 bands, lowering the overall level to avoid distortion when you boost.
  - **Android:** the phone's own system equalizer (usually 5 bands), with the same presets mapped onto them.

### Fixed
- **Downloaded tracks never played on desktop.** Their `offline://` links were misread, so every offline track failed to load. They now play, and you can also seek within them.
- With a single song on repeat-all, playback stopped at the end of the song instead of looping.
- **Android updater:** if an install doesn't go through, the downloaded APK is now kept, so "Installer" opens it straight away instead of downloading it again. This includes the app restarting after you allow app installs.

## 1.2.1 — 2026-09-28

### Changed
- No functional changes. This release exists to test the automatic updater that arrived in 1.2.0: an installed 1.2.0 should pick it up on its own.

## 1.2.0 — 2026-09-28

### Added
- **Automatic updates on Windows:** the app checks GitHub at launch and every 6 hours, downloads new versions in the background, and installs them when you quit. A card offers "Redemarrer maintenant" to update right away.
- **One-tap updates on Android:** when a new version is out, a card offers "Mettre a jour". It downloads the APK with a progress bar, then Android asks you to confirm the install. The first time, Android asks you to allow SelfHost Hub to install apps.
- **Settings → Application** on both apps shows the installed version and has a "Rechercher" button to check for updates on demand.

> This is the one version to install by hand: builds before 1.2.0 don't have the updater. Every later release reaches you on its own.

## 1.1.0 — 2026-09-28

### Added
- **Swipe right to play next (Android):** swipe any song in an album, playlist, favorites or search list to the right, and it plays right after the current track. The rest of the queue is untouched and you stay on the screen you're on. The most recently swiped song plays first.
- **Swipe left to remove from a playlist (Android):** the row disappears straight away. Removals are sent one at a time, and a song comes back if the server refuses.
- **Delete playlists:** use the trash button in a playlist or long-press it in Library on Android; on desktop, use the "Supprimer" button in a playlist or right-click its tile. You're always asked to confirm first.
- **120 Hz on Android:** the app requests the display's fastest refresh rate at the current resolution.

### Improved
- **Artwork is cached across restarts.** Cover URLs changed on every launch, so the image cache never matched and all artwork was downloaded again. Covers are also fetched in three sizes instead of up to six.
- **Desktop file browser:** folder collages and image tiles load small server previews instead of full-size originals. If the server can't produce a preview, the tile falls back to the original.
- **Android:**
  - Image previews in Files are cached.
  - Long Favorites lists only render the rows near the screen.
  - Background artwork prefetching no longer pushes the covers you're looking at out of memory.
- **Android:** coming back to the app no longer reloads every open screen. Only services that are actually down reconnect.

### Fixed
- Removing several playlist songs in quick succession could remove the wrong one.
- A network blip while renewing an expired FileBrowser login could log you out and forget the saved password.

## 1.0.0 — 2026-09-27

First release: a self-hosted media hub for Navidrome (music), FileBrowser Quantum (files) and Downtify (downloads), as a Windows desktop app and an Android app.

### Highlights
- **Music (Navidrome):**
  - Create playlists, add and remove songs, and sort them.
  - Reorder, trim or clear the queue.
  - Likes, local listening history and playback speed.
  - Live lyrics on Now Playing, and offline downloads.
- **Remote control:** drive playback on another device on the same Wi-Fi, Spotify Connect-style.
- **Files (FileBrowser):** drag-and-drop uploads with live progress, and a working right-click menu (new folder, rename, delete, copy link, move by drag) with confirmation toasts.
- **Android:** lock-screen and Samsung Now Bar controls, including next/previous.

### Fixed
- The Android app crashed on launch.
- Sessions dropped mid-use. An expired FileBrowser login now re-authenticates instead of logging you out.
- Drag-and-drop uploads on desktop silently did nothing under Electron 32.
- The right-click menu closed before you could click an item.
