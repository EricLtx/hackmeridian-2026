# Open Window web interface

A minimal interface for the Open Window contract on Stellar testnet: the market board (NAV, exchange rate, quote, offers, caps, pause state), borrowing, positions and repurchase, and lending. Plain JavaScript modules built with Vite; Freighter signs.

A "How it works" card opens the page: one tab per party (holder of shares, lender, fund issuer) with what it needs, what it does and what it commits to, and the terms of the instance read from the chain (stablecoins, funds and haircuts, caps, interest rule, term range, time delay, pause state, contract version). Each position carries a timeline (opened, interest, term, closing, delivery), dated and linked to transactions when the indexer's export `public/history.json` is present. The layout works at phone width.

The interface reads the deployment from `public/deployment.testnet.json` at runtime. The demo's `npm run setup` rewrites that file; no address is hard-coded in the code.

`history.html` is the History page: every repo (lender of record, borrower, fund, shares, principal, rate, dates, state) and the latest events with a link to each transaction, read from `public/history.json`. That file is written by the indexer (`cd indexer && npm run export -- --json --web`) and is git-ignored; without it the page says so.

## Run

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
npm run preview    # serves dist/
```

## Use it with a wallet

1. Install Freighter, set it to Testnet, and connect.
2. If the account is new, use "Get test XLM", then "Add tEUR" (a trustline, signed in Freighter).
3. Only the operator keys can allowlist a wallet and mint test shares. From a checkout holding the demo state:

   ```sh
   cd demo && npm run onboard -- G...ADDRESS                # borrower
   cd demo && npm run onboard -- G...ADDRESS --role=lender  # lender
   ```

4. Borrow, follow the position, repurchase. Lenders create offers, withdraw any part of what they hold, and follow the repos on their offers: once a repo is past its term and unpaid, "Take the shares" calls `seize` to the lender's own address (which the fund issuer must still approve).

## How it works

- `src/chain.js` holds every network call. Reads are simulations from a null account, so the board needs no wallet. Writes are simulated first: a contract refusal is shown before the wallet is asked to sign. A transaction is reported failed only when that is definitive: it failed on chain, or the ledger closed past its validity window without it.
- Positions come from scanning `get_repo` from id 1 until the first empty id. The `repo_opened` events (filtered on the borrower topic) add the opening transaction of each repo still inside the RPC's event retention window.
- `src/terms.js` mirrors the contract's interest rule (every started hour, at least one, rounded up to the unit), so previews match what the contract charges.
- `src/errors.js` names a contract error after the contract that raised it and turns it into a sentence; when a contract caught another contract's error, the error it returned is the one shown.
- A closed repo whose shares the issuer still blocks shows the held-back amount and, for its beneficiary, a Release button that retries the delivery.

## Test

```sh
npm test                                   # formatting, interest, error mapping
OW_TESTNET=1 npm test                      # plus the full cycle on testnet
OW_TESTNET=1 OW_DEMO_DIR=/path/to/demo npm test
```

The testnet test creates fresh keypairs, funds them with Friendbot, adds the trustline, runs the demo's onboarding script (which needs the git-ignored demo state, found in `../demo` or `OW_DEMO_DIR`), then opens, finds and repurchases a repo, all through `src/chain.js` with a Keypair in place of Freighter. The lender test has a test borrower open a one-hour repo on the test lender's offer, checks that `seize` before maturity is refused with `NotMatured` before anything is signed, repays, and withdraws the offer in two parts. The shortest term is one hour, so the test does not wait for its own repo to mature: it checks the matured path by simulating `seize` on any open repo on testnet already past its term (to its lender: accepted; to an unapproved address: `LenderNotApproved`), and the button logic by unit test.
