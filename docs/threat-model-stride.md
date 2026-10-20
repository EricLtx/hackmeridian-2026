# STRIDE threat model of the Open Window contract (crate `night-window`)

Date: 13 October 2026 · Status: **kept current with the implementation; thirteen detectors per admitted fund and nineteen drills rehearsed on the testnet instance (18 October 2026, rc4)** · Method: Stellar's threat modeling guide (four questions, six STRIDE categories, at least one problem per category, one treatment per problem) · Sibling document: [security.md](security.md), which holds the invariants, the vulnerability classes and decisions S1 to S29.

This document meets the requirements of tranche 2 of the Stellar Community Fund (threat model and monitoring plan) and of the Audit Bank readiness assessment. It is a living tool: it is redone at every architecture change and reread before every audit.

---

## 1. What are we working on?

### 1.1 Use case

A holder of tokenized money market fund shares (the borrower) locks their shares in the contract and receives stablecoins in the same transaction, for a term and a rate fixed in advance. They repay principal and interest and get their shares back. The stablecoins come from offers deposited in advance by lenders, which may include the fund issuer itself. In case of default after maturity, the lender seizes the shares.

### 1.2 External entities

| Entity | Trust | Role |
|---|---|---|
| Borrower | None | Calls `open_repo` and `repurchase` |
| Lender, including the issuer as sponsor lender | None | Calls `create_offer`, `withdraw_offer`, `seize` |
| Administrator (multisig, then timelock) | High, constrained | Fund and stablecoin registry, pause, upgrade |
| Fund issuer | External, imposed | Keeps the allowlist of its shares; can freeze or claw back a balance |
| SEP-40 oracle (RedStone, Pyth) | Allowlisted | Publishes the net asset value of the share |
| SEP-41 tokens and SAC (shares, stablecoins) | Allowlisted | Transfer the balances |
| Soroban host, validators | Full | Authorization, reentrancy protection, resource metering, archival |
| Monitoring operator (Hypernative or equivalent) | Medium | Observes the events, can trigger the pause through a signer |
| Indexer, RPC | Low | Read only; no contract decision depends on them |

### 1.3 Processes

The contract's functions: `__constructor`, `set_admin`, `upgrade`, `set_max_term`, `set_fund`, `remove_fund`, `fund_price`, `create_offer`, `withdraw_offer`, `open_repo`, `repurchase`, `seize`, `get_offer`, `get_repo`; to come: `pause`, `unpause`, `set_stablecoin`, `remove_stablecoin`, `migrate`, and a TimelockController contract in front of the non-urgent privileged functions.

### 1.4 Data flows

1. Lender → contract: stablecoins (SEP-41 transfer) and the offer's parameters.
2. Borrower → contract: shares (SEP-41 or SAC transfer); contract → oracle: `lastprice` read; contract → borrower: stablecoins.
3. Borrower → contract: principal and interest; contract → borrower: shares; contract → lender: principal and interest.
4. Lender → contract: `seize`; contract → lender: shares.
5. Admin → contract: registry, pause, upgrade, through the timelock for non-urgent changes.
6. Contract → world: lifecycle events, read by the indexer and the monitoring.

### 1.5 Storage

| Entry | Type | Sensitive content |
|---|---|---|
| `Admin`, `MaxTerm`, `Paused`, `SchemaVersion` | Instance | Authority and global parameters |
| `Fund(address)` | Persistent | Oracle, oracle asset, haircut, freshness, band |
| `Stablecoin(address)` | Persistent | MiCA allowlist |
| `Offer(id)` | Persistent | Lender, stablecoin, available amount, rate, maximum term, accepted funds, sponsor |
| `Repo(id)` | Persistent | Borrower, lender, fund, shares, principal, rate, maturity (timestamp), state |
| `NextOfferId`, `NextRepoId` | Instance | Monotonic counters |

### 1.6 Trust boundaries

