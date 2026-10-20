# Audit package

What an external auditor needs to review Open Window version 4: the scope, how to rebuild and check the code, the trust model, the invariants, what was already reviewed, and where to look hardest. Prepared on 15 October 2026 for Step 2 of the [roadmap](roadmap.md); updated on 18 October 2026 for rc4, and on 20 October 2026 for the rc5 candidate.

**What runs, and what is reviewed.** The testnet instance runs rc4 (tag `audit-v4-rc4` on commit `a85515f`, executable `f5f13ae6…`), upgraded from rc2 and migrated under governance on 18 October 2026. The candidate for review is rc5: the fixes of the security pass of 20 October 2026. It keeps the interface of rc4 (entry points, their types, error codes) and its storage layout (`SCHEMA_VERSION` 2, so the upgrade to it needs no `migrate`), and appends one event, `RepoValued`. It becomes the tag `audit-v4-rc5` after an adversarial review that runs now, then a governed upgrade of the testnet instance. The figures of the candidate, measured on commit `9804c17` on 20 October 2026 with the pinned toolchain and Stellar CLI 28.1.0:

| rc5 candidate | |
|---|---|
| `night_window.wasm` | 102,779 bytes (CI budget 122,880) |
| sha256 | `a4062abac12f6d0c158d8228b84be759be55a0537b2dff1784376807e3b6b62a` |
| Rust host tests | 286 passed: `night-window` 243, `fund-token` 28, `nav-oracle` 15 |

## Scope

| In scope | Path |
|---|---|
| The Open Window contract, version 4 | `contracts/night-window/src/`: `lib.rs`, `storage.rs`, `oracle.rs`, `math.rs`, `token_io.rs`, `types.rs`, `error.rs`, `events.rs` |
| Its host tests, as evidence | `contracts/night-window/src/test.rs`, `test_math.rs` (property tests of the arithmetic), `test_perf.rs` (the real-time profile on the release WASM), and `tests/fixtures/night_window_rc2.wasm`, the rc2 code deployed on testnet, which the migration test upgrades and migrates with a repo open |
| Build configuration | `Cargo.toml`, `rust-toolchain.toml`, `contracts/night-window/Cargo.toml`, `contracts/night-window/build.rs` (the 64 KiB stack and the WASM test mode, decision S34) |

Out of scope: `contracts/fund-token/` and `contracts/nav-oracle/`, which are test doubles of a permissioned share token and an operator NAV feed; `demo/`, `indexer/` and `web/`, which are off-chain tooling; the Stellar network, the Soroban host and `soroban-sdk`. The indexer's journal is outside the contract audit. Its hash chain and its anchor on the ledger prove that no line changed after it was written, not that the events are true: since rc5, `npm run verify -- --against <url>` compares the journal both ways and by content with an endpoint other than the one the indexer read.

## Build and check the deployed code

The toolchain is pinned (Rust 1.98.1, target `wasm32v1-none`), and the build is reproducible: the same commit gives the same WASM hash on another machine. This was checked on 14 October 2026, when the hash of a local build matched the code hash of the contract deployed on testnet.

```sh
stellar contract build                       # CLI 28.1.0, as in CI
sha256sum target/wasm32v1-none/release/night_window.wasm
cargo test                                   # needs the WASM above: the upgrade test uploads it
```

The hash to compare is the `wasmHash` of the contract instance's executable, as returned by `getLedgerEntries` on the instance key. `demo/monitor.mjs` reads it on every pass and raises a critical alert when it changes. Until the governed upgrade to rc5, that executable is rc4's (`f5f13ae6…`), not the candidate's.

