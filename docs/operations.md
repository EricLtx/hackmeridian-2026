# Running an Open Window instance

This page is for the operator of an instance: in the single-lender mode the contract supports, that operator is the regulated lender itself. It says which keys the operator holds, how an instance is deployed and configured, what to check before a fund is admitted, what runs every day, how the code is upgraded, and what to record off chain. The contract never changes for any of this: every step below is a transaction or a script of this repository.

Decision numbers (S1 to S29) refer to [security.md](security.md). The incident side is in [incident-procedure.md](incident-procedure.md); the monitoring plan in [threat-model-stride.md](threat-model-stride.md), section 3.1; every entry point in [interface-reference.md](interface-reference.md). The scripts live in `demo/` and are described in [demo/README.md](../demo/README.md); they run on testnet today and need only a network setting to target another network.

## 1. Roles and keys

| Role | What it can do | Who holds it in a single-lender instance | Key discipline |
|---|---|---|---|
| Governor | admit and remove funds (with the fund's steward), register stablecoins (behind the delay after the first admission, S29), propose upgrades, envelope loosenings, caps and feeds (all behind the delay, S7), lift a pause, name the guardian with the guardian, `migrate` with the trustee | the lender-operator, as a native multisig account (2-of-3 with an outside signer is the target; 2-of-2 is the minimum) | hardware signers held by different people; the ceremony is tooled (`npm run keys`) |
| Guardian | pause new entries, cancel any pending proposal, veto a governor handover or a forced guardian change, name the sentinel | the lender-operator's risk or security function, a key that is not a governor signer | hardware; its registered backup is the only address it can hand over to (S26) |
| Sentinel | pause and cancel, nothing else | the monitoring host (`npm run monitor -- --act`) | hot key in a managed key store, separate identity from the keeper |
| Trustee | co-sign every upgrade proposal; replace itself with a successor | an independent party (optional, fixed before the first admission, S28) | the operator never holds it |
| Steward, per fund | admit its fund with the governor, approve and revoke lenders, set limits inside the envelope, lower the NAV reference, freeze, register its backup | the fund issuer | the issuer's own discipline; its registered backup is the only recovery path (S26) |
| Keeper | pays storage rent; no role in the contract | the operator's operations team | hot key, float capped (incident procedure) |
| Sole lender | the only address that can create offers (S23) | the lender's trading desk | fixed once, before the first admission; irrevocable |

Rules: one person, one role; no key of one role ever signs for another; the governor and the guardian are never the same account; the trustee is independent of every other role, which the contract checks in both directions. The custody policy is section 6.4 of [security.md](security.md).

## 2. Prerequisites

- Node.js 20 or later, and the repository built once (`stellar contract build`) for the WASM files the scripts upload.
- Accounts for every role, funded in XLM. The scripts keep secrets in a state file (`demo/.state/<name>.json`, git-ignored); a production instance replaces that file with the operator's own key management, and signs the governor's transactions from hardware (the `keys` tool prints unsigned XDR for that purpose).
- An RPC endpoint, two if possible (`STELLAR_RPC_URLS`): the monitor compares them.
- For each fund: the share token's contract address (a SEP-41 token, or the Stellar Asset Contract of a classic asset), a SEP-40 NAV feed with its operator, the issuer's allowlisting of the contract and of the approved lenders, and the issuer's freshness policy (how often the NAV is published, which sets the NAV age bound, section 3).
- A stablecoin on the MiCA allowlist (S5) for each loan currency, and the exchange-rate feed when the NAV is not in the loan currency.

## 3. Deploying and configuring

Order of operations, as `demo/setup.mjs` performs it (each step is idempotent and recorded, so a network drop costs one step):

1. **Deploy** the contract with the governor as `admin`; set the time delay (48 hours is the default; the demo shortens it to 5 minutes before the first admission); fix the sole lender (S23) and the trustee (S28) **before the first admission**: both are irrevocable afterwards.
2. **Register the stablecoins** (`set_stablecoin`): immediate before the first admission, a proposal behind the delay afterwards (S29). Set the currency caps (S18).
3. **Admit each fund** (`set_fund`, signed by the governor and the fund's steward): NAV feed and its asset, currency, price source (`Direct` when the NAV is in the loan currency, `Cross` with an FX leg otherwise), haircut, corridor floor, maximum yield, NAV age bound, caps. The envelope (S27) bounds every value; the FX band may not exceed the FX haircut (S22).
4. The steward **registers its backup** (`set_steward_backup`): mandatory by policy (decision D4), the monitor alerts while it is missing.
5. **Approve the lender** on each fund: the lender signs an attestation with the steward (`attest_lender`, S25), the steward approves (`approve_lender`, S8). The issuer must also allowlist the lender and the contract on its share token.
6. The lender **creates offers** (`create_offer`): stablecoin, amount, rate, term ceiling, funds listed (at most 8). The steward may mark one as the designated offer (S19).
7. **Name the guardian's backup and the sentinel**, start the monitor (`--watch --act`) and the keeper's rent task, run the rehearsal once (`npm run monitor -- --rehearse`) against the instance.

Admission checklist, to tick before step 3 for every fund:

- the NAV feed publishes at the promised cadence; the NAV age bound covers the longest gap (a fund that publishes on business days is 64 hours old on Monday morning);
- haircut at or above the envelope minimum, and at or above the corridor's maximum drift over the NAV age bound: the envelope checks each bound on its own and does not enforce this relation, so check it here (threat model Tamper.7);
- for a cross-currency fund, FX band at or below the FX haircut (S22);
- the contract and the lender are allowlisted on the share token; a revoked authorization is handled (S9: the repurchase settles and the shares are delivered when the issuer allows), but the issuer's policy should say when it freezes;
- caps per repo, per fund and per currency consistent with the maximum-loss scenarios (security.md 6.1) and with the lender's off-chain reserve (S16);
- the steward's backup key exists and is held by the issuer.

`npm run inventory` prints every admitted fund against the envelope and these rules, and names what would be refused.

## 4. Every day

| Task | Tool | Rule |
|---|---|---|
| Watch and act | `npm run monitor -- --watch --act` on a dedicated host, `--witness` on a second host | thirteen detectors per fund; a critical alert pauses new entries through the sentinel; exits are never blocked (S6) |
| Rent | the keeper, alerted by the monitor | the contract code and every open entry are extended before archival; the operator pays the code's rent (S20) |
| Feeds | the monitor | a stale or frozen NAV stops new repos on that fund and never forces a liquidation |
| Keys | ceremony tool | rotation through the two-step handovers; readback after every change (`npm run keys -- --readback`) |
| Reporting | the indexer's register and SFTR views ([indexer/README.md](../indexer/README.md)) | one row per repo with the fields the chain carries; the lender's reporting team adds the LEI, the agreement and the ISIN |
| Incidents | [incident-procedure.md](incident-procedure.md) | who acts on each alert and within what time |

## 5. Upgrading the code

An upgrade is a governance act behind the delay (S7, S15), co-signed by the trustee (S28), and a data migration when the stored layout changes (S14, S29). `npm run upgrade` performs the sequence: upload the built WASM, propose with the governor and the trustee, announce the hash to the monitor (an unannounced proposal is treated as an attack and cancelled), wait for the delay, `upgrade`, verify the executable the ledger holds, `migrate` when the schema version is behind, move the monitor's code baseline.

**Before any upgrade that tightens an admission rule, run `npm run inventory`.** A fund admitted under the older rule keeps running after the upgrade, but its next limit change or replacement is refused until a compliant configuration is applied through the delay. This happened on the testnet instance on 18 October 2026: the first fund, admitted with an FX band wider than its FX haircut, saw `set_fund_limits` refused by S22 after the rc4 upgrade, and was replaced through the delay. The inventory names such funds before the upgrade, so the replacements can be proposed in the same delay window.

Every upgrade is recorded in the instance register (section 7) with the WASM hash, the tag, the proposal and application transactions, and the migration transaction.

## 6. Stopping and leaving

- **Pause** (guardian or sentinel): new offers and repos stop; repurchase, withdrawal of unlent funds, seizure and delivery continue (S6).
- **Winding down an instance**: freeze each fund (steward), withdraw the offers (lender), let the open repos close by repurchase or seizure, then remove the funds; the contract stays readable; the operator stops paying rent when nothing is owed.
- **Renouncing upgrades** after the pilot is a commitment the operator can make to the issuer (S15).

## 7. The instance register

Kept off chain by the operator, signed, and updated at every governance act. `npm run inventory -- --json` writes its current content to `demo/.state/instance-register.json`:

- contract address, network, contract version, schema version, executable hash and its time to live, time delay, term ceiling, pending upgrade;
- roles: governor account and its signers, guardian and backup, sentinel, trustee, sole lender;
- risk envelope;
- stablecoins with their currency caps and outstanding amounts;
- every admitted fund: steward and backup, feed, price source, haircuts, band, ages, corridor, caps, outstanding, pending change, lender approval, and the findings of the inventory.

To this the operator adds what the chain does not carry: the tag and the audit report of the code it runs, the signers' names and devices, the agreements (master agreement, DORA clauses, attestation declarations whose hashes are on chain), and the incident log.
