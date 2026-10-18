# AI tooling: Claude marketplaces, skills and MCP servers

This document lists what exists for developing Stellar smart contracts with Claude Code. The survey dates from 5 October 2026.

## What is preconfigured in this repo

When the folder is opened, Claude Code offers to install the following tools. Just accept.

| Tool | File | Role |
|---|---|---|
| **`stellar-dev`** plugin (official, [stellar/stellar-dev-skill](https://github.com/stellar/stellar-dev-skill)) | `.claude/settings.json` | 8 skills: `smart-contracts`, `dapp`, `assets`, `data`, `standards`, `agentic-payments`, `zk-proofs`, `cross-chain` |
| **`stellar-raven`** MCP ([raven.stellar.buzz](https://raven.stellar.buzz/playground)) | `.mcp.json` | `search` across the Stellar docs and the ecosystem, `execute` to query live data |

Manual installation, outside this repo:

```sh
claude plugin marketplace add stellar/stellar-dev-skill
claude plugin install stellar-dev@stellar-dev
claude mcp add --transport http stellar-raven "https://raven.stellar.buzz/mcp"
```

For another agent (Cursor, Codex, VS Code), see [Building with AI](https://developers.stellar.org/docs/build/building-with-ai). The skills can also be browsed without installation at [skills.stellar.org](https://skills.stellar.org).

## The marketplaces already configured

| Marketplace | Smart-contract-related content | Useful for Stellar? |
|---|---|---|
| `claude-plugins-official` (Anthropic) | `circle-skills` (USDC, wallets, Circle Smart Contract Platform), `rust-analyzer-lsp`, `solidity-lsp` | `rust-analyzer-lsp`: **yes** (contracts in Rust). `circle-skills`: partially (USDC and EURC exist on Stellar, but the skills mostly target the EVM). |
| `claude-code-workflows` (wshobson/agents) | `blockchain-web3`: Solidity, DeFi, NFT, web3-testing | No: EVM and Solidity only. DeFi concepts remain transferable. |
| `anthropic-agent-skills`, `claude-code-skills`, `impeccable` | Nothing blockchain-specific | - |
| Anthropic Directory (claude.ai) | Crypto analysis (markets, ETFs) | No: we do not do speculation. |

Conclusion: no preinstalled marketplace covers Stellar. The official **`stellar/stellar-dev-skill`** marketplace is the reference. It can be complemented with `rust-analyzer-lsp`:

```sh
claude plugin install rust-analyzer-lsp@claude-plugins-official
```

## Community alternatives (unverified)

To be used only as a complement and after reviewing the code, since these are third-party sources:

- [kaankacar/stellar-plugin](https://github.com/kaankacar/stellar-plugin): Claude Code plugin for Stellar development
- [rawritude/stellar-expert-skills](https://awesomeclaudeplugins.com/rawritude/stellar-expert-skills): queries against the stellar.expert API
- MCP servers: [syronlabs/stellar-mcp](https://github.com/syronlabs/stellar-mcp) (Horizon + Soroban), [Soroban MCP Server](https://glama.ai/mcp/servers/firstJOASH/soroban-mcp-server) (build, deploy, invoke)

## Good practices with AI

1. **Start with the skill**: `/stellar-dev:smart-contracts write an escrow contract...`. The skill enforces the right SDK, the right Wasm target and the right storage and authentication patterns.
2. **Check the versions**: the SDK major version must match the protocol of the target network (`stellar network settings --network testnet`).
3. **Test before deploying**: `cargo test` with `Env::default()` and `mock_all_auths()`.
4. **Review security**: `/stellar-dev:smart-contracts` then `security.md`, which provides an audit checklist.
