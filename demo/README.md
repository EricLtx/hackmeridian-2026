# Open Window testnet demo

A terminal demo that drives the three workspace contracts on Stellar testnet: the fund share token (`fund-token`), the operator NAV feed (`nav-oracle`) and Open Window (`night-window`). The euro leg uses a test stablecoin, tEUR, and the EUR/USD rate comes from the Reflector fiat feed on testnet, or from a local fallback feed.

Feeds, fund settings, offers, balances, latencies and fees are read from the chain at the moment they are shown. Two figures are computed by the script: the weekend cost, with the contract's own interest formula, and the bank-route comparison of the last scene, from a redemption cut-off time.

## Prerequisites

- Node.js 20 or later.
- The contracts built from the workspace root with `stellar contract build`. The scripts load the WASM files from `target/wasm32v1-none/release/`.
- `npm install` in this folder.

Keys and contract addresses are written to `demo/.state/testnet.json`. The folder is git-ignored and holds testnet keys only.

## Commands

```sh
npm run setup                    # deploy and configure; resumes after a failure
npm run setup -- --restage       # new short repo for the seizure scene
npm run setup -- --fx=local      # re-admit the fund on the local FX feed
npm run setup -- --fx=reflector  # back to the Reflector FX feed
npm run setup -- --fresh         # new contracts, same funded accounts
npm run setup -- --multisig      # governor becomes a 2-of-2 account with an outside co-signer
npm run setup -- --second-fund   # admit a second fund (euro MMF share, own issuer and feed, no FX leg) and a second euro stablecoin
npm run status                   # the board only
npm run demo -- --only=second    # a repo on the second fund, in the second stablecoin (after --second-fund)
npm run demo                     # every scene, Enter between scenes
npm run demo -- --auto           # no pauses, for rehearsal or recording
npm run demo -- --only=open,repurchase
npm run demo -- --only=repair    # unpause, fix the NAV, close the live repo
npm run onboard -- G...ADDRESS   # let an outside wallet use the web interface (--role=lender for a lender)
npm run monitor -- --watch --act # monitoring: alerts every 30 s, pause on a critical alert, TTL extension
npm run monitor -- --rehearse    # fire every detector with a real trigger, act, restore
npm run monitor -- --witness     # second instance elsewhere: alerts, never acts (refuses --act)
npm run keys -- --rehearse       # key ceremony: --plan builds the unsigned multisig setOptions transaction, --readback checks an account, --rehearse replays it on testnet
npm run upgrade                  # governed upgrade: upload the built WASM, propose (governor + trustee), announce, wait, upgrade, migrate; --propose / --apply split it
npm run setup -- --sentinel      # the guardian names the monitoring key as sentinel (rc4): it may only pause and cancel
```

`setup` records each completed step in the state file. When the network drops, rerun the same command: finished steps are skipped, and the steps that move funds check balances first, so nothing is paid or minted twice.

The seizure scene needs a repo past its maturity. The shortest term the contract accepts is one hour, so run `setup` (or `setup -- --restage`) at least one hour before the demo.

## Scenes

| Scene | What happens on chain | What it shows |
|---|---|---|
| `board` | Reads; the operator republishes the NAV when it is over an hour old or wrong | Feeds and their age, the fund settings, the NAV reference, a quote, offers, caps, pause state, open repos |
| `open` | `open_repo` on the cheapest offer with enough funds, the offer the issuer designates first | One transaction, latency measured, balances before and after |
| `guardrails` | Wrong NAV published then corrected; pause by the guardian, unpause by the governor | `LoanTooLarge`, `PriceOutOfBand`, `Paused` refusals; repurchase still allowed while paused |
| `repurchase` | `repurchase` of the repo opened above | Interest per started hour; principal and interest return to the offer |
| `seize` | `seize` of the staged repo, or the `NotMatured` refusal before maturity | Seizure only to an address the issuer approved |
| `value` | Reads only | The same need through a fund redemption at four moments of the week, against the measured latency |
| `repair` | Unpause, NAV republished, live repo repurchased, each when needed | A clean state after an interrupted run |
| `second` | `open_repo` on the second fund through the offer in the second stablecoin, then `repurchase`; needs `setup -- --second-fund` | Two issuers, two NAV feeds, two stablecoins sharing one currency cap, the same contract; the offer that lists both funds |

Refusals are shown by simulation: the transaction is built and simulated, the contract returns its typed error, nothing is submitted. Simulation does not check signatures, so the demo never uses it to show an authorization refusal. An error raised by another contract (the share token, the NAV feed, the stablecoin) is named after that contract, so it is never mistaken for an Open Window refusal.

The two cleanup steps of `guardrails`, the NAV correction and the unpause, are retried three times and then checked on chain. If either did not take, the scene prints a red line with the repair command.

## Day of a live demo