The CI job `wasm-canary` also runs the whole contract suite against a WASM linked with an 8 KiB stack instead of 64 KiB (WASM test mode, [AGENTS.md](../AGENTS.md#test)): a change that deepens the stack fails there long before it nears the shipped margin.

## Trust model

| Actor | Trusted for | Bounded by |
|---|---|---|
| Governor (a native multisig account) | Registry, risk envelope, stablecoins, caps, upgrades | A time delay of at least the configured `timelock_delay` (48 hours by default, settable until the first admission or the first offer, then only able to grow) on upgrades, feed changes, re-anchoring, a new guardian, a stablecoin registration and every loosening of a limit; the guardian's veto; exits never blocked by the pause. Since rc5 an upgrade proposed during bootstrap goes at the first admission, so the delay in force holds for every upgrade once value is at stake, and a stablecoin registration applies only with the governor in office. The governor handover also waits for the delay, with the guardian's veto. Immediate by design: tightening, `unpause`, the removal of a stablecoin, lender approvals, unfreezing. Upgrades and forced guardian changes also need the trustee's signature when one is named, and the trustee may veto them and a handover. Cannot make the steward a lender, nor recover a steward except to the issuer's own backup with the guardian, nor choose that backup (it can only cancel a replacement) |
| Guardian | Pausing new entries, cancelling proposals, vetoing a governor handover, co-signing a steward recovery | Cannot move funds, unpause or block an exit; hands its role only to a backup registered with the governor; can be replaced by the governor (with the trustee) through a 30-day forced change it cannot cancel, which the trustee can veto |
| Sentinel (optional, named by the guardian) | Pausing new entries, cancelling proposals | Cannot veto, lift a pause, propose, hand over or back up a role; holds no other role and, since rc5, is no proposed governor or guardian, checked both ways; the guardian or the governor removes it |
| Trustee (optional, named before the first admission) | Independent consent to upgrades and forced guardian changes; vetoing them and a governor handover | Can hold no other role (checked both ways: no role, backup or proposal may name it; since rc5 it is no proposed guardian and not the sentinel either); cannot propose anything; replaces only itself, with the successor's signature, which drops what it had co-signed; cannot be removed, so a lost trustee key ends upgrades for good, by design |
| Steward of a fund (its issuer) | Attesting and approving lenders, tightening its fund, co-signing admission, replacement, backup feed and re-anchoring, naming its own backup | Can never lend against its fund, nor receive seized shares; loosening its own limits waits for the delay; cannot raise its NAV reference; its approvals end with its tenure (a lender needs the current steward's approval for a new offer or loan; a position opened under an earlier approval stays deliverable); since rc5 a revocation stops new offers and loans but not a seizure, whose shares then wait for an approval or a redirection; replacing its backup waits for the delay |
| NAV and FX feeds | Prices | Freshness; at least 6 decimals (rc5); a corridor around a model path, whose growth stops at one NAV age and which the fund's haircut must cover (rc5); an FX band no wider than the FX haircut, the rate taken on the lender's side of it (rc5); caps. A backup feed is never the primary, is installed only against a fresh primary it agrees with (rc5), and must agree with the primary whenever both are fresh |
| Share token (issuer) | Holding and moving shares | A refused transfer at repurchase or seizure defers the delivery instead of blocking the exit |
| Stablecoin (issuer) | Holding and moving the cash leg | 7 decimals only (rc5). Nothing in the contract bounds a freeze: the repurchase in that coin fails while the seizure stays open, and withdrawals in it fail (threat model DoS.8, open, an interface change for version 2); the monitor watches each stablecoin's authorization of the contract |
| Borrowers, lenders, anyone | Their own positions; applying due proposals (a stablecoin registration excepted since rc5); refreshing the reference along the model; releasing held-back shares | Every write checks their signature or acts only on stored data |

## Invariants the tests check

- **I1:** the contract's stablecoin balance is at least the sum of what the offers hold available; each currency's outstanding total equals the sum of open principals in that currency.
- **I2:** for each fund, the shares the contract holds equal the shares of open repos plus the shares awaiting release. The tests check equality; in operation a transfer from outside a repo can only add a surplus, which no function moves out.
- An open repo's terms never change after opening.
- `open_repo` touches a constant number of ledger entries: 16 read and 9 written, or 18 read with a backup feed configured. The test host asserts this over 200 repos.
- Every error path is reachable and typed; every privileged function refuses an intruder; every state change emits an event, compared in XDR (since rc5 the events of `open_repo` too: `RepoOpened`, `RepoValued`, `ReferenceUpdated`).
- Every user-facing call stays within a real-time budget on the release WASM: 12 million instructions, 12 entries written, 8,192 bytes written and 2,048 bytes of events (`test_perf_profile`, rc5).

`invariants_hold_over_random_sequences` runs 300 random operations and checks the accounting after each one.

## Reviews already done

| Date | Review | Outcome |
|---|---|---|
| 14 October 2026 | Independent review of version 2 | Every finding fixed with a test, or recorded as a decision |
| 14 October 2026 | Scout (CoinFabrik) 0.3.17 on version 2 | 2 medium and 23 enhancement alerts, all false positives, justified in [security.md](security.md), section 7 |
| 15 October 2026 | Independent review of version 3, first pass | 2 high, 3 medium, 9 low; all fixed with tests |
| 15 October 2026 | Second pass on the fixes | 3 medium, 8 low; all fixed with tests, one recorded (L7, no migration needed) |
| 15 October 2026 | Targeted pass on the re-anchoring round | No exploitable finding; 3 low and 2 informational items fixed with tests (signed values, feeds bound to the proposal, model-based apply check, pricing rule for the reading) |
| 15 October 2026 | Independent review of version 4 | 1 high (steward recovery could capture a live issuer's fund), 5 medium, 4 low; all fixed with tests |
| 15 October 2026 | Targeted pass on the version 4 fixes | No critical or high; 2 medium (the steward's backup now co-signs and accepts the role; two version-4 types reshaped before release, so instances are redeployed rather than upgraded) and 3 low, fixed with tests |
| 20 October 2026 | Security pass over rc4 (unchanged), its RPC path, the web interface and the tooling: eight lenses and the 2025-2026 attack landscape | 50 findings; the web and the tooling hardened the same day; the contract's findings recorded with their planned fixes in [threat-model-stride.md](threat-model-stride.md#32-security-pass-of-20-october-2026), none fixed in rc4 |
| 15 October 2026 | Independent review of audit candidate rc2 (trustee, approvals bound to the current steward, delayed replacement of a steward backup) | No critical or high; 2 medium (an upgrade co-signed by a replaced trustee survived the hand-over; approvals of a replaced steward still backed new loans on existing offers), 3 low, 7 informational; all fixed with tests. An approval now stores the steward that granted it, which is a stored-value change: instances are redeployed rather than upgraded |
| 20 October 2026 | The rc5 candidate: the fixes of the security pass, in the contract, the web and the tooling, each with its tests; an adversarial review of the merged candidate runs now | In the contract, DoS.7, Tamper.6 to Tamper.10, Repud.3 and Elev.6 fixed, with the bootstrap upgrade and the two-way independence of the trustee and the sentinel (decisions S30 to S34 and amendments in [security.md](security.md)); DoS.8 and Elev.5 left for an interface change ([threat model](threat-model-stride.md#32-security-pass-of-20-october-2026)) |

None of these is a substitute for an external audit: the reviews were internal, made with AI agents, and the reviewers saw the same documents as the authors.

## Where to look hardest

0. **Lender independence and custody (version 4).** The steward must never lend against its fund by any path; a sole-lender instance must accept no other lender; a governor handover, a guardian handover and a steward recovery must each need the keys and delays documented in the trust model. **Trustee (rc2):** no upgrade and no forced guardian change may be proposed or applied without the trustee's signature when one is named; nothing may name the trustee to another role or make the role vanish; a hand-over must leave nothing the previous trustee co-signed. **Independence (rc5):** the trustee and the sentinel are checked against every other role both ways, proposed roles included; `accept_admin` and `apply_forced_guardian_change` do not check again (only a proposal made under rc4 could need it).
1. **Time delay and proposals.** Every loosening, upgrade, feed change, guardian replacement and re-anchor is a proposal applied by anyone within `[eta, eta + 7 days]`. Check that no path applies a change without its delay, that a tightening always wins over an older pending loosening, and that a governor change drops the governor's proposals, a stablecoin registration excepted, which only the governor in office applies (rc5). Since rc5 the first admission drops a handover and an upgrade proposed during bootstrap.
2. **Reference anchoring.** The NAV and FX references decide what a share is worth. Only two paths may move them beyond the model: admission and the two-key re-anchor, which installs the readings signed at proposal. Check every other path: replacement, re-admission, backup feed, refresh, reset. Since rc5 the corridor grows over at most one NAV age after the reference (S30): check that no path grants more, `carry_nav_reference` included, and that `check_fund_config` refuses a haircut below two floors plus that growth on every admission, replacement and limits path.
3. **Deferred release.** `repurchase` and `seize` settle the debt even when the share token refuses the transfer, and record the shares owed. Check that the shares can only reach the recorded beneficiary, once, and that invariant I2 holds on every path. Since rc5 a seizure by a revoked lender of record settles and defers the delivery (S8): check that seized shares reach only an approved holder, never the steward, through `release` and `redirect_release`.
4. **Backup feed.** It may only stand in for a stale or reverting primary, must agree with a fresh primary within `max_divergence_bps`, and goes through the same corridor. Since rc5 it is never the primary itself, and it is installed only against a fresh primary it agrees with. Check the rescaling and rounding of the comparison.
   **FX leg (rc3, rc5):** the FX band of a cross-priced fund may not exceed its FX haircut (`FxBandExceedsHaircut`), and since rc5 the NAV is divided by the higher of the rate and the reference (`oracle::value`, S22), so an admitted rate overvalues the shares by at most the market's move above the reference while the market stays inside the band. Check that no admission or replacement path skips `check_fund_config`, and that `quote` and `open_repo` price alike. **Precision (rc5):** feeds of at least 6 decimals on every path that installs one (S32), bounds rounded inward, `math::share_value` without overflow, stablecoins of 7 decimals (S31).
6. **rc4 additions.** Schema version: `create_offer` and `open_repo` must refuse while the stored layout is behind the code (`SchemaOutdated`), every exit must keep working, `migrate` must need the governor and the trustee and refuse when nothing is to migrate. Sentinel: it may pause and cancel any proposal, never veto, lift a pause or decide; it must be independent of every other role; the guardian names it, the guardian or the governor removes it. Stablecoin registry: after the first admission a registration or a currency change is a proposal behind the delay, cancellable by the governor, the guardian or the sentinel, applied by the governor in office (rc5), dropped by the removal of a registered token, expiring like every proposal; before the first admission it applies at once. The embedded spec was trimmed: check that the long-form text in [interface-reference.md](interface-reference.md) matches the code, since tools and bindings now see one-sentence doc comments.
5. **Storage and rent.** Operations extend the contract instance but never the code entry; the operator extends the code (decision recorded in `storage::bump_instance`). Check that no user-triggered path pays rent on a large entry, and that every persistent entry an exit depends on is extended when it is written or refused. The monitor keeps the code entry above 90 days (S20, rc5).

7. **The rc5 fixes of the security pass of 20 October 2026** ([threat-model-stride.md](threat-model-stride.md#32-security-pass-of-20-october-2026)). The seizure after a steward revocation (DoS.7, S8), the FX leg on the lender's side of its band (Tamper.6, S22), the corridor's growth window and its haircut cover (Tamper.7, S30), one precision per currency (Tamper.8, S31), feed precision, inward rounding and the split share value (Tamper.9, S32), the valuation recorded per loan (Repud.3, S33), the 64 KiB stack (S34), the backup feed as a second source (Tamper.10), the stablecoin registration of a replaced governor (Elev.6), the bootstrap upgrade, and the two-way independence of the trustee and the sentinel. Check each against its tests and the residual risks the threat model lists. Still open: a stablecoin freeze on the cash leg (DoS.8) and clawback borne by the pooled position (Elev.5), both an interface change, and the restore of an archived code entry on mainnet (DoS.9).

## Known limits

- The NAV base of an admitted fund cannot change by replacement: a feed in other units cannot lie on the old corridor. It needs removal, re-admission (`set_fund`), a re-anchor proposal signed by the governor and the steward on the new feed, then `apply_fund_change` (test `readmission_off_the_path_goes_through_a_reanchor`).
- A guardian can be replaced by the governor alone through a 30-day forced change: this keeps governance alive if the guardian key is lost, and gives 30 public days to react if the governor key is compromised.
- The guardian alone may remove a backup feed. The contract then fails closed when the primary is stale.
- Amounts and counterparties are public on chain.
- One release record per repo; the beneficiary may redirect it, never to the contract itself.
- After a revocation followed by `remove_fund`, seized shares wait in the contract until a re-admission, or until the lender redirects them to a holder approved before the removal; a recovery path for a removed fund is left to version 2.
- A stablecoin freeze on the contract or on a borrower blocks the repurchase in that coin while the seizure stays open (DoS.8, version 2).
- A backup feed's divergence tolerance is capped by the envelope's corridor floor, not by the fund's own.

## Contact

Report a vulnerability as described in [SECURITY.md](../SECURITY.md).
