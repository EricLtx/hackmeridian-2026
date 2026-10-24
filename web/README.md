# Open Window web interface

A minimal interface for the Open Window contract on Stellar testnet: the market board (NAV, exchange rate, quote, offers, caps, pause state), borrowing, positions and repurchase, lending, and an Operate space. Plain JavaScript modules built with Vite; Freighter signs.

The **Operate** space shows the instance as its operator sees it, to anyone: its health (new loans open or paused, contract version and stored layout, each fund's price reference age against its NAV age bound, the cap used, a freeze), who holds each role (governor, guardian and its backup, sentinel, trustee, sole lender, each fund's steward and its backup), and every proposal waiting for the time delay, with a countdown to the moment it can apply. A connected wallet sees its own roles in the wallet card, read from the chain: a role whose read failed is counted as unread, never granted. The actions of these roles still run through the tooling in `demo/`; the design of the role workspaces and their phases is in `docs/superpowers/specs/2026-10-22-role-workspaces-design.md`.

A "How it works" card opens the page: one tab per party (holder of shares, lender, fund issuer) with what it needs, what it does and what it commits to, and the terms of the instance read from the chain (stablecoins, funds and haircuts, caps, interest rule, term range, time delay, pause state, contract version). Each position carries a timeline (opened, interest, term, closing, delivery), dated and linked to transactions when the indexer's export `public/history.json` is present. The layout works at phone width.

The interface reads the deployment from `public/deployment.testnet.json` at runtime. The demo's `npm run setup` rewrites that file; no address is hard-coded in the code.

`history.html` is the History page: every repo (lender of record, borrower, fund, shares, principal, rate, dates, state) and the latest events with a link to each transaction, read from `public/history.json`. That file is written by the indexer (`cd indexer && npm run export -- --json --web`) and committed, so that the published site serves it; refresh and commit it when the journal moves. Without it the page says so. The market page fetches it at start, on `REF` and when the page becomes visible again, revalidated with the host (`no-cache`), not on every refresh; the History page links only to an https explorer and bounds the decimals it reads (`src/journal.js`).

A panel that has not yet been answered says it is reading, in a muted line distinct from the empty state it shows once the chain has answered with nothing (the terminal's tape, book, positions and funds); the registry of the History page shows its dates short (`21 Oct, 23:01 UTC`, the full time as the title and the ISO value in the `<time>` element), and an offer's available amount reads in whole units once it reaches 1,000, the exact amount staying in the title and on the ticket.

A summary opens the positions of a connected wallet once it has an open repo, added up from the cards the page already holds, without a further chain read: as a borrower, the amount borrowed, the amount due now, the next term to end with its countdown and the repos past their term; as a lender, the amount lent, the amount owed now and the repos whose shares it may keep now; while an interest is unread the total shows a dash and says so rather than a partial sum (`src/summary.js`, pure and unit-tested).

The interface is published on GitHub Pages at https://ericltx.github.io/hackmeridian-2026/ by `.github/workflows/pages.yml`, on every push that touches `web/`: the workflow runs the tests, builds, and deploys `dist/`. The relative base of the build lets the same files work at that path, on any static host, or from `npm run preview` locally.

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
| `REL <repo>` | Ticket to retry the delivery of shares a token held back, or, after a seizure, shares waiting for the lender's approval (rc5) |
| `GO` (or Enter on an empty line), `CANCEL` (or Esc) | Sign the ticket in Freighter, or drop it |
| `OFF`, `POS [ALL\|ME\|<address>]`, `FND`, `EV` | Focus the offer book, the positions (yours, the whole market, or any address, read-only), the funds, the tape |
| `CONN`, `REF`, `CLR`, `GUIDE`, `HELP` | Connect Freighter, read the chain now, clear the console, back to the guided view, the list |

Quantities take `1,000.50`, `5K` or `1.5M`; terms take hours (`64`), days (`2D`) or weeks (`1W`); rates take `3.25`, `3.25%` or `325BP`. Arrow keys recall earlier commands, Tab completes a command word, `/` returns to the command line. Clicking an offer, a position or a fund in a panel fills the command line with the matching command.

What each panel reads:

- **Band**: ledger clock, network, pause state, contract and stored-layout versions, every admitted fund's NAV with its age (green fresh, amber past three quarters of the fund's bound, red beyond it, when the contract refuses it), the exchange rate of a cross-priced fund, open interest, the time delay, governance changes waiting for their delay.
- **Offer book**: every offer with money, best rate first, with the funds it accepts, the designated offer and your own offers marked.
- **Positions**: every repo of the scope, open first, with the amount due now, the started hours charged, a countdown to the term, and the state (open, past term, repaid, seized, shares held back).
- **Funds**: each admitted fund's NAV, age, exchange rate, total haircut, capacity used and state, the share token's kind (a SEP-41 token or a classic asset through the Stellar Asset Contract).
- **Tape**: every contract event the RPC still keeps (about a week), merged with the indexer's export when present, newest first, each with its transaction. Since rc5 the valuation behind each opening (`repo_valued`) has its own line, `VALUE`, with the price per share and the haircut.

