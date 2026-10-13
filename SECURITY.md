# Security policy

Open Window (crate `night-window`) is under development. No contract is deployed on mainnet, and testnet deployments hold no real value. The security baseline, threat model and invariants are documented in [docs/securite.md](docs/securite.md) (French).

## Reporting a vulnerability

Please do not open a public issue for a security problem.

1. Use GitHub's private vulnerability reporting on this repository (**Security** tab, **Report a vulnerability**).
2. If that option is unavailable, contact the maintainer through the e-mail address or links on their GitHub profile.

Include what you found, where (file and function, or deployed contract address and network), how to reproduce it, and the impact you expect. A proof of concept against a local test or testnet is welcome; never against a deployment you do not own.

We acknowledge reports within a few days and keep you informed until the issue is fixed. Credit is given in the fix if you want it.

## Scope

In scope:

- the contract code under `contracts/`;
- the build and CI configuration (`Cargo.toml`, `rust-toolchain.toml`, `.github/`);
- any contract address this repository publishes as an official testnet deployment.

Out of scope:

- the Stellar network, the Soroban host, `soroban-sdk` and the Stellar CLI (report to [Stellar's bug bounty](https://immunefi.com/bug-bounty/stellar/));
- third-party tokens and oracles the contract interacts with;
- issues in the git-ignored working documents.

## What the code already enforces

- Every privileged function loads the administrator from storage and requires its authorization.
- Arithmetic must be checked, and failure paths return typed errors; the lints that enforce this are denied at the workspace level.
- Deadlines are stored values compared to the ledger timestamp, never inferred from storage TTLs.
- CI runs formatting, Clippy with the security lints, the tests, the WASM build and a RustSec advisory check, with every third-party action pinned to a commit.
