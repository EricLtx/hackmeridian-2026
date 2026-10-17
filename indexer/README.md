# Open Window event indexer

An append-only journal of every event the Open Window contract emits on Stellar testnet, kept beyond the few days the public RPC retains, with a hash chain over the lines and exports rebuilt from the events alone: a flat event table, a repo registry and an SFTR-shaped table. It is the contract's black box: once a line is written it is never changed, and `verify` proves it.

The indexer reads the chain and writes files. It holds no key and signs nothing.

## Prerequisites

- Node.js 20 or later.
- `npm install` in this folder.
- A contract id: `--contract C...`, or the demo deployment read from `../demo/.state/testnet.json` (field `contracts.openWindow`).

The journal and the exports go to `indexer/.state/`, which is git-ignored.

## Commands

```sh
npm run index                        # one pass: fetch new events, append them
npm run index -- --watch             # a pass every 30 s
npm run index -- --contract C...     # another contract
npm run verify                       # recompute the hash chain, print count and last hash
npm run export -- --csv              # .state/events.csv
npm run export -- --view registre    # .state/registre.csv, one row per repo
npm run export -- --view sftr        # .state/sftr.csv
npm run export -- --json             # .state/export.json
npm run export -- --json --web       # also copies it to ../web/public/history.json
npm test                             # hash chain and views, offline
```

`--state <dir>` points every command at another folder, for a second contract or a second copy.

RPC endpoints: `STELLAR_RPC_URLS` (comma-separated, tried in order on a network error, a timeout, a 429 or a 5xx), else `STELLAR_RPC_URL`, else `https://soroban-testnet.stellar.org`. A request the RPC refuses for another reason is not retried.

## How a pass works

1. The journal is read and its chain verified; a broken chain stops the pass.
2. Resume point: the id of the last journaled event, as the RPC's pagination cursor. On the first run, the oldest ledger the RPC still serves (`getHealth().oldestLedger`); if the RPC answers that the start is outside its window, the pass begins at the oldest ledger it names.
3. `getEvents` is paged to the latest ledger. The public RPC scans at most about 10,000 ledgers per request and returns a cursor even when the stretch holds no event, so the pass follows the cursor until it reaches the latest ledger.
4. Each new event is decoded, chained to the previous line and appended. An event whose id is already in the journal is skipped, so a rerun or a crash between the append and the cursor write never duplicates a line.
5. `cursor.json` is rewritten: last ledger, last event id, last hash, the RPC's latest and oldest ledgers, and the declared gaps. It is a cache; the journal is the authority on where to resume.

If the ledger right after the last journaled event is no longer served, the pass starts at the oldest ledger kept and records the stretch in `cursor.json` (`gaps`); `verify` prints it. Events in that stretch are lost for this copy, which is why the watch mode exists: run it from more than one place, and compare the last hash.

## Journal format

`indexer/.state/events-YYYY-MM.jsonl` (month of the ledger close time, UTC), one JSON object per line:

| Field | Content |
|---|---|
| `seq` | 1-based line number over the whole journal, across files |
| `ledger` | ledger sequence |
| `closedAt` | ledger close time, as the RPC reports it (`2026-10-15T21:44:57Z`); the contract's `env.ledger().timestamp()` |
| `txHash` | transaction hash, hex |
| `id` | RPC event id (`<toid>-<index>`); the pagination cursor |
| `contract` | the contract id |
| `topics` | decoded topics: the event name, then the `#[topic]` fields in the order of `contracts/night-window/src/events.rs` |
| `data` | the other fields of the event, decoded, as a map |
| `prevHash` | the previous line's `hash`; 64 zeros on the first line |
| `hash` | `sha256(prevHash + canonical JSON of the line without hash)` |

Decoding: addresses and symbols as strings, `i128` and `u64` as decimal strings (amounts in token units, 7 decimals for the demo tokens), `u32` as numbers, bytes (`BytesN<32>`, a code hash) as hex, enum variants as `[name, value]`. Canonical JSON means object keys sorted at every depth and no whitespace, so the hash does not depend on how the line was written.

Event names are the contract's `#[contractevent]` struct names in snake case: `repo_opened`, `repo_repurchased`, `repo_seized`, `release_deferred`, `release_redirected`, `shares_released`, `offer_created`, `offer_withdrawn`, `fund_set`, `fund_limits_set`, `stablecoin_set`, `pause_changed`, `upgrade_proposed`, and so on. The list is `events.rs`.

## The hash chain

