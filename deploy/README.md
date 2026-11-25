# SelfHost Hub server : déploiement

Le serveur tourne à côté de Navidrome sur ton serveur maison. Les apps (téléphone, PC, montre) s'y connectent avec
leur compte Navidrome ; chaque compte a son propre groupe d'appareils et ses propres données d'écoute.
Le protocole est décrit dans `docs/server-protocol.md`.

## Installation

Sur le serveur (Docker et Docker Compose requis) :

```sh
git clone <url-du-depot> SelfHost-hub      # ou copie le dossier du projet sur le serveur
cd SelfHost-hub/deploy
mkdir -p hub-data
sudo chown 65532:65532 hub-data            # l'image tourne en utilisateur non-root (uid 65532)
nano docker-compose.yml                    # règle NAVIDROME_URL et SERVER_NAME
docker compose up -d --build
```

La première construction compile le serveur en Rust : compte quelques minutes. Les suivantes réutilisent le cache.

Variables (dans `docker-compose.yml`) :

| Variable | Défaut | Rôle |
|---|---|---|
| `NAVIDROME_URL` | (obligatoire) | Adresse de Navidrome vue **depuis le conteneur** |
| `SERVER_NAME` | `SelfHost Hub` | Nom affiché dans les apps |
| `TRUST_PROXY` | `false` | `true` derrière un reverse proxy (voir plus bas) |
| `PORT` | `51823` | Port d'écoute dans le conteneur |
| `RUST_LOG` | `info` | Niveau des logs |
| `HOST_PROC` | `/proc` | Où lire le `/proc` de l'hôte (voir « Administration ») |
| `HOST_SYS` | `/sys` | Où lire le `/sys` de l'hôte (températures) |
| `HOST_ROOT` | (vide) | Racine de l'hôte montée en lecture seule, pour les disques ; vide : les disques du conteneur |
| `DOCKER_URL` | (vide) | Proxy Docker en lecture seule (`http://docker-proxy:2375`) ; vide : page Services « non configuré » |

`NAVIDROME_URL` : `http://navidrome:4533` si Navidrome est dans le même réseau Docker, `http://192.168.1.10:4533`
s'il est ailleurs sur le réseau local, `http://host.docker.internal:4533` s'il tourne directement sur la machine hôte.
Ce n'est pas forcément l'adresse que tu utilises dans ton navigateur.

## Vérifier

```sh
curl http://localhost:51823/api/health
# {"app":"selfhost-hub-server","version":"0.1.0","name":"Maison"}
docker compose ps        # l'état doit passer à "healthy"
```

## Brancher les apps

Dans les réglages de chaque app, renseigne l'adresse du serveur :

