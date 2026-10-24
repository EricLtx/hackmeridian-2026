// The guided tour's content: thirteen scenes, hook to call to action. Each
// scene has one job, a headline, at most thirty words of body text, the
// interaction it carries, speaker notes and, for four of them, a planet
// (a texture of public/tour/) that sits beside the text. The texts are
// English source strings marked with tk(); tour.js translates them where it
// shows them, so the tour can be regenerated for another audience by editing
// this file alone. The tone is that of a counsellor: second person, one idea
// per sentence, no superlative and no business figure (test/tour.test.js
// checks the words), so a visitor can decide whether the product is for
// them before anything executes. Facts are those of the public documentation
// (README, docs/) or read live from the chain.

import { tk } from "./i18n.js";
import { HOUR, chargedHours, interest } from "./terms.js";

/** Speaker notes: the message, what to say, what to stress, the likely question, its answer, the way to the next scene. */
const notes = (key, say, stress, question, answer, next) => ({ key, say, stress, question, answer, next });

export const SCENES = [
  {
    id: "title",
    kind: "title",
    kicker: tk("Open Window · Stellar testnet"),
    title: tk("A repo for tokenized fund shares"),
    body: tk("Stablecoins against fund shares, for a fixed term at a fixed rate. This tour explains the approach before you touch anything."),
    notes: notes(
      tk("What Open Window is, and what this tour is for."),
      tk("Open Window lends stablecoins against tokenized fund shares, as a repo: a fixed term, a fixed rate, and a contract that holds the shares. The tour explains the approach first, then shows the testnet instance."),
      tk("Nothing here executes: the tour only reads. Testnet only, no real value."),
      tk("Is this a real product or a mock-up?"),
      tk("A testnet instance with a public history; scene 9 reads it live. Nothing on it has real value."),
      tk("Start with the need, on a Friday evening."),
    ),
  },
  {
    id: "hook",
    kind: "hook",
    planet: "moon",
    kicker: tk("Friday, 18:01"),
    title: tk("The market has closed. You need cash tomorrow."),
    points: [tk("A payment falls due on Saturday."), tk("Your cash sits in fund shares."), tk("The fund redeems them on Monday.")],
    notes: notes(
      tk("The need appears when the market is closed."),
      tk("Picture a treasurer on Friday at 18:01: a payment is due tomorrow, and the cash is invested in a money market fund that redeems once a business day."),
      tk("Reveal the three lines one by one, and pause after the last."),
      tk("Is this a real need?"),
      tk("It is a hypothesis: the tour is how we test it with you. If it is not your situation, say so."),
      tk("Why has this not been solved already?"),
    ),
  },
  {
    id: "context",
    kind: "context",
    kicker: tk("The context"),
    title: tk("The shares moved on-chain. The cash did not follow."),
    body: tk("Tokenized fund shares settle at any hour. Borrowing against them still keeps business hours. The week view shows the gap."),
    notes: notes(
      tk("The asset is ready for any hour; the credit is not."),
      tk("Switch the week view: in business hours, credit against fund shares is closed most of the week. A contract can keep it open."),
      tk("Click the two views; let the closed hours speak."),
      tk("Do banks not lend at night?"),
      tk("Against fund shares, the paperwork and the settlement keep business hours."),
      tk("What does waiting cost?"),
    ),
  },
  {
    id: "problem",
    kind: "problem",
    planet: "mars",
    kicker: tk("The problem"),
    title: tk("Waiting has a cost of its own"),
    points: [tk("A payment missed, or paid late."), tk("An overdraft at a punitive rate."), tk("Shares sold that should have stayed invested.")],
    notes: notes(
      tk("The cost of waiting is real, even when it is hard to see."),
      tk("Each consequence appears in turn: a late payment, an expensive overdraft, a redemption that breaks an investment plan."),
      tk("No figures here: the point is the kind of cost, not its size. Yours may be small; then this is not for you."),
      tk("How large is that cost?"),
      tk("It depends on your treasury; measure it before you decide."),
      tk("Here is the approach."),
    ),
  },
  {
    id: "insight",
    kind: "insight",
    kicker: tk("The approach"),
    title: tk("A repo, not a pool"),
    body: tk("You sell the shares to the contract and buy them back later. Fixed term, fixed rate. No liquidation, no margin call. The shares' yield stays yours."),
    notes: notes(
      tk("A known transaction, with its terms fixed when you sign."),
      tk("A repo is a sale with a promise to buy back. Compare the two columns: a lending pool on one side, this repo on the other. The rate and the term do not move while the loan is open."),
      tk("Say what happens if you do not buy back: at maturity the lender receives the shares and redeems them at the fund's window. Nothing happens before that, whatever the price does."),
      tk("Why a repo and not a loan?"),
      tk("The lender holds the shares, not a claim on them; the shares come back to you with the yield they earned meanwhile."),
      tk("Who takes part, and is it for you?"),
    ),
  },
  {
    id: "roles",
    kind: "roles",
    kicker: tk("The parties"),
    title: tk("Three parties, one contract: which are you?"),
    body: tk("Select a role to see what it can do, what it can never do, and whether Open Window fits you."),
    notes: notes(
      tk("Power is split, and each party should check the fit before going further."),
      tk("Open each role: the holder borrows, the lender lends, the fund's issuer keeps its allowlist, its price feed and its freeze, and never lends. The guardian, sentinel and trustee check the governor."),
      tk("Read the 'is it for you?' questions aloud for the party in the room, and the honest answer when it is not a fit."),
      tk("Who runs it?"),
      tk("The lender: a regulated institution running its own instance with its own stablecoins. An instance can be fixed to a single lender."),
      tk("Let us follow one loan from start to finish."),
    ),
  },
  {
    id: "journey",
    kind: "journey",
    kicker: tk("How it works"),
    title: tk("One signature, start to finish"),
    steps: [
      [tk("Quote"), tk("The contract values the shares and applies the haircut. You see the amount before you sign.")],
      [tk("Borrow"), tk("One signature: shares in, stablecoins out, for a fixed term.")],
      [tk("Hour by hour"), tk("Interest counts each started hour, at the rate fixed when you signed.")],
      [tk("Buy back"), tk("Repay any time; the shares come back in the same transaction. Unpaid at maturity, the lender takes the shares and redeems them at the fund's window.")],
    ],
    notes: notes(
      tk("The whole life of a loan fits in four steps."),
      tk("Step through the four stages; the panel replays a real repo from the public record of this instance."),
      tk("A confirmation takes a few seconds on testnet. Nothing about the loan changes between the quote and the buy-back."),
      tk("And if the borrower never repays?"),
      tk("From maturity on, and only then, the lender takes the shares. Interest runs until it does."),
      tk("What would it cost you?"),
    ),
  },
  {
    id: "cost",
    kind: "cost",
    kicker: tk("The cost"),
    title: tk("What it costs, before you sign"),
    body: tk("Choose an amount and a duration. The cost uses the contract's own formula and the best live offer, when one can be read."),
    notes: notes(
      tk("The price is known to the unit before any signature."),
      tk("Move the duration from one night to a weekend: the interest follows the hours used, nothing more."),
      tk("The rate comes from the lowest live offer when the chain answers; otherwise the example rate is labelled as such. Quote no other figure."),
      tk("Are there hidden fees?"),
      tk("The contract takes no fee of its own; the network fee is far below one unit."),
      tk("What runs today?"),
    ),
  },
  {
    id: "live",
    kind: "live",
    kicker: tk("Verified on testnet"),
    title: tk("What runs on testnet today"),
    body: tk("Read live from the testnet instance as you watch. Nothing on this scene is typed in by hand."),
    notes: notes(
      tk("The instance exists and answers right now; the figures are the chain's, not ours."),
      tk("These values are read from the chain as you watch: the admitted funds, the age of their price, the offers, the repos on record."),
      tk("A stale price is shown as stale, and an unreadable chain says so: the page never hides what the chain says. Testnet tokens have no value."),
      tk("Can I see the history?"),
      tk("Every event since the first deployment is on the History page, under a hash chain anyone can recompute."),
      tk("What happens when something goes wrong?"),
    ),
  },
  {
    id: "safety",
    kind: "safety",
    planet: "jupiter",
    kicker: tk("The safeguards"),
    title: tk("Exits stay open; changes wait"),
    tabs: [
      [tk("Price"), tk("Every loan checks the fund's price against a corridor and a backup feed. A wrong price stops new loans; buying back stays open.")],
      [tk("Time delay"), tk("Every upgrade, feed change and loosening waits a public delay. The guardian or the trustee can veto it. Tightening is immediate.")],
      [tk("Exits"), tk("No pause and no upgrade blocks an exit: buying back, withdrawing an offer and seizing at maturity always work.")],
      [tk("Rehearsed"), tk("Incident drills were replayed on testnet against the running code: a wrong price, an unannounced upgrade, an issuer freeze. The History page keeps the trail.")],
    ],
    notes: notes(
      tk("Failure is planned for, rehearsed and bounded; exits never depend on anyone's goodwill."),
      tk("Open each tab: price checks, the delay and the veto on every change, exits that no pause or upgrade can block, and the drills rehearsed on testnet."),
      tk("Say plainly what has not been done: no outside audit yet."),
      tk("Has it been audited?"),
      tk("Not by a third party. Internal reviews only, with every finding fixed and tested; the outside audit comes before any real asset."),
      tk("Here are the questions you should ask."),
    ),
  },
  {
    id: "questions",
    kind: "questions",
    kicker: tk("Before you decide"),
    title: tk("The questions you should ask"),
    faq: [
      [tk("Is any of this real money?"), tk("No. Everything runs on Stellar testnet. The tokens have no value, and nothing is deployed on mainnet.")],
      [tk("Has the code been reviewed by a third party?"), tk("Not yet. Treat it as unreviewed by anyone outside the project. The audit package is ready; the audit comes before any real asset.")],
      [tk("Will there be cash when I need it?"), tk("Only if a lender has an offer with funds left at that moment. Nothing promises liquidity; the live scene shows the offers of the moment.")],
      [tk("Can the rules change on my open loan?"), tk("No. Its rate, term, amount and shares are stored when it opens. Other changes wait a public delay, can be vetoed, and are visible to all.")],
      [tk("What if the price feed is wrong?"), tk("A corridor bounds how fast the price may move, and a backup feed must agree. Otherwise new loans stop, and buying back stays open.")],
      [tk("Is it regulated?"), tk("Open Window is software. The lender is meant to be a regulated institution on its own instance; the legal form of the transaction is being qualified.")],
    ],
    notes: notes(
      tk("Hard questions have direct answers, and some answers are 'not yet'."),
      tk("Open the questions the room cares about; each answer points to a rule the contract enforces, or says plainly what is not done."),
      tk("Say what is not claimed: no outside audit, testnet only, no real value, no promise of liquidity."),
      tk("What is not done yet?"),
      tk("The outside audit, key custody with separate people and devices, and the legal qualification."),
      tk("So what comes next?"),
    ),
  },
  {
    id: "roadmap",
    kind: "roadmap",
    kicker: tk("The road ahead"),
    title: tk("From testnet to a guarded start"),
    phases: [
      [tk("Done"), tk("The mechanism on testnet: the full lifecycle live, governed upgrades, drills rehearsed.")],
      [tk("Next"), tk("Before any real asset: an outside audit, key custody with separate people and devices.")],
      [tk("Then"), tk("A guarded start: low caps, one regulated lender, monitoring in operation.")],
      [tk("Later"), tk("More funds and currencies as data, without a new contract.")],
    ],
    notes: notes(
      tk("Each step retires one risk before the next."),
      tk("Walk the phases: what is done, what comes next, and what a guarded start means."),
      tk("Caps stay low until the evidence justifies raising them. No date is promised."),
      tk("When on mainnet?"),
      tk("Only after the outside audit and real key custody; the steps, not a date, decide."),
      tk("See it for yourself."),
    ),
  },
  {
    id: "cta",
    kind: "cta",
    planet: "saturn",
    kicker: tk("Your turn"),
    title: tk("Decide with your own eyes"),
    body: tk("Testnet only: nothing here has real value. Look without a wallet; borrow with a Freighter wallet on testnet."),
    doors: [
      [tk("Explore the live market"), "./index.html#board"],
      [tk("Open the terminal"), "./index.html?view=terminal"],
      [tk("Read the history"), "./history.html"],
    ],
    notes: notes(
      tk("One next step: try it, or decide it is not for you."),
      tk("Pick a door: the market as a treasurer sees it, the terminal as a desk sees it, or the full record."),
      tk("No wallet is needed to look; a Freighter wallet on testnet to borrow. Say again that nothing has real value."),
      tk("Can I try it now?"),
      tk("Yes, on testnet, with a Freighter wallet; the guide in the app walks you through it."),
      tk("Thank you."),
    ),
  },
];

