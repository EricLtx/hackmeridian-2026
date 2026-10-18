// The in-page guide: what each party does with Open Window, what it needs,
// what it commits to, and the terms of this instance read from the chain.
// Pure: it turns facts into rows and steps; main.js renders them.

import { formatAmount, formatDuration, formatRate } from "./format.js";

/** The three parties the interface serves, in the order a newcomer meets them. */
export const ROLES = ["borrower", "lender", "issuer"];

export const ROLE_TITLES = {
  borrower: "I hold fund shares and need cash",
  lender: "I lend stablecoins",
  issuer: "I issue a fund",
};

/**
 * Steps and commitments per role. `ctx` carries the live names and limits:
 * { code, sym, maxTermSecs, delaySecs, haircutBps }.
 */
export function roleGuide(role, ctx) {
  const term = formatDuration(ctx.maxTermSecs);
  const delay = formatDuration(ctx.delaySecs);
  const haircut = ctx.haircutBps === null ? "the fund's haircut" : `${formatRate(ctx.haircutBps)} haircut`;
  if (role === "borrower") {
    return {
      intro: `You keep your ${ctx.sym} shares and their yield. You lock them in the contract and receive ${ctx.code} in the same transaction, at any hour, for a term you choose.`,
      need: [
        "Freighter set to Testnet, with a little XLM for network fees.",
        `A trustline to ${ctx.code}, added from the wallet card.`,
        `${ctx.sym} shares in your wallet, and your address on the fund issuer's allowlist: the issuer decides who may hold its shares.`,
      ],
      steps: [
        "Pick an offer: the one the issuer designates comes first, then the cheapest.",
        `Choose the shares to lock and the term, from one hour to ${term}. The page shows the most you can borrow after the ${haircut}, and what you will owe.`,
        "Sign once. If the contract would refuse (too large, stale price, paused), the page tells you before you sign.",
        "Repurchase whenever you want: principal plus interest for the started hours, with a minimum of one hour. Your shares come back in the same transaction.",
      ],
      terms: [
        "Fixed rate, fixed term, no margin call: nothing is liquidated before the term, whatever the price does.",
        "After the term the lender may take the shares; until it does, you can still repurchase.",
        `A pause of the contract never blocks a repurchase. If the issuer freezes your shares, your debt still settles and the shares are delivered when the issuer allows.`,
        "Cost: the interest, and the network fee of each transaction (well under 1 XLM). The contract charges no fee of its own.",
      ],
    };
  }
  if (role === "lender") {
    return {
      intro: `You deposit ${ctx.code} in an offer with your rate and longest term. Borrowers draw on it against shares of the funds you list; what is not borrowed stays yours to withdraw at any time.`,
      need: [
        "An approval by each fund's issuer: you sign an attestation, the issuer approves your address for its fund.",
        `A trustline to ${ctx.code} and the stablecoins to lend.`,
        "On an instance fixed to a single lender, only that address may create offers.",
      ],
      steps: [
        `Create an offer: amount, annual rate, longest term (up to ${term}), the funds it accepts (up to eight).`,
        "Each repurchase returns principal and interest to your offer; withdraw any unlent amount whenever you want, even while the contract is paused.",
        "If a borrower has not repurchased by the term, take the shares: they go to your address or to another address the issuer approved.",
      ],
      terms: [
        `The loan never exceeds the share value after the ${haircut}; the price comes from the fund's own NAV feed, checked against a corridor and refused when stale.`,
        "You carry the credit risk inside the haircut and your own reserve; the contract holds no buffer and sells nothing for you.",
        "Rate floors, caps and feeds change only through a time delay you can see on this page.",
      ],
    };
  }
  return {
    intro: "Your fund is admitted as data: its share token, NAV feed, haircut, limits. You never lend against your own fund; you keep the controls an issuer needs.",
    need: [
      "A SEP-41 share token with an allowlist (a classic Stellar asset with authorization flags works), and a SEP-40 NAV feed published at a known cadence.",
      "A steward key for the fund, and a registered backup key.",
    ],
    steps: [
      "Admit the fund with the governor: two signatures on one call.",
      "Approve the lenders who may lend against your fund, after their attestation; revoke at will.",
      "Tune the haircut and the caps inside the risk envelope; lower the NAV reference when the fund distributes; freeze the fund if you must.",
    ],
    terms: [
      `Any loosening of a limit waits ${delay}; a tightening applies at once.`,
      "If your token refuses a transfer during a repo, the debt still settles and the shares are recorded for later delivery: no exit is ever blocked.",
      "The contract never lends your fund's shares and never sells them: a defaulted repo hands the shares to an address you approved.",
    ],
  };
}

/**
 * The terms of this instance, as rows [label, value, note], from the deployment
 * file and the board. Every value is read from the chain at the time shown.
 */
export function guideTerms({ dep, board, maxTermSecs, delaySecs, version, paused }) {
  const sd = dep.stablecoin.decimals;
  const code = dep.stablecoin.code;
  const rows = [];
  const stablecoins = dep.stablecoins?.length ? dep.stablecoins.map((s) => `${s.code} (${s.currency})`).join(", ") : `${code} (${dep.stablecoin.currency})`;
  rows.push(["Loan currency", stablecoins, "MiCA-allowlisted stablecoins only; several tokens of one currency share one cap"]);
  const funds = (board?.funds ?? []).filter((f) => f.config?.value);
  if (funds.length) {
    rows.push([
      "Funds admitted",
      funds
        .map((f) => {
          const c = f.config.value;
          const src = Array.isArray(c.source) ? c.source[0] : String(c.source);
          return `${f.symbol}: ${formatRate(c.haircut_bps)} haircut, NAV in ${f.navCurrency}${src === "Cross" ? " through an exchange-rate feed" : ""}, NAV at most ${formatDuration(Number(c.nav_max_age_secs))} old`;
        })
        .join("; "),
      "each fund has its own issuer, feed, haircut and caps",
    ]);
    const first = funds[0].config.value;
    rows.push([
      "Caps",
      `${formatAmount(BigInt(first.max_principal_per_repo), sd)} ${code} per repo, ${formatAmount(BigInt(first.max_outstanding), sd)} ${code} per fund (${funds[0].symbol})${board?.cap?.value !== undefined ? `, ${formatAmount(BigInt(board.cap.value), sd)} ${code} for the currency` : ""}`,
      "exposure grows only through the time delay",
    ]);
  }
  rows.push(["Interest", "the offer's annual rate, charged per started hour, one hour at least", "actual/365; rounded up to the unit in the lender's favor"]);
  rows.push(["Term", `one hour to ${formatDuration(maxTermSecs)}`, "early repurchase allowed; after the term the lender may take the shares"]);
  rows.push(["Changes", `${formatDuration(delaySecs)} time delay on upgrades, feed changes and any loosening`, "cancellable by the guardian or the sentinel; tightening is immediate"]);
  rows.push(["Pause", paused === true ? "paused: no new offer or repo" : "open", "a pause never blocks repurchase, withdrawal, seizure or delivery"]);
  rows.push(["Network", `${dep.network}, contract version ${version ?? "?"}`, "no real value; the code is not externally audited yet"]);
  return rows;
}
