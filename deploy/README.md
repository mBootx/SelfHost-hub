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
| `GATE_DOMAIN` | (vide) | Active `/gate` et `/api/gate/*` avec un cookie `hub_gate` sur un ou plusieurs domaines racines séparés par des virgules (choisi d'après `Host`) ; vide : désactivé |
| `GATE_SERVICES` | (vide) | Lanceur sur `/gate` après connexion : entrées `Nom=URL` séparées par des virgules |
| `DOWNTIFY_URL` | (vide) | Adresse interne de Downtify (ex. `http://host.docker.internal:8087`) pour le proxy `/api/downtify/*` ; vide : proxy désactivé (`503`) |
| `BACKUP_KEEP` | `7` | Nombre de sauvegardes automatiques quotidiennes de `hub.db` conservées (`0` désactive la planification) |
| `ALERT_DISK_PERCENT` | `90` | Seuil d'occupation disque (%) déclenchant une alerte (`critical` à partir de 95 %) |
| `ALERT_TEMP_C` | `85` | Seuil de température (°C) déclenchant une alerte (`critical` à partir de seuil + 10 °C) |
| `ALERT_WEBHOOK_URL` | (vide) | URL webhook (ntfy, Discord…) appelée lors d'une nouvelle alerte ou de sa résolution |

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

La page affiche : Performances (courbes en direct sur 60 s, détail par cœur, E/S disque, températures, 1 h d'historique),
Processus, Conteneurs (avec consultation des **Logs**), Disques, Réseau, **Alertes** (disques, températures,
conteneurs arrêtés, Navidrome ; notification webhook optionnelle via `ALERT_WEBHOOK_URL`), Hub (appareils en ligne
avec un bouton « Déconnecter », appareils connus, données d'écoute, **Sauvegardes (`hub.db`)** automatiques et
manuelles via `VACUUM INTO`) et Terminal. Elle se rafraîchit toutes les 1 s tant que l'onglet est visible (3 s pour
l'onglet Hub).

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

## Protéger un service web (`/gate`)

Quand `GATE_DOMAIN` est défini (un ou plusieurs domaines racines séparés par des virgules, par exemple
`goofysound.duckdns.org,goofydownloader.duckdns.org`), le hub expose une page de connexion sur `/gate` et valide les
requêtes via `GET /api/gate/verify` (`auth_request` Nginx). Cela permet de protéger un service web (comme Downtify)
derrière Nginx Proxy Manager avec **n'importe quel compte Navidrome** (pas seulement les administrateurs), tout en
laissant les apps sur le réseau local y accéder directement.

Le cookie `hub_gate` (signé HMAC-SHA256, valable 30 jours) reçoit un `Domain=` choisi d'après l'en-tête `Host` de la
requête, et `rd` est validé sur ce même domaine (les sous-domaines partagent le cookie). Mets `auth_request` dans
`location /` afin que les défis Let's Encrypt (`/.well-known/acme-challenge/`) ne soient jamais bloqués.

Si `GATE_SERVICES` est défini, `/gate` affiche un lanceur vers ces services une fois connecté. Pour les apps
(téléphone, PC), le hub propose aussi le proxy authentifié `/api/downtify/*` (via `POST /api/client/token` et
`DOWNTIFY_URL`) : il n'est donc pas nécessaire d'exposer le port `8087` de Downtify sur le routeur.

**1. Service sur son propre domaine DuckDNS** (ex. `goofydownloader.duckdns.org`, distinct de `goofysound.duckdns.org` :
un cookie DuckDNS ne peut pas être partagé entre deux sous-domaines racine) — onglet **Advanced** du Proxy Host :

```nginx
location = /__hub_gate {
    internal;
    proxy_pass http://172.17.0.1:51823/api/gate/verify;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Cookie $http_cookie;
}
location = /gate {
    proxy_pass http://172.17.0.1:51823;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location /api/gate/ {
    proxy_pass http://172.17.0.1:51823;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location = /api/admin/challenge {
    proxy_pass http://172.17.0.1:51823;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location @hub_gate_login {
    return 302 https://$host/gate?rd=$scheme://$host$request_uri;
}
location / {
    auth_request /__hub_gate;
    error_page 401 = @hub_gate_login;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
    proxy_http_version 1.1;
    include conf.d/include/proxy.conf;
}
```

**2. Sous-domaine de `*.goofysound.duckdns.org`** (le cookie est déjà posé sur `goofysound.duckdns.org` par
`hub.goofysound.duckdns.org`) — onglet **Advanced** du Proxy Host :

```nginx
location = /__hub_gate {
    internal;
    proxy_pass http://172.17.0.1:51823/api/gate/verify;
    proxy_pass_request_body off;
    proxy_set_header Content-Length "";
    proxy_set_header Cookie $http_cookie;
}
location @hub_gate_login {
    return 302 https://hub.goofysound.duckdns.org/gate?rd=$scheme://$host$request_uri;
}
location / {
    auth_request /__hub_gate;
    error_page 401 = @hub_gate_login;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
    proxy_http_version 1.1;
    include conf.d/include/proxy.conf;
}
```
