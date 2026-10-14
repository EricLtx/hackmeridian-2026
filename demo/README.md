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
npm run status                   # the board only
npm run demo                     # every scene, Enter between scenes
npm run demo -- --auto           # no pauses, for rehearsal or recording
npm run demo -- --only=open,repurchase
npm run demo -- --only=repair    # unpause, fix the NAV, close the live repo
```

`setup` records each completed step in the state file. When the network drops, rerun the same command: finished steps are skipped, and the steps that move funds check balances first, so nothing is paid or minted twice.

The seizure scene needs a repo past its maturity. The shortest term the contract accepts is one hour, so run `setup` (or `setup -- --restage`) at least one hour before the demo.

## Scenes

| Scene | What happens on chain | What it shows |
|---|---|---|
| `board` | Reads; the operator republishes the NAV when it is over an hour old or wrong | Feeds and their age, the fund settings, the NAV reference, a quote, offers, caps, pause state, open repos |
| `open` | `open_repo` on the cheapest offer with enough funds, the sponsor offer first | One transaction, latency measured, balances before and after |
| `guardrails` | Wrong NAV published then corrected; pause by the guardian, unpause by the governor | `LoanTooLarge`, `PriceOutOfBand`, `Paused` refusals; repurchase still allowed while paused |
| `repurchase` | `repurchase` of the repo opened above | Interest per started hour; principal and interest return to the offer |
| `seize` | `seize` of the staged repo, or the `NotMatured` refusal before maturity | Seizure only to an address the issuer approved |
| `value` | Reads only | The same need through a fund redemption at four moments of the week, against the measured latency |
| `repair` | Unpause, NAV republished, live repo repurchased, each when needed | A clean state after an interrupted run |

Refusals are shown by simulation: the transaction is built and simulated, the contract returns its typed error, nothing is submitted. Simulation does not check signatures, so the demo never uses it to show an authorization refusal. An error raised by another contract (the share token, the NAV feed, the stablecoin) is named after that contract, so it is never mistaken for an Open Window refusal.

The two cleanup steps of `guardrails`, the NAV correction and the unpause, are retried three times and then checked on chain. If either did not take, the scene prints a red line with the repair command.

## How a transaction is confirmed

Each transaction is valid for 60 seconds. The script waits until it has landed or until the ledger has closed past that window, then reports one of two outcomes: confirmed, with its link, or expired, in which case nothing changed on chain. A lost response, a resend the network refuses because the first copy already applied, or a congested queue are resolved by looking the transaction up by its hash. A rerun therefore never repeats a step that landed late.

## Demo parameters

The fund is admitted with the settings in `config.mjs`; the board reads them back from the contract.

| Setting | Value | Why |
|---|---|---|
| Fund haircut | 2 % | Covers a NAV move far larger than a money market fund makes in a week |
| FX haircut | 2 % | Covers a weekend EUR/USD gap; FX markets are closed while the chain is open |
| FX band | ±5 % around the rate at admission | A rate outside it is treated as a faulty feed; re-admission with `setup -- --fx=…` resets it |
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
| `PriceOutOfBand` outside the guardrails scene | EUR/USD moved more than 5 % since admission | `setup -- --fx=local`, or back with `--fx=reflector`: re-admission anchors today's rate |
| `Repo #n from an earlier run is still open` | A rehearsal opened a repo and did not repurchase it | `npm run demo -- --only=repurchase` |
| `No offer has enough funds left` | Offers drained by repeated runs | `setup -- --fresh` |
| `Repo #n is Defaulted` | The staged repo was already seized | `setup -- --restage`, then wait one hour |
| `Setup failed: … account` | Testnet reset; accounts and contracts are gone | Delete `demo/.state/testnet.json`, run `setup` again |

Re-admission anchors the NAV reference on the live NAV, so run `repair` before `setup -- --fx=…` if a wrong NAV might be live.

## Optional settings

The `value` scene reads `private/demo/value-panel.json` when it exists: `cutoff` (`"HH:MM"`), `settlementBusinessDays`, `timeZone` and `notes`, a list of lines printed under the comparison. An invalid file is reported and ignored. The defaults are a 12:00 Paris cut-off and cash one business day later.