The evening before: fund every demo account (≥ 50 XLM), run one monitor pass (no TTL alert), play the full rehearsal, `setup -- --restage`, then `demo -- --auto` and `demo -- --only=second --auto` end to end; refresh the indexer (`index`, `verify --anchors`, `anchor`) and rebuild the web interface; save the text output of every scene and a screen recording as fallbacks. One hour before: `setup -- --restage` again (the seizure repo must mature during the talk), `npm run status`, the monitor in `--watch` mode without `--act`. On stage, one scene per command, `board` → `open` → `guardrails` → `repurchase` → `seize` → `second` → `value`. Fallbacks: a second endpoint in `STELLAR_RPC_URLS` (automatic failover); `setup -- --fx=local` if the exchange-rate feed is down (before the talk: it re-admits the fund through the time delay); `demo -- --only=repair` for a dirty state; the recording and the saved outputs if the network is gone.

## How a transaction is confirmed

Each transaction is valid for 60 seconds. The script waits until it has landed or until the ledger has closed past that window, then reports one of two outcomes: confirmed, with its link, or expired, in which case nothing changed on chain. A lost response, a resend the network refuses because the first copy already applied, or a congested queue are resolved by looking the transaction up by its hash. A rerun therefore never repeats a step that landed late.

## Demo parameters

The fund is admitted with the settings in `config.mjs`; the board reads them back from the contract.

| Setting | Value | Why |
|---|---|---|
| Fund haircut | 2 % | Covers a NAV move far larger than a money market fund makes in a week |
| FX haircut | 2 % | Covers a weekend EUR/USD gap; FX markets are closed while the chain is open |
| FX band | ±2 % around the rate at admission, never wider than the FX haircut | A rate outside it is treated as a faulty feed; a rate inside it stays covered by the haircut. Re-admission with `setup -- --fx=…` or a two-key re-anchor resets it |
| NAV max age | 26 hours | One daily publication plus two hours of slack |
| FX max age | 3 days | Spans a weekend if the FX feed stops on Friday evening |
| Corridor floor | 0.1 % | The NAV may dip this much below its reference |
| Model growth cap | 5 % a year | Above any money market yield; a jump beyond it is refused |
| Cap per repo, per fund | 100,000 / 500,000 tEUR | Bounds what one wrong price can cost |
| Currency cap | 1,000,000 tEUR | Bounds the whole euro book |

## When something fails

| Symptom | Cause | Action |
|---|---|---|
| `network: … retry` lines | RPC or connection drop | None: reads are retried three times with backoff, submissions until they land or expire |
| `expired before landing` | Testnet congestion | Rerun the scene: nothing changed on chain |
| `Entries are paused` | A run stopped between pause and unpause | `npm run demo -- --only=repair` |
| `The wrong NAV may still be live` | The NAV correction did not take | `npm run demo -- --only=repair` |
| `StalePrice` | NAV older than 26 h, or FX older than 3 days | `npm run status` republishes the NAV; for FX, `setup -- --fx=local` |
| `PriceOutOfBand` outside the guardrails scene | EUR/USD moved more than 2 % since admission | `setup -- --fx=local`, or back with `--fx=reflector`: re-admission anchors today's rate |
| `Repo #n from an earlier run is still open` | A rehearsal opened a repo and did not repurchase it | `npm run demo -- --only=repurchase` |
| `No offer has enough funds left` | Offers drained by repeated runs | `setup -- --fresh` |
| `Repo #n is Defaulted` | The staged repo was already seized | `setup -- --restage`, then wait one hour |
| `Setup failed: … account` | Testnet reset; accounts and contracts are gone | Delete `demo/.state/testnet.json`, run `setup` again |

Re-admission anchors the NAV reference on the live NAV, so run `repair` before `setup -- --fx=…` if a wrong NAV might be live.

## Version 3 governance in the demo

`setup` sets the contract's time delay to 5 minutes before the first fund is admitted (`config.mjs`), so changes can be shown live; a real deployment keeps 48 hours or more. With `--multisig`, the governor needs two keys for every action. After admission, replacing the fund, raising a cap or appointing a guardian is a proposal: `setup -- --fx=…` proposes the replacement, waits for the delay, then applies it. The operator extends the contract code itself, by 30 days at a time, because the contract never extends its own code.

## Monitoring

`monitor.mjs` implements the monitoring plan of [docs/modele-menace-stride.md](../docs/modele-menace-stride.md), section 3.1. Thirteen detectors, each run for every admitted fund the state file knows, cover the price, a stored layout left behind by an upgrade without `migrate` (rc4), a NAV that keeps its value publication after publication (`--nav-frozen-hours=` sets the threshold, 72 h by default; raise it for a constant-NAV fund), the share reconciliation of invariant I2 (including shares held back by an issuer freeze), privileged changes, pending proposals, governor handovers, forced guardian changes and code upgrades, the pause, storage time to live (contract code and the lender approvals a seizure reads included), exposure against fund caps and currency caps, the event trail of each repo, an exchange rate that keeps its value while its timestamp is refreshed (a closed market looks fresh to the contract; the FX band and haircut bound it), the float of the keeper that pays the rent, and two cross-checks between redundant sources (two sources, one arbiter):