- **F1, user ↔ contract**: every argument is hostile; every authority consumed is re-authenticated in the function.
- **F2, contract ↔ tokens**: a token can fail, return a different amount (permissioned token, freeze), or be fake; hence the allowlist and the balance check before and after each transfer.
- **F3, contract ↔ oracle**: the data is external; freshness, model-based corridor, FX band, refusal in case of doubt.
- **F4, admin ↔ contract**: the strongest authority; multisig, timelock, narrow emergency powers.
- **F5, issuer ↔ shares**: the issuer can freeze or claw back; rule S9 sets the consequences.
- **F6, on-chain ↔ off-chain**: monitoring, indexer, web interface; no contract decision depends on them, but the incident response does.
- **F7, interface ↔ RPC endpoints and hosting** (added on 20 October 2026): the web interface reads the chain through public RPCs (SDF's, then Gateway.fm's as a fallback) and reads an outside exchange-rate feed directly; it is served from GitHub Pages and signs through the visitor's wallet. Every value decoded from the chain is untrusted input to the page: it is checked at the boundary before it reaches the markup, and the pages carry a content security policy. The RPC providers see the visitor's address and IP.

## 2. What can go wrong?

Each problem is numbered by category. Invariants I1 to I9 and decisions S1 to S29 are those of [security.md](security.md).

### Spoofing

| # | Problem | Treatment |
|---|---|---|
| Spoof.1 | A third party withdraws an offer, seizes a repo or repurchases on behalf of someone else | `require_auth` on `lender` in `create_offer` and `withdraw_offer`, on `borrower` in `open_repo` and `repurchase`; lender loaded from `Repo` in `seize`. Test: targeted `mock_auths`, an intruder refused, `env.auths()` tree checked |
| Spoof.2 | A fake oracle or a fake token imitates the SEP-40 or SEP-41 interface | Addresses read only from the registry, never from an argument (S5, fund registry) |
| Spoof.3 | Replay of a pre-signed authorization through an intermediary contract | Every layer that exercises an address's authority re-authenticates it; nonces and expirations handled by the host |
| Spoof.4 | A hostile RPC, or an outside price feed the page reads directly, returns a string where the interface expects a number or an id, and the page renders it as markup: a script on the published origin, next to a connected wallet | **Fixed in the web on 20 October 2026** (security pass of 20 October 2026): every decoded value is checked at the boundary (integers, Stellar addresses, repo statuses, SEP-40 prices, decimals between 0 and 38) and the scanned id can no longer be replaced by a decoded field; both pages carry a content security policy (scripts from the site only, connections to the site, the two RPCs and friendbot). Test: `web/test/boundary.test.js` |

### Tampering