/** The planets a scene may show beside its text: the textures of public/tour/ (Solar System Scope, CC BY 4.0). */
export const PLANETS = ["moon", "mars", "jupiter", "saturn"];

/** The words of a text, for the thirty-word rule. */
export const wordCount = (text) => String(text).trim().split(/\s+/).filter(Boolean).length;

/** The visible body text of a scene, excluding labels and data: body, points, step and phase texts. */
export function visibleWords(scene) {
  const parts = [scene.body ?? "", ...(scene.points ?? [])];
  return parts.reduce((n, text) => n + wordCount(text), 0);
}

/**
 * The roles of scene 6: what each may do, and what the contract never lets it
 * do. The three parties a visitor may be (holder, lender, issuer) also carry
 * an "is it for you?" moment: the questions to ask oneself, and the honest
 * answer when it is not a fit.
 */
export const ROLES = [
  {
    id: "holder",
    name: tk("Holder"),
    can: tk("Borrows stablecoins against its fund shares for a fixed term, and buys them back at any time."),
    never: tk("Can never be liquidated or margin-called before the term, whatever the price does."),
    fit: {
      questions: [
        tk("Do you hold tokenized shares of a fund admitted on an instance?"),
        tk("Do you need cash for hours or days, outside the fund's window?"),
        tk("Can you repay at the term, or accept that the lender keeps the shares?"),
      ],
      no: tk("If you need cash for months, or cannot accept losing the shares at maturity, a repo is not for you: redeem at the fund's window instead."),
    },
  },
  {
    id: "lender",
    name: tk("Lender"),
    can: tk("Posts offers in its own stablecoins, withdraws what is not lent, and takes the shares of a loan unpaid at its term."),
    never: tk("Can never touch the shares before the term ends, and never changes the terms of an open loan."),
    fit: {
      questions: [
        tk("Are you a regulated institution, with your own stablecoins to lend and your own instance to run?"),
        tk("Can you hold the fund's shares as an approved holder, and redeem them at the fund's window?"),
        tk("Do you accept a fixed rate per offer, with your cash idle until someone borrows it?"),
      ],
      no: tk("If you want a floating pool yield, or cannot hold the fund's shares, do not lend here."),
    },
  },
  {
    id: "steward",
    name: tk("Fund issuer"),
    can: tk("Through its steward key: admits its fund with the governor, keeps the allowlist, the price feed and the freeze, and approves the lenders."),
    never: tk("Never lends against its own fund, and never pays anyone."),
    fit: {
      questions: [
        tk("Do your shares exist as tokens, with an allowlist you control?"),
        tk("Do you publish a price feed, and can you keep it fresh?"),
        tk("Do you accept that a lender, not you, provides the cash?"),
      ],
      no: tk("If you want to fund your holders' liquidity yourself, this is not the tool: the issuer never lends here."),
    },
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
    can: tk("Pauses new loans, cancels a pending change and vetoes a governor handover."),
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
    can: tk("Optional: its signature is needed for every upgrade and for a forced change of guardian, and it can veto both."),
    never: tk("Holds no other power over the instance."),
  },
];

/** The two columns of scene 5: a lending pool, and this repo. */
export const COMPARE = {
  before: { title: tk("A lending pool"), items: [tk("A floating rate that moves with use"), tk("A liquidation when the price falls"), tk("Many lenders, one shared balance")] },
  after: { title: tk("Open Window, a repo"), items: [tk("A fixed rate and a fixed term"), tk("No liquidation before the term"), tk("One lender, one contract, your own shares back")] },
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
/**
 * The lowest rate among the offers with funds left and, when `hours` or
 * `stablecoin` (a contract id) is given, those that could serve such a loan:
 * a term within the offer's longest, in that stablecoin.
 */
export function bestRate(offers, { hours, stablecoin } = {}) {
  const term = hours === undefined ? null : Math.max(1, Math.round(Number(hours))) * HOUR;
  const rates = (offers ?? [])
    .filter((o) => BigInt(o.available ?? 0) > 0n)
    .filter((o) => term === null || Number(o.max_term) >= term)
    .filter((o) => !stablecoin || String(o.stablecoin) === stablecoin)
    .map((o) => Number(o.rate_bps));
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
        // A buy-back recorded before the opening is not a repo to show: zero hours drops it below.
        hours: closed > opened ? chargedHours(closed - opened) : 0,
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