The view keeps motion to brief cues (see below), keeps numbers in a monospaced font aligned right, and stays usable at phone width, where the panels stack and the GO and CANCEL keys replace Enter and Esc.

## Guided tour

`tour.html` is a presentation of the product in thirteen scenes, from the need to the next step, on [Reveal.js](https://revealjs.com/) (bundled, no CDN). It needs no wallet and only reads: the journey replays a repurchased repo of `history.json`, the cost scene prices a loan with the contract's formula (`src/terms.js`) against the best live offer, and the live scene reads the board through `src/chain.js`. The scenes, their speaker notes and the role descriptions live in `src/tour-scenes.js`, so the tour is rewritten by editing that one file; `test/tour.test.js` checks the presentation rules (one job per scene, at most thirty words of body text, complete notes) and the reading of untrusted data.

The text is written as counsel, not as a pitch: it explains the approach before anything is read live (a repo, not a pool: fixed term, fixed rate, no liquidation and no margin call, the lender receiving the shares at maturity; the issuer never lends; the lender is a regulated institution on its own instance; exits never blocked; every change delayed and vetoable), says what is verified on testnet and what is not claimed (no outside audit, testnet only, no real value, no promise of liquidity), and gives the holder, the lender and the issuer an "is it for you?" moment with the honest answer when it is not a fit. Second person, one idea per sentence, no superlative and no business figure: the test forbids the words and the typed-in figures, so every number on the scenes comes from the chain or from the contract's formula.

- Keys: arrows or space to move, `O` overview, `F` full screen, `?` shortcuts, `N` speaker notes. `tour.html#/8` opens a scene directly; `?autoplay=1` advances every 20 seconds until a key is pressed.
- Presenter: `tour.html?presenter=1` in a second window shows the notes, the next scene and a timer, kept in step with the deck over a `BroadcastChannel` (the Reveal.js notes plugin writes inline scripts the page's policy refuses).
- A dark stage whatever the system theme (`body.face-stage` in `src/style.css`, checked like the other palettes); a portrait canvas on a phone held upright.
- Images: two NASA images of the [NASA 3D Resources](https://github.com/nasa/NASA-3D-Resources) collection (the earth of the title, the star field), and four planet textures of [Solar System Scope](https://www.solarsystemscope.com/textures/) (moon, mars, jupiter, saturn; CC BY 4.0), converted to WebP at 2048 px and kept under 450 KB each; all bundled in `public/tour/` and credited in `NOTICE` and on screen. The textures sit beside the text of four scenes (`planet` in `src/tour-scenes.js`), never behind it: on the 1280 px canvas they start past every text block, their limb nearest the text is shaded, and under 760 px they are not shown.
- Motion, in CSS only and only under `prefers-reduced-motion: no-preference`: each planet turns once in 70 to 120 seconds (a strip of two copies of the texture slides by one texture width, `transform` only), the star field drifts over four minutes, and on a scene change the planet arrives a little behind the text, a parallax between the two layers. The planets are lazy-loaded with their size declared, so the first scene paints without them. With reduced motion, nothing on the stage moves: the Reveal transition is already `none`, and the planets and sky stand still.

## Design and motion

A clean visual system on the foundations of the Stellar Design System ([DESIGN.md](DESIGN.md)): light grey page, white cards with large radii, one lilac accent, a lilac-to-navy gradient kept for small accents (the hero line, the progress bar, the capacity bars). Text is set in Inter and figures in Inconsolata, served with the page from the `@fontsource-variable` packages (OFL), so no font is fetched from a third party and the page looks the same on every system. The terminal view is a dark market screen with amber commands whatever the system theme; the guided view follows the system's light or dark setting. The language switch shows flags drawn in SVG, since Windows has no flag emoji.

Motion is short and eased, and stops entirely when the system asks for reduced motion (`src/motion.js`): cards and panels rise in turn on arrival; the view and language switches cross-fade (View Transitions where the browser has them) and their segmented controls slide a thumb under the pressed key; a figure that moves flashes green when it rises and red when it falls, like a market screen (every value marked `data-k`, compared by `setHTML` before and after each render); new events slide into the tape; a new ticket rises and its checks follow one by one; skeletons stand in for figures until the first read lands, with a thin progress bar; a confirmed transaction and an RPC switch also say so in a toast.

## Languages

Both views and the History page are available in English, French and Spanish. The EN, FR and ES keys in the header switch the language at once, without reading the chain again; in the terminal, `LANG FR` does the same. The page opens in the language of the link (`?lang=fr`), else the one chosen last on the device, else the browser's, else English. A link shared for a demo can therefore fix the language: `?view=terminal&lang=en`.

Numbers follow the language: `1,250.50` in English, `1 250,50` in French, `1250,50` and `12.345,50` in Spanish; dates and durations too. Inputs accept each language's own form, in the forms and on the command line (`O 1 1000,5 64` in French). A form that could be read two ways, such as `1,000.5` in French, is refused rather than guessed, and every ticket shows the parsed amounts before anything is signed. Command words stay the same in every language, like the keys of a market terminal; `AIDE` and `AYUDA` also open the help, and terms accept `2J` (jours) and `1S` (semaine, semana) next to `2D` and `1W`.

The English text is the source: each visible string is written in English in the code, marked with `t()`, and looked up in `src/locales/fr/` and `src/locales/es/` (one file per source module). `npm run check:i18n` lists any marked text that lacks a French or Spanish entry, or whose translation changes its `{placeholders}` or its HTML tags; the unit tests run the same check, so a new string without its translations fails the tests and the CI.

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

4. Borrow, follow the position, repurchase. Lenders create offers, withdraw any part of what they hold, and follow the repos on their offers: once a repo is past its term and unpaid, "Take the shares" calls `seize` to the lender's own address. When the fund issuer no longer approves the lender, the seizure still settles in the rc5 candidate, and the shares wait in the contract until the issuer approves the lender again or the lender redirects them to an approved holder.

## How it works

- `src/chain.js` holds every network call. Each call has a time bound (7 s; 12 s for a scan of events, 10 s for a submission). A call that does not answer in time, or fails on the network, moves at once to the next RPC endpoint of the deployment file (`rpcUrl`, then `rpcFallbacks`: the testnet file lists Gateway.fm's public RPC after SDF's), which then stays in use; a request an RPC refuses is not retried elsewhere. A signed transaction sent again through the other endpoint cannot apply twice, since it keeps its hash. Since rc5, before each refresh the page also reads every endpoint's latest ledger: calls leave an endpoint more than 10 ledgers behind the highest, and return to the first endpoint once it is level again, after resting 60 s if it failed a call. The terminal's status line shows the endpoint in use and its last answer time and the console says when it switches; the footer of the guided page names it, and a privacy line on both pages names the RPC providers, which see the visitor's IP address and the addresses the page reads. Reads are simulations from a null account, so the board needs no wallet. Writes are simulated first: a contract refusal is shown before the wallet is asked to sign. A transaction is reported failed only when that is definitive: it failed on chain, or the ledger closed past its validity window without it. Since rc5 it is reported confirmed only once a second endpoint sees it succeed: until then the page says "Submitted, confirming", and a failure reported there, a transaction it does not know once the validity window has passed, or its silence, ends the write as unconfirmed (`TxUnconfirmed`), never as confirmed.
- Every value decoded from the chain is untrusted input. `src/chain.js` checks its shape at the boundary (integers, Stellar addresses, repo statuses, SEP-40 prices, decimals between 0 and 38; since rc5 the fund, its state, its price and held-back shares too) before it reaches the markup. It checks the fee of the transaction the wallet is asked to sign, not the simulation's summary of it: the resource fee in its envelope and its total fee beyond the inclusion bid each stay under 25 XLM, are the same amount, and match the simulation's estimate, or nothing is signed. The footprint and the restore list of a write are not checked yet. The three pages carry a content security policy: scripts, styles, fonts and images from the site only, connections only to the RPC endpoints of the deployment file (and Friendbot, except on the tour, which never asks for test funds). A deployment that adds an RPC endpoint adds it to `connect-src` in `index.html`, `history.html` and `tour.html`.
- `src/deployment.js` checks the deployment file before anything uses it: the test network's passphrase only, plain tickers, https URLs, well-formed contract addresses (not pinned: `setup` changes them) and decimals from 0 to 38.
- `src/frame.js`: the three pages refuse to run inside another site's frame, since GitHub Pages cannot send `frame-ancestors`; the dev server and the preview on `localhost` still run in an editor's frame. This is defence in depth only: a sibling Pages site on the same origin could still script the page, so a dedicated origin stays the fix.
- Positions come from scanning `get_repo` from id 1 until the first empty id. The `repo_opened` events (filtered on the borrower topic) add the opening transaction of each repo still inside the RPC's event retention window.
- `src/terms.js` mirrors the contract's interest rule (every started hour, at least one, rounded up to the unit), so previews match what the contract charges.
- `src/errors.js` names a contract error after the contract that raised it and turns it into a sentence; when a contract caught another contract's error, the error it returned is the one shown. Since rc5 a refusal by any registered stablecoin's contract is named after that stablecoin, never read as the Open Window error with the same number.
- A closed repo whose shares the issuer still blocks, or, after a seizure, whose lender is not approved (rc5), shows the held-back amount and, for its beneficiary, a Release button that retries the delivery.
- `src/command.js` parses the terminal's command line into typed commands with integer token units; `src/blotter.js` computes the band, the book, the funds, the blotter, the tape lines and the tickets from chain facts with the contract's interest rule; `src/terminal.js` renders them and runs the keyboard. The first two are pure and unit-tested.

## Test

```sh
npm test                                   # formatting, interest, error mapping, guide, timelines, terminal commands and tickets, languages, RPC failover and staleness, motion, boundary checks, fee check, confirmation on a second endpoint, deployment file, frame refusal, roles, Operate space, positions summary, short dates, design tokens, tour rules
npm run check:i18n                         # every marked text translated in French and Spanish
OW_TESTNET=1 npm test                      # plus the full cycle on testnet
OW_TESTNET=1 OW_DEMO_DIR=/path/to/demo npm test
```

The testnet test creates fresh keypairs, funds them with Friendbot, adds the trustline, runs the demo's onboarding script (which needs the git-ignored demo state, found in `../demo` or `OW_DEMO_DIR`), then opens, finds and repurchases a repo, all through `src/chain.js` with a Keypair in place of Freighter. The lender test has a test borrower open a one-hour repo on the test lender's offer, checks that `seize` before maturity is refused with `NotMatured` before anything is signed, repays, and withdraws the offer in two parts. The shortest term is one hour, so the test does not wait for its own repo to mature: it checks the matured path by simulating `seize` on any open repo on testnet already past its term (to its lender: accepted; to an unapproved address: `LenderNotApproved`), and the button logic by unit test.