| # | Problem | Treatment |
|---|---|---|
| Tamper.1 | Price manipulated to borrow more than the shares are worth (YieldBlox incident, February 2026) | NAV feed, never a DEX price; model-based corridor with a reference that does not follow the feed (S2); freshness (S1); FX band and FX haircut; haircut; refusal outside the corridor. Tests: `reference_cannot_be_ratcheted_by_a_faulty_feed`, `corridor_refuses_a_jump_faster_than_the_maximum_yield` |
| Tamper.2 | Overflow or unfavorable rounding in the computation of the interest or of the borrowing cap | `checked_*` enforced by the lints, `overflow-checks` in release and test, fixed rounding directions (S3, S4), property tests |
| Tamper.3 | Terms of an open repo modified through a registry change | I9: terms frozen at opening; `remove_fund` does not affect open repos |
| Tamper.4 | Malicious or faulty upgrade that corrupts the storage | 48 h timelock (S7), storage keys never renamed or retyped, schema version and `migrate` (S14), upgrade test with the real WASM |
| Tamper.5 | A hostile RPC inflates the resource fee or alters the footprint of a simulated transaction that the wallet then signs | **Partial** (20 October 2026): the interface refuses a simulation that asks more than 25 XLM of resource fees, and the wallet shows the fee before signing. Open: cross-checking write simulations across endpoints |
| Tamper.6 | The FX band is measured around the rate fixed at admission or at the last re-anchor (S21). Once EUR/USD has drifted inside the band, a wrong rate can still be accepted while its distance to the market exceeds the FX haircut: S22 bounds the band by the haircut around the reference, not around the market | **Open, contract (rc5 candidate)**, confirmed by the security pass of 20 October 2026: re-centre the band or bound drift plus band by the haircut. Meanwhile, the monitor's FX detectors and a re-anchor (S21) before the drift reaches half the band |
| Tamper.7 | The NAV corridor widens with the time since the last reference update; after a quiet spell, a faulty feed or one run by the issuer can move the NAV further than the haircut covers | **Open, contract (rc5 candidate)**, confirmed: bound the corridor growth by the NAV age, or by the haircut. Meanwhile, the keeper keeps the reference recent (`refresh_reference`, open to anyone) |
| Tamper.8 | Caps and outstanding totals add raw base units across the stablecoins of one currency: a stablecoin with other decimals would distort them | **Open, low**, confirmed: until rc5 normalises the units, admit only stablecoins with the same decimals per currency (the registry is governed, behind the delay) |
| Tamper.9 | Extreme decimals (18-decimal shares with an 18-decimal feed) can overflow `max_principal`; coarse feeds widen the tolerances, since the bounds round outward | **Open, low**, confirmed: admission checklist on decimals and feed resolution; fix in rc5 |

### Repudiation

| # | Problem | Treatment |
|---|---|---|
| Repud.1 | A lender or an issuer disputes a seizure or an amount | One event per transition with identifiers and addresses as topics (S13), compared in XDR in the tests; an indexer keeping the history beyond the RPC's 7 days |
| Repud.2 | The administrator changes a parameter without a trace | An event on every administrative change, public timelock queue |
| Repud.3 | The valuation behind each loan (price, exchange rate, applied haircut) is in no event, and a refused opening leaves no trace on chain | **Open, contract (rc5 candidate)**: an append-only valuation event at `open_repo`. Meanwhile, the interface and the indexer keep the quotes off chain |

### Information Disclosure

| # | Problem | Treatment |
|---|---|---|
| Disc.1 | Positions and counterparties readable by anyone on a public chain | Accepted and documented: the shares are already permissioned, the parties are already known to the issuer. Confidentiality of amounts out of scope for version 1; lead: OpenZeppelin confidential token for Soroban |
| Disc.2 | Administration or deployment keys exposed in the repository or the CI | No secret in the repository (checked), local Stellar identities ignored by git, CI actions pinned to a SHA, least-privilege permissions |
| Disc.3 | Every RPC provider, now including the fallback, sees the visitor's IP together with the addresses and positions it queries | Accepted on testnet and documented; a production instance would use an RPC its operator runs, or tell its users |
| Disc.4 | The deployment file published with the site could carry an operator's private RPC URL and its API key | **Fixed on 20 October 2026**: `setup` writes only the public endpoints named by `WEB_RPC_URL` and `WEB_RPC_FALLBACKS`, never the operator's own list |

### Denial of Service

