# Running an Open Window instance

This page is for the operator of an instance: in the single-lender mode the contract supports, that operator is the regulated lender itself. It says which keys the operator holds, how an instance is deployed and configured, what to check before a fund is admitted, what runs every day, how the code is upgraded, and what to record off chain. The contract never changes for any of this: every step below is a transaction or a script of this repository.

Decision numbers (S1 to S34) refer to [security.md](security.md). The page describes the rc5 candidate and its tooling; the testnet instance runs rc4 until the governed upgrade (section 5). The incident side is in [incident-procedure.md](incident-procedure.md); the monitoring plan in [threat-model-stride.md](threat-model-stride.md), section 3.1; every entry point in [interface-reference.md](interface-reference.md). The scripts live in `demo/` and are described in [demo/README.md](../demo/README.md); they run on testnet today and need only a network setting to target another network.

## 1. Roles and keys

| Role | What it can do | Who holds it in a single-lender instance | Key discipline |
|---|---|---|---|
| Governor | admit and remove funds (with the fund's steward), register stablecoins (7 decimals only; after the first admission a proposal behind the delay, which since rc5 the governor applies with its own signature, S29, S31), propose upgrades, envelope loosenings, caps and feeds (all behind the delay, S7), lift a pause, name the guardian with the guardian, `migrate` with the trustee | the lender-operator, as a native multisig account (2-of-3 with an outside signer is the target; 2-of-2 is the minimum) | hardware signers held by different people; the ceremony is tooled (`npm run keys`) |
| Guardian | pause new entries, cancel any pending proposal, veto a governor handover or a forced guardian change, name the sentinel | the lender-operator's risk or security function, a key that is not a governor signer | hardware; its registered backup is the only address it can hand over to (S26) |
| Sentinel | pause and cancel, nothing else; it may hold no other role, which the contract checks both ways (S26) | the monitoring host (`npm run monitor -- --act`) | hot key in a managed key store, separate identity from the keeper |
| Trustee | co-sign every upgrade proposal; replace itself with a successor | an independent party (optional, fixed before the first admission, S28) | the operator never holds it |
| Steward, per fund | admit its fund with the governor, approve and revoke lenders, set limits inside the envelope, lower the NAV reference, freeze, register its backup | the fund issuer | the issuer's own discipline; its registered backup is the only recovery path (S26) |
| Keeper | pays storage rent, steps each fund's price reference along its model (`refresh_reference`) and delivers held-back shares once they can be delivered (`release`), all calls open to anyone; no role in the contract | the operator's operations team | hot key; a float of at least 250 XLM, about one 30-day slice of the code's rent on testnet (S20), and capped |
| Sole lender | the only address that can create offers (S23) | the lender's trading desk | fixed once, before the first admission; irrevocable |

Rules: one person, one role; no key of one role ever signs for another; the governor and the guardian are never the same account; the trustee and the sentinel are independent of every other role, proposed roles included, which the contract checks in both directions (since rc5 for the sentinel and the proposed roles). The monitoring host needs only the sentinel's and the keeper's keys: its reads use no key, and without the guardian's or the trustee's key there, a veto becomes a critical alert for that key's holder. The custody policy is section 6.4 of [security.md](security.md).

## 2. Prerequisites

- Node.js 20 or later, and the repository built once (`stellar contract build`) for the WASM files the scripts upload.
- Accounts for every role, funded in XLM. The scripts keep secrets in a state file (`demo/.state/<name>.json`, git-ignored); a production instance replaces that file with the operator's own key management, and signs the governor's transactions from hardware (the `keys` tool prints unsigned XDR for that purpose).
- Two RPC endpoints from independent providers (`STELLAR_RPC_URLS`; the demo's default lists SDF's and Gateway.fm's public testnet RPCs). The monitor compares their heights, reads the pause and the pending proposals on both, takes an automatic action only once the second endpoint confirms it, and checks the indexer's journal against an endpoint the indexer did not read.
- For each fund: the share token's contract address (a SEP-41 token, or the Stellar Asset Contract of a classic asset), a SEP-40 NAV feed with its operator, the issuer's allowlisting of the contract and of the approved lenders, and the issuer's freshness policy (how often the NAV is published, which sets the NAV age bound, section 3).
- A stablecoin on the MiCA allowlist (S5) for each loan currency, and the exchange-rate feed when the NAV is not in the loan currency.

## 3. Deploying and configuring

Order of operations, as `demo/setup.mjs` performs it (each step is idempotent and recorded, so a network drop costs one step):

1. **Deploy** the contract with the governor as `admin`; set the time delay (48 hours is the default; the demo shortens it to 5 minutes before the first admission); fix the sole lender (S23) and the trustee (S28) **before the first admission**: both are irrevocable afterwards.
2. **Register the stablecoins** (`set_stablecoin`): 7-decimal tokens only (S31); immediate before the first admission, afterwards a proposal behind the delay that the governor applies once due (S29). Set the currency caps (S18).
3. **Admit each fund** (`set_fund`, signed by the governor and the fund's steward): NAV feed and its asset, currency, price source (`Direct` when the NAV is in the loan currency, `Cross` with an FX leg otherwise), haircut, corridor floor, maximum yield, NAV age bound, caps. The envelope (S27) bounds every value; the FX band may not exceed the FX haircut (S22); since rc5 the haircut must cover the NAV corridor (S30) and the feeds must publish with at least 6 decimals (S32).
4. The steward **registers its backup** (`set_steward_backup`): mandatory by policy (decision D4), the monitor alerts while it is missing.
5. **Approve the lender** on each fund: the lender signs an attestation with the steward (`attest_lender`, S25), the steward approves (`approve_lender`, S8). The issuer must also allowlist the lender and the contract on its share token.
6. The lender **creates offers** (`create_offer`): stablecoin, amount, rate, term ceiling, funds listed (at most 8). The steward may mark one as the designated offer (S19).
7. **Name the guardian's backup and the sentinel**, start the monitor (`--watch --act`) with the sentinel's and the keeper's keys, run the rehearsal once (`npm run monitor -- --rehearse`) against the instance, with both RPC endpoints reachable.

Admission checklist, to tick before step 3 for every fund:

- the NAV feed publishes at the promised cadence; the NAV age bound covers the longest gap (a fund that publishes on business days is 64 hours old on Monday morning);
- haircut at or above the envelope minimum, and at or above `2 × corridor floor + max yield × NAV age bound / year`, rounded up: the corridor's span from an honest NAV at its bottom to a wrong one at its top. Since rc5 the contract refuses a lower haircut (S30), and the inventory prints the figure for each fund;
- NAV and FX feeds that publish with at least 6 decimals (S32), and stablecoins with 7 (S31);
- for a cross-currency fund, FX band at or below the FX haircut (S22);
- the contract and the lender are allowlisted on the share token; a revoked authorization is handled (S9: the repurchase settles and the shares are delivered when the issuer allows), but the issuer's policy should say when it freezes;
- caps per repo, per fund and per currency consistent with the maximum-loss scenarios (security.md 6.1) and with the lender's off-chain reserve (S16);
- the steward's backup key exists and is held by the issuer.

`npm run inventory` prints every admitted fund against the envelope and these rules, rc5's included (the corridor cover, the feeds' and the stablecoins' decimals), and names what would be refused.

## 4. Every day

| Task | Tool | Rule |
|---|---|---|
| Watch and act | `npm run monitor -- --watch --act` on a dedicated host, `--witness` on a second host | nineteen detectors (`demo/detectors.mjs`), those about a fund run for each admitted fund; a price refusal or a deficit of shares or stablecoins pauses new entries through the sentinel, a surplus is a warning; every automatic action waits for the second endpoint's own reading; the pause never blocks an exit (S6). Announce a planned change first, or `--act` answers it: `--announce=<hash>` for an upgrade, `--announce-stablecoin=<C...>`, `--announce-admin=<G...>` for a governor handover, `--announce-guardian=<G...>` for a forced guardian change |
| Rent | the keeper, alerted by the monitor | open entries are extended when under 14 days, the contract code when under 90 days, 30 days at a time up to 120 (S20); the operator pays the code's rent: one 30-day slice cost about 215 XLM on testnet at the rate read on 20 October 2026, so the keeper's float stays above 250 XLM; on mainnet the code entry must never near archival, since its restore may not fit in one transaction (threat model DoS.9) |
| Price references | the keeper, alerted by the monitor's `reference-age` detector | since rc5 a fund's corridor grows over at most one NAV age bound after its reference (S30): a reference older than the bound is stepped with `refresh_reference` while the NAV is newer; an honest NAV that already left the corridor needs a two-key re-anchor (S21). The demo's first fund (a NAV growing 4 % a year, a 0.1 % floor, a 26 h bound) leaves it after about ten days without a step or an opening |
| Feeds | the monitor | a stale or frozen NAV stops new repos on that fund and never forces a liquidation; `feed-flat` warns on a NAV unchanged over two business days, an FX rate unchanged over 24 business hours, and an FX feed more than half its band away from a second FX source (`--fx-fallback=<C...>` names it) |
| Keys | ceremony tool | rotation through the two-step handovers; readback after every change (`npm run keys -- --readback`) |
| Reporting | the indexer's register and SFTR views ([indexer/README.md](../indexer/README.md)) | one row per repo with the fields the chain carries, the SFTR haircut being the one the opening applied (`repo_valued`, rc5); the lender's reporting team adds the LEI, the agreement and the ISIN |
| Journal | the indexer, and the monitor's `journal` detector | `npm run verify -- --against <url>` compares the journal both ways and by content with an endpoint other than the one the indexer read; the monitor runs the same comparison on every pass |
| Incidents | [incident-procedure.md](incident-procedure.md) | who acts on each alert and within what time |
| Web interface | `.github/workflows/pages.yml` publishes `web/` on every push that touches it | the published deployment file lists keyless public RPCs only (`WEB_RPC_URL`, `WEB_RPC_FALLBACKS` at `setup`); an endpoint added there is added to the content security policy of both pages; `web/public/history.json` is refreshed from the indexer and committed when the journal moves |

## 5. Upgrading the code

An upgrade is a governance act behind the delay (S7, S15), co-signed by the trustee (S28), and a data migration when the stored layout changes (S14, S29). `npm run upgrade` performs the sequence: upload the built WASM, propose with the governor and the trustee, announce the hash to the monitor (an unannounced proposal is treated as an attack and cancelled), wait for the delay, `upgrade`, verify the executable the ledger holds, `migrate` when the schema version is behind, move the monitor's code baseline. Propose an upgrade only after the first admission: since rc5 one proposed before is cancelled at it.

**Before any upgrade that tightens an admission rule, run `npm run inventory`.** A fund admitted under the older rule keeps running after the upgrade, but its next limit change or replacement is refused until a compliant configuration is applied through the delay. This happened on the testnet instance on 18 October 2026: the first fund, admitted with an FX band wider than its FX haircut, saw `set_fund_limits` refused by S22 after the rc4 upgrade, and was replaced through the delay. The inventory names such funds before the upgrade, so the replacements can be proposed in the same delay window.

**The upgrade to rc5** keeps the stored layout (`SCHEMA_VERSION` 2), so it needs no `migrate`. Its rules bind admitted funds at their next change: run the inventory first. Check by hand what the inventory does not read: a proposal made under rc4 that names the trustee or the sentinel (`apply_guardian_change` refuses it after the upgrade, `accept_admin` and `apply_forced_guardian_change` do not check), a pending backup feed that is the primary feed (refused at its apply), a pending re-anchor on a feed under 6 decimals (refused at its apply), and a stablecoin registration proposed by a former governor (only the governor in office applies it). Just before the upgrade, step each fund's price reference with `refresh_reference`, which rc4 accepts too: rc5 refuses at once the NAV of a fund that has grown more than its floor plus one NAV age of model growth since its reference, and such a fund then needs a two-key re-anchor. After the upgrade the keeper keeps the references recent.

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
- every admitted fund: steward and backup, feed and its decimals, backup feed, price source, haircuts, band, ages, corridor and the haircut it needs, caps, outstanding, pending change, lender approval, and the findings of the inventory.

To this the operator adds what the chain does not carry: the tag and the audit report of the code it runs, the signers' names and devices, the agreements (master agreement, DORA clauses, attestation declarations whose hashes are on chain), and the incident log.
