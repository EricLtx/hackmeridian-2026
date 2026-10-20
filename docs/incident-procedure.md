# Incident procedure

This document says who acts, how and within what time when Open Window's monitoring raises an alert. It complements the monitoring plan of [threat-model-stride.md](threat-model-stride.md), section 3.1, and decisions S6, S7 and S17 of [security.md](security.md). Version of 14 October 2026, revised on 20 October 2026 for the rc5 tooling (the monitor's detectors, actions and announcements); testnet deployment.

## 1. Roles

| Role | Holds | Can | Cannot |
|---|---|---|---|
| Incident lead | The decision | Declare the incident, choose the action, communicate | Act alone with a key it does not hold |
| Guardian | The `guardian` key | Suspend entries (`pause`), cancel a proposal, hand its role over to its backup, veto a handover, name the sentinel | Lift the pause; block an exit |
| Sentinel (rc4) | The monitoring host's key, named by the guardian | Suspend entries, cancel a proposal | Lift the pause; veto; hand over or back up a role; propose anything |
| Governor | The `governor` key, a native multisig account (2 of 2 on testnet, target 2 of 3 on hardware with one outside signer) | Lift the pause, remove a fund, propose an upgrade or a loosening, replace the guardian alone after 30 days | Touch an open repo; apply anything before the delay |
| Steward of a fund | The fund's key | Freeze its fund, revoke a lender (since rc5 a revocation stops new loans, not the seizure of the lender's open repos), lower the reference | Act on another fund |
| Keeper | The rent-paying key, on the monitoring host | Extend entries, step a price reference (`refresh_reference`), deliver held-back shares (`release`): calls open to anyone | Pause, cancel, veto |
| Price operator | The NAV feed's key | Republish a NAV | Modify the contract |

Rule: the pause is the first move, because it never blocks an exit. Repurchase, withdrawal of the unlent part and seizure at maturity remain available throughout the incident, except on the cash leg when a stablecoin's issuer freezes the contract or a borrower (DoS.8, section 3).

## 2. Detection

The monitoring runs continuously:

```sh
cd demo
npm run monitor -- --watch --act
```

One pass every 30 seconds. `--act` pauses new entries on a price refusal or on a deficit of shares or stablecoins (a surplus is a warning), cancels an unannounced upgrade or stablecoin proposal, vetoes an unannounced governor handover or forced guardian change when the guardian's or the trustee's key is on the host, extends the entries near archival (the contract code in 30-day steps when it has less than 90 days, decision S20), steps a price reference older than its NAV age bound, and delivers held-back shares that can now be delivered. With two endpoints in `STELLAR_RPC_URLS`, the default, each action waits for the second endpoint's own reading and is taken only if it agrees; otherwise, or when a veto's key is missing, a critical alert asks a human to act. Every alert is appended to `demo/.state/alerts.jsonl`.

A planned change is announced first, so that `--act` reports it instead of answering it: `npm run monitor -- --announce=<hash>` for an upgrade, `--announce-stablecoin=<C...>` for a stablecoin registration, `--announce-admin=<G...>` for a governor handover, `--announce-guardian=<G...>` for a forced guardian change.

| Level | Reaction time | Examples |
|---|---|---|
| Critical | Automatic pause or cancellation, incident lead reached within 15 minutes | Price refused by the contract, a deficit of shares (I2) or of a stablecoin (I1), a stablecoin that deauthorized the contract, a fund removed or unreadable, an unannounced proposal (upgrade, stablecoin, governor handover, forced guardian change), contract code changed, endpoints that disagree on the pause or a proposal, a journal line unknown to or different from an independent endpoint, an action not taken or failed, archived entry |
| Warning | Review before the proposal falls due | Pending proposal (fund, backup feed, re-anchor, guardian, envelope, limits, cap), privileged change, pause in progress, cap 80 % used, more than 20 openings in an hour, NAV two hours from its age bound, entry less than 14 days from archival (lender approvals included), the contract code less than 90 days, a price reference older than its NAV age bound, exchange rate unchanged for more than 60 hours, NAV unchanged for more than 72 hours, a flat feed over business days or two FX sources apart, a surplus of shares or of a stablecoin, shares held back, a lender revoked with open repos, keeper float below 250 XLM |

Each detector about a fund runs for every admitted fund: with two funds, an alert carries the name of the fund concerned.

Robustness of the monitoring itself: `STELLAR_RPC_URLS` lists several RPCs tried in order (the public RPC answered "account not found" on an existing account three times in thirteen hours on 17 October 2026); `HEARTBEAT_URL` sends a heartbeat after every successful pass to an external service that alerts when the monitoring stops; a failed pass is logged and replayed thirty seconds later. Since rc5 one fund's failing read no longer fails the pass: it is that fund's critical alert, and the other funds and detectors keep running. Reads simulate from the null account, so the host needs no governor key.

