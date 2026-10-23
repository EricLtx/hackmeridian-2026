// The guided tour's content: thirteen scenes, hook to call to action. Each
// scene has one job, a headline, at most thirty words of body text, the
// interaction it carries and speaker notes. The texts are English source
// strings marked with tk(); tour.js translates them where it shows them,
// so the tour can be regenerated for another audience by editing this file
// alone. Facts are those of the public documentation (README, docs/) or
// read live from the chain; nothing here is a business figure.

import { tk } from "./i18n.js";
import { HOUR, chargedHours, interest } from "./terms.js";

/** Speaker notes: the message, what to say, what to stress, the likely question, its answer, the way to the next scene. */
const notes = (key, say, stress, question, answer, next) => ({ key, say, stress, question, answer, next });

export const SCENES = [
  {
    id: "title",
    kind: "title",
    kicker: tk("Open Window · Stellar testnet"),
    title: tk("Liquidity that keeps your hours"),
    body: tk("Stablecoin cash against tokenized fund shares, at any hour, in one signature."),
    notes: notes(
      tk("What Open Window is, in one line."),
      tk("Open Window lends stablecoins against tokenized money market fund shares, at any hour. A contract on Stellar enforces every term."),
      tk("It runs on testnet today, and what you will see is live."),
      tk("Is this a real product or a mock-up?"),
      tk("A live testnet instance with its full public history; scene 9 shows it."),
      tk("Let us start on a Friday evening."),
    ),
  },
  {
    id: "hook",
    kind: "hook",
    kicker: tk("Friday, 18:01"),
    title: tk("The market has closed. Your treasury needs cash."),
    points: [tk("Saturday, a payment falls due."), tk("Your cash sits in fund shares."), tk("Their redemption waits for Monday.")],
    notes: notes(
      tk("The need appears when the market is closed."),
      tk("Picture a treasurer on Friday at 18:01: a payment is due tomorrow, and the money is invested in a money market fund."),
      tk("Reveal the three lines one by one, and pause after the last."),
      tk("Is this a real need?"),
      tk("It is our hypothesis: the tour itself is how we test it with you."),
      tk("Why has this not been solved already?"),
    ),
  },
  {
    id: "context",
    kind: "context",
    kicker: tk("The context"),
    title: tk("The shares moved on-chain. The cash did not follow."),
    body: tk("Tokenized fund shares settle at any hour. Borrowing against them still keeps business hours."),
    notes: notes(
      tk("The asset is ready for any hour; the credit is not."),
      tk("Switch the week view: in business hours, credit against fund shares is closed most of the week. Open Window keeps it open."),
      tk("Click the two views; let the closed hours speak."),
      tk("Do banks not lend at night?"),
      tk("Against fund shares, the paperwork and the settlement keep business hours."),
      tk("What does waiting cost?"),
    ),
  },
  {
    id: "problem",
    kind: "problem",
    kicker: tk("The problem"),
    title: tk("Waiting costs more than interest"),
    points: [tk("A payment missed, or paid late."), tk("An overdraft at a punitive rate."), tk("Shares sold that should have stayed invested.")],
    notes: notes(
      tk("The cost of waiting is real, even when it is hard to see."),
      tk("Each consequence appears in turn: a late payment, an expensive overdraft, a redemption that breaks an investment plan."),
      tk("No figures here: the point is the kind of cost, not its size."),
      tk("How large is that cost?"),
      tk("It depends on the treasury; we would rather measure it with you than guess it."),
      tk("Here is the shift that removes it."),
    ),
  },
  {
    id: "insight",
    kind: "insight",
    kicker: tk("The insight"),
    title: tk("A repo, rebuilt as code"),
    body: tk("Sell the shares, buy them back later: the oldest form of secured lending. A contract now holds the shares and enforces every term."),
    notes: notes(
      tk("Nothing new to trust: a known transaction, enforced by code."),
      tk("A repo is a sale with a promise to buy back. Compare the two columns: the back office on one side, the contract on the other."),
      tk("The terms do not change; who enforces them does."),
      tk("Why a repo and not a loan?"),
      tk("The lender holds the collateral by law, not by a claim; it is the safest form of secured lending."),
      tk("Who takes part, and what can each one do?"),
    ),
  },
  {
    id: "roles",
    kind: "roles",
    kicker: tk("The solution"),
    title: tk("Three parties, one contract, no single key"),
    body: tk("Select a role to see what it can do, and what it can never do."),
    notes: notes(
      tk("Power is split, so no one can rewrite the deal alone."),
      tk("Open each role: the holder borrows, the lender lends, the fund's steward keeps control of its shares and never lends. The guardian, sentinel and trustee check the governor."),
      tk("Insist on the 'never' column: it is enforced by the contract."),
      tk("Who runs it?"),
      tk("An instance can be fixed to a single regulated lender, which runs it for its clients."),
      tk("Let us follow one loan from start to finish."),
    ),
  },
  {
    id: "journey",
    kind: "journey",
    kicker: tk("How it works"),
    title: tk("One signature, start to finish"),
    steps: [
      [tk("Quote"), tk("The contract values the shares and applies the haircut.")],
      [tk("Borrow"), tk("One signature: shares in, stablecoins out, in seconds.")],
      [tk("Hour by hour"), tk("Interest counts each started hour, at a fixed rate.")],
      [tk("Buy back"), tk("Repay any time; the shares come back in the same transaction.")],
    ],
    notes: notes(
      tk("The whole life of a loan fits in four steps."),
      tk("Step through the four stages; the panel replays a real repo from the public record of this instance."),
      tk("A confirmation takes 2 to 6 seconds on testnet."),
      tk("And if the borrower never repays?"),
      tk("After the term, and only then, the lender takes the shares."),
      tk("What will it cost you?"),
    ),
  },
  {
    id: "cost",
    kind: "cost",
    kicker: tk("The value"),
    title: tk("What it costs, before you sign"),
    body: tk("Choose an amount and a duration: the cost uses the contract's own formula."),
    notes: notes(
      tk("The price is known to the unit before any signature."),
      tk("Move the duration from one night to a weekend: the interest follows the hours used, nothing more."),
      tk("The rate comes from the best live offer when the chain answers; otherwise the example rate is labelled as such."),
      tk("Are there hidden fees?"),
      tk("The contract takes no fee of its own; the network fee is far below one unit."),
      tk("Is any of this real?"),
    ),
  },
  {
    id: "live",
    kind: "live",
    kicker: tk("The proof"),
    title: tk("It is running now"),
    body: tk("Read live from the testnet instance, this minute."),
    notes: notes(
      tk("The product exists and answers right now."),
      tk("These figures are read from the chain as you watch: admitted funds, the age of their price, the offers, the loans."),
      tk("A stale price is shown as stale: the page never hides what the chain says."),
      tk("Can I see the history?"),
      tk("Every event since the first deployment is on the History page, under a hash chain."),
      tk("What happens when something goes wrong?"),
    ),
  },
  {
    id: "safety",
    kind: "safety",
    kicker: tk("The safeguards"),
    title: tk("Built to fail safely"),
    tabs: [
      [tk("Price"), tk("Every loan checks the fund's price against a corridor and a backup feed. A wrong price stops new loans; buying back stays open.")],
      [tk("Time delay"), tk("Upgrades, feed changes and every loosening wait a public delay, and can be cancelled. Tightening is immediate.")],
      [tk("Roles"), tk("No key does everything: the sentinel pauses, the guardian vetoes, the trustee checks the guardian's replacement.")],
      [tk("Drills"), tk("Nineteen incident drills replayed against the running code; 307 automated host tests on the contract.")],
    ],
    notes: notes(
      tk("Failure is planned for, rehearsed and bounded."),
      tk("Open each tab: price checks, the delay on every change, split roles, and the drills rehearsed on testnet."),
      tk("In the key-compromise drill, an unannounced upgrade was cancelled 6 seconds after it was proposed."),
      tk("Has it been audited?"),
      tk("Not externally yet: internal reviews with every finding fixed and tested; the external audit is the next step."),
      tk("Here are the questions you should ask."),
    ),
  },
  {
    id: "questions",
    kind: "questions",
    kicker: tk("Your questions"),
    title: tk("The questions you should ask"),
    faq: [
      [tk("What if the price is wrong?"), tk("A corridor bounds how fast the price may move, and a backup feed must agree. Otherwise new loans stop, and repurchases stay open.")],
      [tk("What if a key is stolen?"), tk("Changes wait a public delay. The guardian cancels an unannounced proposal, and the monitor pauses new loans on a critical alert.")],
      [tk("Can the operator change the rules?"), tk("Not at once: every change is proposed, delayed, public and cancellable. Error codes and the interface only ever grow.")],
      [tk("What if the network stops?"), tk("Nothing moves without a signature. Deadlines are stored and compared with the ledger's time, so no loan is seized before its term.")],
      [tk("Is it regulated?"), tk("Open Window is software. The legal form of the transaction and the operator's status are being qualified; nothing is deployed on mainnet.")],
    ],
    notes: notes(
      tk("Hard questions have direct answers."),
      tk("Open the questions the room cares about; each answer points to a rule the contract enforces."),
      tk("Say plainly what is not done yet: external audit, key custody, legal validation."),
      tk("What is not done yet?"),
      tk("The external audit, key custody with separate people and devices, and the legal qualification."),
      tk("So what comes next?"),
    ),
  },
  {
    id: "roadmap",
    kind: "roadmap",
    kicker: tk("The road ahead"),
    title: tk("From testnet to a guarded launch"),
    phases: [
      [tk("Done"), tk("Proof of mechanism and testnet pilot: the full lifecycle live, governed upgrades, drills rehearsed.")],
      [tk("Next"), tk("Hardening for real assets: external audit, key custody with separate people and devices.")],
      [tk("Then"), tk("A guarded launch: low caps, one regulated lender, monitoring in operation.")],
      [tk("Later"), tk("Extension: more funds and currencies as data, without a new contract.")],
    ],
    notes: notes(
      tk("Each step retires one risk before the next."),
      tk("Walk the phases: what is done, what comes next, and what a guarded launch means."),
      tk("Caps stay low until the evidence justifies raising them."),
      tk("When on mainnet?"),
      tk("Only after the external audit and real key custody; the steps, not a date, decide."),
      tk("See it for yourself."),
    ),
  },
  {
    id: "cta",
    kind: "cta",
    kicker: tk("Your turn"),
    title: tk("See it with your own eyes"),
    body: tk("Testnet only: nothing here has real value."),
    doors: [
      [tk("Explore the live market"), "./index.html#board"],
      [tk("Open the terminal"), "./index.html?view=terminal"],
      [tk("Read the history"), "./history.html"],
    ],
    notes: notes(
      tk("One next step: try it."),
      tk("Pick a door: the market as a treasurer sees it, the terminal as a desk sees it, or the full record."),
      tk("No wallet needed to look; a Freighter wallet on testnet to borrow."),
      tk("Can I try it now?"),
      tk("Yes, on testnet, with a Freighter wallet; the guide in the app walks you through it."),
      tk("Thank you."),
    ),
  },
];

