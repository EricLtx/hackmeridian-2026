# Open Window: from MVP to a product in operation

This page shows two things. First, what the minimum viable product already proves, with the evidence for each claim. Second, how each later step keeps a working product while it adds safety and reach, and what each step must prove before the next one starts.

## Principles

1. **The product works end to end at every step.** The whole lifecycle exists from the first step: offer, open, repurchase, default, withdrawal. Later steps add safety, operations and reach. They never add the core mechanism.
2. **Exposure grows only with proof.** Caps per repo, per fund and per currency start low, and governance raises them only after a step's exit criteria are met. The contract never has to be redeployed for that.
3. **Users can always leave.** No pause, upgrade or parameter change blocks repurchase, withdrawal of unlent funds, or seizure at maturity. A user can exit at any version.
4. **Interfaces stay compatible.** Error codes and exported types are append-only, storage keys are never renamed, and the contract upgrades in place. Wallets, indexers and scripts keep working across versions.
5. **Every exit criterion can be checked.** Each one is a test, a CI job, a published report or a value read on chain, not an opinion.

## What the MVP proves today

| Claim | Evidence |
|---|---|
| A holder gets stablecoins against fund shares in one transaction, at any hour | `open_repo` on testnet, confirmed in 2 to 6 seconds; demo scene `open`; test `open_moves_shares_in_and_stablecoins_out_in_one_transaction` |
| The loan never exceeds the haircut-adjusted value of the shares | Test `open_lends_exactly_the_ceiling_and_not_one_unit_more`; demo refusal `LoanTooLarge` |
| A wrong price is refused, even when the feed keeps publishing it | Tests `corridor_refuses_a_jump_faster_than_the_maximum_yield`, `reference_cannot_be_ratcheted_by_a_faulty_feed`; demo refusal `PriceOutOfBand` after a NAV published 3 % too high |
| A cross-currency loan works with a live FX feed | Test `cross_currency_repo_opens_and_closes`; testnet fund admitted with the Reflector EUR/USD feed, and a local fallback feed |
| The pause stops entries and never traps funds | Test `repurchase_works_while_paused_and_only_once`; demo: repurchase still allowed while paused |
| The lender is paid principal and interest, or gets the shares at maturity | Tests `repurchase_after_a_weekend_pays_interest_to_the_lender`, `seizure_waits_for_maturity_and_goes_to_an_approved_address`; demo scenes `repurchase` and `seize` |
| The fund issuer keeps control of who holds its shares | Tests `issuer_must_whitelist_the_contract_before_any_repo`, `seizure_delivers_permissioned_shares_to_the_whitelisted_lender` |
| Accounting stays exact under any sequence of operations | Test `invariants_hold_over_random_sequences`: invariants checked after 300 random operations |
| Cost per operation does not grow with usage | Tests `opening_a_repo_touches_a_constant_number_of_entries` and `many_repos_keep_a_constant_footprint_per_operation`: 16 entries read and 9 written by every `open_repo` over 200 repos; on the testnet instance the heaviest opening used 1.66 % of the instructions a transaction may use (validators' metrics, 20 October 2026) |
| The code meets its own security rules | CI on every push: format, WASM build, clippy with warnings as errors, the contract's host tests and the same suite against a WASM with an 8 KiB stack, web build and tests, the tooling's offline tests, RustSec advisories; since 24 October 2026 a pull request runs only the jobs its files need behind one `ci-ok` check, a guard fails on any tracked private path, and a change to a critical path gets a review checklist; internal reviews of versions 2, 3 and 4 with every finding fixed and tested; the security pass of 20 October 2026, whose contract findings the rc5 candidate fixes |

The value for a holder is shown in the demo's last scene. It compares the measured latency with the earliest cash through a fund redemption, at four moments of the week. On a weekday after the cut-off, the redemption route takes about 42 hours. From a Friday evening it takes about 89 hours. Open Window answers within one ledger at any of those moments.

## Steps

### Step 0: proof of mechanism (done, October 2026)

**What works:**
- the full lifecycle, the roles (governor, guardian, steward per fund) and two-key fund admission;
- the model-based NAV corridor and cross-currency pricing with its own FX band and haircut;
- caps per repo, per fund and per currency;
- a scripted live demo on testnet, with a recovery procedure for every failure seen in rehearsal.

**What it retires:** the mechanism risk. The contract does what the product promises on the real network, and refuses what it must refuse.

### Step 1: testnet pilot

**Adds:**
- a minimal web interface: quote, open, repurchase, offers, positions;
- an indexer built from the contract's events;
- the monitoring plan of [threat-model-stride.md](threat-model-stride.md), section 3.1, run against the testnet deployment;
- a written incident procedure: who pauses, how, and how lenders and borrowers are told;
- static analysis with Scout and the OpenZeppelin detectors;
- an upgrade test with a real uploaded WASM;
- a load test that opens many repos.

**Exit criteria:**
- Each monitoring detector has fired at least once on a real trigger, and the matching action was taken.
- Static analysis has no unresolved finding: each one is fixed or justified in [security.md](security.md).
- The upgrade test passes and keeps every open repo intact.
- The interface completes the full cycle with a standard Stellar wallet.

**What it retires:** the operating risk. The team can see, explain and stop what happens on chain.

**Status on 22 October 2026:**

| Item | State | Evidence |
|---|---|---|
| Web interface | Built | `web/`: the full borrower and lender cycles pass on testnet through the interface's own chain module, signed by a test key; since 18 October 2026 an in-page guide per party with the instance's terms read from the chain, a timeline per position fed by the indexer's export, and a phone-width layout; since 19 October 2026 a terminal view for desk users (command line, offer book, tickets with every check before signing, positions blotter, funds, tape of contract events); since 20 October 2026 both views and the History page in English, French and Spanish, published on GitHub Pages with a fallback RPC, and hardened by the security pass of that day (values read from the chain checked before display, content security policy, fees capped before signing); the rc5 candidate adds a check of the fee the wallet signs, a write confirmed on a second endpoint, a lagging endpoint left for a level one, a refusal to run in another site's frame and a footer naming the RPC providers; since 22 October 2026 an Operate space (health, roles, pending proposals) and role chips read from the chain; since 24 October 2026 the Stellar Design System's foundations, a guided tour in thirteen scenes (`tour.html`) with a live scene, loading and empty states, compact dates, clean offer amounts and a positions summary for borrower and lender; a manual run with Freighter by a real user is still to record |
| Indexer | Done, first version (17 October 2026) | `indexer/` keeps every contract event in an append-only journal under a SHA-256 hash chain (`verify` recomputes it), behind a persistent cursor, and exports CSV, a per-repo register and the SFTR columns the chain can fill; the web interface's History page reads its export. The monitor compares the journal with the events an RPC serves; since rc5 both ways and by content, against an endpoint the indexer did not read, as `verify --against <url>` does; runs on the operator's machine |
| Monitoring | Done | Nineteen drills replayed on testnet on 18 October 2026 against the rc4 instance, including a key-compromise, an issuer-freeze, a frozen-NAV and an unannounced-stablecoin drill, with the automatic actions signed by the sentinel key ([incident-procedure.md](incident-procedure.md)). The rc5 monitor has nineteen detectors, tested offline, and takes an action only once a second endpoint confirms it; the nineteen drills were replayed against rc5 on 22 October 2026 after its governed upgrade; the detectors rc5 added have no drill yet |
| Incident procedure | Done | [incident-procedure.md](incident-procedure.md) |
| Static analysis | Partly | Scout: 2 medium and 23 enhancement alerts, all justified; OpenZeppelin detectors not run yet |
| Upgrade test | Done | `upgrade_to_the_built_wasm_keeps_offers_repos_and_roles`; and `an_rc2_instance_upgrades_then_migrates_with_a_repo_open` runs the real rc2 WASM, upgrades it, repays a repo opened before the upgrade and migrates the stored layout. The governed upgrade and the migration were then executed on the testnet instance on 18 October 2026 (`npm run upgrade`) |
| Load test | Done | `many_repos_keep_a_constant_footprint_per_operation`: 200 repos, 16 entries read and 9 written by every `open_repo` |

### Step 2: hardening for real assets

**Adds:**
- a multisig governor with an outside signer;
- a time delay on upgrades and oracle changes;
- on-chain handling of an issuer freeze during an open repo;
- a second NAV source or a fallback rule per fund;
- a bug bounty sized to the value at stake, on top of the disclosure policy already published in `SECURITY.md`;
- a third-party audit of the code that will run on mainnet.

**Exit criteria:**
- The audit report is published, and every critical, high and medium finding is fixed.
- The deployed code is the audited code; any significant change triggers a targeted review.
- A key compromise drill shows the time delay gives enough time to pause and react.

**What it retires:** the governance risk and the residual code risk.

**Status on 22 October 2026:**

| Item | State | Evidence |
|---|---|---|
| Multisig governor | Done on testnet; custody not done | 2-of-2 native account with a co-signer; both signing paths succeed, a single key is refused with `txBadAuth`. The demo holds both keys on one machine: real custody (separate people and hardware devices) is the critical path to any deployment that holds value. Since 17 October 2026 the ceremony is tooled (`npm run keys`: unsigned atomic setOptions plan, read-back, testnet rehearsal with minutes) and the key policy is summarised in [security.md](security.md), section 6.4 |
| Time delay | Done, version 3; stablecoin registry behind the delay since rc4 | Upgrades, feed changes, re-anchoring, a new guardian, stablecoin registrations after the first admission and every loosening wait 48 hours by default, are cancellable, and expire after seven days; tightening is immediate. In the rc5 candidate the governor in office applies a stablecoin registration, and an upgrade proposed before the first admission is cancelled at it |
| Schema version and migration | Done, rc4 | The contract stores a schema version; `migrate` (governor and trustee) transforms the stored layout after an upgrade; entries refuse to open while the layout is outdated, exits never check. Demonstrated on testnet on 18 October 2026 |
| Sentinel | Done, rc4 | A hot key named by the guardian that can pause and cancel proposals, and nothing else; the monitoring host acts with it, so the guardian key leaves that host |
| Several funds and stablecoins as data | Done, 18 October 2026 | Two funds (a dollar T-bill share with an FX leg, a euro money market share without one) and two euro stablecoins sharing one currency cap, admitted on the same testnet instance without a code change |
| Issuer freeze | Done, version 3 | Debt settles, shares are recorded and delivered once the issuer allows it; rehearsed on testnet |
| Backup NAV feed | Done, version 3 | Stands in for a stale primary, must agree with a fresh one; in rc5 it is never the primary itself and is installed only against a fresh primary it agrees with |
| Key compromise drill | Done | An unannounced upgrade proposed with the governor keys was cancelled by the guardian 6 seconds later, with 295 of the 300 seconds of the testnet delay left |
| Internal reviews | Done | Three passes on version 3 and two on version 4, every finding fixed with a test; the security pass of 20 October 2026, and the adversarial review of the merged rc5 candidate the same day, 24 findings each fixed with a test, then two check rounds on the fixes |
| Security pass of 20 October 2026 | Done; contract fixes in rc5 | Over rc4, its RPC path, the web interface and the tooling: the web and the tooling hardened the same day; the contract's findings fixed in the rc5 candidate (decisions S30 to S34 and amendments in [security.md](security.md)), which passed its adversarial review the same day, is the tag `audit-v4-rc5` and runs on the testnet instance since the governed upgrade of 22 October 2026; a stablecoin freeze on the cash leg and the pooled share balance wait for an interface change (version 2); the restore of an archived code entry on mainnet is to check before any mainnet deployment ([threat-model-stride.md](threat-model-stride.md#32-security-pass-of-20-october-2026)) |
| Real-time profile | Done, rc5 | A 64 KiB WASM stack instead of 1 MiB: 122,880 instructions and 983,040 bytes of memory saved on every call, measured on the testnet instance after the upgrade of 22 October 2026 (`version()` simulated at 828,021 instructions against 949,251 under rc4); every user-facing call checked against a budget on the release WASM; a CI canary runs the whole suite on an 8 KiB stack |
| Lenders independent of the fund | Done, version 4 | The issuer can never lend against its fund; lenders attested before approval; an instance can be fixed to a single regulated lender (mode D3); shown live in the demo |
| Custody safeguards in the contract | Done, version 4 | Governor handover behind the delay with a guardian veto; guardian handover only to a registered backup; lost steward key recovered only to the issuer's own backup, after 30 days, with governor and guardian. Devices and signers are still to set up |
| Audit package | Ready, for the tag `audit-v4-rc5` | [audit-scope.md](audit-scope.md) |
| Third-party audit | Not started | Needs an auditor and a budget |
| Bug bounty | Not started | Needs a budget sized to the value at stake |

Found on the way and fixed: operations used to extend the contract's code entry, whose rent grows with its size. On testnet the user who crossed the extension threshold would have paid about 530 XLM (14 October 2026), more than one transaction may carry. The contract now extends only its instance, and the operator keeps the code alive (decision S20 in [security.md](security.md)): at the testnet rate read on 20 October 2026, one 30-day slice costs about 250 XLM for the rc4 code and 257 XLM for rc5's (the rate moved from 7.15 to 8.40 XLM a day within the day), so the monitor extends the code when it has less than 90 days to live, under a fee cap of 400 XLM per slice, and keeps the keeper's float above 800 XLM, the rent of one upgrade run.

### Step 3: guarded launch

**Adds:**
- deployment on mainnet with one fund, one stablecoin and allowlisted participants only;
- low caps and the lender's reserve, held off chain by agreement (S16);
- monitoring in production with pause on alert;
- a public risk page: audits, privileged roles, dependencies, incident history.

**Exit criteria for raising the caps:**
- A continuous operating period without an unexplained incident.
- The share balance of the contract always equal to the sum of open repos, checked by monitoring (invariant I2).
- Every repo closed by repurchase or seizure as designed.

**What it retires:** the market risk, under bounded exposure.

### Step 4: extension

**Adds, each one behind its own review and with no change to existing interfaces:**
- more funds and issuers, each admitted with two keys and its own feeds and limits;
- a second loan currency;
- partial repurchase and rollover;
- a confidentiality track for amounts.

**What it retires:** the concentration risk on one fund or one issuer.

## Next developments, sorted MoSCoW

Sorted on 18 October 2026 and re-read on 22 October 2026, once the code was frozen at the tag `audit-v4-rc5` and installed on the testnet instance. "Must" items gate the guarded launch; nothing below changes the contract before the external audit, except a fix a review requires: rc5 was such a fix, from the security pass of 20 October 2026, under its own tag.

**Must**
- External audit of the frozen tag `audit-v4-rc5` (adversarial review passed on 20 October 2026, on testnet since 22 October 2026); every critical, high and medium finding fixed, each on its own commit.
- Key custody on hardware with separate signers: governor signers, guardian, sentinel and keeper keys off the development machine; the ceremony replayed on devices; the monitor's witness on a second host.
- A NAV feed for the pilot fund published to a SEP-40 interface, with the freshness policy written into the fund's admission.
- One public story: the reserve of step 3 is the lender's own, held off chain by agreement and sized from the maximum-loss scenarios (S16, amended 18 October 2026).
- A second maintainer with keys, so that no role depends on one person.

**Should**
- Two RPC providers chosen for production: the rc5 monitor confirms every automatic action on a second endpoint (the testnet default uses two public ones), and a mainnet exchange-rate log can be kept.
- The indexer anchored and compared with an independent endpoint on a schedule (`verify --against <url>`, rc5); `verify` run periodically.
- The SFTR export checked with a reporting team; the master agreement and the DORA clauses signed.
- The web interface completed by a real user with a standard wallet; the timelines, the phone-width layout and the terminal view are built (18 and 19 October 2026).
- A deployment kit for an instance operator: runbooks for deployment, admission, daily operation and upgrades (including the inventory of funds that a tightened admission rule would refuse) and an off-chain instance register are in [operations.md](operations.md) with `npm run inventory` (18 October 2026); a setup that signs every governor step from an external account remains to do.
- A third-party SEP-41 share admitted on testnet, then a real issuer's testnet share.

**Could** (after the audit, as version 2 behind `migrate`)
- A fixed-repurchase-date offer mode; an irrevocable-commitment event at opening; a holding address per lender, if legal review asks for them.
- Formal verification of the interest and haircut arithmetic; instruction measurements on the real WASM.
- Partial repurchase and rollover; a second loan currency; a confidentiality track for amounts.
- A read-only risk assistant, off chain, that suggests bounded parameter changes and applies none: it needs no contract change, and each suggestion goes through a human proposal and the time delay like any other change.

**Won't** (this cycle)
- A multi-lender instance operated by the project: one regulated lender per instance, by design.
- Automatic liquidation or margin calls: a fixed-term bilateral repo does not need them, and exits must never block.
- An on-chain commission: it would finance nothing at the pilot's scale.
- Pooled lending, or stablecoins outside the MiCA allowlist.
- A deployment factory before several instances exist.
- A soroban-sdk upgrade before the audit intake: it changes the hash of the frozen code.

## The order of proof, from here to the guarded launch

The MoSCoW list says what; this says in which order, and what stops the sequence. Each step starts when the previous one's exit criterion is met; each has a stop rule, so that a missing proof is seen before money or exposure follows it. Dates are deliberately absent: every step below depends on a third party, and the only dates the project controls are the testnet network resets and its own releases.

| # | Step | Exit criterion | Stop rule |
|---|---|---|---|
| 1 | A second maintainer with keys; the custody ceremony replayed on hardware devices in the two-person configuration | signed ceremony record; the governor's second signature held by another person on another device; the backup device sealed off line | no second person: the project stays single-person, says so publicly, and no step beyond 4 starts |
| 2 | Counsel's written opinion on the three structuring questions (the repo's qualification, the issuer's prohibition to lend, the platform-scope question) | opinion received; each fallback either triggered or declined in writing | a fallback changes the frozen interface: a new candidate, a new review and a new tag before any audit |
| 3 | Testnet redeployment after the network reset of December 2026, with the second signer in the ceremony | three funds and two stablecoins re-admitted; indexer and anchor restarted; the nineteen drills green | — |
| 4 | External audit of the tag, intake package first | report received; every critical, high and medium finding fixed on its own commit; re-tag only if a fix touches the interface | a finding that changes the mechanism: back to internal review before any launch |
| 5 | Signable documents: master agreement with its technical annex, terms of use, attestation declaration; a legal entity and LEI | documents read by counsel; the issuer's register letter drafted | — |
| 6 | A regulated lender with a written rate quote and an issuer as steward with a SEP-40 NAV feed, both under letters of intent; three treasurer interviews | two letters; the fund's freshness policy written into its admission; interviews on file | no letter after a set number of formal contacts: the lender profile and the operating mode are reviewed before any bounty or hardware spend |
| 7 | Bug bounty sized to the launch caps, then the first real repo under the step 3 caps | pool funded and rules published; one repo opened and closed with the SFTR report filed the next business day; a joint incident drill with the lender and the issuer | caps stay at their floor until the three-month compliance review |

What this order protects: the two scarcest resources are the maintainer's time and the trust of the first lender and issuer. Steps 1 and 2 cost little and unblock everything; steps 4 and 5 can run in parallel once 2 is done; step 6 is the one that cannot be forced, and its stop rule is the honest one.

## Running it over time

These tasks run continuously from step 1 on. Each one has an owner in the incident procedure.

| Task | Rule |
|---|---|
| SDK and protocol | Stay within the two latest major versions of `soroban-sdk`, the ones that get security fixes; rebuild and rerun the tests at every protocol upgrade |
| Storage | Entries are extended on every write; monitoring alerts when an open entry has under 14 days left, and the contract code under 90 days |
| Feeds | Freshness and drift watched per fund; a stale feed stops new repos and never forces a liquidation; a price reference older than its NAV age bound is stepped by the keeper (rc5) |
| Keys | Governor and guardian keys rotated through the two-step handover, never shared between roles |
| Dependencies | Dependabot updates reviewed as pull requests; RustSec advisories checked in CI |
| Testnet | Network resets are planned for: `npm run setup` rebuilds the demo from nothing |

## Where the details are

- [architecture.md](architecture.md): the map of the system, with diagrams.
- [security.md](security.md): security baseline, decisions S1 to S34, maximum loss, DORA.
- [threat-model-stride.md](threat-model-stride.md): threat model and monitoring plan.
- [incident-procedure.md](incident-procedure.md): who acts, how and within what time when an alert fires.
- [interface-reference.md](interface-reference.md): every entry point, type and error, in long form.
- [audit-scope.md](audit-scope.md): what an external auditor needs; the testnet runs the tag `audit-v4-rc5` since 22 October 2026, and its size, hash and test counts are described there.
- [operations.md](operations.md): running an instance as its operator, with the pre-upgrade inventory and the instance register.
- [faq.md](faq.md): questions and answers for users, the Stellar ecosystem, engineers and security reviewers.
- [demo/README.md](../demo/README.md): the live testnet demo and its recovery procedures.