Each line commits to the previous one. Changing a field changes that line's hash and breaks the next line's `prevHash`; removing a line breaks the `seq` sequence; recomputing a tampered line's hash moves the break to the next line; inserting a line out of ledger order is refused. `npm run verify` re-reads every file, recomputes the chain and prints the line count and the last hash, or the first line that does not fit.

The last hash is the integrity proof: publish it (a timestamped mail, a ticket, a second machine) and anyone with a copy of the files can check that nothing was altered since. The chain proves that the journal was not changed after the fact; it does not prove that it is complete, which is what the declared gaps and a second indexer are for.

## Views

Every column comes from an event. Nothing is read from contract storage, and a field the chain does not carry stays empty; the `source` column lists the events used (`repo_opened@17` is line 17) and names what was not found.

**Registry** (`registre.csv`), one row per repo: `repo_id`, `lender`, `borrower`, `fund`, `shares`, `principal`, `stablecoin`, `currency`, `rate_bps`, `opened_at`, `maturity`, `status`, `closure`, `closed_at`, `interest`, `release_to`, `release_shares`, `last_tx`, `source`.

- `repo_opened` gives the borrower (topic), the lender, the fund, the shares, the principal, the rate and the maturity; `opened_at` is its ledger close time.
- The stablecoin is not in `repo_opened`: it comes from the `offer_created` event of the repo's `offer_id`, and the currency from the `stablecoin_set` event of that stablecoin. Both must be in the journal.
- `status`: `open`, `repurchased` (`repo_repurchased`), `seized` (`repo_seized`), `release_pending` (`release_deferred` not yet followed by `shares_released`; `closure` keeps how the repo closed). `release_redirected` updates `release_to`.
- A repo whose `repo_opened` is before the first journaled ledger still appears, with the fields its later events carry and `repo_opened not in chain` in `source`.

**SFTR** (`sftr.csv`), the fields of Regulation (EU) 2015/2365 reporting that the chain can fill: `uti` (the repo id), `sft_type` (`REPO`), `action_type` (`NEWT` while open, `ETRM` once repurchased or seized), `execution_timestamp` and `value_date` (the opening; both legs settle in one transaction), `maturity_date`, `termination_date`, `principal_amount_value_date`, `principal_amount_maturity_date` (principal plus interest, repurchases only), `principal_currency`, `fixed_rate_pct` and `rate_bps`, `collateral_type` (`FUND_SHARES`), `collateral_component` (the share token), `collateral_quantity`, `collateral_haircut_bps` (the fund's haircut from the latest `fund_set` or `fund_limits_set` before the opening), `settlement_venue`, `source`. `reporting_counterparty_side` is `COLLATERAL_TAKER` from the lender's point of view.

### What the chain does not carry

These SFTR fields stay empty; they belong to the parties' own records:

- LEI of the reporting counterparty and of the other counterparty: the chain holds Stellar addresses, not legal entities.
- Master agreement type and version, and the reference of the agreement between lender and borrower.
- Branch, sector and country of the counterparties, beneficiary, broker, CSD participant, tri-party agent.
- Collateral ISIN, issuer LEI, quality and market value: the chain identifies the fund by its token address and counts shares; the NAV used at opening is not in `repo_opened`.
- Floating-rate fields (every repo has a fixed rate), rate reset, spread, margin lending and reuse fields.
- The exact amount repaid when a repurchase is settled while the token refuses the delivery: `repo_repurchased` carries principal and interest, the deferred shares are in `release_deferred`.

**Flat table** (`events.csv`): one row per line, with the event name, the topics (without the name) and the data as JSON, plus `prevHash` and `hash`.

**Web export** (`export.json`): journal summary (lines, first and last ledgers, last hash, gaps), the registry, and the 200 most recent events, newest first. `--web` copies it to `web/public/history.json`, which `web/history.html` reads at runtime like `deployment.testnet.json`; the file is git-ignored.

## Limits

- A copy of the journal is only as complete as the RPC windows it saw: if the indexer is down longer than the RPC's event retention (about a week on the public testnet endpoint, sometimes less), a gap is declared, not filled. Run `--watch` continuously, or from two places.
- The RPC is trusted for the content of the events; the chain protects the journal after it is written. A second copy from another RPC with the same last hash is the cross-check.
- Order follows the RPC's event ids (ledger, transaction, operation, event index). Two events of one transaction keep that order.
- The journal is one contract's. Another contract needs `--state <dir>`.
- Amounts are raw token units; the decimals of each token are not in the events (the web page reads them from `deployment.testnet.json`).