/** The words of a text, for the thirty-word rule. */
export const wordCount = (text) => String(text).trim().split(/\s+/).filter(Boolean).length;

/** The visible body text of a scene, excluding labels and data: body, points, step and phase texts. */
export function visibleWords(scene) {
  const parts = [scene.body ?? "", ...(scene.points ?? [])];
  return parts.reduce((n, text) => n + wordCount(text), 0);
}

/** The roles of scene 6: what each may do, and what the contract never lets it do. */
export const ROLES = [
  {
    id: "holder",
    name: tk("Holder"),
    can: tk("Borrows stablecoins against its fund shares, and buys them back at any time."),
    never: tk("Can never be liquidated before the term, whatever the price does."),
  },
  {
    id: "lender",
    name: tk("Lender"),
    can: tk("Posts offers, withdraws what is not lent, and takes the shares of a loan unpaid at its term."),
    never: tk("Can never touch the shares before the term ends."),
  },
  {
    id: "steward",
    name: tk("Fund steward"),
    can: tk("Admits its fund with the governor, sets its limits and approves the lenders."),
    never: tk("Never lends against its own fund."),
  },
  {
    id: "governor",
    name: tk("Governor"),
    can: tk("Proposes upgrades and changes of settings."),
    never: tk("Can never apply a change at once: each one waits a public delay."),
  },
  {
    id: "guardian",
    name: tk("Guardian"),
    can: tk("Pauses new loans and vetoes a governor handover."),
    never: tk("Can never block a repurchase: a pause stops entries, never exits."),
  },
  {
    id: "sentinel",
    name: tk("Sentinel"),
    can: tk("The monitoring key: pauses new loans and cancels unannounced proposals."),
    never: tk("Can never veto, unpause or move funds."),
  },
  {
    id: "trustee",
    name: tk("Trustee"),
    can: tk("Optional: its signature is needed for every upgrade and for a forced change of guardian."),
    never: tk("Holds no other power over the instance."),
  },
];

