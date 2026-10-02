# Changelog

## 2.5.0 — 2026-10-02

### Added
- **Wear OS watch app (new, Android phone + watch).** A remote control and library browser for a Wear OS 3+ watch: what is playing (cover, title, artist, a seek bar), previous / play-pause / next, shuffle, repeat, volume on the crown, a black always-on screen, and the library (artists, albums, playlists, search, also offline) from which you start an album or a song. A chip on the watch face offers the player when a song starts.
  - **The watch only talks to the phone** (over the Wear OS data layer) and to Navidrome; it never connects to the PC. The phone stays the one link to the PC: when it is paired with the PC (Réglages → Appareils), the watch can also pause, skip and change the volume of the PC's player through it. Something chosen in the watch's library always plays on the phone.
  - **Réglages → Montre** (phone) sends the watch Navidrome's address and a login token. The password itself never leaves the phone, and nothing about the PC is sent. The same screen says when the watch last got in touch.
  - The watch app is not installed by the phone: download `SelfHost-Hub-Watch-2.5.0.apk` from this page and install it over Wi-Fi debugging (steps in `wear/README.md`). It needs this version of the phone app.

### Fixed
- **Plain `http://` and `ws://` connections are no longer blocked in the installed Android app.** Release builds did not allow unencrypted traffic, which Android 9 and later blocks unless the app asks for it: a Navidrome or FileBrowser at an `http://` address, and the remote-control link to the PC on the home network, could not connect. The app now allows it.
- **The Android updater picks the phone's APK by name**, so a release that also carries the watch's APK can never offer the wrong file.

## 2.4.0 — 2026-10-02

### Fixed
- **"Copy link" no longer copies your login (both apps).** It copied the file's address *with your session token in it*, so whoever received the pasted link had your session. It now creates a real FileBrowser share link: a week by default on the desktop, with a choice of duration on the phone. On the phone, photos and thumbnails are no longer fetched with the token in the address either.
- **Uploading a file whose name already exists asks first (both apps).** It used to be replaced without a word. Now you choose: skip, keep both (the new one gets a number) or replace. The photo backup never overwrites anything: a file with the same name and size counts as already sent, a different one gets a name of its own.
- **Files (Android):** the list refreshes when an upload finishes, and delete, rename and new folder tell you when they fail instead of doing nothing.
- **Remote control needs a pairing code (both apps).** The hub accepted any device on the network that knew a hash it handed out to anyone who asked. Now the PC shows a code (Réglages → Contrôle à distance), the phone enters it once (Réglages → Appareils → Appairer avec le PC), and from then on it only answers a fresh challenge with a keyed proof: the code itself never travels. Only home-network addresses are accepted, and an address that gets the code wrong five times is ignored for ten minutes. **After updating, each phone has to be paired once**, and a new code disconnects the phones paired with the old one.
- **App lock (Android):** the app no longer appears in the recents screen while it is locked, and the lockout can't be ended by moving the phone's clock forward.
- **Plays are not lost to a server hiccup (both apps).** The scrobbler dropped a play on a 500 or a 429. It now tells an outage (the plays wait), a failure without a reason (a few more tries) and a play the server refuses for good (dropped).
- **Thumbnails (both apps):** they asked for `/api/preview`, which FileBrowser 1.3 and later no longer has, so every thumbnail failed and the full-size picture was loaded instead. The current route is now tried first.
- **Fewer permissions (Android):** the microphone and "display over other apps", which were never used, are no longer requested.
- **Desktop:** the window runs sandboxed, and external links open only when they are http(s).

### Added
- **Diagnostics (Android):** Réglages → Diagnostic shows the versions, whether each server answers and how fast, the state of the photo backup and of remote control, and the latest events. "Copier le rapport" produces a text report with server names, accounts and IP addresses hidden, ready to paste into a message.
- **Photos (Android):**
  - **Trash.** Deleting from the gallery now moves photos to a `Corbeille` folder on the server, kept 30 days. From the trash button you can restore them, delete them for good, or empty it.
  - **Zoom, share, save.** Pinch or double-tap to zoom and drag around; share a photo to another app or save it to the phone's gallery.
  - **Videos** appear in the gallery and play in the viewer (their thumbnails need ffmpeg on the server). Filter by Tout / Photos / Vidéos, and by album.
  - **Other albums** (Screenshots, WhatsApp…) can be backed up: Réglages → Sauvegarde des photos → Autres albums. Each goes to its own folder, by year and month.
  - **"Seulement en charge":** back up only while the phone is plugged in.
- **Files (Android):**
  - **Send to SelfHost Hub from any app's share sheet.** Choose the folder and the files go up; shared text becomes a note (.txt).
  - **Select several items** (long-press): download them as a zip, move them, delete them, or create a share link.
  - **Search** by name, in the current folder and below.
  - **"Liens de partage"** lists the links you created, to copy or revoke. Moving uses a folder picker.
- **Music (Android):**
  - **Sleep timer** (the moon on the player): 15 minutes to 1 h 30, or at the end of the song. The volume fades over the last 10 seconds, and it works with the screen off.
  - **Uniform volume** (Réglages → Lecture): turns down tracks that are too loud, per track or per album, using the ReplayGain tags in your files. Without tags nothing changes, and no track is ever made louder.
  - **Radio:** "Lancer la radio" in a track's menu plays similar songs and keeps adding more.
  - **Genres:** Bibliothèque → Genres lists them; each has its albums and a random mix.
  - **Home-screen widget** with the song playing and previous / play-pause / next.

