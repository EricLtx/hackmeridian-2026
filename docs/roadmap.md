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
| Cost per operation does not grow with usage | Test `opening_a_repo_touches_a_constant_number_of_entries`: 17 entries read and 9 written, whatever the number of open repos |
| The code meets its own security rules | CI on every push: format, clippy with warnings as errors, 106 tests, WASM build, RustSec advisories; independent review with every finding fixed and tested |

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
- the monitoring plan of [modele-menace-stride.md](modele-menace-stride.md), section 3.1, run against the testnet deployment;
- a written incident procedure: who pauses, how, and how lenders and borrowers are told;
- static analysis with Scout and the OpenZeppelin detectors;
- an upgrade test with a real uploaded WASM;
- a load test that opens many repos.

**Exit criteria:**
- Each monitoring detector has fired at least once on a real trigger, and the matching action was taken.
- Static analysis has no unresolved finding: each one is fixed or justified in [securite.md](securite.md).
- The upgrade test passes and keeps every open repo intact.
- The interface completes the full cycle with a standard Stellar wallet.

**What it retires:** the operating risk. The team can see, explain and stop what happens on chain.

### Step 2: hardening for real assets

**Adds:**
- a multisig governor with an outside signer;
- a time delay on upgrades and oracle changes;
- on-chain handling of an issuer freeze during an open repo, version 1.1;
- a second NAV source or a fallback rule per fund;
- a bug bounty sized to the value at stake, on top of the disclosure policy already published in `SECURITY.md`;
- a third-party audit of the code that will run on mainnet.

**Exit criteria:**
- The audit report is published, and every critical, high and medium finding is fixed.
- The deployed code is the audited code; any significant change triggers a targeted review.
- A key compromise drill shows the time delay gives enough time to pause and react.

**What it retires:** the governance risk and the residual code risk.

### Step 3: guarded launch

**Adds:**
- deployment on mainnet with one fund, one stablecoin and allowlisted participants only;
- low caps and a first-loss buffer;
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

## Running it over time

These tasks run continuously from step 1 on. Each one has an owner in the incident procedure.

| Task | Rule |
|---|---|
| SDK and protocol | Stay within the two latest major versions of `soroban-sdk`, the ones that get security fixes; rebuild and rerun the tests at every protocol upgrade |
| Storage | Entries are extended on every write; monitoring alerts when an open entry has under 14 days left |
| Feeds | Freshness and drift watched per fund; a stale feed stops new repos and never forces a liquidation |
| Keys | Governor and guardian keys rotated through the two-step handover, never shared between roles |
| Dependencies | Dependabot updates reviewed as pull requests; RustSec advisories checked in CI |
| Testnet | Network resets are planned for: `npm run setup` rebuilds the demo from nothing |

## Where the details are

- [securite.md](securite.md): security baseline, decisions S1 to S19, maximum loss, DORA (French).
- [modele-menace-stride.md](modele-menace-stride.md): threat model and monitoring plan (French).
- [faq.md](faq.md): questions and answers for users, the Stellar ecosystem, engineers and security reviewers.
- [demo/README.md](../demo/README.md): the live testnet demo and its recovery procedures.