/** The two columns of scene 5. */
export const COMPARE = {
  before: { title: tk("Back office"), items: [tk("Calls and e-mails in business hours"), tk("Settlement the next business day"), tk("Terms checked by hand")] },
  after: { title: tk("Contract"), items: [tk("One signature, at any hour"), tk("Settled in seconds"), tk("Every term enforced by code")] },
};

/** The week of scene 3: hours when credit against fund shares is open, in each view. */
export const WEEK_DAYS = [tk("Mon"), tk("Tue"), tk("Wed"), tk("Thu"), tk("Fri"), tk("Sat"), tk("Sun")];

/** Whether hour `h` (0-23) of day `d` (0 = Monday) is open in `view` ("hours": 9:00 to 17:00 on working days; "window": always). */
export const isOpen = (view, d, h) => view === "window" || (d < 5 && h >= 9 && h < 17);

/** Open hours in a week, per view. */
export const openHours = (view) => {
  let n = 0;
  for (let d = 0; d < 7; d += 1) for (let h = 0; h < 24; h += 1) if (isOpen(view, d, h)) n += 1;
  return n;
};

/** The duration presets of the cost scene, in hours. */
export const COST_PRESETS = [
  [tk("One night"), 14],
  [tk("A weekend"), 64],
  [tk("One week"), 168],
];

