# Open Window web interface

A minimal interface for the Open Window contract on Stellar testnet: the market board (NAV, exchange rate, quote, offers, caps, pause state), borrowing, positions and repurchase, and lending. Plain JavaScript modules built with Vite; Freighter signs.

The interface reads the deployment from `public/deployment.testnet.json` at runtime. The demo's `npm run setup` rewrites that file; no address is hard-coded in the code.

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

4. Borrow, follow the position, repurchase. Lenders create and withdraw offers.

## How it works

- `src/chain.js` holds every network call. Reads are simulations from a null account, so the board needs no wallet. Writes are simulated first: a contract refusal is shown before the wallet is asked to sign. A transaction is reported failed only when that is definitive: it failed on chain, or the ledger closed past its validity window without it.
- Positions come from scanning `get_repo` from id 1 until the first empty id. The `repo_opened` events (filtered on the borrower topic) add the opening transaction of each repo still inside the RPC's event retention window.
- `src/terms.js` mirrors the contract's interest rule (every started hour, at least one, rounded up to the unit), so previews match what the contract charges.
- `src/errors.js` names a contract error after the contract that raised it and turns it into a sentence.

## Test

```sh
npm test                                   # formatting, interest, error mapping
OW_TESTNET=1 npm test                      # plus the full cycle on testnet
OW_TESTNET=1 OW_DEMO_DIR=/path/to/demo npm test
```

The testnet test creates fresh keypairs, funds them with Friendbot, adds the trustline, runs the demo's onboarding script (which needs the git-ignored demo state, found in `../demo` or `OW_DEMO_DIR`), then opens, finds and repurchases a repo, and creates and withdraws an offer, all through `src/chain.js` with a Keypair in place of Freighter.
