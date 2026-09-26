# SelfHost Hub

Hub desktop (Electron + React + TypeScript + Tailwind) pour piloter Navidrome, FileBrowser (OpenMediaVault) et Downtify depuis une seule application.

## Prerequis

- Node.js 18+ et npm (non detectes sur cette machine - a installer depuis https://nodejs.org/)

## Demarrage

```bash
npm install
npm run dev
```

## Verification des types

```bash
npm run typecheck
```

## Build de production

```bash
npm run dist:win   # .exe (NSIS)
npm run dist:mac   # .dmg
npm run dist:linux # .AppImage
```

## Architecture

- `src/main` : processus principal Electron (fenetre, `electron-store` + `safeStorage` pour les identifiants, proxy HTTP `net:request` pour eviter les soucis CORS avec les services auto-heberges, upload/download de fichiers pour FileBrowser).
- `src/preload` : pont `contextBridge` exposant `window.api` (store, secure, net, fb) au renderer, sans exposer Node directement.
- `src/renderer/src` : application React.
  - `components/Sidebar.tsx` : navigation verticale collapsible.
  - `components/Navidrome` : client musique (API Subsonic), lecteur audio, file d'attente, paroles, favoris.
  - `components/FileBrowser` : explorateur de fichiers (arborescence, drag & drop, apercus image/audio/video/texte).
  - `components/Downtify` : file de telechargement, historique, statistiques, parametres.
  - `store/*` : etat global via Zustand (connexion par service + lecteur audio).
  - `services/*` : clients HTTP pour chaque API (Navidrome/Subsonic, FileBrowser, Downtify generique).

## Securite des identifiants

Les mots de passe et tokens ne sont jamais stockes en clair : ils sont chiffres via `safeStorage` d'Electron (backend par le trousseau du systeme d'exploitation) puis persistes dans `electron-store`. Les URLs et noms d'utilisateur (non sensibles) sont stockes en clair pour permettre la reconnexion automatique.

## Notes sur les API

- **Navidrome** utilise l'API Subsonic (`/rest/*.view`) avec authentification par salt+token MD5.
- **FileBrowser** utilise son API REST (`/api/login`, `/api/resources`, `/api/raw`) avec un token `X-Auth`.
- **Downtify** n'ayant pas de specification publique unique, le client (`src/renderer/src/services/downtify.ts`) suit un contrat REST generique (`/api/status`, `/api/queue`, `/api/history`, `/api/download`, `/api/settings`, `/api/stats`) a adapter aux endpoints reels de votre instance.

Toutes les requetes JSON passent par le processus principal (`net:request`) pour eviter les blocages CORS des services locaux ; le streaming audio/video/cover art se fait directement via des URLs signees (pas de restriction CORS sur les balises `<audio>`/`<img>`/`<video>`).