/** The rate of the cost scene when no live offer can be read, in basis points: labelled as an example. */
export const EXAMPLE_RATE_BPS = 300;

// ---------------------------------------------------------------------------
// Pure helpers of the live scenes (tested in test/tour.test.js)
// ---------------------------------------------------------------------------

/** The best rate a borrower can take now: the lowest rate among offers with funds left, in basis points; null when none has. */
export function bestRate(offers) {
  const rates = (offers ?? []).filter((o) => BigInt(o.available ?? 0) > 0n).map((o) => Number(o.rate_bps));
  return rates.length ? Math.min(...rates) : null;
}

/** The cost of borrowing `principal` (token units) at `rateBps` for `hours`: the contract's interest, and principal plus interest. */
export function costOf(principal, rateBps, hours) {
  const due = interest(BigInt(principal), BigInt(rateBps), Math.max(1, Math.round(Number(hours))) * HOUR);
  return { interest: due, total: BigInt(principal) + due };
}

const DIGITS = /^\d{1,30}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

/**
 * The repo the journey scene replays, from the indexer's export (untrusted):
 * the repurchased one with the largest principal whose fields all read as
 * expected, or null. Hours are the charged hours between opening and buy-back.
 */
export function replayRepo(registry) {
  const usable = (Array.isArray(registry) ? registry : [])
    .filter(
      (r) =>
        r && r.status === "repurchased" && DIGITS.test(String(r.repo_id)) && DIGITS.test(String(r.principal)) && DIGITS.test(String(r.interest)) &&
        DIGITS.test(String(r.rate_bps)) && ISO.test(String(r.opened_at)) && ISO.test(String(r.closed_at)) && /^[A-Z]{1,12}$/.test(String(r.currency)),
    )
    .map((r) => {
      const opened = Date.parse(r.opened_at) / 1000;
      const closed = Date.parse(r.closed_at) / 1000;
      return {
        id: String(r.repo_id),
        principal: BigInt(r.principal),
        interest: BigInt(r.interest),
        rateBps: Number(r.rate_bps),
        currency: String(r.currency),
        openedAt: r.opened_at,
        closedAt: r.closed_at,
        hours: chargedHours(Math.max(closed - opened, 0)),
      };
    })
    .filter((r) => r.hours > 0);
  usable.sort((a, b) => (a.principal === b.principal ? 0 : a.principal > b.principal ? -1 : 1));
  return usable[0] ?? null;
}

/** A price's age and whether the contract still accepts it: `{ age, fresh }`, or null when the timestamp is unusable. */
export function freshness(timestamp, maxAgeSecs, now) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0 || !Number.isFinite(Number(now))) return null;
  const age = Math.max(Number(now) - ts, 0);
  return { age, fresh: age <= Number(maxAgeSecs) };
}
