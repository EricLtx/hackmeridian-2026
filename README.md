# Night Window

An on-chain repo contract on Stellar. Holders of tokenized money market funds borrow stablecoins against their shares at any hour, for a fixed term and price, when the fund's redemption window is closed.

Holders keep their whole treasury invested instead of parking idle stablecoin buffers. Lenders earn short-term interest secured by fund shares. Funds become more attractive without having to finance instant liquidity themselves.

> **Status:** scoping is complete; the contract is not implemented yet. The workspace currently holds the `hello-world` sample contract. "Night Window" (French: "Guichet de nuit") is a working name.

## How it works

| Step | Who | What happens |
|---|---|---|
| Offer | Lender | Deposits stablecoins with terms: rate, maximum term, accepted funds |
| Open | Borrower | Locks fund shares and receives stablecoins in the same transaction |
| Repurchase | Borrower | Repays principal plus interest and gets the shares back |
| Default | Lender | After maturity, seizes the shares |
| Withdraw | Lender | Takes back the stablecoins that were not lent |

## Planned design

These choices come from the scoping work and will be fixed in the specification.

- Fixed term of seven days at most and fixed rate; early repurchase allowed, with interest pro rata.
- A haircut per fund caps the loan below the value of the shares.
- Fund shares and stablecoins go through the SEP-41 token interface; the share price comes from a SEP-40 oracle.
- One storage entry per repo and no loop over all positions, so the cost per operation stays constant.
- An administrator holds the registry of accepted funds and can upgrade the code.

## Repository layout

```
.
├── contracts/
│   └── hello-world/         # sample contract, to be replaced by the Night Window contract
├── docs/
│   ├── scoping/             # market study, proposal PDF and its sources (French)
│   ├── stellar-platform.md  # overview of the Stellar platform (French)
│   └── claude-tooling.md    # AI tooling: plugins, skills, MCP (French)
├── .claude/settings.json    # Stellar plugin shared through the repo
├── .mcp.json                # Raven MCP server (Stellar docs and live data)
├── AGENTS.md / CLAUDE.md    # instructions for AI agents
└── Cargo.toml               # Rust workspace (soroban-sdk 28)
```

To add a contract: `stellar contract init . --name my-contract`. It is created in `contracts/my-contract/`.

## Build and test

### 1. Tools

| Tool | Windows | macOS / Linux |
|---|---|---|
| Rust ≥ 1.84 | [rustup.rs](https://rustup.rs) | `curl https://sh.rustup.rs -sSf \| sh` |
| Wasm target | `rustup target add wasm32v1-none` | same |
| Stellar CLI | `winget install --id Stellar.StellarCLI` | `brew install stellar-cli` |

Check with `stellar --version`. The workspace is tested with 28.1.0.

### 2. Compile and test

```sh
cargo test                 # unit tests, run off-chain
stellar contract build     # → target/wasm32v1-none/release/hello_world.wasm
```

### 3. Deploy to testnet

```sh
# Identity funded automatically by Friendbot
stellar keys generate alice --network testnet --fund

stellar contract deploy \
  --wasm target/wasm32v1-none/release/hello_world.wasm \
  --source-account alice --network testnet --alias hello_world

stellar contract invoke --id hello_world --source-account alice --network testnet \
  -- hello --to world
# ["Hello","world"]
```

The deployed contract can be inspected on [stellar.expert/explorer/testnet](https://stellar.expert/explorer/testnet) or in [Stellar Lab](https://lab.stellar.org).

## Documentation

- [docs/scoping/etude-cadrage-idee-contrat.md](docs/scoping/etude-cadrage-idee-contrat.md): market study, idea selection and open hypotheses (French).
- [docs/scoping/proposition-commerciale-guichet-de-nuit.pdf](docs/scoping/proposition-commerciale-guichet-de-nuit.pdf): proposal with the stakeholder and flow diagrams, feasibility and return on investment (French). Its sources are in [docs/scoping/proposition-commerciale/](docs/scoping/proposition-commerciale/).
- [docs/stellar-platform.md](docs/stellar-platform.md): overview of the Stellar platform (French).
- [docs/claude-tooling.md](docs/claude-tooling.md): AI tooling (French).

## Building with AI

The repo is preconfigured for [Claude Code](https://claude.com/claude-code). Open the folder and accept the prompts:

- **`stellar-dev` plugin**, the official Stellar skill: contracts, dApps, assets, data, SEP/CAP standards, agentic payments.
- **`stellar-raven` MCP server**: search in the Stellar docs and queries on live ecosystem data.

Details and alternatives are in [docs/claude-tooling.md](docs/claude-tooling.md).

## License

[MIT](LICENSE)
