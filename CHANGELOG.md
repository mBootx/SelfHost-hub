# Changelog

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
