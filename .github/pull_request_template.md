## Summary

<!-- What changes, and why. One paragraph. -->

## Areas touched

- [ ] contract (`contracts/`, `Cargo.*`, `rust-toolchain.toml`, `deny.toml`)
- [ ] signing web (`web/src/chain.js`, `wallet.js`, `deployment.js`, the deployment file, `web/package*.json`, `vite.config.js`)
- [ ] content security policy (`web/*.html`)
- [ ] operator signing (`demo/*.mjs`)
- [ ] CI (`.github/`)
- [ ] documentation only

## Critical-path checklist

Needed when any box above except "documentation only" is ticked. CI posts the same list for the areas it detects.

- [ ] The review rules of [`docs/security.md` §7](https://github.com/EricLtx/hackmeridian-2026/blob/main/docs/security.md#7-toolchain-and-review-process) were applied to every changed privileged function and stored value.
- [ ] No change under `contracts/` without a new tag and a new testnet rehearsal (`AGENTS.md`).
- [ ] Values read from the chain are checked in `web/src/chain.js` before they reach the markup; the deployment file is checked in `web/src/deployment.js`.
- [ ] The content security policy is the same on every page, and `connect-src` lists every RPC endpoint of the deployment file.
- [ ] Workflows: every action pinned to a full commit SHA, least-privilege `permissions`, `persist-credentials: false`, no `pull_request_target`, no `${{ }}` inside `run:`.
- [ ] Nothing from `private/` or `references/`, and no personal data, in the diff (`AGENTS.md`, "What stays out"; `SECURITY.md`).

## Local checks

```sh
cargo fmt --all --check && stellar contract build && cargo clippy --all-targets -- -D warnings && cargo test
cd web && npm test && npm run check:i18n && npm run build
cd demo && npm test
```
