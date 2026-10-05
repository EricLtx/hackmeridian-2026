# Outillage IA : marketplaces Claude, skills et MCP

Ce document recense ce qui existe pour développer des smart contracts Stellar avec Claude Code. Le tour d'horizon date du 5 octobre 2026.

## Ce qui est préconfiguré dans ce repo

À l'ouverture du dossier, Claude Code propose d'installer les outils suivants. Il suffit d'accepter.

| Outil | Fichier | Rôle |
|---|---|---|
| Plugin **`stellar-dev`** (officiel, [stellar/stellar-dev-skill](https://github.com/stellar/stellar-dev-skill)) | `.claude/settings.json` | 8 skills : `smart-contracts`, `dapp`, `assets`, `data`, `standards`, `agentic-payments`, `zk-proofs`, `cross-chain` |
| MCP **`stellar-raven`** ([raven.stellar.buzz](https://raven.stellar.buzz/playground)) | `.mcp.json` | `search` dans la doc Stellar et l'écosystème, `execute` pour interroger les données live |

Installation manuelle, hors de ce repo :

```sh
claude plugin marketplace add stellar/stellar-dev-skill
claude plugin install stellar-dev@stellar-dev
claude mcp add --transport http stellar-raven "https://raven.stellar.buzz/mcp"
```

Pour un autre agent (Cursor, Codex, VS Code), voir [Building with AI](https://developers.stellar.org/docs/build/building-with-ai). Les skills sont aussi consultables sans installation sur [skills.stellar.org](https://skills.stellar.org).

## Les marketplaces déjà configurées

| Marketplace | Contenu lié aux smart contracts | Utile pour Stellar ? |
|---|---|---|
| `claude-plugins-official` (Anthropic) | `circle-skills` (USDC, wallets, Circle Smart Contract Platform), `rust-analyzer-lsp`, `solidity-lsp` | `rust-analyzer-lsp` : **oui** (contrats en Rust). `circle-skills` : partiellement (USDC et EURC existent sur Stellar, mais les skills ciblent surtout l'EVM). |
| `claude-code-workflows` (wshobson/agents) | `blockchain-web3` : Solidity, DeFi, NFT, web3-testing | Non : EVM et Solidity uniquement. Les concepts DeFi restent transposables. |
| `anthropic-agent-skills`, `claude-code-skills`, `impeccable` | Rien de spécifique à la blockchain | — |
| Anthropic Directory (claude.ai) | Analyse crypto (marchés, ETF) | Non : on ne fait pas de spéculation. |

Conclusion : aucune marketplace préinstallée ne couvre Stellar. La marketplace officielle **`stellar/stellar-dev-skill`** est la référence. On peut la compléter avec `rust-analyzer-lsp` :

```sh
claude plugin install rust-analyzer-lsp@claude-plugins-official
```

## Alternatives communautaires (non vérifiées)

À n'utiliser qu'en complément et après relecture du code, puisque ce sont des sources tierces :

- [kaankacar/stellar-plugin](https://github.com/kaankacar/stellar-plugin) : plugin Claude Code pour le dev Stellar
- [rawritude/stellar-expert-skills](https://awesomeclaudeplugins.com/rawritude/stellar-expert-skills) : requêtes sur l'API stellar.expert
- Serveurs MCP : [syronlabs/stellar-mcp](https://github.com/syronlabs/stellar-mcp) (Horizon + Soroban), [Soroban MCP Server](https://glama.ai/mcp/servers/firstJOASH/soroban-mcp-server) (build, deploy, invoke)

## Bonnes pratiques avec l'IA

1. **Commencer par le skill** : `/stellar-dev:smart-contracts écris un contrat d'escrow…`. Le skill impose le bon SDK, la bonne cible Wasm et les bons patterns de stockage et d'authentification.
2. **Vérifier les versions** : la version majeure du SDK doit correspondre au protocole du réseau visé (`stellar network settings --network testnet`).
3. **Tester avant de déployer** : `cargo test` avec `Env::default()` et `mock_all_auths()`.
4. **Relire la sécurité** : `/stellar-dev:smart-contracts` puis `security.md`, qui fournit une checklist d'audit.
