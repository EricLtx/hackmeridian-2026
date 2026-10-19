// The in-page guide: what each party does with Open Window, what it needs,
// what it commits to, and the terms of this instance read from the chain.
// Pure: it turns facts into rows and steps; main.js renders them. Every text
// is in the interface language (i18n.js), chosen when the guide is rendered.

import { formatAmount, formatDuration, formatRate } from "./format.js";
import { t, tk } from "./i18n.js";

/** The three parties the interface serves, in the order a newcomer meets them. */
export const ROLES = ["borrower", "lender", "issuer"];

/** Tab titles, as written in English; `roleTitle` shows them in the interface language. */
export const ROLE_TITLES = {
  borrower: tk("I hold fund shares and need cash"),
  lender: tk("I lend stablecoins"),
  issuer: tk("I issue a fund"),
};

/** The tab title of a role, in the interface language. */
export const roleTitle = (role) => t(ROLE_TITLES[role] ?? String(role));

/**
 * Steps and commitments per role. `ctx` carries the live names and limits:
 * { code, sym, maxTermSecs, delaySecs, haircutBps }.
 */
export function roleGuide(role, ctx) {
  const term = formatDuration(ctx.maxTermSecs);
  const delay = formatDuration(ctx.delaySecs);
  const rate = ctx.haircutBps === null ? null : formatRate(ctx.haircutBps);
  if (role === "borrower") {
    return {
      intro: t(
        "You keep your {sym} shares and their yield. You lock them in the contract and receive {code} in the same transaction, at any hour, for a term you choose.",
        { sym: ctx.sym, code: ctx.code },
      ),
      need: [
        t("Freighter set to Testnet, with a little XLM for network fees."),
        t("A trustline to {code}, added from the wallet card.", { code: ctx.code }),
        t("{sym} shares in your wallet, and your address on the fund issuer's allowlist: the issuer decides who may hold its shares.", { sym: ctx.sym }),
      ],
      steps: [
        t("Pick an offer: the one the issuer designates comes first, then the cheapest."),
        rate === null
          ? t("Choose the shares to lock and the term, from one hour to {term}. The page shows the most you can borrow after the fund's haircut, and what you will owe.", { term })
          : t("Choose the shares to lock and the term, from one hour to {term}. The page shows the most you can borrow after the {rate} haircut, and what you will owe.", { term, rate }),
        t("Sign once. If the contract would refuse (too large, stale price, paused), the page tells you before you sign."),
        t("Repurchase whenever you want: principal plus interest for the started hours, with a minimum of one hour. Your shares come back in the same transaction."),
      ],
      terms: [
        t("Fixed rate, fixed term, no margin call: nothing is liquidated before the term, whatever the price does."),
        t("After the term the lender may take the shares; until it does, you can still repurchase."),
        t("A pause of the contract never blocks a repurchase. If the issuer freezes your shares, your debt still settles and the shares are delivered when the issuer allows."),
        t("Cost: the interest, and the network fee of each transaction (well under 1 XLM). The contract charges no fee of its own."),
      ],
    };
  }
  if (role === "lender") {
    return {
      intro: t(
        "You deposit {code} in an offer with your rate and longest term. Borrowers draw on it against shares of the funds you list; what is not borrowed stays yours to withdraw at any time.",
        { code: ctx.code },
      ),
      need: [
        t("An approval by each fund's issuer: you sign an attestation, the issuer approves your address for its fund."),
        t("A trustline to {code} and the stablecoins to lend.", { code: ctx.code }),
        t("On an instance fixed to a single lender, only that address may create offers."),
      ],
      steps: [
        t("Create an offer: amount, annual rate, longest term (up to {term}), the funds it accepts (up to eight).", { term }),
        t("Each repurchase returns principal and interest to your offer; withdraw any unlent amount whenever you want, even while the contract is paused."),
        t("If a borrower has not repurchased by the term, take the shares: they go to your address or to another address the issuer approved."),
      ],
      terms: [
        rate === null
          ? t("The loan never exceeds the share value after the fund's haircut; the price comes from the fund's own NAV feed, checked against a corridor and refused when stale.")
          : t("The loan never exceeds the share value after the {rate} haircut; the price comes from the fund's own NAV feed, checked against a corridor and refused when stale.", { rate }),
        t("You carry the credit risk inside the haircut and your own reserve; the contract holds no buffer and sells nothing for you."),
        t("Rate floors, caps and feeds change only through a time delay you can see on this page."),
      ],
    };
  }
  return {
    intro: t("Your fund is admitted as data: its share token, NAV feed, haircut, limits. You never lend against your own fund; you keep the controls an issuer needs."),
    need: [
      t("A SEP-41 share token with an allowlist (a classic Stellar asset with authorization flags works), and a SEP-40 NAV feed published at a known cadence."),
      t("A steward key for the fund, and a registered backup key."),
    ],
    steps: [
      t("Admit the fund with the governor: two signatures on one call."),
      t("Approve the lenders who may lend against your fund, after their attestation; revoke at will."),
      t("Tune the haircut and the caps inside the risk envelope; lower the NAV reference when the fund distributes; freeze the fund if you must."),
    ],
    terms: [
      t("Any loosening of a limit waits {delay}; a tightening applies at once.", { delay }),
      t("If your token refuses a transfer during a repo, the debt still settles and the shares are recorded for later delivery: no exit is ever blocked."),
      t("The contract never lends your fund's shares and never sells them: a defaulted repo hands the shares to an address you approved."),
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
  rows.push([t("Loan currency"), stablecoins, t("MiCA-allowlisted stablecoins only; several tokens of one currency share one cap")]);
  const funds = (board?.funds ?? []).filter((f) => f.config?.value);
  if (funds.length) {
    rows.push([
      t("Funds admitted"),
      funds
        .map((f) => {
          const c = f.config.value;
          const src = Array.isArray(c.source) ? c.source[0] : String(c.source);
          const facts = { symbol: f.symbol, haircut: formatRate(c.haircut_bps), currency: f.navCurrency, age: formatDuration(Number(c.nav_max_age_secs)) };
          // A cross-priced fund adds the exchange-rate haircut: the quote applies both.
          const leg = src === "Cross" && Array.isArray(c.source) ? c.source[1] : null;
          if (leg?.haircut_bps !== undefined) {
            const fx = { ...facts, fxHaircut: formatRate(leg.haircut_bps), total: formatRate(Number(c.haircut_bps) + Number(leg.haircut_bps)) };
            return t("{symbol}: {haircut} haircut plus {fxHaircut} on the exchange rate, {total} in all; NAV in {currency} through an exchange-rate feed, at most {age} old", fx);
          }
          return src === "Cross"
            ? t("{symbol}: {haircut} haircut, NAV in {currency} through an exchange-rate feed, NAV at most {age} old", facts)
            : t("{symbol}: {haircut} haircut, NAV in {currency}, NAV at most {age} old", facts);
        })
        .join(t("; ")),
      t("each fund has its own issuer, feed, haircut and caps"),
    ]);
    const first = funds[0].config.value;
    const caps = {
      perRepo: `${formatAmount(BigInt(first.max_principal_per_repo), sd)} ${code}`,
      perFund: `${formatAmount(BigInt(first.max_outstanding), sd)} ${code}`,
      symbol: funds[0].symbol,
    };
    rows.push([
      t("Caps"),
      board?.cap?.value !== undefined
        ? t("{perRepo} per repo, {perFund} per fund ({symbol}), {currencyCap} for the currency", { ...caps, currencyCap: `${formatAmount(BigInt(board.cap.value), sd)} ${code}` })
        : t("{perRepo} per repo, {perFund} per fund ({symbol})", caps),
      t("exposure grows only through the time delay"),
    ]);
  }
  rows.push([t("Interest"), t("the offer's annual rate, charged per started hour, one hour at least"), t("actual/365; rounded up to the unit in the lender's favor")]);
  rows.push([t("Term"), t("one hour to {term}", { term: formatDuration(maxTermSecs) }), t("early repurchase allowed; after the term the lender may take the shares")]);
  rows.push([
    t("Changes"),
    t("{delay} time delay on upgrades, feed changes and any loosening", { delay: formatDuration(delaySecs) }),
    t("cancellable by the guardian or the sentinel; tightening is immediate"),
  ]);
  rows.push([t("Pause"), paused === true ? t("paused: no new offer or repo") : t("open"), t("a pause never blocks repurchase, withdrawal, seizure or delivery")]);
  rows.push([t("Network"), t("{network}, contract version {version}", { network: dep.network, version: version ?? "?" }), t("no real value; the code is not externally audited yet")]);
  return rows;
}
