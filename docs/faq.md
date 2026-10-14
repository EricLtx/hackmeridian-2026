# Open Window: questions and answers

Answers for five audiences: people new to blockchains, the people who would use the contract, the Stellar ecosystem, software engineers, and security reviewers. Every answer describes the code in this repository as of October 2026. When something is planned rather than built, the answer says so.

- [For everyone](#for-everyone)
- [For users: borrowers, lenders, fund issuers](#for-users-borrowers-lenders-fund-issuers)
- [For the Stellar ecosystem](#for-the-stellar-ecosystem)
- [For software engineers](#for-software-engineers)
- [For security reviewers](#for-security-reviewers)
- [Status and limits](#status-and-limits)

---

## For everyone

### What does Open Window do, in one paragraph?

Some investment funds now exist as tokens: a share of the fund is a digital token held in a wallet, like a bank balance in a payment app. These funds pay cash back to their holders once per business day, at a fixed cut-off time. Open Window lets a holder get cash at any hour instead: the holder locks fund shares in the contract and receives digital euros or dollars (stablecoins) in the same instant. Later, the holder pays back the amount plus interest and gets the shares back. This is a repurchase agreement, or repo, the oldest form of secured short-term lending in finance.

### Why not just sell the shares?

Because the fund only buys shares back once per business day. Outside that window, on a Friday evening or a Sunday, there is no buyer at the fund's price. A repo does not need a buyer: the shares are only pledged, and the holder keeps their value.

### Who holds the shares during the loan?

The contract does: a program on the Stellar network that nobody can alter on the fly. It holds the shares until one of two things happens. Either the borrower repays and the shares go back to the borrower, or the borrower has not repaid at maturity and the lender may take them. No person holds the shares in between, not even the operator of Open Window.

### Where does the money come from?

From lenders who deposit stablecoins in advance into offers, each with a rate, a maximum term and the funds it accepts. A lender can be a market participant or the fund issuer itself, which can back the liquidity of its own shares this way.

### What is a stablecoin?

A digital token that tracks a currency one for one, such as one euro, issued by a regulated company that holds the matching reserves. On Stellar, stablecoins move between accounts in about five seconds, at any hour.

### What if the borrower never pays back?

From maturity on, the lender may take the pledged shares. The loan was smaller than the value of the shares from the start: the haircut, a safety margin, ensures it. The lender therefore holds more value than was lent.

### What is testnet?

Stellar's public test network. It works like the real network but its tokens have no value and it is reset from time to time. Everything Open Window runs today runs on testnet.

### How much energy does a loan use?

A loan is three transactions: offer, open, repurchase. Published estimates for Stellar are about 0.2 Wh per transaction, so a full loan uses well under one watt-hour, less than a phone screen for a minute. The contract's cost per operation stays constant however many loans are open.

---

## For users: borrowers, lenders, fund issuers

### How much can I borrow against my shares?

The contract values the shares at the fund's published net asset value (NAV), converts that value into the loan currency when needed, and subtracts the haircuts. The `quote` function returns the exact maximum before any commitment. With the demo settings, 10,000 shares worth 1.085 USD each give at most about 9,300 tEUR. That is 2 % for the fund haircut plus 2 % for the currency conversion below the value in euros.

### What does it cost?

Interest at the offer's annual rate, counted per started hour, for at least one hour, on a 365-day year, rounded up in the lender's favour. Interest keeps running after maturity until the borrower repays or the lender takes the shares. Example: 8,374 tEUR held from Friday 17:00 to Monday 09:00, which is 64 hours at 2.50 %, costs 1.53 tEUR.

The network fee comes on top. On testnet it was 0.65 XLM to open a repo, most of it rent for the new storage entries, and under 0.1 XLM for the other operations.

### Can I repay early? Late?

Early, yes, at any time, paying interest for the hours used. Late, yes, as long as the lender has not taken the shares: interest keeps running. From maturity on, the lender may take the shares at any moment, so a late repayment is a race the borrower can lose.

### Can the terms change while my loan is open?

No. Rate, maturity, amount and shares are fixed when the repo opens and stored with it. Later changes to the fund's settings, the offer, or the fund registry do not touch open repos.

### As a lender, can I get my money back before anyone borrows it?

Yes. `withdraw_offer` returns any amount not currently lent, at any time, even when the contract is paused. Repayments, principal and interest, flow back into the offer, and the lender withdraws them from there.

### As a lender, what do I receive if the borrower defaults?

The pledged fund shares, at maturity, sent to your address or to another address the fund issuer has approved. You must be an approved holder of that fund: the issuer approves lenders fund by fund, and the approval is checked again at every opening.

### As a fund issuer, what control do I keep?

- **Who may lend against my fund.** You approve each lender, and can revoke the approval.
- **The fund's risk settings.** You tune the haircut and the caps per repo and per fund, inside a risk envelope set by the governor.
- **Pausing my fund.** You can freeze it: no new repo opens against it, and open repos run to their end.
- **The NAV reference.** You can lower it after a legitimate drop in value, never raise it.
- **Admission.** Your fund can only be admitted with your signature and the governor's, on the same transaction.
- **Custody.** The contract must be on your allowlist like any other holder, so nothing moves without your consent.

### What is a sponsor offer?

An offer from the fund issuer, marked as such by the fund's steward. Interfaces show it first. It follows the same rules as any other offer and has no special right to take shares or exit first.

### What happens when the fund issuer freezes the shares held by the contract?

Shares cannot move while frozen, so a repurchase fails until the freeze is lifted, and the debt remains. Handling this on-chain is planned for version 1.1; today it is a documented limit, covered by a test.

---

## For the Stellar ecosystem

### Which standards does it use?

- **SEP-41** for fund shares and stablecoins, including Stellar Asset Contracts of classic assets.
- **SEP-40** for prices: `lastprice`, `decimals` and `base` are read from the NAV feed of each fund, and from an FX feed when the NAV is not in the loan currency.

The testnet demo uses the Reflector fiat feed for EUR/USD.

### Why Stellar?

- **Regulated assets come first.** Issuers control who may hold their tokens: allowlists, authorization flags, clawback. A repo of permissioned fund shares needs exactly that.
- **Settlement is fast and cheap.** Transactions settle in about five seconds and are final, at a cost a treasury can ignore.
- **Signatures are native.** The authorization framework lets two parties sign one call: two-key fund admission uses it.
- **Euro stablecoins and tokenized funds already exist** on the network, from several issuers.

### What does a deployment require from the network?

Three external dependencies per fund:

- a SEP-41 share token whose issuer allowlists the contract;
- a SEP-40 NAV feed;
- an FX feed if the NAV and the loan are in different currencies.

The contract itself is about 47 KB of WASM, built with `soroban-sdk` 28.

### How does it behave with storage archival?

Every write of a persistent entry extends its TTL: when fewer than 30 days remain, it is extended to 120 days. Every privileged call extends the instance. Deadlines are timestamps stored in the repo and compared with the ledger time, never inferred from a TTL. An archived entry can be restored by any caller before use.

### Does its cost grow with usage?

No. Each fund, offer and repo is one storage entry, and no function loops over positions. A test opens repos repeatedly and checks that the number of entries read and written stays the same: 17 read and 9 written for `open_repo`.

### What does it emit?

One event per state change, with identifiers and addresses as topics: offers, repos, repurchases, seizures, every administrative change, price reference updates and pauses. An indexer can rebuild the full history from events alone.

### Can it be upgraded?

Yes, by the governor, through `upgrade(wasm_hash)`. Error codes and exported types are append-only, so clients keep working across versions. A time delay on upgrades is on the roadmap.

---

## For software engineers

### How is the code organised?

| File | Role |
|---|---|
| `lib.rs` | Entry points, role checks, lifecycle |
| `math.rs` | Fixed-point arithmetic: `Bps` and `Price` newtypes, haircuts, interest, corridor |
| `oracle.rs` | SEP-40 reads, freshness, corridor and FX band checks |
| `storage.rs` | Typed keys, TTL extension, role loading |
| `token_io.rs` | SEP-41 transfers with a balance check before and after |
| `types.rs` | Stored and exported types |
| `error.rs` | Typed error codes, append-only |
| `events.rs` | One event type per state change |

### Why are amounts `i128` and rates in basis points?

SEP-41 amounts are `i128`. Rates and haircuts are integers in basis points: 250 means 2.50 %. A newtype rejects a haircut of 100 % or more at construction. Prices carry their own number of decimals and are rescaled explicitly. There is no floating point anywhere.

### How is arithmetic kept safe?

Workspace lints deny `unsafe`, unchecked arithmetic, `unwrap`, `expect`, `panic!` and slice indexing in contract code. Every operation is `checked_*` and returns a typed error on overflow. Overflow checks also stay on in release builds. Each rounding has a stated direction:

- the amount a borrower may take rounds down;
- the interest a borrower owes rounds up.

### How is the price checked?

1. **Freshness.** The NAV must be younger than the fund's maximum age, and not in the future.
2. **Corridor.** The NAV must lie between the reference minus a small floor and the reference grown at a maximum yield since it was set. The reference never follows the feed blindly: anyone can move it along that model path, and it never falls. A faulty feed cannot drag it, even by publishing every ledger.
3. **FX.** If the price is crossed through an FX feed, that rate must be fresh and within a band around the rate recorded at admission, and it adds its own haircut.

### Why interest per started hour?

The amount the borrower signs is fixed when the transaction is simulated, a few seconds before it executes. With per-second interest the two would differ and the call would fail. With per-hour interest they match, except across an hour boundary.

### How is it tested?

106 host tests across the workspace, 63 of them for Open Window:

- every error path;
- an intruder refused on every privileged function;
- authorization trees checked;
- events compared in XDR;
- invariants checked after 300 random operations;
- the constant-footprint test.

An integration module runs the full cycle with the real share token and NAV feed contracts of this repository. CI runs format, clippy with warnings as errors, the tests, the WASM build and a RustSec advisory check on every push.

### How do I run it?

```sh
cargo test                 # host tests
stellar contract build     # WASM in target/wasm32v1-none/release/
cd demo && npm install && npm run setup && npm run demo   # live on testnet
```

The demo runner is described in [demo/README.md](../demo/README.md). It never reports a transaction as failed while it could still land: it waits for the transaction or for the end of its validity window.

---

## For security reviewers

### Where is the threat model?

- **[securite.md](securite.md)** holds assets, actors and trust, invariants I1 to I9, vulnerability classes, decisions S1 to S19, maximum loss per scenario and the DORA mapping.
- **[modele-menace-stride.md](modele-menace-stride.md)** holds 21 STRIDE problems, the treatment of each and a first monitoring plan.

Both are in French.

### Who can do what?

| Role | Can | Cannot |
|---|---|---|
| Governor | Upgrade, set the risk envelope, the stablecoin registry and the caps, admit or remove a fund with the steward, unpause | Move anyone's funds or shares; change an open repo |
| Guardian | Pause new offers and new repos | Unpause; block repurchase, withdrawal or seizure |
| Steward, one per fund | Approve lenders, tune its fund inside the envelope, freeze its fund, lower the NAV reference | Raise the reference; exceed the envelope; touch another fund |
| Lender | Create and withdraw its offers; seize at maturity | Seize early; seize to an unapproved address |
| Borrower | Open and repurchase its repos | Borrow above the haircut-adjusted value |
| Anyone | Read; move the NAV reference along the model path | Move it outside the corridor |

Every function that consumes an address's authority calls `require_auth` on that address. Governor handover takes two steps: the successor must sign to accept.

### What stops a manipulated price?

Five layers stop it:

1. Prices come from NAV feeds chosen at admission, never from a market price or a function argument.
2. Freshness limits apply to the NAV and the FX rate.
3. The model-based corridor stops sudden moves.
4. The FX band stops a faulty rate.
5. Haircuts and three caps, per repo, per fund and per currency, bound what a wrong price that passes every check can cost.

The demo publishes a NAV 3 % too high and shows the contract refuse it.

### What does the pause do, exactly?

It blocks `create_offer` and `open_repo` and nothing else. Repurchase, withdrawal and seizure always work, so the pause can never trap funds. The guardian or the governor can pause; only the governor can unpause.

### What is the maximum loss?

It is bounded by construction through the caps. Section 6.1 of [securite.md](securite.md) gives it scenario by scenario: compromised feed, compromised key, issuer freeze, contract bug.

### What about DORA?

Open Window is designed to be operated as an ICT service a regulated entity can rely on: exit always possible, roles separated, events for audit, documented incident steps. The requirements retained, and the two operating modes, are in section 6.3 of [securite.md](securite.md).

### What is not done yet?

- **Third-party audit:** not done.
- **Multisig governor and time delay** on upgrades and oracle changes: not in place. Today the governor is a single key.
- **Monitoring plan:** written, not rehearsed.
- **Static analysis** with Scout and the OpenZeppelin detectors: to run.
- **Upgrade test with a real uploaded WASM:** to write.
- **Issuer freeze during a repo:** documented limit, planned for version 1.1.

Each item has a place in the [roadmap](roadmap.md), before any real deposit.

---

## Status and limits

- **Testnet only.** Nothing is deployed on mainnet, and no real asset is at stake.
- **No web interface yet.** The demo runs in a terminal; transactions can be checked on the testnet explorer.
- **Version 1 scope:**
  - whole repurchase only, no partial repayment and no rollover;
  - one NAV feed per fund;
  - positions and amounts are public on chain.
- **The [roadmap](roadmap.md)** lists the steps from here to a guarded launch, and what each step must prove before the next one starts.