| # | Problem | Treatment |
|---|---|---|
| DoS.1 | An operation exceeds the resource limits because it walks through every position | I6: one entry per offer and per repo, no global loop; at most 8 funds per offer (S10); load test at constant cost |
| DoS.2 | Archived entry (expired TTL) that blocks a repurchase or a seizure | Deadlines as timestamps, never as TTLs; TTL extended on every write; extension task in operations; restoration possible by the caller |
| DoS.3 | Oracle silent or stale over a weekend | Explicit refusal (`NoPrice`, `StalePrice`) rather than a default price; freshness parameter per fund; second oracle in the next version |
| DoS.4 | Abusive pause that blocks exits | The pause only affects `create_offer` and `open_repo` (S6); `repurchase`, `withdraw_offer` and `seize` always remain available |
| DoS.5 | Freeze or clawback of the shares by the issuer during a repo | Rule S9: debt maintained. Today, the repurchase fails as long as the issuer freezes the contract's shares; limit documented and covered by a test; closing without restitution planned for version 1.1 |
| DoS.6 | Repos of a few seconds that probe or saturate the contract | Minimum term of one hour (S11), caps (S18) |
| DoS.7 | The steward revokes the lender after an opening: `seize` requires a current approval of its destination, so the matured repo can no longer be seized, and the borrower keeps the choice to repay or walk away; after `remove_fund` the block is permanent | **Open, contract (rc5 candidate)**, confirmed by reading `seize` and `approve_lender`: let the lender of record seize without a current approval and defer the delivery as in S9 until an approved destination exists. Meanwhile: documented exposure, highest in sole-lender mode; S8 and S25 read with this exception |
| DoS.8 | The stablecoin issuer freezes the contract or a borrower: the repurchase fails while the seizure stays open, which forces a default; the cash side has no equivalent of S9 | **Open, contract with an interface change (rc5 or V2)**, confirmed: a grace period or a deferred settlement when the cash leg is refused. Meanwhile, MiCA-allowlisted stablecoins only, incident procedure |
| DoS.9 | On mainnet, the minimum lifetime of a restored entry is about 120 days: a contract code entry left to archive may cost more to restore than one transaction can carry, which would block every exit | **To check before any mainnet deployment** (a simulated restore of the code entry, read only); keep the code's lifetime near its maximum through extensions each under the per-transaction fee; alert below 90 days, not 14; reconsider S20 (a capped extension on user paths). Not reachable on testnet, where the minimum is 7 days |
| DoS.10 | The monitor's `--act` mode turns conditions it cannot attribute (a donated share unit, a reverting feed, one lying RPC) into instance-wide pauses; its single `getLedgerEntries` batch fails as the state grows | **Open, off-chain**: `--act` stays off in demonstrations; attribution rules, smaller batches and agreement across RPCs before acting |
| DoS.11 | A lender lends to itself and holds a fund's and a currency's cap at almost no cost | **Open, economic**: a single-lender instance (mode D3) is not exposed; elsewhere, caps per lender or a fee; to decide |

### Elevation of Privilege

| # | Problem | Treatment |
|---|---|---|
| Elev.1 | Capture of the admin through a replayable initialization function | Ruled out: `__constructor` constructor, no `initialize` |
| Elev.2 | Compromise of the admin key | Native threshold multisig with an outside signer; 48 h timelock on upgrade and oracle; two-step admin transfer (S7); emergency powers limited to entries |
| Elev.3 | A sponsor lender obtains an exit or seizure privilege | S19: the sponsor mark is indicative, set by the steward, with no on-chain matching; same rules as any offer |
| Elev.4 | A lender not authorized by the issuer receives seized shares and blocks them | S8: only lenders approved by the steward may lend; checked at `create_offer`, again at every `open_repo`, and on the destination address of `seize` |
| Elev.5 | The shares of a fund are pooled in the contract: a clawback by the issuer aimed at one position is borne by whichever position closes last | **Open, contract with an interface change (V2)**, confirmed: per-position accounting of clawbacks. Meanwhile, the monitor's I2 detector alerts on any gap between the pooled balance and the open repos |

## 3. What are we going to do about it?

The treatments above fall into three states:

State as of 14 October 2026, lifecycle implemented:

- **In place and tested**: Spoof.1, Spoof.2, Spoof.3, Tamper.1, Tamper.2, Tamper.3, Repud.2, Disc.2, DoS.1, DoS.2, DoS.3, DoS.4, DoS.6, Elev.1, Elev.3, Elev.4. The caps per repo, per fund and per currency are in place.
- **Partial**: Repud.1 (events in place, indexer to build), Tamper.4 (upgrade reserved to the governor; time delay and test with a real WASM to do), DoS.5 (limit documented, treatment in version 1.1).
- **To put in place before any real deposit**: Elev.2 (multisig, time delay), the monitoring plan below in production, the lender's reserve (S16).

