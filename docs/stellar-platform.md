# La plateforme Stellar en un coup d'œil

Ces notes résument ce qu'on peut construire sur Stellar pendant HackMeridian. Elles ont été rédigées à partir du skill officiel [`stellar-dev`](https://github.com/stellar/stellar-dev-skill) (v1.2.0) et de [developers.stellar.org](https://developers.stellar.org). Dans Claude Code, chaque section renvoie au skill qui la détaille : `/stellar-dev:<skill>`.

## À quoi sert Stellar

Stellar est un réseau de paiement ouvert, rapide (environ 5 s par ledger) et peu coûteux (une fraction de centime par transaction). Son domaine, ce sont les **paiements, les stablecoins et les actifs réels tokenisés**, pas la spéculation. Parmi ses utilisateurs : Circle (USDC et EURC natifs), MoneyGram (cash-in / cash-out), Société Générale-FORGE (stablecoin EURCV), et des anchors fiat dans de nombreux pays.

## Les briques

### 1. Smart contracts (ex-« Soroban ») — `/stellar-dev:smart-contracts`

- Écrits en **Rust** (`#![no_std]`, crate `soroban-sdk`) et compilés en **WebAssembly** pour la cible `wasm32v1-none`.
- Taille maximale du binaire : 128 Ko. Pas d'I/O, pas de réseau : tout passe par `Env`.
- **Stockage loué** : chaque entrée a un TTL. Trois types existent : `instance`, `persistent` et `temporary`. Sans `extend_ttl`, les données finissent archivées.
- **Autorisation native** : `address.require_auth()` fonctionne aussi bien avec des comptes classiques qu'avec des smart accounts.
- Constructeur atomique `__constructor` (CAP-58), événements `#[contractevent]`, erreurs typées `#[contracterror]`.
- La réentrance cross-contract est bloquée par l'hôte, et `delegatecall` n'existe pas.
- La version majeure de `soroban-sdk` suit celle du protocole. Ce repo utilise **SDK 28 ↔ protocole 28**.

### 2. Assets et stablecoins — `/stellar-dev:assets`

Les tokens existent sous deux formes :

| | Stellar Asset (classique) | Token contrat (SEP-41) |
|---|---|---|
| Création | Une opération, sans code | Contrat Rust |
| Performance et coût | Optimal | Plus cher |
| Logique métier | Flags : `auth_required`, `clawback`… | Libre |
| Accès depuis un contrat | Via le **SAC** (Stellar Asset Contract) | Natif |

Il vaut mieux partir d'un Stellar Asset et passer par le **SAC** pour l'utiliser depuis un contrat. Un token custom ne se justifie que si la logique l'exige. Côté utilisateur, détenir un asset demande une **trustline**.

### 3. Lire la chaîne — `/stellar-dev:data`

| API | Usage | Testnet |
|---|---|---|
| **Stellar RPC** (recommandé) | Contrats, simulation, événements, envoi de transactions | `https://soroban-testnet.stellar.org` |
| Horizon (legacy) | Historique des comptes, paiements, carnets d'ordres | `https://horizon-testnet.stellar.org` |
| Friendbot | Alimenter un compte testnet en XLM | `https://friendbot.stellar.org` |

Pour l'analytique historique : Hubble (BigQuery), Galexie, ou des indexeurs tiers.

### 4. Frontend et wallets — `/stellar-dev:dapp`

- SDK JS `@stellar/stellar-sdk`. `contract.Client` génère un client typé à partir d'un contrat déployé, ce qui revient à l'équivalent de `stellar contract bindings typescript`.
- Wallets : **Freighter** (extension navigateur), **Stellar Wallets Kit** (multi-wallet), **smart accounts avec passkeys** (connexion par empreinte digitale, sans seed phrase).

### 5. Standards (SEP / CAP) — `/stellar-dev:standards`

| Besoin | Standard |
|---|---|
| Token fongible | SEP-41 (+ SEP-57 si régulé) |
| Authentification web avec un wallet | SEP-10 |
| Dépôt / retrait fiat via un anchor | SEP-24 (interactif), SEP-6 (API) |
| KYC | SEP-12 |
| Corridors de paiement transfrontaliers | SEP-31 |
| Contrats upgradables | SEP-49 + CAP-58 (constructeurs) |
| Passkeys / smart wallets | CAP-51 (secp256r1) |

### 6. Paiements agentiques — `/stellar-dev:agentic-payments`

Ce sont des paiements d'IA à API, en USDC :
- **x402** (HTTP 402 Payment Required) : une API payante à la requête, sans que le client ait besoin de XLM, les frais étant sponsorisés par un facilitateur. C'est l'option la plus simple pour démarrer.
- **MPP** (Machine Payments Protocol) : en mode *Charge*, un paiement par requête ; en mode *Session*, des engagements off-chain via un canal de paiement, pour les agents qui envoient beaucoup de requêtes.

### 7. Aller plus loin

- **ZK** — `/stellar-dev:zk-proofs` : vérification BLS12-381, Groth16, UltraHonk (Circom, Noir, RISC Zero).
- **Cross-chain** — `/stellar-dev:cross-chain` : CCTP (USDC natif), Axelar, LayerZero.

## Outils web

- [Stellar Lab](https://lab.stellar.org) : construire et signer des transactions, explorer les contrats, consulter les limites réseau.
- [stellar.expert](https://stellar.expert/explorer/testnet) : explorateur de blocs (testnet et mainnet).
- [soroban-examples](https://github.com/stellar/soroban-examples) : contrats de référence (token, escrow, atomic swap, timelock, liquidity pool…).
- [OpenZeppelin Stellar Contracts](https://github.com/OpenZeppelin/stellar-contracts) : bibliothèques auditées (tokens, contrôle d'accès, pausable, upgradeable).
- [llms.txt](https://developers.stellar.org/llms.txt) : la documentation dans un format pensé pour les LLM.

## Pistes d'idées par brique

| Brique | Exemples de projets |
|---|---|
| Stablecoins + anchors | Transferts de fonds entre étudiants Erasmus, paie de freelances en EURC |
| SAC + contrat | Escrow pour des missions freelance, cagnotte d'asso avec règles de déblocage |
| Passkeys | Wallet sans seed phrase pour primo-utilisateurs |
| x402 / MPP | API payante consommée par des agents IA, micro-paiement par requête |
| Assets régulés | Tokenisation de tickets d'événement, de bons ou d'actifs réels |
| ZK | Preuve d'âge ou de diplôme sans révéler la donnée |
