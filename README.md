# Tangente

> [!NOTE]
> **Genèse.** Tout est parti d'un week-end entre amis et d'une envie toute simple : rejouer ensemble à _Achtung, die Kurve!_. Seulement, nous étions bien trop nombreux pour nous serrer autour d'un clavier, et nous rêvions d'un grand écran partagé où chacun piloterait sa ligne depuis son téléphone. Les outils d'aujourd'hui semblaient le permettre, alors nous avons tenté l'aventure, et Tangente en est le fruit. Il en garde l'esprit et les mécaniques, sans emprunter la moindre ressource à l'original : ni code, ni graphismes, ni sons.
>
> **Avertissement.** Pas une spécification, pas une page de documentation, pas une ligne de code de ce dépôt n'a été écrite ni relue par un humain : l'ensemble a été généré par une IA (Claude). À utiliser en connaissance de cause.

Jeu de courbes multijoueur pour les soirées. Un PC affiche l'arène sur une TV ou un projecteur, et 2 à 12 personnes jouent depuis le navigateur de leur téléphone, rejoint en scannant un QR code. Il n'y a ni compte ni installation.

- Classique : traces permanentes, trous périodiques, collisions éliminatoires, dernier survivant.
- Party : en plus, 10 bonus et malus activables un par un.
- Le serveur fait autorité : les téléphones n'envoient que l'état de leurs deux touches. Le PC simule, arbitre et compte les points.
- Latence minimale : les commandes passent en **WebRTC (UDP) directement sur le Wi-Fi local** dès que c'est possible, même pour un téléphone qui a scanné le QR Internet. La simulation tourne à 240 Hz et l'écran dessine dès réception. Mesuré sur ce PC : **3 ms du toucher à l'image** (voir « Latence »).
- Redémarrage transparent : une mise à jour ou un plantage du serveur coupe le jeu ~0,3 s. Le salon, les scores et l'URL publique sont conservés, et chacun se reconnecte seul (voir « Relancer sans casser la partie »).

---

## Démarrage rapide (soirée)

```bash
pnpm install                 # une fois
pnpm soiree                  # build + serveur + tunnel Cloudflare
```

1. Sur le PC, ouvrez **http://localhost:3000/host**, puis passez en plein écran avec `F`.
2. Les joueurs scannent le QR code, choisissent un pseudo et une couleur, puis appuient sur **Je suis prêt**.
3. Appuyez sur **Espace** (ou « Lancer la partie »).

Pendant la partie, sur le téléphone : la **moitié gauche** de l'écran fait tourner à gauche, la **moitié droite** à droite. Sans doigt, ou avec deux doigts, la courbe va tout droit.

### Raccourcis de l'écran hôte

| Touche          | Action                                                                         |
| --------------- | ------------------------------------------------------------------------------ |
| Espace / Entrée | action principale : lancer, pause, reprendre ou manche suivante selon la phase |
| P               | pause / reprise                                                                |
| F               | plein écran                                                                    |
| D               | panneau de diagnostic (latences, FPS, charge serveur)                          |

---

## Prérequis et commandes

- Node 22 ou plus (testé avec Node 24.14) et pnpm 10.
- Pour l'accès Internet : `cloudflared` (recommandé) ou `ssh` (localhost.run, plus lent).
- `node-datachannel` (WebRTC côté serveur) s'installe avec un binaire précompilé pour Linux, macOS et Windows (x64/arm64). Le build le recopie dans `.output/`.