- `rpc` (threat `Infra.1`): when `STELLAR_RPC_URLS` lists several endpoints, every pass asks each one for its latest ledger, in parallel. An endpoint that does not answer within 10 s, or two endpoints more than 10 ledgers apart, raise a warning: one of them is stale or not on the same network. With a single endpoint there is no cross-check, and the monitor says so once at startup. The STRIDE table has no row for the reading infrastructure yet; `Infra.1` names it until that row exists.
- `journal` (threat `Repud.2`): when the indexer's journal exists (`indexer/.state/`, or `INDEXER_STATE_DIR`), every event the RPC served must be in the journal once the journal covers its ledger (last journaled ledger at or past the event's). An event present at the RPC and absent from the covered journal is a warning: run the indexer, then compare; a persistent gap means a stalled or tampered journal. Events the journal does not cover yet wait in memory and are checked on a later pass; nothing is raised when there is no journal. The journal is read incrementally: only the files of the current and the previous month, from where the last pass stopped.

The rehearsal (`npm run monitor -- --rehearse`) plays nineteen drills, one trigger per detector, among them a key compromise (an unannounced upgrade proposal, cancelled by the guardian inside the delay), an issuer freeze, a diverging backup feed, a two-key re-anchor, a governor handover vetoed by the guardian, a forced guardian change vetoed by the trustee, lender approvals near archival extended before a seizure could need them, a NAV identical across passes, an unannounced stablecoin registration withdrawn by the sentinel, and the sentinel's limits (it pauses, it cannot veto). With rc4 code and `setup -- --sentinel`, the automatic pause and cancellations are signed by the sentinel key, so the guardian key leaves the monitoring host; vetoes stay with the guardian and the trustee. The two cross-checks have no drill: a second endpoint pointed at an unreachable address, or a copy of the journal missing a line, fires them. With `--act`, a critical price or reconciliation alert makes the guardian pause new entries, an unannounced upgrade is cancelled, an unexpected handover or forced guardian change is vetoed, and entries near archival are extended (the contract code by the keeper). Nothing else is automatic: unpausing stays a decision for the governor. What to do for each alert is in [docs/procedure-incident.md](../docs/procedure-incident.md).

Modes: `npm run monitor` is one pass; `--watch` is a pass every 30 s; `--act` adds the automatic actions; `--rehearse` plays the drills. `--witness` is a watch for a second instance on another machine: it alerts and never acts (it refuses `--act` and `--rehearse` with an error), writes to its own files (`demo/.state/monitor-witness.json`, `demo/.state/alerts-witness.jsonl`), sends its heartbeat to `HEARTBEAT_WITNESS_URL` and tags every line with `[witness]`. Two witnesses, one actor: when only one of them alerts on a ledger, investigate.

## Outside wallets

`setup` writes the public facts of the deployment to `web/public/deployment.testnet.json` for the web interface. A wallet that is not one of the demo keys needs the fund issuer's allowlist and some test assets: add the tEUR trustline from the web interface, then run `npm run onboard -- G...ADDRESS`. A borrower receives fund shares and a little tEUR for interest; a lender with `--role=lender` receives the steward's approval and tEUR to lend.

## Optional settings

`STELLAR_RPC_URLS` lists several RPC endpoints of the same network, comma separated, tried in order: a call that fails with a network error, a 429 or 5xx, or a transient "Account not found" on a live account moves to the next endpoint, which then stays active. With several endpoints the monitor also compares their ledger heights on every pass (detector `rpc`). `STELLAR_RPC_URL` names a single endpoint; the default is the public SDF testnet RPC. `HEARTBEAT_URL` (monitor), `HEARTBEAT_WITNESS_URL` (monitor in `--witness` mode) and `HEARTBEAT_FX_URL` (FX log) are fetched after every successful pass, so an external service such as Healthchecks.io or an Uptime Kuma push monitor can alert when a watcher dies; nothing is sent when they are unset. `INDEXER_STATE_DIR` points the monitor's journal cross-check at a copy of the indexer's journal kept elsewhere (the indexer's `--state <dir>`); the default is `indexer/.state/` in this repository.

The `value` scene reads `private/demo/value-panel.json` when it exists: `cutoff` (`"HH:MM"`), `settlementBusinessDays`, `timeZone`, `notes`, a list of lines printed under the comparison, and `roi`: `reserve`, `fundYield`, `borrow`, `weekendHours`, `weekendsPerYear` and `scenarioRates`. With `roi`, the scene prices a weekend loan with the contract's own interest rule at the live offers' rates and at the scenario rates, derives the treasurer's net yearly return, and checks every line against the simple-interest model. An invalid file is reported and ignored. The defaults are a 12:00 Paris cut-off and cash one business day later.