- à la maison (ou via un VPN) : `http://192.168.1.10:51823` (l'IP de ton serveur) ;
- depuis l'extérieur : `https://hub.exemple.fr` via un reverse proxy (voir ci-dessous).

Puis connecte-toi avec ton compte Navidrome. L'app vérifie `/api/health` quand tu enregistres l'adresse. Sans adresse
de serveur, les apps gardent l'ancien mode pair-à-pair sur le réseau local.

## Reverse proxy (WebSocket obligatoire)

Les apps utilisent un WebSocket sur `/ws` : le proxy doit laisser passer l'upgrade. Ajoute `TRUST_PROXY: "true"` dans le
compose pour que la limite de tentatives de connexion (5 échecs en 10 min par adresse) voie la vraie adresse du client
(premier élément de `X-Forwarded-For`). Ne l'active **pas** si le port 51823 est aussi exposé directement : n'importe
qui pourrait alors falsifier l'en-tête.

**Nginx Proxy Manager** : crée un Proxy Host vers `selfhost-hub` (ou l'IP du serveur), port `51823`, et **coche
« Websockets Support »**. Onglet SSL : demande un certificat Let's Encrypt et coche « Force SSL ».

**nginx** :

```nginx
location / {
    proxy_pass http://127.0.0.1:51823;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
}
```

**Caddy** (les WebSockets et le HTTPS sont gérés tout seuls) :

```
hub.exemple.fr {
    reverse_proxy 127.0.0.1:51823
}
```

## Sauvegarde

Tout est dans `deploy/hub-data/hub.db` (SQLite, mode WAL). Arrête le conteneur (`docker compose stop`) puis copie le
dossier `hub-data` entier (il peut contenir `hub.db-wal` et `hub.db-shm`), ou copie à chaud avec
`sqlite3 hub-data/hub.db ".backup hub-backup.db"`.

## Logs et mises à jour

```sh
docker logs -f selfhost-hub
git pull && docker compose up -d --build     # mise à jour
docker compose down                           # arrêt (les données restent dans hub-data)
```

## Administration

Une page d'administration est disponible sur `/admin` (par exemple `https://hub.goofysound.duckdns.org/admin`).
Elle est réservée aux **administrateurs Navidrome** : connecte-toi avec ton compte Navidrome ; un compte non
administrateur est refusé. Le mot de passe ne quitte jamais le navigateur (seul `md5(mot de passe + nonce)` est
envoyé, comme le fait Subsonic). La session dure 12 h, dans un cookie `HttpOnly` + `SameSite=Strict` (et `Secure`
derrière HTTPS avec `TRUST_PROXY=true`). Les 5 échecs en 10 min par adresse bloquent la connexion, comme pour les apps.

La page affiche : Système (CPU, mémoire, températures, uptime, avec 1 h d'historique), Services (conteneurs Docker),
Processus, Disques, Réseau, et Hub (appareils en ligne avec un bouton « Déconnecter », appareils connus, données
d'écoute). Elle se rafraîchit toutes les 3 s tant que l'onglet est visible.

Ce que le compose monte, et pourquoi tout est en lecture seule :

| Montage | Rôle |
|---|---|
| `/proc:/host/proc:ro` | CPU, mémoire, charge, processus, réseau et disques de l'**hôte** (`HOST_PROC`) |
| `/sys:/host/sys:ro` | Capteurs de température (`HOST_SYS`) |
| `/:/hostfs:ro,rslave` | Taille des disques de l'hôte (`HOST_ROOT`) ; `rslave` fait apparaître les disques montés après le démarrage |
| service `docker-proxy` | Liste des conteneurs et leurs stats via `tecnativa/docker-socket-proxy` |

Le serveur ne fait que **lire** : il n'écrit nulle part dans ces montages et n'envoie jamais de requête `POST` à Docker.
Le socket Docker n'est pas monté dans le hub : le donner à un conteneur reviendrait à lui donner root sur la machine.
Le proxy, lui, n'accepte que `GET /containers` (`CONTAINERS=1`, `POST=0`, tout le reste désactivé), n'expose aucun
port et n'est joignable que depuis le réseau du compose.

Sans ces montages, le hub marche quand même : chaque section indique ce qui manque (« Montez /proc de l'hôte »,
« Conteneurs : non configuré »). Pour ne pas surveiller l'hôte, retire les montages et les variables `HOST_*` / `DOCKER_URL`.

Si une section reste vide alors que le montage est là : l'image tourne en utilisateur non-root (uid 65532) et
certains fichiers `/proc/1/…` (réseau, points de montage) peuvent être refusés à un non-root. Dans ce cas, la section
affiche la raison ; la solution est d'ajouter `user: "0:0"` au service `selfhost-hub` (le montage reste en lecture
seule), à décider en connaissance de cause.

### Terminal

L'onglet **Terminal** ouvre un shell sur l'hôte, par SSH depuis le hub. Il est protégé par un code TOTP (Aegis,
2FAS, Google Authenticator…) en plus de la connexion Navidrome. Mise en route :

1. Dans `docker-compose.yml`, `SHELL_ENABLED: "true"` et `SHELL_SSH_USER: "<ton utilisateur>"`, puis
   `docker compose up -d`.
2. Dans l'onglet Terminal, copie la ligne « Clé SSH du hub » et ajoute-la à `~/.ssh/authorized_keys` de cet
   utilisateur. Elle n'est acceptée que depuis les réseaux Docker (`from=…`), sans redirection de ports ni d'agent.
3. « Configurer » : scanne le QR code, entre le code affiché. Ensuite, chaque ouverture demande un code (valable 10 min).

Limites : 2 shells à la fois, fermés après 15 min d'inactivité ou 4 h. Les sessions sont listées dans l'onglet.
5 codes faux ferment la session admin. Téléphone perdu : `docker exec selfhost-hub /selfhost-hub-server --reset-totp <utilisateur>`.
Hôte réinstallé (clé SSH changée) : `--reset-shell-hostkey`. Pour désactiver : `SHELL_ENABLED: "false"`.