The monitoring plan is implemented (`demo/monitor.mjs`) and was rehearsed on testnet on 14 October 2026: six detectors out of seven were fired by a real event, the planned action was taken and the state restored. Results and what to do in [incident-procedure.md](incident-procedure.md).

The schedule of these steps is in [roadmap.md](roadmap.md).

### 3.1 Monitoring plan, first version

The plan follows from the model: every threat that cannot be made impossible by the code gets a detector and an action.

| Threat | Detector | Threshold | Action |
|---|---|---|---|
| Tamper.1 | Price read by `fund_price` compared with the corridor of the reference | Outside the corridor, or price unchanged for more than N hours | Immediate alert; pause of entries by the guardian |
| Elev.2 | Operations scheduled in the timelock; calls to `set_admin`, `upgrade`, `set_fund` | Any occurrence | Immediate alert; verification by a second signer during the delay |
| DoS.2 | Remaining TTL of the open `Fund`, `Offer`, `Repo` entries, and of the `Lender` approvals an exit reads (seizure, redirection): an archived approval would block a seizure, which S6 forbids | Less than 14 days | Automatic extension; alert if the failure repeats |
| Tamper.1 (frozen NAV) | NAV published with a fresh timestamp but an unchanged value, publication after publication (the age check does not see it); threshold per fund, a constant-NAV fund publishes the same value by design | Unchanged for more than 72 hours | Warning; check the fund type and that the operator is publishing; the corridor floor bounds the exposure |
| DoS.1, DoS.6 | Number of repos opened per hour, amount per repo, total locked | Caps S18 exceeded, or abnormal pace | Alert; pause of entries |
| DoS.5 | Share balance of the contract per fund compared with the sum of open repos (I2) | Non-zero gap | Immediate alert: probable freeze or clawback by the issuer |
| Repud.1 | Expected event missing after a successful transaction | Any occurrence | Alert; investigation |
| Tamper.1 (FX) | Exchange rate published with a fresh timestamp but an unchanged value (closed market: the age check does not see it) | Unchanged for more than 60 hours | Warning; check that the market is closed; the FX band and haircut bound the exposure |
| DoS.2 (rent) | Balance of the keeper account that pays the extensions | Less than one month of rent | Warning; top up from the treasury |
| Infra.1 (reading) | Ledger height compared across the configured RPCs (`STELLAR_RPC_URLS`) | A silent RPC, or more than 10 ledgers apart | Warning; the monitoring fails over to the other RPC; a persistent disagreement invalidates the pass's readings |
| Repud.2 (journal) | Events read at the RPC compared with the indexer's hashed journal, when it covers the ledger | An event present at the RPC and absent from the journal | Warning; rerun the indexer; a persistent gap signals a tampered or stalled journal |
| Elev.2 (schema, rc4) | `schema_version` compared with the version the code expects | Stored version lower | Critical alert: the upgrade was not followed by `migrate`; entries refused (`SchemaOutdated`), exits open |

**Implementation as of 18 October 2026**: `demo/monitor.mjs` carries twelve detectors, each run per admitted fund, and seventeen drills rehearsed on testnet (15 of 15 on 17 October, 16 and 17 added on the 18th), a witness mode (`--witness`) for a second instance that alerts without ever acting (`npm run monitor -- --rehearse`), with automatic reaction on critical alerts (`--act`), a failover across several RPCs (`STELLAR_RPC_URLS`) and an optional heartbeat (`HEARTBEAT_URL`). The event history beyond the RPC's retention is kept by `indexer/` (append-only journal under a hash chain, verifiable). Tools considered for operation on dedicated infrastructure: Hypernative (SDF guide of July 2026, two published examples) or OctoPos; alerts to the incident lead; preliminary report within 48 hours in case of incident, public post-mortem.