## 2.3.1 — 2026-10-01

### Fixed
- **Photos that were backed up did not show up, or only the old ones did (Android):**
  - The backup now sends the **newest photos first**, then older ones, and photos before videos. Before, a big first backup went from the oldest photo forward, so for hours (or days, on a large camera roll) the gallery showed only old pictures while the latest ones were still waiting at the end of the queue.
  - **One file that keeps failing no longer blocks the ones behind it.** A timeout or a server error on a single file used to stop every run at that same file, so nothing newer was ever sent. Now the app checks whether the server still answers: if it does, the failure is held against that file (three tries, then it is given up on); if it doesn't, the run stops and nothing is held against any file. A server that answers but refuses every upload stops the run after three files.
  - **The Photos tab keeps up with the backup.** Opening the tab, or coming back to the app while it is open, looks for new photos on the phone and starts sending them; pulling down does the same. Photos sent meanwhile appear every few seconds, and once more when the run ends. It used to read the server once and then show that list for a minute, whatever was uploaded after.
  - **Old photos show up without moving them.** Photos still in the old backup folder (`/Appareil photo`) appear in the Photos tab along with the others, and can be deleted from there. A photo present in both places is shown once. Moving them into your own folder is now optional, a button in Réglages (Sauvegarde des photos) instead of a banner in the Photos tab, and nothing depends on it.

### Added
- **Backup status above the photos (Android):** one line says where the backup stands, so a missing photo can be explained: sending (with the file and how far along), waiting for Wi-Fi, how many files are waiting, refused by the server (with the reason), access to photos denied, or backup turned off. It has the matching button: send now, send anyway over mobile data (once, the "Wi-Fi only" setting stays), authorise, try again, turn on.
- **Files the server would not take can be tried again.** After three failures a file is given up on, as before, but the app now remembers it ("3 files not sent") and offers to send it again, from the status line or from Réglages, for example after raising the upload limit of a reverse proxy.

## 2.3.0 — 2026-09-30

### Added
- **Cover art in the Now Bar (Android):** the current song's cover is now the Now Bar's background and the lock screen picture. The next song's cover is downloaded in advance, so skipping shows it straight away instead of a moment later.
- **Photos tab (Android):** your backed-up photos in a grid, month by month, between Fichiers and Réglages.
  - Tap a photo to see it full size and swipe to the next; long-press to select several.
  - Sort by date, name or size, search by name, and delete photos from the server: for good, after a confirmation. The copies on your phone are not touched.
  - It only ever shows your own account's photos. Videos are backed up as before but not shown here.

### Improved
- **Now Playing screen (Android), redone in the style of Spotify's:**
  - The cover now fills the width of the screen. Under it: the title with a heart to add the song to your favourites, a slim seek bar (elapsed and remaining time) and the playback buttons. The whole page takes its colour from the cover.
  - The lyrics are a card under the player, showing the lines around the one being sung. Tap it and it grows into the full lyrics: they follow the song, tapping a line jumps to it, and the play bar stays at the bottom. The Back button closes the lyrics first.
  - Under the playback buttons: output device, playback speed, download and queue. The "…" menu has add to playlist, favourites, go to the album and the automatic search for lyrics and cover.
  - On a short phone the cover gives up height before the buttons do, so everything stays on the first screen.
- **Photo backup is organised by account (Android):** photos now go to `/backups/photos/<your account>/year/month` instead of the shared `/Appareil photo` folder.
  - The folder is a setting in Réglages; `{user}` stands for the account's name. A folder you chose yourself is kept, with a button to switch it to the per-account layout.
  - If you were on the old default, the Photos tab offers to move the photos already there: moved, not copied, into the same year/month folders, and nothing is overwritten.
  - In the file browser, the other accounts' folders inside the central folder are hidden (the server's owner sees everything).
  - This is tidiness, not the lock: for other accounts to be kept out for real, limit each FileBrowser account to its own folder on the server (the account's scope).

### Fixed
- **Samsung Now Bar and lock screen controls (Android):**
  - Skipping a song no longer closes the Now Bar, and it keeps working after many skips. Before, every song change rebuilt the media session and Android's media service refused the new one, so the Now Bar was left showing a dead session: no buttons, and play/pause did nothing.
  - One session now lasts the whole listening session and follows the music from one player to the next, including on crossfades and gapless changes.
  - "Stop" from a headset or the Now Bar now pauses, instead of leaving the song unable to play again.
  - Clearing the queue takes the Now Bar down with it.
- **Crossfade and gapless playback (Android):**
  - The crossfade now happens with the screen off. It ran on a timer that Android freezes as soon as the app leaves the screen, so the new song stayed silent until the old one ended, then jumped in at full volume part-way through.
  - The next song no longer starts 15 seconds or more in. After a song ended on its own, its player kept playing the next song silently during the preload, so it was already well into the song when it took over.
  - Pausing from the Now Bar, the lock screen or a headset in the middle of a crossfade now stops both songs, instead of letting the old one play on.

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
