# Audit package

What an external auditor needs to review Open Window version 4 (audit candidate rc2): the scope, how to rebuild and check the deployed code, the trust model, the invariants, what was already reviewed, and where to look hardest. Prepared on 15 October 2026 for Step 2 of the [roadmap](roadmap.md).

## Scope

| In scope | Path |
|---|---|
| The Open Window contract, version 4 | `contracts/night-window/src/`: `lib.rs`, `storage.rs`, `oracle.rs`, `math.rs`, `token_io.rs`, `types.rs`, `error.rs`, `events.rs` |
| Its host tests, as evidence | `contracts/night-window/src/test.rs` |
| Build configuration | `Cargo.toml`, `rust-toolchain.toml`, `contracts/night-window/Cargo.toml`, `contracts/night-window/build.rs` |

Out of scope: `contracts/fund-token/` and `contracts/nav-oracle/`, which are test doubles of a permissioned share token and an operator NAV feed; `demo/`, `indexer/` and `web/`, which are off-chain tooling; the Stellar network, the Soroban host and `soroban-sdk`. The indexer's journal is outside the contract audit, but its register and reporting views are checkable without trusting it: every line carries a hash chained to the previous one, the chain head is anchored on the ledger, and `verify` recomputes it.

## Build and check the deployed code

The toolchain is pinned (Rust 1.98.1, target `wasm32v1-none`), and the build is reproducible: the same commit gives the same WASM hash on another machine. This was checked on 14 October 2026, when the hash of a local build matched the code hash of the contract deployed on testnet.

```sh
stellar contract build                       # CLI 28.1.0, as in CI
sha256sum target/wasm32v1-none/release/night_window.wasm
cargo test                                   # needs the WASM above: the upgrade test uploads it
```

The hash to compare is the `wasmHash` of the contract instance's executable, as returned by `getLedgerEntries` on the instance key. `demo/monitor.mjs` reads it on every pass and raises a critical alert when it changes.

## Trust model

