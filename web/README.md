# Open Window web interface

A minimal interface for the Open Window contract on Stellar testnet: the market board (NAV, exchange rate, quote, offers, caps, pause state), borrowing, positions and repurchase, and lending. Plain JavaScript modules built with Vite; Freighter signs.

A "How it works" card opens the page: one tab per party (holder of shares, lender, fund issuer) with what it needs, what it does and what it commits to, and the terms of the instance read from the chain (stablecoins, funds and haircuts, caps, interest rule, term range, time delay, pause state, contract version). Each position carries a timeline (opened, interest, term, closing, delivery), dated and linked to transactions when the indexer's export `public/history.json` is present. The layout works at phone width.

The interface reads the deployment from `public/deployment.testnet.json` at runtime. The demo's `npm run setup` rewrites that file; no address is hard-coded in the code.

`history.html` is the History page: every repo (lender of record, borrower, fund, shares, principal, rate, dates, state) and the latest events with a link to each transaction, read from `public/history.json`. That file is written by the indexer (`cd indexer && npm run export -- --json --web`) and is git-ignored; without it the page says so.

## Terminal view

The header switches between two views of the same instance. **Guide** is the page above, explained for a first visit. **Terminal** is a dense, keyboard-first screen for desk users, in the spirit of a market terminal: a command line where Enter is the GO key, a band of live facts, the offer book, a ticket, the positions blotter, the funds and the tape of contract events. Open it with the switch or with `?view=terminal`; the choice is remembered on the device. It reads the same chain state and signs through the same functions as the guided view: the terminal never writes on its own, and nothing is signed before a ticket shows every number and check and the user presses GO.

| Command | What it does |
|---|---|
| `Q <shares> [FUND]` | Values shares now through the contract: price, haircut, the most they can secure, and a weekend at the best rate |
| `O <offer> <shares> <term> [amount]` | Ticket to open a repo; the amount defaults to 90 % of the ceiling. With a wallet, the call is simulated and a refusal lands on the ticket |
| `R <repo>` | Ticket to repurchase: principal and interest now, shares back, and a warning when the next hour of interest is about to start |
| `L <amount> <rate> <term>` | Ticket to create an offer (approved lenders) |
| `W <offer> [amount\|ALL]` | Ticket to withdraw unlent funds |
| `S <repo>` | Ticket to take the shares of an unpaid repo after its term |
| `REL <repo>` | Ticket to retry the delivery of shares a token held back |
| `GO` (or Enter on an empty line), `CANCEL` (or Esc) | Sign the ticket in Freighter, or drop it |
| `OFF`, `POS [ALL\|ME\|<address>]`, `FND`, `EV` | Focus the offer book, the positions (yours, the whole market, or any address, read-only), the funds, the tape |
| `CONN`, `REF`, `CLR`, `GUIDE`, `HELP` | Connect Freighter, read the chain now, clear the console, back to the guided view, the list |

Quantities take `1,000.50`, `5K` or `1.5M`; terms take hours (`64`), days (`2D`) or weeks (`1W`); rates take `3.25`, `3.25%` or `325BP`. Arrow keys recall earlier commands, Tab completes a command word, `/` returns to the command line. Clicking an offer, a position or a fund in a panel fills the command line with the matching command.

What each panel reads:

- **Band**: ledger clock, network, pause state, contract and stored-layout versions, every admitted fund's NAV with its age (green fresh, amber past three quarters of the fund's bound, red beyond it, when the contract refuses it), the exchange rate of a cross-priced fund, open interest, the time delay, governance changes waiting for their delay.
- **Offer book**: every offer with money, best rate first, with the funds it accepts, the designated offer and your own offers marked.
- **Positions**: every repo of the scope, open first, with the amount due now, the started hours charged, a countdown to the term, and the state (open, past term, repaid, seized, shares held back).
- **Funds**: each admitted fund's NAV, age, exchange rate, total haircut, capacity used and state, the share token's kind (a SEP-41 token or a classic asset through the Stellar Asset Contract).
- **Tape**: every contract event the RPC still keeps (about a week), merged with the indexer's export when present, newest first, each with its transaction.

The view uses no animation, keeps numbers in a monospaced font aligned right, and stays usable at phone width, where the panels stack and the GO and CANCEL keys replace Enter and Esc.

## Languages

Both views and the History page are available in English, French and Spanish. The EN, FR and ES keys in the header switch the language at once, without reading the chain again; in the terminal, `LANG FR` does the same. The page opens in the language of the link (`?lang=fr`), else the one chosen last on the device, else the browser's, else English. A link shared for a demo can therefore fix the language: `?view=terminal&lang=en`.

Numbers follow the language: `1,250.50` in English, `1 250,50` in French, `1250,50` and `12.345,50` in Spanish; dates and durations too. Inputs accept each language's own form, in the forms and on the command line (`O 1 1000,5 64` in French). A form that could be read two ways, such as `1,000.5` in French, is refused rather than guessed, and every ticket shows the parsed amounts before anything is signed. Command words stay the same in every language, like the keys of a market terminal; `AIDE` and `AYUDA` also open the help, and terms accept `2J` (jours) and `1S` (semaine, semana) next to `2D` and `1W`.

The English text is the source: each visible string is written in English in the code, marked with `t()`, and looked up in `src/locales/fr/` and `src/locales/es/` (one file per source module). `npm run check:i18n` lists any marked text that lacks a French or Spanish entry or changes its `{placeholders}`; the unit tests run the same check, so a new string without its translations fails the tests and the CI.

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
- `src/command.js` parses the terminal's command line into typed commands with integer token units; `src/blotter.js` computes the band, the book, the funds, the blotter, the tape lines and the tickets from chain facts with the contract's interest rule; `src/terminal.js` renders them and runs the keyboard. The first two are pure and unit-tested.

## Test

```sh
npm test                                   # formatting, interest, error mapping, guide, timelines, terminal commands and tickets, languages
npm run check:i18n                         # every marked text translated in French and Spanish
OW_TESTNET=1 npm test                      # plus the full cycle on testnet
OW_TESTNET=1 OW_DEMO_DIR=/path/to/demo npm test
```

The testnet test creates fresh keypairs, funds them with Friendbot, adds the trustline, runs the demo's onboarding script (which needs the git-ignored demo state, found in `../demo` or `OW_DEMO_DIR`), then opens, finds and repurchases a repo, all through `src/chain.js` with a Keypair in place of Freighter. The lender test has a test borrower open a one-hour repo on the test lender's offer, checks that `seize` before maturity is refused with `NotMatured` before anything is signed, repays, and withdraws the offer in two parts. The shortest term is one hour, so the test does not wait for its own repo to mature: it checks the matured path by simulating `seize` on any open repo on testnet already past its term (to its lender: accepted; to an unapproved address: `LenderNotApproved`), and the button logic by unit test.