### 3.2 Security pass of 20 October 2026

A zero-day hunt over the contract (rc4, unchanged since the tag), its RPC path, the web interface and the tooling, following the initial approach of [security.md](security.md) and a review of the 2025-2026 attack landscape (price-source manipulation such as YieldBlox, configuration and unit errors such as Moonwell, risk-parameter pushes such as Aave's CAPO incident, front-end and supply-chain attacks). Eight lenses (arithmetic and units; authorization, governance and upgrade; oracles; token interactions; state, storage and lifetime; economic attacks; web and hosting; RPC trust and tooling), each finding then put to an adversarial verifier.

- **Findings**: 50 reported. The 11 of the arithmetic and token lenses were confirmed by their verifier; the others were triaged by hand, and the most serious were checked against the code.
- **Fixed the same day** (web and tooling, no contract change): Spoof.4, Tamper.5 (partly), Disc.4.
- **Open in the contract**: DoS.7, DoS.8, Tamper.6, Tamper.7, Tamper.8, Tamper.9, Repud.3, Elev.5. None can be fixed without a new tag; the fixes are grouped as rc5 candidates, to be decided after the hackathon and reviewed by the auditor. The rows above describe each class and the planned fix, not a way to exploit it: the instance runs on testnet and holds nothing of value.
- **Before mainnet**: DoS.9.
- **Off-chain backlog**: DoS.10, DoS.11, Disc.3, Infra.2 and Infra.3 below.

| # | Problem | Treatment |
|---|---|---|
| Infra.2 | The web fails over only on a timeout or a network failure, not on staleness: a fast but lagging endpoint would serve old state | **Open, low**: compare ledger heights across endpoints before trusting a fallback |
| Infra.3 | Front-end supply chain and hosting: npm install scripts, fresh releases, a github.io origin shared with the account's other Pages sites | **Partial**: lockfile and `npm ci`, actions pinned to a SHA, Dependabot, content security policy. Open: install scripts off in CI, a release-age gate, frame protection |

## 4. Did we do a good job?

Review list, to be gone through again at every architecture change:

- [ ] The flow diagram (1.4) has been reread after the implementation of the lifecycle.
- [x] Every STRIDE category has at least one identified problem: yes, six categories; 21 problems on 18 October, 36 after the security pass of 20 October, plus the infrastructure rows Infra.1 to Infra.3 of section 3.
- [ ] Every problem has a treatment and, when it can be implemented, a named test.
- [x] Problems discovered afterwards are added here, not just fixed (security pass of 20 October 2026, section 3.2).
- [x] The monitoring plan has been rehearsed on testnet with at least one real trigger (14 October 2026, [incident-procedure.md](incident-procedure.md), section 5).
- [ ] The model has been reviewed in a Security Office Hours session or by the auditor.

## 5. Sources

- [Threat Modeling How-To Guide, Stellar](https://developers.stellar.org/docs/build/security-docs/threat-modeling/threat-modeling-how-to)
- [Stellar DeFi Security Standards and Best Practices, SDF, 20 July 2026](https://stellar.org/blog/ecosystem/stellar-defi-security-standards-and-best-practices)
- [Submission criteria of the Community Fund, tranche 2](https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/submission-criteria)
- [Monitoring Stellar with Hypernative, SDF](https://stellar.org/blog/developers/monitoring-stellar-with-hypernative)
- [Auditing Smart Contracts on Stellar, Certora, 7 October 2026](https://www.certora.com/blog/auditing-smart-contracts-stellar)
- [YieldBlox post-mortem, Blockaid](https://www.blockaid.io/blog/73-quarantined-how-blockaid-and-stellar-validators-contained-a-10m-price-manipulation-attack)
- [Storage strategies and TTL](https://developers.stellar.org/docs/build/guides/storage/storage-strategies#strategy-5-ttl-management--bump-on-access)