| Commande                                            | Effet                                                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm soiree`                                       | build de production, serveur sur `:3000` et tunnel cloudflared                                                               |
| `pnpm start`                                        | serveur de production seul, sans tunnel (Wi-Fi local) ; build si `.output/` est absent                                       |
| `node scripts/start.mjs --tunnel localhostrun`      | tunnel localhost.run (serveurs aux États-Unis : +80 à +100 ms, à éviter)                                                     |
| `node scripts/start.mjs --kiosk`                    | ouvre l'écran hôte dans Chrome en kiosque, **sans vsync ni limite d'images** (profil dédié `.data/chrome-kiosk`)             |
| `node scripts/start.mjs --port 4000 --build --open` | autre port, rebuild forcé, ouverture du navigateur                                                                           |
| `pnpm dev`                                          | serveur de développement Nuxt (HMR) sur `0.0.0.0:3000`                                                                       |
| `node scripts/start.mjs --dev --tunnel cloudflared` | dev + tunnel                                                                                                                 |
| _même commande, jeu déjà lancé_                     | **relance à chaud** : nouvelle version construite à côté, serveur seul redémarré, tunnel et salons conservés (voir plus bas) |
| `pnpm stop -- --port 3200`                          | arrête le lanceur en cours sur ce port (serveur + tunnel)                                                                    |
| `pnpm test`                                         | tests automatisés (Vitest)                                                                                                   |
| `pnpm test:e2e`                                     | test de bout en bout dans un vrai Chrome (écran + téléphone, redémarrages du serveur en pleine partie)                       |
| `pnpm test:load -- --players 12 --seconds 60`       | banc de charge sur un serveur lancé (voir « Mesures »)                                                                       |
| `pnpm typecheck` / `pnpm format`                    | vérifications TypeScript / Prettier                                                                                          |

Variables d'environnement :

| Variable                                                                   | Rôle                                                                                               |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `PORT`                                                                     | port d'écoute (défaut 3000)                                                                        |
| `TANGENTE_TUNNEL`                                                          | `cloudflared`, `localhostrun` ou `none`, équivalent de `--tunnel`                                  |
| `TANGENTE_LAN_HOST=1`                                                      | autorise un écran hôte sur le réseau local (TV connectée à une autre machine)                      |
| `TANGENTE_TUNNEL_DEBUG=1`                                                  | affiche la sortie brute du tunnel                                                                  |
| `TANGENTE_RTC=0`                                                           | désactive WebRTC (commandes par WebSocket seul)                                                    |
| `TANGENTE_STUN`                                                            | serveurs STUN séparés par des virgules (défaut : Cloudflare + Google) ; `none` = réseau local seul |
| `TANGENTE_TURN_URLS`, `TANGENTE_TURN_USERNAME`, `TANGENTE_TURN_CREDENTIAL` | relais TURN statique, pour les réseaux où le direct échoue                                         |
| `TANGENTE_CF_TURN_KEY_ID`, `TANGENTE_CF_TURN_API_TOKEN`                    | relais TURN Cloudflare : identifiants générés à la volée (TTL 24 h)                                |
| `TANGENTE_STATE_FILE`                                                      | fichier de sauvegarde des salons (défaut `.data/rooms-<port>.json`) ; `none` = pas de sauvegarde   |

Pour jouer **sans le lanceur** : `pnpm build`, puis `PORT=3000 node .output/server/index.mjs`. Dans un autre terminal, lancez le tunnel à la main (commandes plus bas), puis collez son URL dans le champ « Autre adresse » du tableau de bord : le QR code l'utilise aussitôt.

---

## Accès des téléphones

L'écran propose trois adresses pour le QR code, dans le menu « Adresse du QR code » :

| Adresse                                      | Quand l'utiliser                                                                              | Latence typique                                                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Wi-Fi local** `http://192.168.x.y:3000`    | tout le monde est sur le même Wi-Fi que le PC                                                 | la plus faible (quelques ms)                                                                                        |
| **Internet** `https://xxx.trycloudflare.com` | marche pour tout le monde ; un téléphone sur le même Wi-Fi bascule quand même en WebRTC local | local : quelques ms ; 4G : direct via STUN/TURN si possible, sinon tunnel (≈ 100–160 ms d'aller-retour mesurés ici) |
| **Ce PC** `http://localhost:3000`            | tests sur la même machine                                                                     | ~1 ms                                                                                                               |

> **Conseil** : le QR « Internet » convient à tous, car WebRTC trouve seul le chemin local. Vérifiez le chemin de chacun dans le diagnostic (`D`, colonne « chemin ») ou en haut de la manette (« Wi-Fi direct », « direct », « relais », « tunnel »).

Le jeu n'a besoin ni de HTTPS ni de service worker : le Wi-Fi local fonctionne en HTTP simple. Si le pare-feu du PC bloque les connexions entrantes, ouvrez le port, par exemple `sudo ufw allow 3000/tcp`.

**Tester depuis un téléphone hors Wi-Fi** : désactivez le Wi-Fi du téléphone, scannez le QR « Internet ». Vérifiez le chemin et l'aller (« ↑ x ms ») en haut à droite de la manette, et dans le diagnostic (`D`).

### Tunnel : Cloudflare Quick Tunnel ou localhost.run

|                       | Cloudflare Quick Tunnel                                         | localhost.run                                                         |
| --------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Installation          | binaire `cloudflared`                                           | rien (`ssh` suffit)                                                   |
| Compte                | non                                                             | non                                                                   |
| WebSocket (WSS)       | oui                                                             | oui                                                                   |
| Mise en route mesurée | URL en ~5 s                                                     | URL en ~10 s, ouverture WSS ~0,8 s                                    |
| URL                   | `https://<mots>.trycloudflare.com`, nouvelle à chaque lancement | `https://<id>.lhr.life`, nouvelle à chaque lancement (offre gratuite) |
| Points de présence    | réseau Cloudflare mondial (proche des joueurs)                  | quelques régions                                                      |
| Limites               | « sans SLA », pas pour la production                            | URL gratuite changeante, coupures possibles                           |

**Choix : Cloudflare** (proximité réseau, stabilité). **localhost.run seulement à la main** : ses serveurs sont aux États-Unis (IP AWS us-east-1 mesurée), ce qui ajoute 80 à 100 ms. Le lanceur ne bascule donc plus dessus automatiquement. Commandes vérifiées le 2026-11-07, avec cloudflared 2026.6.0 :

```bash
cloudflared tunnel --no-autoupdate --url http://localhost:3000
ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -R 80:localhost:3000 nokey@localhost.run
```

Le lanceur `scripts/start.mjs` les exécute, lit l'URL dans leur sortie et la publie au serveur. Le tableau de bord met alors à jour le QR code tout seul.

Le tunnel ne fait que relayer HTTPS/WSS vers le PC. S'il tombe, le jeu local continue ; il est relancé avec une nouvelle URL et un nouveau QR. Les joueurs déjà connectés via l'ancienne URL doivent rescanner. Un redémarrage du **serveur** ne touche pas au tunnel : l'URL reste la même (section suivante).

Installer cloudflared (Debian/Ubuntu) : téléchargez le `.deb` depuis les releases GitHub `cloudflare/cloudflared`, ou consultez la documentation Cloudflare « Downloads ». Un fichier `~/.cloudflared/config.yml` existant peut gêner les Quick Tunnels : renommez-le le temps de la soirée.

---

## Relancer sans casser la partie

Pendant que le jeu tourne, il suffit de relancer **la même commande** (par exemple `pnpm soiree`, ou `node scripts/start.mjs --build --port 3200 --tunnel cloudflared`). Le lanceur détecte celui qui est déjà en place sur ce port (`.data/launcher-<port>.json`) et ne le remplace pas :

1. La nouvelle version est construite **à côté**, dans `.output-next`. La partie continue pendant le build. Si le build échoue, rien ne change.
2. Le lanceur en place reçoit `SIGUSR2`. Il arrête le serveur, bascule sur la nouvelle version et redémarre le serveur seul. **Le tunnel n'est pas touché** : même URL, même QR code.
3. Si la nouvelle version ne répond pas sur `/api/health`, l'ancienne est remise en place automatiquement.

Ce qui se passe côté jeu :

- **À l'arrêt**, le serveur sauvegarde ses salons dans `.data/rooms-<port>.json`. Le fichier contient les codes, le secret de l'hôte, les règles, les scores, les jetons des joueurs et leurs couleurs. Il est écrit de façon atomique, en `0600`. Le serveur prévient ensuite écrans et téléphones (bandeau bleu « Mise à jour du serveur ») et ferme leurs connexions.
- **Au démarrage**, il restaure les salons de moins de 30 minutes. L'écran retrouve son salon grâce à son secret, et chaque téléphone retrouve son joueur grâce à son jeton, sans rien ressaisir. Les clients réessaient toutes les 120 ms après l'annonce du redémarrage.
- Une **manche en cours** ne peut pas reprendre, car les traces ne sont pas sauvegardées. Elle est annulée et ses points sont retirés, puis l'écran propose « Manche suivante ». Si c'était la première manche, l'écran revient au salon.
- Le serveur sauvegarde aussi en continu : au plus une écriture par seconde, et seulement si un salon a changé. Un **plantage** est donc rattrapé de la même façon : le lanceur relance le serveur, qui restaure les salons. Après 3 plantages en une minute, le lanceur arrête tout.
- **Sans sauvegarde** (fichier effacé ou périmé), l'écran qui se reconnecte garde quand même son code : le QR déjà scanné reste valable. Les téléphones attendent que l'écran ait recréé le salon, puis le rejoignent seuls sous leur pseudo et leur couleur mémorisés.

Mesuré par `pnpm test:e2e` (Chrome headless, 2026-11-07) :

- port libéré 2–3 ms après l'arrêt ;
- nouveau serveur prêt en 110–215 ms ;
- écran et téléphone reconnectés au même salon et au même joueur 50–130 ms plus tard ;
- **environ 0,3 s d'interruption au total**.

L'ancien processus finit de s'éteindre en parallèle (~2,4 s, libération de la bibliothèque WebRTC native), sans retarder le nouveau serveur.

`pnpm stop -- --port <port>` arrête le tout. Arrêter le lanceur (Ctrl+C) coupe aussi le tunnel : l'URL publique changera au prochain lancement.

---

## Latence : où elle se perd et comment le jeu la réduit

Un appui traverse : tactile du téléphone → réseau téléphone → PC → attente du tick → trame vers l'écran → dessin → affichage (Chrome, puis TV).

### Diagnostic de départ (configuration défavorable)

- PC relié à Internet par un **partage de connexion 4G** : 42–60 ms de ping, gigue 7–16 ms.
- Le tunnel cloudflared n'ouvre qu'**une connexion QUIC vers le point de présence Cloudflare le plus proche** (39–49 ms d'aller-retour ici).
- Via le tunnel, chaque commande traverse alors **deux liaisons cellulaires**, celle du téléphone puis celle du PC : 100 à 160 ms d'aller-retour, environ 50 ms à l'aller.
- Le serveur ajoutait 4 ms (tick à 120 Hz), et l'écran 6 ms (attente de l'image) plus le compositeur de Chrome.

### Ce que fait le jeu

| Levier                                     | Implémentation                                                                                                                                                                                                             | Gain mesuré / attendu                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Commandes en WebRTC**                    | DataChannel `in` **non ordonné, sans retransmission** (UDP/SCTP) ouvert par le téléphone. Côté serveur : `node-datachannel` (libdatachannel), signalisation par le WebSocket existant                                      | plus de blocage de tête de file TCP : un paquet perdu ne retarde plus les suivants                                      |
| **Chemin local automatique**               | ICE essaie toutes les paires : un téléphone sur le même Wi-Fi passe **en direct sur le réseau local**, même avec une page chargée via le tunnel HTTPS (WebRTC n'est pas soumis au blocage du « contenu mixte »)            | aller **~50 ms → < 1 ms** sur ce PC, quelques ms en Wi-Fi                                                               |
| **Internet sans tunnel**                   | STUN (Cloudflare, Google) pour traverser les NAT ; TURN optionnel (statique ou Cloudflare) quand le NAT est symétrique (4G avec CGNAT)                                                                                     | évite le détour cloudflared quand la traversée réussit                                                                  |
| **Double chemin, première copie gagnante** | chaque commande est numérotée (`i<bits>,<seq>,<t>`) et part 3 fois par le DataChannel (0, 6, 20 ms) **et** 1 fois par le WebSocket ; le serveur applique la première arrivée et ignore les copies ou les paquets en retard | la voie la plus rapide gagne à chaque fois ; rien n'est perdu si l'UDP échoue                                           |
| **Radio éveillée**                         | pendant une manche, l'état courant est renvoyé toutes les 50 ms (DataChannel) et 250 ms (WebSocket)                                                                                                                        | évite le « réveil » 4G/Wi-Fi (+20 à +100 ms) au premier appui après une pause ; répare une perte en ≤ 50 ms             |
| **Mesure de l'aller seul**                 | synchronisation d'horloge de type NTP (`s<t0>` → `S<t0>,<ts>`, on garde l'échantillon au plus petit RTT) ; chaque commande porte l'instant du toucher (`event.timeStamp`) sur l'horloge serveur                            | affiche l'aller réel (« ↑ ») et le **toucher → image** au lieu de RTT/2, faux en Wi-Fi (économie d'énergie asymétrique) |
| **Simulation à 240 Hz**                    | `TICK_RATE = 240`, une trame par tick vers l'écran                                                                                                                                                                         | attente du tick : moy. 4,2 → **2,1 ms**                                                                                 |
| **Canvas basse latence**                   | un seul canvas visible `desynchronized` (hors compositeur) ; les traces sont sur un canvas hors écran ; quand Chrome l'accorde, l'écran **dessine dès réception** d'une trame, sans attendre l'image suivante              | serveur → image : 5,9 → **2,3 ms**                                                                                      |
| **Chrome en kiosque**                      | `--kiosk` : `--disable-gpu-vsync --disable-frame-rate-limit`                                                                                                                                                               | supprime l'attente de synchronisation verticale (léger déchirement possible)                                            |

### Ce qui ne dépend pas du code

- **Mode jeu de la TV** et lissage de mouvement coupé : jusqu'à −100 ms, souvent le plus gros gain.
- **Connexion du PC** : une box fibre ou un câble Ethernet plutôt qu'un partage 4G (pour les joueurs hors Wi-Fi).
- **Économie d'énergie Wi-Fi du PC** coupée (par exemple sous Linux avec NetworkManager) : `nmcli connection modify <nom du Wi-Fi> 802-11-wireless.powersave 2`, puis reconnecter.
- Un écran à 120/144 Hz réduit encore l'attente d'image quand le canvas basse latence n'est pas disponible.

---

## Règles du jeu

- Chaque tête avance seule à vitesse constante (150 unités/s par défaut). Gauche/droite la fait tourner (2,8 rad/s).
- La trace (épaisseur 5) reste jusqu'à la fin de la manche. Un **trou** de 180 à 300 ms apparaît toutes les 4 à 8 s : on peut le traverser.
- Toucher un mur, une trace adverse ou une ancienne trace de soi élimine immédiatement. La trace juste derrière la tête ne compte jamais.
- Une manche se termine quand il reste au plus un survivant. Les éliminations d'un même tick sont simultanées : égalité possible, par exemple dans un face-à-face.
- **Points** : chaque élimination rapporte `pointsPerDeath` (1 par défaut) à chaque survivant. Des têtes éliminées pendant le même tick ne se rapportent rien entre elles. Un bonus optionnel récompense le dernier survivant.
- **Fin de partie**, au choix :
  - objectif de points (auto : 10 × (joueurs − 1), minimum 5), avec 2 points d'avance en option ;
  - ou un nombre de manches fixe, ex æquo possibles.
- Les joueurs prêts qui arrivent en cours de partie entrent à la manche suivante, avec 0 point.
- Un joueur déconnecté continue tout droit (sa commande est neutralisée) jusqu'à sa reconnexion.

Tout se règle depuis le tableau de bord : mode, fin de partie, points, compte à rebours, enchaînement automatique, chaque bonus, et en avancé vitesse, rotation, épaisseur, trous et taille de l'arène. Un changement s'applique à la manche suivante.

### Bonus et malus (mode Party)

Couleur du disque : vert = favorable à qui le prend, rouge = défavorable, bleu = neutre.

| Bonus            | Effet                                                                                                             | Durée            | Cible        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------- | ------------ |
| Accélération »   | vitesse ×1,5                                                                                                      | 5 s              | soi (rouge)  |
| Ralentissement « | vitesse ×0,65                                                                                                     | 5 s              | soi          |
| Trace fine —     | épaisseur ×0,5                                                                                                    | 7 s              | soi          |
| Trace épaisse ▬  | épaisseur ×2                                                                                                      | 6 s              | soi (rouge)  |
| Bouclier ◎       | annule une collision avec une trace, puis 0,6 s d'immunité aux traces pour s'en dégager ; ne protège pas des murs | 1 charge (3 max) | soi          |
| Fantôme ◌        | traverse les traces, pas les murs ; ne laisse pas de trace                                                        | 3 s              | soi          |
| Inversion ⇄      | gauche et droite inversées (signalé sur le téléphone)                                                             | 4 s              | soi (rouge)  |
| Effacement ✕     | supprime toutes les traces dans un rayon de 200 autour du bonus                                                   | immédiat         | arène (bleu) |
| Virage rapide ↻  | rotation ×1,5                                                                                                     | 5 s              | soi          |
| Chaos ?          | un malus au hasard (accélération, inversion ou trace épaisse) pour tous les adversaires vivants                   | réglable (4 s)   | adversaires  |

Règles d'application, toutes testées :

- **Ordre dans un tick** : expiration des effets → rotation et déplacement → collisions → pose des traces et éliminations → ramassage → apparition.
- **Cumul** : chaque ramassage est une instance indépendante avec sa propre fin. Les multiplicateurs se multiplient, puis sont bornés : vitesse [0,4 ; 2,5], épaisseur [0,35 ; 4], rotation [1 ; 2,5].
- **Collecte simultanée** : la tête la plus proche du centre du bonus le prend, puis l'index le plus bas en cas d'égalité.
- **Élimination** : effets et bouclier sont perdus. Les bonus posés restent dans l'arène.
- **Apparition** : toutes les 3 à 7 s, 3 au maximum. Un bonus apparaît à au moins 60 unités des murs, 120 des têtes, et loin des traces et des autres bonus. S'il n'y a aucun emplacement sûr, l'apparition est sautée.

---

## Architecture

```
            ┌─ DataChannel WebRTC « i<bits>,<seq>,<t> » ×3 (UDP, local si possible) ─┐
téléphone ──┤                                                                         ├─▶ GameServer ─▶ Room ─▶ Round
            └─ WebSocket (tunnel ou LAN) : même commande (fiable), signalisation, « me » ┘   │ boucle 240 Hz   │ trame/tick
                       ▲ « P/Q » pings, « s/S » synchro d'horloge (sur les deux chemins)     │                  ▼
                                                     écran hôte ◀── WS « f » (localhost) : têtes, événements, marqueurs de latence
                                                     canvas visible « desynchronized » + canvas des traces hors écran
```

### Choix et alternatives

| Sujet                   | Retenu                                                                                                                      | Alternatives écartées                                    | Raison                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Socle                   | **Nuxt 4 SPA + Nitro `node-server`**, WebSocket natif crossws (`nitro.experimental.websocket`)                              | serveur `ws` séparé, Socket.IO, Colyseus                 | un seul process, une seule origine (le tunnel expose un port), aucune dépendance de transport ; Socket.IO ajoute un protocole et du polling inutiles             |
| Modèle réseau           | **serveur autoritaire, commandes d'état numérotées**                                                                        | prédiction côté client, envoi d'événements appui/relâche | les téléphones n'affichent pas l'arène : rien à prédire. Un message d'_état_ est idempotent : doublons, pertes et reconnexions ne peuvent pas bloquer une touche |
| Transport des commandes | **WebRTC DataChannel non ordonné, sans retransmission + copie WebSocket**                                                   | WebSocket seul, WebTransport                             | voir « Latence ». WebTransport demande un port UDP public et un certificat, et passe mal par un tunnel rapide                                                    |
| Simulation              | **pas fixe 240 Hz**, minuteur visant l'échéance, rattrapage borné                                                           | 60/120 Hz, pas variable                                  | attente moyenne avant prise en compte d'un appui : 2,1 ms ; ~40 µs de calcul par tick à 12 joueurs ; mouvement déterministe                                      |
| Diffusion               | **une trame par tick vers l'hôte** (positions arrondies au 1/100, drapeaux, événements), JSON compact                       | snapshots binaires, deltas                               | l'hôte est sur la même machine (~0 ms de réseau) ; ~400 octets × 240/s. Le binaire n'apportait aucun gain mesurable                                              |
| Rendu                   | **Canvas 2D basse latence** (`desynchronized`) : traces hors écran, dessin dès réception ; dernier état, sans interpolation | PixiJS/WebGL, interpolation                              | les traces ne sont jamais redessinées (un segment par tick) ; interpoler ajouterait un tick de retard                                                            |
| Collisions              | **capsules balayées** (segment-segment, Ericson), **grille uniforme** de 24 u                                               | test de points, canvas pixel-perfect                     | exact quelle que soit la vitesse (pas de traversée), indépendant de la résolution, O(segments voisins)                                                           |
| Identité                | **jeton secret** par joueur (localStorage), id public distinct                                                              | cookie, id seul                                          | reconnexion après rechargement ; l'id visible ne permet pas d'usurper                                                                                            |
| Hôte                    | création **locale seulement** (loopback sans en-têtes de proxy), **secret** pour toute action                               | mot de passe                                             | le tunnel arrive aussi par 127.0.0.1 mais avec `cf-connecting-ip` / `x-forwarded-for`                                                                            |
| QR code                 | `uqr` (unjs, sans dépendance)                                                                                               | `qrcode`                                                 | minuscule, SVG direct                                                                                                                                            |
| Styles                  | Tailwind v4 + police Nunito (`@fontsource-variable`)                                                                        | CSS à la main, bibliothèque de composants                | classes utilitaires dans les composants, aucune feuille de style à maintenir ; police servie localement, sans CDN                                                |

### Arborescence

```
shared/      constantes, règles (défauts + validation), protocole, géométrie (code client + serveur)
game/        moteur et serveur, sans Nuxt ni réseau — testables seuls
  round.ts     simulation d'une manche (déplacement, trous, collisions, bonus)
  trails.ts    stockage des traces en tableaux typés + grille spatiale
  bot.ts       pilote automatique (charge, appoint en soirée)
  scoring.ts   points, bonus de survie, conditions de victoire
  room.ts      salon : joueurs, phases, manches, scores, messages, instantané / restauration
  server.ts    connexions, routage, limites de débit, pings, synchro d'horloge, boucle temps réel, diagnostic, sauvegarde
  snapshot.ts  format de l'instantané des salons et validation à la relecture
  store-node.ts fichier d'instantané (écriture atomique, 0600)
  rtc.ts       interface du pont WebRTC, classement du chemin ICE (lan / direct / relais)
  rtc-node.ts  implémentation node-datachannel, serveurs STUN/TURN
server/      adaptateur Nitro : /_ws, /api/health, /api/tunnel, /api/rooms/:code
app/         pages /, /host (écran), /play/:code (manette) ; renderer Canvas ; useSocket ; useInputLink (WebRTC + WS) ;
             SafePanel (barrière d'erreur des panneaux de l'écran)
scripts/     start.mjs (lanceur, tunnel supervisé, relance à chaud), load-test.mjs (banc de charge),
             e2e.mjs (bout en bout dans Chrome via le protocole DevTools)
tests/       Vitest : moteur, bonus, scores, protocole/serveur, sauvegarde, parties multijoueurs simulées
```

### Protocole

- Chemin critique en texte brut, sans JSON, identique sur le DataChannel et le WebSocket :
  - le téléphone envoie `i<bits>,<seq>,<t>` à chaque changement, dans le gestionnaire `pointerdown`/`pointerup`, sans passer par Vue. Bit 1 = gauche, bit 2 = droite. `seq` est croissant et `t` est l'instant du toucher sur l'horloge serveur (0 si inconnu). La forme courte `i<bits>` reste acceptée ;
  - le serveur envoie `P<n>` chaque seconde sur chaque chemin ; le client répond `Q<n>`, ce qui donne le RTT et la gigue (style RFC 3550) ;
  - le téléphone envoie `s<t0>` ; le serveur répond `S<t0>,<heure serveur>` (synchronisation d'horloge).
- Signalisation WebRTC (JSON sur le WebSocket) : `joined.iceServers`, puis `rtc` `offer` / `answer` / `cand`. Une nouvelle offre remplace la session précédente, et la fermeture du WebSocket ferme le DataChannel.
- Trames : `in` porte des triplets `[index, arrivée, toucher]`, pour que l'écran mesure arrivée → image et toucher → image.
- JSON validé côté serveur (`parseClientMessage`) pour le reste :
  - `host`, `join`, `ready`, `profile`, `leave` ;
  - les actions hôte : `rules`, `start`, `pause`, `resume`, `next`, `restartRound`, `newGame`, `endGame`, `kick`, `addBot`, `removeBot`.
- Serveur → hôte :
  - `room` (salon complet, à chaque changement) ;
  - `round` (début de manche ou réhydratation : arène, têtes, bonus, traces compactées en polylignes) ;
  - `f` (trame) ;
  - `diag` (1/s).
- Serveur → téléphone : `me` (son état, à chaque changement), `joined`, `error`, `kicked`, `replaced`.
- Protections :
  - messages JSON limités à 16 Ko (offres SDP), commandes à 48 caractères (expression régulière stricte) ;
  - seau à jetons WebSocket (120 messages, 60/s ; déconnexion après 400 dépassements) et DataChannel (400, 250/s) ;
  - connexion muette libérée après 6 s sans réponse aux pings ;
  - pseudo nettoyé (caractères de contrôle, 16 caractères) ;
  - couleur unique ;
  - 12 joueurs au maximum.

### Moteur : points clés

- **Collision d'un tick** : le déplacement de la tête est une capsule (début → fin, rayon = épaisseur/2). Il est testé contre :
  - les murs ;
  - les traces existantes (grille) ;
  - les nouveaux segments des autres têtes du même tick, ce qui couvre les face-à-face.
- **Trace derrière la tête** : les segments de sa propre trace posés il y a moins de `2 × (r + rmax) + 2 × pas` unités de parcours sont ignorés. Comme le rayon de virage (≥ 53 u par défaut) est très supérieur à l'épaisseur, aucune collision artificielle n'est possible.
- **Départ** : positions à ≥ 12 % du bord, espacées (32 % du petit côté, distance relâchée si nécessaire), orientées pour laisser ≥ 1,5 s de ligne droite. Ces propriétés sont testées sur 200 graines, et 100 graines à 12 joueurs ne donnent aucune mort pendant la première seconde.
- **Déterminisme** : générateur `mulberry32` à graine. Même graine + mêmes commandes = même partie (testé).
- **Arène** : unités logiques indépendantes de l'écran, ratio 4:3. En mode auto, 1140×855 à 2 joueurs et 1740×1305 à 12.

### Reconnexion

- **Téléphone** : backoff 100 ms → 3 s, reconnexion immédiate au retour au premier plan ou au retour du réseau. Une socket muette depuis 4 s est recyclée. Le jeton de `localStorage` restaure l'identité, et l'état des touches est renvoyé. Une seconde manette sur la même identité remplace la première (message « Manette ouverte ailleurs »).
- **Commandes neutralisées** au relâchement, à la perte de focus (`blur`, `visibilitychange`, `pagehide`) et à la déconnexion (côté serveur). Filet de sécurité : `touchend` sans aucun doigt restant.
- **Écran hôte** : il retrouve son salon avec le secret stocké, et reçoit l'état complet de la manche en cours (traces comprises).
- **Redémarrage du serveur** : annoncé par un message `restarting`. Les clients réessaient alors toutes les 120 ms au lieu du backoff. Les salons sont restaurés depuis l'instantané (voir « Relancer sans casser la partie »). Un téléphone qui trouve le salon absent attend jusqu'à 30 s que l'écran l'ait recréé.
- **Écran robuste** : le diagnostic, les règles et le classement sont rendus derrière une barrière d'erreur (`SafePanel`). Un bug dans l'un d'eux affiche un encart, l'arène et le QR code restent utilisables.

---

## Mesures

### Après les optimisations de latence (2026-11-07, ce PC)

Manette ouverte dans Chrome **via l'URL du tunnel Cloudflare**, écran hôte en local, mesures du panneau `D` :

| Mesure                                | Avant (WebSocket via tunnel, 120 Hz) | Après                                                   |
| ------------------------------------- | ------------------------------------ | ------------------------------------------------------- |
| Chemin des commandes                  | tunnel                               | **LAN (WebRTC)**, choisi seul                           |
| RTT                                   | 97 ms (WebSocket)                    | **1 ms** (DataChannel)                                  |
| Commandes arrivées d'abord par WebRTC | —                                    | **98 %**                                                |
| Aller toucher → serveur (« ↑ »)       | ~50 ms (RTT/2)                       | **0,8 ms**                                              |
| Arrivée → image                       | p50 5,9 · p95 16,5 ms                | **p50 2,3 · p95 4,2 ms** (canvas basse latence accordé) |
| **Toucher → image**                   | ~89 ms (estimé)                      | **p50 3 · p95 6 ms (mesuré)**                           |

Banc de charge à 240 Hz, 12 téléphones, WebSocket : commande → trame p50 **2,2** · p95 4,4 · max 5,7 ms ; intervalle entre trames p50 4,2 · p95 5,2 · max 6,3 ms ; 0 trou ; scores exacts. Avec latence 30 ms, gigue 20 ms, coupures et mode Party : 0 trou, 0 écart de score.

Le téléphone et l'écran étaient ici la même machine. Avec un vrai téléphone en Wi-Fi, il faut ajouter le Wi-Fi (quelques ms), la dalle tactile (10–30 ms) et l'affichage de la TV.

### Banc de charge à 120 Hz (WebSocket réels)

Mesuré le 2026-11-07 (Linux, Node 24.14) avec `node scripts/load-test.mjs`. Le client de charge et le serveur tournent sur la même machine.

| Scénario                                                                            | Trames reçues / trous | Intervalle entre trames (cible 8,3 ms à 120 Hz) | Commande arrivée → trame reçue par l'hôte | Tick serveur             | Retard du minuteur    | Scores ≠ éliminations |
| ----------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------- | ----------------------------------------- | ------------------------ | --------------------- | --------------------- |
| 12 téléphones, 30 s, réseau parfait                                                 | 2 580 / **0**         | p50 8,3 · p95 9,2 · max 10,4 ms                 | p50 **4,3** · p95 8,4 · max 9,2 ms        | moy ≤ 0,11 · max 1,64 ms | moy 0,55 · max 2,1 ms | **0**                 |
| 12 téléphones, 40 s, Party, latence 40 ms + gigue 30 ms, coupures (20 reconnexions) | 3 420 / **0**         | p50 8,3 · p95 9,2 · max 10,0 ms                 | p50 **4,2** · p95 8,3 · max 9,3 ms        | moy ≤ 0,05 · max 0,56 ms | moy 0,53 · max 1,3 ms | **0**                 |

- Mémoire du serveur : ~100 Mo.
- Simulation seule : 12 bots IA comprise, ~40 µs par tick (2 419 ticks en 96 ms).
- Le délai commande → trame vaut bien un demi-tick en médiane (attente du prochain tick) plus l'envoi sur localhost.

### Chaîne appui → écran et ce que mesure le diagnostic

```
dalle tactile ─▶ événement (event.timeStamp) ─▶ réseau (aller) ─▶ attente du tick (0–4,2 ms) ─▶ trame (<1 ms) ─▶ dessin ─▶ affichage (Chrome, TV)
               └──────────────────── « toucher → image » mesuré ────────────────────────────────────────────┘
```

- **toucher → image** : instant du toucher, ramené sur l'horloge serveur par la synchronisation, jusqu'au dessin de l'image qui montre la commande. L'écran est sur la même machine que le serveur, donc sur la même horloge.
- **↑ aller** : toucher → arrivée au serveur.
- **srv→img** : arrivée → image.
- Ne sont **pas** inclus : la dalle tactile du téléphone (10–30 ms) et l'affichage (scanout, TV).

**Mesure de référence (non faite ici)** : filmer téléphone et TV dans le même plan au ralenti (240 fps), puis compter les images entre le contact du doigt et le changement de direction visible. Cette méthode inclut la latence tactile et celle du téléviseur (activez le « mode jeu » de la TV).

---

## Tests

`pnpm test` lance 74 tests (Vitest, ~2 s), tous verts au 2026-11-07 :

- **`engine.test.ts`** :
  - vitesse et rotation exactes, deux touches = tout droit ;
  - déterminisme ;
  - mort contre un mur (rayon compris), contre une trace adverse, contre sa propre trace ancienne ;
  - jamais contre la trace juste derrière soi ;
  - pas de traversée à 400 u/s contre une trace de 1 u ;
  - face-à-face simultané (égalité) ;
  - fréquence et durée des trous, sans segment pendant un trou ; traversée par un trou ;
  - équité du départ (200 graines), aucune mort en 1 s (100 graines × 12 joueurs) ;
  - encodage des trames ;
  - polylignes de réhydratation.
- **`bonus.test.ts`** :
  - chaque bonus, cumuls et bornes, expirations ;
  - fantôme (traces oui, murs non), bouclier (consommation, immunité, murs) ;
  - effacement (rayon exact), chaos (adversaires seulement) ;
  - collecte simultanée, effets perdus à l'élimination ;
  - limite simultanée, bonus désactivés, zone sûre, aucun bonus en Classique.
- **`scoring.test.ts`** : points par élimination, simultanéité, bonus de survie, objectif auto, 2 points d'avance, mode manches, validation des règles.
- **`server.test.ts`** :
  - création locale seulement ; secret hôte ; actions hôte refusées aux joueurs ;
  - messages invalides ; pseudos et couleurs uniques ; 13e joueur refusé ;
  - reconnexion par jeton (ancienne connexion remplacée) ; usurpation impossible ;
  - commande neutralisée à la déconnexion ; connexion muette libérée ; limite de débit ;
  - phases (compte à rebours, pause figée, reprise) ; « rejouer la manche » annule ses points ;
  - réhydratation d'un écran hôte en pleine manche.
- **`input.test.ts`** :
  - format strict des commandes ;
  - première copie gagnante (doublons et paquets en retard ignorés) ;
  - numérotation remise à zéro à la reconnexion ;
  - aller seul mesuré depuis l'heure du toucher ;
  - marqueurs `[index, arrivée, toucher]` des trames ;
  - synchronisation d'horloge ;
  - classement du chemin ICE (IPv4 privées, IPv6 du même /64, relais).
- **`rtc.test.ts`** : **WebRTC réel** (libdatachannel des deux côtés). On vérifie :
  - le DataChannel s'ouvre par la signalisation WebSocket, et le chemin est classé `lan` ;
  - une commande arrive par le DataChannel et sa copie WebSocket est ignorée ;
  - la synchronisation et les pings passent par le DataChannel ;
  - fermer le WebSocket libère la session WebRTC.
- **`persist.test.ts`** : sauvegarde et redémarrage.
  - Le salon est repris : même code, l'hôte revient par son secret, le téléphone par son seul jeton (même joueur, même couleur, toujours prêt).
  - Une manche interrompue est annulée (points retirés, victoires inchangées) puis rejouée avec tout le monde. Une première manche interrompue ramène au salon.
  - Le serveur n'écrit que si un salon a changé, au plus une fois par seconde.
  - Un instantané périmé (> 30 min), invalide ou d'une autre version est ignoré.
  - Sans instantané, l'écran garde son code ; un code invalide, déjà pris ou `fresh` donne un code neuf.
  - À l'arrêt : sauvegarde, message `restarting`, connexions fermées (1012).
  - Fichier : écriture atomique, mode `0600`, fichier tronqué ignoré.
- **`multiplayer.test.ts`** : parties **complètes** à **2, 6 et 12** téléphones sur un réseau simulé (latence 10–100 ms, gigue jusqu'à 40 ms, coupures et reconnexions aléatoires). On vérifie :
  - la fin de partie ;
  - aucune trame manquante ;
  - l'identité conservée ;
  - **chaque score égal aux éliminations observées par l'écran** ;
  - la victoire avec 2 points d'avance.

  S'y ajoutent une partie Party à 12 (bonus ramassés, scores exacts) et une partie par nombre de manches avec bonus de survie.

`pnpm test:load` mesure sur un serveur réellement lancé (voir « Mesures ») et sort en erreur s'il y a un trou de trames ou un écart de score.

`pnpm test:e2e` (≈ 10 s) lance le vrai serveur de production et **Chrome headless** piloté par le protocole DevTools, sans dépendance ajoutée. L'écran et le téléphone sont deux contextes isolés ; le téléphone est émulé en mobile tactile. Le test enchaîne :

1. L'écran s'ouvre avec le panneau diagnostic mémorisé ouvert (cas qui faisait autrefois échouer le chargement). On vérifie le code du salon et le QR code.
2. Le téléphone saisit son pseudo, rejoint et se met prêt ; l'écran ajoute un bot et lance la partie.
3. WebRTC s'ouvre (« Wi-Fi direct »). De vrais touchers (`Input.dispatchTouchEvent`) arrivent au serveur, qui mesure l'aller (≈ 5 ms).
4. **Le serveur est arrêté en pleine partie.** On vérifie le bandeau « mise à jour », le redémarrage, puis le même salon et le même joueur sans rien ressaisir. Une nouvelle manche est ensuite lancée.
5. **Relance à froid** (sauvegarde effacée) : l'écran garde son code et le téléphone revient seul.

Il sort en erreur au premier écart. La relance à chaud du lanceur (`.output-next`, tunnel conservé) a été vérifiée à la main sur le port 3200 : serveur relancé en 165 ms, URL du tunnel inchangée, 4 salons restaurés.

**Ce qui a été vérifié à la main** (Chrome, 2026-11-07) :

- salon, QR code et adresses ;
- un joueur rejoint, se met prêt ; partie lancée avec bots ;
- manche, résultats, manche suivante ;
- la zone gauche maintenue fait boucler la courbe, qui meurt sur sa propre trace ;
- manette ouverte **via le tunnel Cloudflare** (HTTPS + WSS, RTT ~100 ms), zigzag piloté à distance ;
- rechargement de la manette : même identité ;
- panneau de diagnostic ; HTTP et WSS via localhost.run ;
- manette chargée **via le tunnel** et passée seule en **WebRTC local** (« Wi-Fi direct ») : 98 % des commandes arrivent d'abord par le DataChannel, toucher → image 3 ms (p50) ;
- binaire natif `node-datachannel` chargé depuis `.output/` (build de production).

**Pas encore vérifié** :

- de vrais téléphones (iOS Safari, Android Chrome), sur le Wi-Fi et en 4G (traversée STUN, besoin de TURN) ;
- une vraie TV ;
- le mode `--kiosk` sur l'écran de la soirée.

Les gestes ont été simulés par des `PointerEvent` dans Chrome desktop.

---

## Dépannage

| Symptôme                                                                   | Cause probable / solution                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| « Le tableau de bord s'ouvre depuis le PC hôte (localhost) »               | l'écran hôte a été ouvert via le tunnel ou une IP. Ouvrez `http://localhost:3000/host`, ou lancez avec `TANGENTE_LAN_HOST=1` pour une TV sur le réseau local                                                                                 |
| Les téléphones en Wi-Fi ne chargent pas la page                            | pare-feu du PC (ouvrez le port 3000) ou Wi-Fi « invité » isolant les appareils. Utilisez le QR « Internet »                                                                                                                                  |
| `le tunnel ne répond pas encore`                                           | sortie Internet du PC ; essayez `--tunnel localhostrun`. Sur le PC lui-même, l'URL peut sembler injoignable quelques minutes (cache DNS négatif local) alors qu'elle marche pour les téléphones                                              |
| « Salon introuvable » sur le téléphone                                     | l'hôte a créé un nouveau salon (« Nouveau salon »), ou le salon a expiré (30 min sans personne) : rescannez le QR. Un simple redémarrage du serveur ne le provoque plus                                                                      |
| « En attente de l'écran… » sur le téléphone                                | le serveur a redémarré sans sauvegarde et l'écran ne s'est pas encore reconnecté : rouvrez ou rechargez `http://localhost:<port>/host` sur le PC                                                                                             |
| Encart « Panneau … indisponible » sur l'écran                              | erreur de rendu dans ce panneau (voir la console) ; « réessayer » le recharge, le jeu continue                                                                                                                                               |
| Plusieurs salons ouverts, QR différents                                    | plusieurs onglets du tableau de bord sont ouverts : chacun tient son salon. Gardez-en un seul                                                                                                                                                |
| « Manette ouverte ailleurs »                                               | la même identité a été ouverte dans un autre onglet ; « Reprendre ici » la récupère                                                                                                                                                          |
| Un joueur va tout droit sans le vouloir                                    | il est déconnecté (« hors ligne » sur l'écran) ; la reconnexion est automatique au retour de la page                                                                                                                                         |
| Saccades sur la TV                                                         | vérifiez dans `D` les FPS et les « trames reçues » (≈240/s). Préférez le build (`pnpm soiree`/`pnpm start`) à `pnpm dev`, et le mode jeu de la TV                                                                                            |
| Le téléphone se met en veille                                              | l'écran reste allumé via Wake Lock quand le navigateur le permet ; sinon, réglez la mise en veille du téléphone                                                                                                                              |
| La manette affiche « tunnel » alors que le téléphone est sur le même Wi-Fi | WebRTC n'a pas pu s'établir : Wi-Fi qui isole les appareils, pare-feu UDP du PC (`sudo ufw allow proto udp from 192.168.0.0/16`), ou Chrome qui demande l'autorisation « réseau local » (acceptez-la). Le jeu reste jouable par le WebSocket |
| « relais » ou « tunnel » pour un joueur en 4G                              | NAT symétrique côté opérateur ; configurez un TURN (`TANGENTE_TURN_*` ou `TANGENTE_CF_TURN_*`) pour éviter le détour par le tunnel                                                                                                           |

---

## Limites connues

- Un redémarrage du serveur annule la manche en cours : les traces ne sont pas sauvegardées, seuls les scores des manches terminées le sont. Les salons sans personne depuis 30 minutes ne sont pas restaurés.
- L'URL d'un Quick Tunnel change à chaque lancement **du tunnel** : il faut rescanner après une coupure du tunnel ou un arrêt du lanceur. La relance à chaud du serveur la conserve. Une URL fixe demande un tunnel Cloudflare nommé, donc un compte et un domaine.
- En mode développement (`--dev`), la relance à chaud redémarre `nuxt dev` sans `.output-next`.
- Le bouclier ne protège pas des murs. Un joueur fantôme qui finit son effet à l'intérieur d'une trace meurt.
- Avec des effets cumulés extrêmes (ralentissements + virages rapides + trace épaisse), le rayon de virage peut descendre sous l'épaisseur ; la tête peut alors toucher sa propre trace en tournant sur place. C'est cohérent physiquement, mais rare.
- Les bots ne cherchent pas les bonus et évitent seulement les obstacles (horizon ~1 s).
- Le jeu n'a ni son ni PWA, par choix : le gameplay et la latence passent avant.
- Le DataChannel est lié à la session WebSocket : si le WebSocket tombe (tunnel coupé), la session WebRTC est refaite après la reconnexion, en ~1 s.
- Les interfaces virtuelles de l'hôte (Docker, VPN…) peuvent être annoncées comme candidats ICE. C'est sans effet sur le chemin retenu, mais cela allonge la liste des candidats.
- Le canvas basse latence dépend du navigateur et du GPU : le diagnostic indique s'il est accordé. Sinon, l'écran dessine à l'image suivante.
- Avec `--kiosk`, l'absence de vsync peut produire un léger déchirement d'image : c'est un compromis assumé pour la latence.

---

## Licence

[MIT](LICENSE)