## 3. What to do for each alert

| Alert | Probable cause | Immediate action | Back to normal |
|---|---|---|---|
| Price refused (`PriceOutOfBand`, `StalePrice`) | NAV feed faulty or silent; FX rate outside the band; since rc5 also a price reference left alone until an honest NAV outgrew its corridor | Pause by the sentinel (automatic with `--act` once the second endpoint reads the same refusal) | The operator republishes the right value; a reference left alone is stepped with `refresh_reference` or, beyond reach, re-anchored with two keys (S21); if the FX rate has drifted durably, a two-key re-anchor; then the governor lifts the pause |
| Deficit of shares (I2) or of a stablecoin (I1) | Freeze or clawback by the issuer; bug | Pause (automatic with `--act` once confirmed); contact the issuer | Gap explained and settled; decision S9 if repos are affected |
| Surplus of shares or of a stablecoin | A transfer to the contract outside a repo, which no function moves out | None: a surplus harms no position; find the sender | Recorded; the warning returns only when the surplus changes |
| Unannounced upgrade proposal | Governor keys compromised | Cancellation by the sentinel or the guardian (automatic with `--act`), pause, rotation of the multisig signers | New keys in place; any remaining proposal cancelled |
| Pending proposal | Administration or steward operation | A second signer checks that it was planned before it falls due | None if planned; otherwise cancellation by the guardian or the steward |
| Shares held back (`ReleaseDeferred`) | The issuer freezes the contract or removes a beneficiary from its allowlist; since rc5 also a seizure by a lender the steward no longer approves | Contact the issuer; or ask the steward whether it approves the lender again; the debt is already settled | Freeze lifted or lender approved again, then `release` by anyone (the keeper with `--act`); the beneficiary can redirect, after a seizure only to an approved holder |
| Code changed | Upgrade applied | Check that it had been announced and that the delay has elapsed | Review of the deployed WASM against the published code (`docs/audit-scope.md`) |
| Governor handover proposed or done (`admin_proposed`, `admin_changed`) | Planned change of signers, or compromised keys | A planned handover is announced before it is proposed (`--announce-admin=<G...>`) and is never vetoed. Unplanned: check with each signer, then the guardian vetoes (`veto_admin`) during the delay, automatically with `--act` only when the guardian key is on the monitoring host; otherwise a critical alert asks the guardian to veto by hand; then key rotation | New signers confirmed |
| Steward recovery proposed (`steward_recovery_proposed`) | Steward key lost, or attempt to capture the fund | Warn the issuer: any action signed with its key cancels the procedure | The issuer's backup key installed after 30 days, or procedure cancelled |
| Forced guardian change (`guardian_change_forced`) | Guardian lost, or governor compromised | A planned change is announced first (`--announce-guardian=<G...>`). Unplanned: treat as a key compromise, 30 days to react; the trustee vetoes (`veto_forced_guardian_change`), automatically with `--act` only when its key is on the host, otherwise by hand after a critical alert | Guardian confirmed or change cancelled by the legitimate governor |
| Privileged change | Administration operation | A second signer checks that it was planned | None if planned; otherwise treat as a key compromise |
| Entry near archival | TTL not extended | Extension (automatic with `--act`); for the contract code, below 90 days, since on mainnet its restore may not fit in one transaction (DoS.9) | Entry back above the threshold |
| Cap at 80 % or more than 20 openings in an hour | Real usage or probing | Review; pause if unexplained | Caps revised by the steward or the governor |
| Exchange rate unchanged for more than 60 hours | Currency market closed (long weekend, public holiday); frozen feed | Check that the market is closed; the exposure stays bounded by the FX band and haircut while the market stays inside the band (S22); pause if the feed is frozen on a trading day | The rate moves at reopening; otherwise fail over to the backup feed (`setup -- --fx=local` in the demo) |
| Keeper float below the threshold | Rent paid without top-up | Top up from the treasury (the keeper has no role in the contract) | Balance back above 250 XLM, one 30-day slice of the code's rent with a margin |
| Schema behind the code (rc4) | Upgrade applied without `migrate` | Governor and trustee run `migrate` (`npm run upgrade -- --apply`); entries answer `SchemaOutdated`, exits continue | `schema_version` equal to the expected version |
| Unannounced stablecoin proposal (rc4) | Governor keys compromised, or announcement forgotten | Cancellation by the sentinel or the guardian (automatic with `--act` unless announced with `--announce-stablecoin=`) | Proposal gone; if planned, announce again then propose again |
| NAV unchanged for more than 72 hours | Operator republishing without recomputing; frozen feed; or constant-NAV fund (normal) | Check the fund type with the steward; if the fund has a variable NAV, ask the operator for a recomputed publication; the corridor floor bounds the exposure | The NAV moves; for a constant-NAV fund, raise the threshold (`--nav-frozen-hours=`) |
| Lender approval near archival | TTL not extended on a `Lender` entry a seizure will read | Extension (automatic with `--act`); an archived approval would block the seizure until it is restored | Entry back above the threshold |
| Price reference older than its NAV age bound (`reference-age`, rc5) | No opening and no refresh since then | `refresh_reference` by anyone, automatic with `--act` while the NAV is newer; if the NAV already left the corridor, a two-key re-anchor (S21) | Reference within its bound |
| Stablecoin deauthorized the contract (`stablecoins`, DoS.8) | The stablecoin's issuer froze the contract's balance | Contact the issuer; warn the borrowers of open repos in that coin before their maturity: their repurchase fails while the seizure stays open, and withdrawals in that coin fail; no pause, since new entries in that coin fail anyway | The issuer authorizes the contract again |
| Lender revoked with open repos (`lenders`, DoS.7) | The steward revoked a lender's approval | Ask the steward why; after maturity the lender still seizes, and the shares wait for its approval or a redirection | The lender approved again, or its repos closed |
| Fund removed or unreadable (`funds`) | `remove_fund` by the governor, or a reverting feed or endpoint | Check the delisting with the governor, or the feed and the endpoint; the other funds stay watched; open repos of a removed fund can still be repurchased and seized | Fund delisted on purpose and dropped from the demo state, or reads back |
| Endpoints disagree on the pause or a proposal (`rpc`, Infra.1) | A lying, lagging or forked endpoint | Nothing automatic rests on the disputed fact; check both endpoints by hand and replace the faulty one | Endpoints agree |
| Journal line unknown or altered (`journal`, Repud.2) | The indexer's endpoint served a made-up event, or a line was written by hand | Stop trusting the journal from that line; re-index from an honest endpoint; `npm run verify -- --against <url>` in `indexer/` | The journal and an independent endpoint agree |
| Flat feed (`feed-flat`) | An operator republishing without recomputing; a frozen FX feed | Verify with the operator; compare with another source; re-anchor or move the FX leg if the fund's feed is wrong | The feed moves, or the fund's NAV is constant by design (`--nav-frozen-hours=Infinity`) |
| Action not taken or failed (`act`) | The second endpoint did not confirm it, a key was missing, or the transaction failed | Act by hand if the condition is real; the next pass tries again while it lasts | Condition gone |

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

