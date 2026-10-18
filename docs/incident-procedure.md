# Incident procedure

This document says who acts, how and within what time when Open Window's monitoring raises an alert. It complements the monitoring plan of [threat-model-stride.md](threat-model-stride.md), section 3.1, and decisions S6, S7 and S17 of [security.md](security.md). Version of 14 October 2026, testnet deployment.

## 1. Roles

| Role | Holds | Can | Cannot |
|---|---|---|---|
| Incident lead | The decision | Declare the incident, choose the action, communicate | Act alone with a key it does not hold |
| Guardian | The `guardian` key | Suspend entries (`pause`), cancel a proposal, hand its role over to its backup, veto a handover, name the sentinel | Lift the pause; block an exit |
| Sentinel (rc4) | The monitoring host's key, named by the guardian | Suspend entries, cancel a proposal | Lift the pause; veto; hand over or back up a role; propose anything |
| Governor | The `governor` key, a native multisig account (2 of 2 on testnet, target 2 of 3 on hardware with one outside signer) | Lift the pause, remove a fund, propose an upgrade or a loosening, replace the guardian alone after 30 days | Touch an open repo; apply anything before the delay |
| Steward of a fund | The fund's key | Freeze its fund, revoke a lender, lower the reference | Act on another fund |
| Price operator | The NAV feed's key | Republish a NAV | Modify the contract |

Rule: the pause is the first move, because it never blocks an exit. Repurchase, withdrawal of the unlent part and seizure at maturity remain available throughout the incident.

## 2. Detection

The monitoring runs continuously:

```sh
cd demo
npm run monitor -- --watch --act
```

One pass every 30 seconds. `--act` sets the pause on a critical price or reconciliation alert, cancels any unannounced upgrade proposal, and extends the entries near archival (the contract code in 30-day steps, decision S20). A planned upgrade is announced first: `npm run monitor -- --announce=<hash>`. Every alert is appended to `demo/.state/alerts.jsonl`.

| Level | Reaction time | Examples |
|---|---|---|
| Critical | Automatic pause or cancellation, incident lead reached within 15 minutes | Price refused by the contract, share reconciliation gap (I2), shares held back by the issuer, unannounced upgrade proposal, contract code changed, archived entry |
| Warning | Review before the proposal falls due | Pending proposal (fund, backup feed, re-anchor, guardian, envelope, limits, cap), privileged change, pause in progress, cap 80 % used, NAV two hours from its age bound, entry less than 14 days from archival (lender approvals included), exchange rate unchanged for more than 60 hours, NAV unchanged for more than 72 hours, keeper float below one month of rent |

Each detector runs per admitted fund: with two funds, an alert carries the name of the fund concerned.

Robustness of the monitoring itself: `STELLAR_RPC_URLS` lists several RPCs tried in order (the public RPC answered "account not found" on an existing account three times in thirteen hours on 17 October 2026); `HEARTBEAT_URL` sends a heartbeat after every successful pass to an external service that alerts when the monitoring stops; a failed pass is logged and replayed thirty seconds later.

## 3. What to do for each alert

| Alert | Probable cause | Immediate action | Back to normal |
|---|---|---|---|
| Price refused (`PriceOutOfBand`, `StalePrice`) | NAV feed faulty or silent; FX rate outside the band | Pause by the guardian | The operator republishes the right value; if the FX rate has drifted durably, new two-key admission; then the governor lifts the pause |
| Reconciliation gap (I2) | Freeze or clawback of the shares by the issuer; bug | Pause; contact the issuer | Gap explained and settled; decision S9 if repos are affected |
| Unannounced upgrade proposal | Governor keys compromised | Cancellation by the guardian (automatic with `--act`), pause, rotation of the multisig signers | New keys in place; any remaining proposal cancelled |
| Pending proposal | Administration or steward operation | A second signer checks that it was planned before it falls due | None if planned; otherwise cancellation by the guardian or the steward |
| Shares held back (`ReleaseDeferred`) | The issuer freezes the contract or removes a beneficiary from its allowlist | Contact the issuer; the debt is already settled | Freeze lifted, then `release` by anyone; the beneficiary can redirect |
| Code changed | Upgrade applied | Check that it had been announced and that the delay has elapsed | Review of the deployed WASM against the published code (`docs/audit-scope.md`) |
| Governor handover proposed or done (`admin_proposed`, `admin_changed`) | Planned change of signers, or compromised keys | Check with each signer; if unplanned, guardian veto (`veto_admin`, automatic with `--act`) during the delay, then key rotation | New signers confirmed |
| Steward recovery proposed (`steward_recovery_proposed`) | Steward key lost, or attempt to capture the fund | Warn the issuer: any action signed with its key cancels the procedure | The issuer's backup key installed after 30 days, or procedure cancelled |
| Forced guardian change (`guardian_change_forced`) | Guardian lost, or governor compromised | Check; if unplanned, treat as a key compromise: 30 days to react | Guardian confirmed or change cancelled by the legitimate governor |
| Privileged change | Administration operation | A second signer checks that it was planned | None if planned; otherwise treat as a key compromise |
| Entry near archival | TTL not extended | Extension (automatic with `--act`) | Entry back above the threshold |
| Cap at 80 % or abnormal pace of openings | Real usage or probing | Review; pause if unexplained | Caps revised by the steward or the governor |
| Exchange rate unchanged for more than 60 hours | Currency market closed (long weekend, public holiday); frozen feed | Check that the market is closed; the exposure stays bounded by the FX band and haircut (S22 to come: band ≤ haircut); pause if the feed is frozen on a trading day | The rate moves at reopening; otherwise fail over to the backup feed (`setup -- --fx=local` in the demo) |
| Keeper float below the threshold | Rent paid without top-up | Top up from the treasury (the keeper has no role in the contract) | Balance back above one month of rent |
| Schema behind the code (rc4) | Upgrade applied without `migrate` | Governor and trustee run `migrate` (`npm run upgrade -- --apply`); entries answer `SchemaOutdated`, exits continue | `schema_version` equal to the expected version |
| Unannounced stablecoin proposal (rc4) | Governor keys compromised, or announcement forgotten | Cancellation by the sentinel or the guardian (automatic with `--act` unless announced with `--announce-stablecoin=`) | Proposal gone; if planned, announce again then propose again |
| NAV unchanged for more than 72 hours | Operator republishing without recomputing; frozen feed; or constant-NAV fund (normal) | Check the fund type with the steward; if the fund has a variable NAV, ask the operator for a recomputed publication; the corridor floor bounds the exposure | The NAV moves; for a constant-NAV fund, raise the threshold (`--nav-frozen-hours=`) |
| Lender approval near archival | TTL not extended on a `Lender` entry a seizure will read | Extension (automatic with `--act`); an archived approval would block the seizure until it is restored | Entry back above the threshold |

