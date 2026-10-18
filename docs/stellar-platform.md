# The Stellar platform at a glance

These notes summarize what can be built on Stellar. They were written from the official [`stellar-dev`](https://github.com/stellar/stellar-dev-skill) skill (v1.2.0) and from [developers.stellar.org](https://developers.stellar.org). In Claude Code, each section points to the skill that covers it in detail: `/stellar-dev:<skill>`.

## What Stellar is for

Stellar is an open payment network, fast (about 5 s per ledger) and inexpensive (a fraction of a cent per transaction). Its domain is **payments, stablecoins and tokenized real-world assets**, not speculation. Its users include Circle (native USDC and EURC), MoneyGram (cash-in / cash-out), Société Générale-FORGE (EURCV stablecoin), and fiat anchors in many countries.

## The building blocks

### 1. Smart contracts (formerly "Soroban"): `/stellar-dev:smart-contracts`

- Written in **Rust** (`#![no_std]`, `soroban-sdk` crate) and compiled to **WebAssembly** for the `wasm32v1-none` target.
- Maximum binary size: 128 KB. No I/O, no network: everything goes through `Env`.
- **Rented storage**: every entry has a TTL. Three types exist: `instance`, `persistent` and `temporary`. Without `extend_ttl`, data ends up archived.
- **Native authorization**: `address.require_auth()` works with classic accounts as well as with smart accounts.
- Atomic `__constructor` constructor (CAP-58), `#[contractevent]` events, `#[contracterror]` typed errors.
- Cross-contract reentrancy is blocked by the host, and `delegatecall` does not exist.
- The major version of `soroban-sdk` follows the protocol's. This repo uses **SDK 28 ↔ protocol 28**.

### 2. Assets and stablecoins: `/stellar-dev:assets`

Tokens come in two forms:

| | Stellar Asset (classic) | Contract token (SEP-41) |
|---|---|---|
| Creation | One operation, no code | Rust contract |
| Performance and cost | Optimal | More expensive |
| Business logic | Flags: `auth_required`, `clawback`... | Free-form |
| Access from a contract | Through the **SAC** (Stellar Asset Contract) | Native |

It is better to start from a Stellar Asset and go through the **SAC** to use it from a contract. A custom token is only justified when the logic requires it. On the user side, holding an asset requires a **trustline**.

### 3. Reading the chain: `/stellar-dev:data`

| API | Use | Testnet |
|---|---|---|
| **Stellar RPC** (recommended) | Contracts, simulation, events, transaction submission | `https://soroban-testnet.stellar.org` |
| Horizon (legacy) | Account history, payments, order books | `https://horizon-testnet.stellar.org` |
| Friendbot | Fund a testnet account with XLM | `https://friendbot.stellar.org` |

For historical analytics: Hubble (BigQuery), Galexie, or third-party indexers.

### 4. Frontend and wallets: `/stellar-dev:dapp`

- JS SDK `@stellar/stellar-sdk`. `contract.Client` generates a typed client from a deployed contract, which amounts to the equivalent of `stellar contract bindings typescript`.
- Wallets: **Freighter** (browser extension), **Stellar Wallets Kit** (multi-wallet), **smart accounts with passkeys** (fingerprint login, no seed phrase).

### 5. Standards (SEP / CAP): `/stellar-dev:standards`

| Need | Standard |
|---|---|
| Fungible token | SEP-41 (+ SEP-57 if regulated) |
| Web authentication with a wallet | SEP-10 |
| Fiat deposit / withdrawal through an anchor | SEP-24 (interactive), SEP-6 (API) |
| KYC | SEP-12 |
| Cross-border payment corridors | SEP-31 |
| Upgradable contracts | SEP-49 + CAP-58 (constructors) |
| Passkeys / smart wallets | CAP-51 (secp256r1) |

### 6. Agentic payments: `/stellar-dev:agentic-payments`

These are AI-to-API payments, in USDC:
- **x402** (HTTP 402 Payment Required): a pay-per-request API, without the client needing XLM, since the fees are sponsored by a facilitator. This is the simplest option to start with.
- **MPP** (Machine Payments Protocol): in *Charge* mode, one payment per request; in *Session* mode, off-chain commitments through a payment channel, for agents that send many requests.

### 7. Going further

- **ZK** (`/stellar-dev:zk-proofs`): BLS12-381 verification, Groth16, UltraHonk (Circom, Noir, RISC Zero).
- **Cross-chain** (`/stellar-dev:cross-chain`): CCTP (native USDC), Axelar, LayerZero.

## Web tools

- [Stellar Lab](https://lab.stellar.org): build and sign transactions, explore contracts, check network limits.
- [stellar.expert](https://stellar.expert/explorer/testnet): block explorer (testnet and mainnet).
- [soroban-examples](https://github.com/stellar/soroban-examples): reference contracts (token, escrow, atomic swap, timelock, liquidity pool...).
- [OpenZeppelin Stellar Contracts](https://github.com/OpenZeppelin/stellar-contracts): audited libraries (tokens, access control, pausable, upgradeable).
- [llms.txt](https://developers.stellar.org/llms.txt): the documentation in a format designed for LLMs.

## Project ideas by building block

| Building block | Project examples |
|---|---|
| Stablecoins + anchors | Money transfers between Erasmus students, freelancer payroll in EURC |
| SAC + contract | Escrow for freelance assignments, nonprofit fundraising pool with release rules |
| Passkeys | Seed-phrase-free wallet for first-time users |
| x402 / MPP | Paid API consumed by AI agents, per-request micropayment |
| Regulated assets | Tokenization of event tickets, vouchers or real-world assets |
| ZK | Proof of age or degree without revealing the data |
