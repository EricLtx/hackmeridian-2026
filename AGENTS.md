# Agent instructions

This is a Stellar smart-contract workspace (Soroban). Each contract is a workspace member under `contracts/<name>/`.

## Layout

- `Cargo.toml` — workspace root; contract crates inherit `soroban-sdk` from here
- `contracts/<name>/src/lib.rs` — contract implementation (`#![no_std]`)
- `contracts/<name>/src/test.rs` — host-side unit tests

## Build

From the workspace root:

```sh
stellar contract build
```

That compiles every `cdylib` member to WASM. Artifacts land in `target/wasm32v1-none/release/*.wasm`. Build one crate with `stellar contract build --package <name>`.

Do not substitute this with `cargo build --target wasm32v1-none`. `stellar contract build` applies the flags and metadata the network expects.

`rust-toolchain.toml` pins the Rust version, the `wasm32v1-none` target and the `rustfmt` and `clippy` components; rustup installs them on the first `cargo` command. Do not override the toolchain. To bump it, edit that file, rebuild, rerun the tests and say so in the commit.

## Security baseline

Read `docs/security.md` before changing the contract. The enforced rules:

- Workspace lints (`Cargo.toml`, `[workspace.lints]`) deny `unsafe_code`, unchecked arithmetic, `unwrap`, `expect`, `panic!` and slice indexing in contract code. Use `checked_*` arithmetic and return a typed `Error`, or `panic_with_error!`. Tests opt out at the top of `test.rs`; do not opt out in `lib.rs`.
- Every privileged function loads the admin from storage and calls `require_auth` on it. Every `Address` argument whose authority a function consumes gets its own `require_auth` in that function.
- Deadlines live in stored values and are compared to the ledger timestamp, never inferred from a TTL.
- Error codes and exported types are append-only.
- Before finishing a change, run `cargo fmt --all --check`, `stellar contract build`, `cargo clippy --all-targets -- -D warnings` and `cargo test`, in that order. CI runs the same, plus a RustSec advisory check.

## Test

Host tests run with the normal Cargo test harness (not on-chain). Build the WASM first: the upgrade test of `night-window` uploads `target/wasm32v1-none/release/night_window.wasm`, and the test crate does not compile without it (`contracts/night-window/build.rs`).

```sh
stellar contract build
cargo test
```

A single crate: `cargo test -p <name>`.

## Deploy and invoke

On testnet, after a successful build:

```sh
stellar contract deploy \
  --wasm target/wasm32v1-none/release/night_window.wasm \
  --source-account <identity> \
  --network testnet \
  --alias night_window \
  -- --admin <identity>

stellar contract invoke \
  --id night_window \
  --network testnet \
  --source-account <identity> \
  -- version
```

The product contract is `night-window` (`contracts/night-window/`): the Open Window contract, a stablecoin liquidity facility for tokenized fund shares built as a repo. The crate keeps its historical name; the product name is Open Window. Its constructor takes `--admin <address>`, passed after the `--` separator at deploy time. `stellar contract invoke --id <id> -- -h` prints the generated CLI for the deployed contract.

Version 4 is implemented and tested (audit candidate rc4, tag `audit-v4-rc4`, interface frozen on 18 October 2026): the full lifecycle, roles (governor, guardian, steward per fund, optional trustee, sentinel), price checks with a backup feed, deferred share delivery, lenders independent of the fund, a time delay on every upgrade, feed change and loosening (propose, wait, apply by anyone, cancel), a stablecoin registry behind that delay after the first admission, and a stored schema version with a governed `migrate`. Any change to `contracts/` after the tag means a new tag and a new rehearsal. Scripts that change an admitted fund, the guardian, the term ceiling, the envelope, fund limits or a currency cap must handle the proposal: these calls queue the change after bootstrap. Operations extend the contract instance, never its code (decision S20). `contracts/fund-token/` (allowlisted SEP-41 share token) and `contracts/nav-oracle/` (operator-fed SEP-40 feed) exist for the tests and the testnet demo in `demo/`; they are not part of the product. Error codes are public ABI: add new ones, never renumber; `NotImplemented` (code 1) stays reserved.

## Web interface

`web/` is the interface (Vite, plain JavaScript); `.github/workflows/pages.yml` publishes it on GitHub Pages on every push that touches `web/`. Before finishing a change there, run `npm test` and `npm run build` in `web/`. Every visible text is written in English, marked with `t()` and translated in `web/src/locales/fr/` and `web/src/locales/es/`; `npm run check:i18n` and the tests fail on a missing translation.

`web/public/deployment.testnet.json` (written by `demo/` `setup`) and `web/public/history.json` (the indexer's export) are committed and published: public facts only, never a secret or an RPC URL that carries a key. Values read from the chain are untrusted: check them at the boundary in `web/src/chain.js` before they reach the markup. Both pages carry a content security policy; an RPC endpoint added to the deployment file must be added to `connect-src` in `web/index.html` and `web/history.html`.

## Public repository: what stays out

This repository is public. The market study, the business proposal and third-party reference material are working documents kept in `private/` and `references/`, both git-ignored.

- Never add files from `private/` or `references/` to git, and never copy their content (figures, partner or product names, business case, pitch) into tracked files. Tracked documentation describes the product and the code, not the business plan.
- When the functional specification is written, it is the reference for the lifecycle; keep it in `private/` until the maintainer decides otherwise, and keep tracked files limited to what the code needs (interface, invariants, security decisions).
- Do not add event, application or team-administration content.
- `LICENSE` and `NOTICE` name the copyright holder, Jean-Eric Le Texier, at the owner's request: keep that name there and add no other personal data anywhere.

## Network requests made by agents

Any HTTP request an agent or a script sends on the maintainer's behalf (RPC, documentation fetch, web search) uses a generic `User-Agent` that names the tool, never a person. No e-mail address, name or other personal data goes into request headers, URLs, payloads or committed files.

## Further reading

- https://developers.stellar.org/docs/build/smart-contracts/overview
- https://github.com/stellar/soroban-examples
