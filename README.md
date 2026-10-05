# HackMeridian 2026 — Stellar

Repo de l'équipe pour [HackMeridian](https://hackmeridian.com), le hackathon Stellar organisé à Lisbonne (ONE16) les **25 et 26 octobre 2026**.
Il a été lancé lors de la soirée *Discover Stellar, Soroban Demo & How to Find Your Idea* (KRYPTOSPHERE ESGI, 5 octobre 2026).

| Date | Étape |
|---|---|
| 5 oct. | Soirée ESGI : découverte de Stellar, premier contrat sur le testnet, mur à idées, formation des équipes |
| **19 oct.** | **Clôture des candidatures** sur [hackmeridian.com](https://hackmeridian.com) |
| 25–26 oct. | Hackathon à Lisbonne (parcours **Genesis** ou **Scale**) |
| 28–29 oct. | Meridian, la conférence Stellar |

## Démarrage rapide (testnet en moins d'une heure)

### 1. Outils

| Outil | Windows | macOS / Linux |
|---|---|---|
| Rust ≥ 1.84 | [rustup.rs](https://rustup.rs) | `curl https://sh.rustup.rs -sSf \| sh` |
| Cible Wasm | `rustup target add wasm32v1-none` | idem |
| Stellar CLI | `winget install --id Stellar.StellarCLI` | `brew install stellar-cli` |

Vérification : `stellar --version` (le repo est testé avec la 28.1.0).

### 2. Compiler et tester

```sh
cargo test                 # tests unitaires, exécutés hors chaîne
stellar contract build     # → target/wasm32v1-none/release/hello_world.wasm
```

### 3. Déployer sur le testnet

```sh
# Identité financée automatiquement par Friendbot
stellar keys generate alice --network testnet --fund

stellar contract deploy \
  --wasm target/wasm32v1-none/release/hello_world.wasm \
  --source-account alice --network testnet --alias hello_world

stellar contract invoke --id hello_world --source-account alice --network testnet \
  -- hello --to ESGI
# ["Hello","ESGI"]
```

Le contrat déployé est consultable sur [stellar.expert/explorer/testnet](https://stellar.expert/explorer/testnet) ou dans [Stellar Lab](https://lab.stellar.org).

## Structure

```
.
├── contracts/
│   └── hello-world/        # contrat d'exemple (à remplacer par le vôtre)
├── docs/
│   ├── stellar-platform.md # tour d'horizon de la plateforme Stellar
│   ├── claude-tooling.md   # outillage IA : plugins, skills, MCP
│   └── ideas.md            # mur à idées et formation des équipes
├── .claude/settings.json   # plugin Stellar partagé avec l'équipe
├── .mcp.json               # serveur MCP Raven (docs Stellar et données live)
├── AGENTS.md / CLAUDE.md   # instructions pour les agents IA
└── Cargo.toml              # workspace Rust (soroban-sdk 28)
```

Pour ajouter un contrat : `stellar contract init . --name mon-contrat`. Il est créé dans `contracts/mon-contrat/`.

## Construire avec l'IA

Le repo est préconfiguré pour [Claude Code](https://claude.com/claude-code). Il suffit d'ouvrir le dossier et d'accepter les propositions :

- **Plugin `stellar-dev`**, le skill officiel Stellar : contrats, dApp, assets, données, standards SEP/CAP, paiements agentiques.
- **MCP `stellar-raven`** : recherche dans la doc Stellar et requêtes sur les données live de l'écosystème.

Les détails et alternatives sont dans [docs/claude-tooling.md](docs/claude-tooling.md).

## Équipe

| Nom | Rôle | GitHub |
|---|---|---|
| | | |

Parcours visé : ☐ Genesis · ☐ Scale

## Checklist candidature

- [ ] Idée choisie ([docs/ideas.md](docs/ideas.md))
- [ ] Équipe formée (1 à 4 personnes)
- [ ] Candidature envoyée sur hackmeridian.com **avant le 19 octobre**
- [ ] Demande de bourse de voyage (vol + auberge de jeunesse)
- [ ] Wallet testnet ([Freighter](https://freighter.app)) installé par chaque membre
- [ ] Prototype de contrat déployé sur le testnet
- [ ] Pitch préparé

## Licence

[MIT](LICENSE)
