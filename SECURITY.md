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

- Every privileged function loads its role (governor, guardian, or the fund's steward) from storage and requires its authorization; a fund is admitted only with both the governor's and the steward's signatures.
- Every function that consumes a party's authority requires that party's signature; repurchase and seizure load the parties from the stored repo, never from arguments.
- The emergency pause blocks only new offers and new repos; repurchase, withdrawal and seizure always work.
- Prices come only from the feeds fixed at a fund's admission, are refused when stale, and must lie inside a model-based corridor; caps per repo, per fund and per currency bound the exposure.
- Arithmetic must be checked, and failure paths return typed errors; the lints that enforce this are denied at the workspace level.
- Deadlines are stored values compared to the ledger timestamp, never inferred from storage TTLs.
- CI runs formatting, Clippy with the security lints, the tests, the WASM build and a RustSec advisory check, with every third-party action pinned to a commit.

## Bug bounty

A paid bug bounty is in preparation and will open before any deposit of real value. Until it opens, reports go through private vulnerability reporting as described above, and credit is given in the fix. The rules below are the ones the paid programme will apply; reward amounts are published when it opens.

**In scope:** the Open Window contract under `contracts/night-window/` at the commit tagged for audit, and any contract address this repository publishes as an official deployment.

**Severity:**

| Level | Examples |
|---|---|
| Critical | Theft or permanent freezing of stablecoins or fund shares held by the contract; a loan above the haircut-adjusted value of its collateral; applying a governance change without its time delay |
| High | Blocking a repurchase, a withdrawal or a seizure that should succeed; moving a fund's price reference without the two signatures; bypassing the guardian's veto |
| Medium | Griefing that costs users fees or rent without stealing funds; accounting drift that breaks an invariant without a direct loss |
| Low | Incorrect events, misleading errors, issues with no impact on funds |

**Out of scope:** the test contracts `fund-token` and `nav-oracle`, `demo/`, `web/`, third-party tokens and price feeds, the Stellar network and Soroban host (see Stellar's own programme), attacks that need a compromised governor and guardian together, front-running of public transactions, and denial of service by spamming the network.

**Rules:** test only against a local host or your own testnet deployment, never against a deployment you do not own; do not access or move other people's funds; give us reasonable time to fix before any disclosure. Research done in good faith under these rules will not lead to legal action from the maintainers.