| Actor | Trusted for | Bounded by |
|---|---|---|
| Governor (a native multisig account) | Registry, risk envelope, stablecoins, caps, upgrades | A time delay of at least the configured `timelock_delay` (48 hours by default, settable until the first admission or the first offer, then only able to grow) on upgrades, feed changes, re-anchoring, a new guardian and every loosening of a limit; the guardian's veto; exits never blocked. The governor handover also waits for the delay, with the guardian's veto. Immediate by design: tightening, `unpause`, the stablecoin registry, lender approvals, unfreezing. Upgrades and forced guardian changes also need the trustee's signature when one is named, and the trustee may veto them and a handover. Cannot make the steward a lender, nor recover a steward except to the issuer's own backup with the guardian, nor choose that backup (it can only cancel a replacement) |
| Guardian | Pausing new entries, cancelling proposals, vetoing a governor handover, co-signing a steward recovery | Cannot move funds, unpause or block an exit; hands its role only to a backup registered with the governor; can be replaced by the governor (with the trustee) through a 30-day forced change it cannot cancel, which the trustee can veto |
| Trustee (optional, named before the first admission) | Independent consent to upgrades and forced guardian changes; vetoing them and a governor handover | Can hold no other role (checked both ways: no role, backup or proposed governor may name it); cannot propose anything; replaces only itself, with the successor's signature, which drops what it had co-signed; cannot be removed, so a lost trustee key ends upgrades for good, by design |
| Steward of a fund (its issuer) | Attesting and approving lenders, tightening its fund, co-signing admission, replacement, backup feed and re-anchoring, naming its own backup | Can never lend against its fund; loosening its own limits waits for the delay; cannot raise its NAV reference; its approvals end with its tenure (a lender needs the current steward's approval for a new offer or loan; a seized position stays deliverable); replacing its backup waits for the delay |
| NAV and FX feeds | Prices | Freshness, a corridor around a model path, an FX band, haircuts, caps; a backup feed must agree within a tolerance |
| Share token (issuer) | Holding and moving shares | A refused transfer at repurchase or seizure defers the delivery instead of blocking the exit |
| Borrowers, lenders, anyone | Their own positions; applying due proposals; refreshing the reference along the model; releasing held-back shares | Every write checks their signature or acts only on stored data |

## Invariants the tests check

- **I1:** the contract's stablecoin balance is at least the sum of what the offers hold available; each currency's outstanding total equals the sum of open principals in that currency.
- **I2:** for each fund, the shares the contract holds equal the shares of open repos plus the shares awaiting release.
- An open repo's terms never change after opening.
- `open_repo` touches a constant number of ledger entries: 16 read and 9 written, or 18 read with a backup feed configured. The test host asserts this over 200 repos.
- Every error path is reachable and typed; every privileged function refuses an intruder; every state change emits an event, compared in XDR.

`invariants_hold_over_random_sequences` runs 300 random operations and checks the accounting after each one.

## Reviews already done

| Date | Review | Outcome |
|---|---|---|
| 14 October 2026 | Independent review of version 2 | Every finding fixed with a test, or recorded as a decision |
| 14 October 2026 | Scout (CoinFabrik) 0.3.17 on version 2 | 2 medium and 23 enhancement alerts, all false positives, justified in [securite.md](securite.md), section 7 |
| 15 October 2026 | Independent review of version 3, first pass | 2 high, 3 medium, 9 low; all fixed with tests |
| 15 October 2026 | Second pass on the fixes | 3 medium, 8 low; all fixed with tests, one recorded (L7, no migration needed) |
| 15 October 2026 | Targeted pass on the re-anchoring round | No exploitable finding; 3 low and 2 informational items fixed with tests (signed values, feeds bound to the proposal, model-based apply check, pricing rule for the reading) |
| 15 October 2026 | Independent review of version 4 | 1 high (steward recovery could capture a live issuer's fund), 5 medium, 4 low; all fixed with tests |
| 15 October 2026 | Targeted pass on the version 4 fixes | No critical or high; 2 medium (the steward's backup now co-signs and accepts the role; two version-4 types reshaped before release, so instances are redeployed rather than upgraded) and 3 low, fixed with tests |
| 15 October 2026 | Independent review of audit candidate rc2 (trustee, approvals bound to the current steward, delayed replacement of a steward backup) | No critical or high; 2 medium (an upgrade co-signed by a replaced trustee survived the hand-over; approvals of a replaced steward still backed new loans on existing offers), 3 low, 7 informational; all fixed with tests. An approval now stores the steward that granted it, which is a stored-value change: instances are redeployed rather than upgraded |

None of these is a substitute for an external audit: the reviews were internal, made with AI agents, and the reviewers saw the same documents as the authors.

## Where to look hardest

0. **Lender independence and custody (version 4).** The steward must never lend against its fund by any path; a sole-lender instance must accept no other lender; a governor handover, a guardian handover and a steward recovery must each need the keys and delays documented in the trust model. **Trustee (rc2):** no upgrade and no forced guardian change may be proposed or applied without the trustee's signature when one is named; nothing may name the trustee to another role or make the role vanish; a hand-over must leave nothing the previous trustee co-signed.
1. **Time delay and proposals.** Every loosening, upgrade, feed change, guardian replacement and re-anchor is a proposal applied by anyone within `[eta, eta + 7 days]`. Check that no path applies a change without its delay, that a tightening always wins over an older pending loosening, and that a governor change drops the governor's proposals.
2. **Reference anchoring.** The NAV and FX references decide what a share is worth. Only two paths may move them beyond the model: admission and the two-key re-anchor, which installs the readings signed at proposal. Check every other path: replacement, re-admission, backup feed, refresh, reset.
3. **Deferred release.** `repurchase` and `seize` settle the debt even when the share token refuses the transfer, and record the shares owed. Check that the shares can only reach the recorded beneficiary, once, and that invariant I2 holds on every path.
4. **Backup feed.** It may only stand in for a stale or reverting primary, must agree with a fresh primary within `max_divergence_bps`, and goes through the same corridor. Check the rescaling and rounding of the comparison.
   **FX leg (rc3):** the FX band of a cross-priced fund may not exceed its FX haircut (`FxBandExceedsHaircut`), so a rate inside the band stays covered. Check that no admission or replacement path skips `check_fund_config`, and that the NAV side keeps the same property through the envelope (`min_haircut_bps` 100 against a worst-case corridor rise of 58 bps over `max_nav_age_secs`).
5. **Storage and rent.** Operations extend the contract instance but never the code entry; the operator extends the code (decision recorded in `storage::bump_instance`). Check that no user-triggered path pays rent on a large entry, and that every persistent entry an exit depends on is extended when it is written or refused.

## Known limits

- The NAV base of an admitted fund cannot change by replacement: a feed in other units cannot lie on the old corridor. It needs removal, re-admission (`set_fund`), a re-anchor proposal signed by the governor and the steward on the new feed, then `apply_fund_change` (test `readmission_off_the_path_goes_through_a_reanchor`).
- A guardian can be replaced by the governor alone through a 30-day forced change: this keeps governance alive if the guardian key is lost, and gives 30 public days to react if the governor key is compromised.
- The guardian alone may remove a backup feed. The contract then fails closed when the primary is stale.
- Amounts and counterparties are public on chain.
- One release record per repo; the beneficiary may redirect it, never to the contract itself.

## Contact

Report a vulnerability as described in [SECURITY.md](../SECURITY.md).