With the rc5 tooling (20 October 2026): drill 18 deploys a 7-decimal stand-in token, since rc5 registers no other precision; with two endpoints, each drill's action waits for the second endpoint, so the rehearsal runs with both reachable, or with a single endpoint in `STELLAR_RPC_URLS`; drill 15 restores only with a keeper float of 250 XLM. The detectors rc5 adds (reference age, flat feeds, stablecoin authorization, revoked lenders, proposals read from state, unreadable funds, the journal both ways) have offline tests (`npm test` in `demo/`) and no drill yet. The rehearsal against rc5 follows its governed upgrade.

Pace: one full rehearsal before every public demonstration and every upgrade, then one per month in operation.

## 6. Known limits

- Before rc4, the automatic pause used the guardian key on the monitoring machine. Since rc4, the guardian names a sentinel (`setup -- --sentinel`): the host's key can only suspend and cancel, never lift the pause, veto or hand over a role; the guardian key leaves the host. Since rc5 a veto is automatic only when the guardian's or the trustee's key is on the host; without it the monitor raises a critical alert and the key's holder vetoes by hand.
- The monitoring reads the event history of the public RPC, kept for about seven days, from where the last pass stopped: an outage shorter than that loses nothing, and a longer one is reported, not skipped in silence. The full history is kept separately by `indexer/` (append-only journal under a hash chain, anchored on the ledger, register and SFTR views), to be run regularly; since rc5, on every pass the monitoring compares the journal both ways and by content with the events of an endpoint other than the indexer's (Repud.2).
- By default the monitoring lists two public testnet RPCs, SDF's and Gateway.fm's: it compares their heights (Infra.1), reads the pause and the pending proposals on both, takes an action only when the second agrees, and fails over on error. The providers for a real operation remain to be chosen.
- A second instance in witness mode (`npm run monitor -- --witness`, on another machine) alerts with its own files and its own heartbeat, without ever acting: two witnesses, one actor.
- The detectors cover every fund the demo's state file knows (two since 18 October); a fund admitted by another route must be added to it to be monitored.