Useful commands, from `demo/`:

```sh
npm run status                    # contract state as the demo sees it
npm run demo -- --only=repair     # lifts the pause, republishes the NAV, settles the demo repo
npm run setup -- --fx=local       # switch to the backup FX feed (new admission)
```

## 4. Communication

- **Within the hour** following a critical alert: public message on the repository (pinned issue) saying what is suspended, what remains open (repurchase, withdrawal, seizure), and when the next update will come.
- **Within 48 hours**: preliminary report, in line with the SDF's DeFi standards taken up in section 6.2 of [security.md](security.md).
- **After resolution**: public post-mortem, with the timeline, the cause, the action and the fix, and the addition of the problem to the STRIDE model if it was new.
- **Regulated issuers**: the information they need for their own incident notification obligations is provided without delay (section 6.3 of [security.md](security.md)).

## 5. Drills

The rehearsal replays every detector with a real trigger on testnet, takes the action and restores the state:

```sh
npm run monitor -- --rehearse
```

Rehearsal of 15 October 2026, on version 4 with a multisig governor, a sole lender (mode D3) and a 5-minute delay:

| Detector | Threat | Trigger | Alert | Action | Restored |
|---|---|---|---|---|---|
| Price | Tamper.1 | NAV published 3 % too high | yes, critical | pause by the guardian | yes |
| Reconciliation | DoS.5 | Clawback of one share unit by the issuer | yes, critical | pause by the guardian | yes |
| Privileged change | Elev.2 | The governor proposes a new guardian | yes | the guardian in place cancels its replacement | yes |
| Exposure | DoS.1 | Fund cap lowered to 90 % utilization | yes | caps restored, after the 300 s delay since it is a loosening | yes |
| Pause | DoS.4 | Pause by the guardian | yes | lifted by the governor | yes |
| Archival | DoS.2 | Threshold forced to 130 days: no entry is actually near archival | yes | entries extended to about 140 days | yes |
| Events | Repud.1 | No real trigger possible: every repo emits its event | no, check passed | none | not applicable |
| Key compromise | Elev.2 | Unannounced upgrade proposed with the governor keys | yes, critical | cancellation by the guardian 6 s after the proposal, 295 s before it fell due; `upgrade` before the delay refused (`TimelockPending`) | yes |
| Issuer freeze | DoS.5 | The issuer freezes the contract, the borrower repays | yes, critical | debt settled, shares recorded; delivery refused during the freeze, successful after | yes |
| Governor handover with stolen keys (version 4) | Elev.2 | The governor proposes a handover to a third-party address | yes, critical | guardian veto 11 s after the proposal, 290 s before it fell due; acceptance before the delay refused (`TimelockPending`) | yes |

Drills added since: 14 exchange rate unchanged, 15 keeper float (17 October); 16 lender approvals near archival, extended (threshold forced to 130 days; two approvals on two funds on 18 October); 17 NAV unchanged from one pass to the next (threshold lowered to 0 h). Since 18 October the testnet instance admits two funds (US Treasury fund shares in USD, euro money market fund shares in EUR with no FX leg) and two euro stablecoins sharing one cap: the drills replay on both.

Pace: one full rehearsal before every public demonstration and every upgrade, then one per month in operation.

## 6. Known limits

- Before rc4, the automatic pause used the guardian key on the monitoring machine. Since rc4, the guardian names a sentinel (`setup -- --sentinel`): the host's key can only suspend and cancel, never lift the pause, veto or hand over a role; the guardian key leaves the host.
- The monitoring reads the event history of the public RPC, kept for about seven days. The full history is kept separately by `indexer/` (append-only journal under a hash chain, anchored on the ledger, register and SFTR views), to be run regularly; on every pass the monitoring compares the RPC's events with the journal when it covers the ledger (Repud.2).
- By default the monitoring queries a single RPC; with `STELLAR_RPC_URLS`, it compares the ledger height of the endpoints on every pass (Infra.1) and fails over on error. The second provider remains to be chosen before any real operation.
- A second instance in witness mode (`npm run monitor -- --witness`, on another machine) alerts with its own files and its own heartbeat, without ever acting: two witnesses, one actor.
- The detectors cover every fund the demo's state file knows (two since 18 October); a fund admitted by another route must be added to it to be monitored.
