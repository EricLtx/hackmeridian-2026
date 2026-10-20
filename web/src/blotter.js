// What the terminal shows, computed from chain facts: the band, the offer
// book, the funds, the positions blotter, the tape and the tickets. Pure: no
// DOM and no network; the arithmetic is the contract's (terms.js mirrors
// math.rs), so a ticket shows what the contract will take.

import { formatAmount, formatDateTime, formatRate, formatUnits, shortAddress } from "./format.js";
import { t, tk } from "./i18n.js";
import { HOUR, WEEKEND_SECS, chargedHours, defaultPrincipal, interest, maxTermFor, nextInterestStep, seizeState } from "./terms.js";

const big = (v) => {
  try {
    return BigInt(String(v ?? 0));
  } catch {
    return 0n;
  }
};

/** Tone of a feed: fresh, past three quarters of its age bound, or beyond it (the contract refuses it). */
export function feedTone(ageSecs, maxAgeSecs) {
  const age = Number(ageSecs);
  const max = Number(maxAgeSecs);
  if (!Number.isFinite(age) || !Number.isFinite(max) || max <= 0) return "bad";
  if (age > max) return "bad";
  return age >= max * 0.75 ? "warn" : "ok";
}

/** A duration for dense screens: "45s", "12m03s", "3h05m", "2d04h". */
export function compactDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds)));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, "0")}h`;
}

/** Time of a tape line, UTC: "21:47:03" today, "10-18 21:47" another day. */
export function tapeTime(iso, nowSecs) {
  const ms = Date.parse(iso ?? "");
  if (!Number.isFinite(ms)) return "--:--:--";
  const at = new Date(ms).toISOString();
  const today = new Date(Number(nowSecs) * 1000).toISOString().slice(0, 10);
  return at.slice(0, 10) === today ? at.slice(11, 19) : `${at.slice(5, 10)} ${at.slice(11, 16)}`;
}

// ---------------------------------------------------------------------------
// Offer book, funds, positions
// ---------------------------------------------------------------------------

/**
 * The offer book: every offer with money left, best rate first, then the
 * deepest. `funds` is the deployment's list (tickers for the fund columns),
 * `fund` the fund this interface borrows against, `wallet` the connected address.
 */
export function bookRows(offers, { funds = [], fund = null, wallet = null, maxTerm = 0 } = {}) {
  const symbolOf = (address) => funds.find((f) => f.shares === address)?.symbol ?? shortAddress(address);
  return (offers ?? [])
    .filter((o) => big(o.available) > 0n)
    .map((o) => ({
      id: Number(o.id),
      lender: o.lender,
      rateBps: Number(o.rate_bps),
      available: big(o.available),
      termSecs: maxTermFor(o, maxTerm || o.max_term),
      funds: (o.funds ?? []).map(symbolOf),
      designated: Boolean(o.sponsor),
      mine: Boolean(wallet && o.lender === wallet),
      takesFund: Boolean(fund && (o.funds ?? []).includes(fund)),
    }))
    .sort((a, b) => a.rateBps - b.rateBps || (b.available > a.available ? 1 : b.available < a.available ? -1 : 0) || a.id - b.id);
}

/** Names shown for the fund states, the position states and the sides; the codes stay for comparisons. */
const FUND_STATES = { "N/A": tk("N/A"), FROZEN: tk("FROZEN"), STALE: tk("STALE"), "FX STALE": tk("FX STALE"), OPEN: tk("OPEN") };
const POSITION_STATES = { OPEN: tk("OPEN"), LATE: tk("LATE"), REPAID: tk("REPAID"), SEIZED: tk("SEIZED"), HELD: tk("HELD") };
const SIDES = { BOR: tk("BOR"), LND: tk("LND") };

/**
 * One row per admitted fund: NAV and its age against the fund's bound,
 * exchange rate for a cross-priced fund, haircut, capacity used, state.
 * `funds` are board entries (deployment fund + `config` + `state`), `feeds`
 * maps a fund address to `{ nav, fx }` read through the contract. `state` is
 * a code (OPEN, FROZEN, STALE, FX STALE, N/A); `stateLabel` shows it.
 */
export function fundRows(funds, { feeds = new Map(), now = 0, iface = null } = {}) {
  return (funds ?? []).map((f) => {
    const cfg = f.config?.value ?? null;
    const st = f.state?.value ?? null;
    const feed = feeds.get(f.shares) ?? null;
    const nav = feed?.nav?.value ?? null;
    const source = Array.isArray(cfg?.source) ? cfg.source[0] : (cfg?.source ?? null);
    const leg = source === "Cross" ? cfg.source[1] : null;
    const fx = leg ? (feed?.fx?.value ?? null) : null;
    const navAge = nav ? now - Number(nav.timestamp) : null;
    const fxAge = fx ? now - Number(fx.timestamp) : null;
    const navTone = feed?.nav?.error ? "bad" : nav && cfg ? feedTone(navAge, cfg.nav_max_age_secs) : "dim";
    const fxTone = !leg ? null : feed?.fx?.error ? "bad" : fx ? feedTone(fxAge, leg.max_age_secs) : "dim";
    const outstanding = st ? big(st.outstanding) : null;
    const cap = cfg ? big(cfg.max_outstanding) : null;
    let state = "N/A";
    if (cfg) state = st?.frozen ? "FROZEN" : navTone === "bad" ? "STALE" : fxTone === "bad" ? "FX STALE" : "OPEN";
    return {
      symbol: f.symbol,
      name: f.name,
      shares: f.shares,
      navCurrency: f.navCurrency,
      token: f.tokenCode === "stellar-asset-contract" ? "SAC" : "SEP-41",
      nav: nav ? big(nav.price) : null,
      navDecimals: st ? Number(st.nav_decimals) : 14,
      navAge,
      navMaxAge: cfg ? Number(cfg.nav_max_age_secs) : null,
      navTone,
      fx: fx ? big(fx.price) : null,
      fxDecimals: st ? Number(st.fx_decimals) : 14,
      fxAge,
      fxMaxAge: leg ? Number(leg.max_age_secs) : null,
      fxTone,
      source: source === "Cross" ? "CROSS" : source === "Direct" ? "DIRECT" : "—",
      haircutBps: cfg ? Number(cfg.haircut_bps) : null,
      fxHaircutBps: leg ? Number(leg.haircut_bps) : null,
      outstanding,
      cap,
      usedPct: outstanding !== null && cap ? Number((outstanding * 1000n) / cap) / 10 : null,
      perRepo: cfg ? big(cfg.max_principal_per_repo) : null,
      frozen: Boolean(st?.frozen),
      state,
      stateLabel: t(FUND_STATES[state] ?? state),
      iface: Boolean(iface && f.shares === iface),
    };
  });
}

/**
 * The blotter: one row per repo, open ones first, newest first. `dues` maps
 * an open repo to the interest due now, `releases` a closed repo to the
 * shares the token held back. `viewer` is the address the rows are seen
 * from (the side column); actions are offered only when it is `wallet`,
 * the address that can sign. `side` (BOR, LND) and `state` (OPEN, LATE,
 * REPAID, SEIZED, HELD) are codes; `sideLabel` and `stateLabel` show them.
 */
export function positionRows(repos, { now = 0, dues = new Map(), releases = new Map(), wallet = null, viewer = null, funds = [] } = {}) {
  const who = viewer ?? wallet;
  const signs = Boolean(wallet && who === wallet);
  const symbolOf = (address) => funds.find((f) => f.shares === address)?.symbol ?? shortAddress(address);
  const isOpen = (r) => r.status === "Open";
  return [...(repos ?? [])]
    .sort((a, b) => (isOpen(a) === isOpen(b) ? b.id - a.id : isOpen(a) ? -1 : 1))
    .map((r) => {
      const open = isOpen(r);
      const principal = big(r.principal);
      const owed = dues.get(r.id);
      const held = releases.get(r.id) ?? null;
      const until = Number(r.maturity) - now;
      const side = !who ? "" : r.borrower === who ? "BOR" : r.lender === who ? "LND" : "";
      let state = open ? (until <= 0 ? "LATE" : "OPEN") : r.status === "Repurchased" ? "REPAID" : "SEIZED";
      if (!open && held) state = "HELD";
      let action = null;
      if (signs && open && side === "BOR") action = `R ${r.id}`;
      else if (signs && open && side === "LND" && until <= 0) action = `S ${r.id}`;
      else if (signs && held && held.to === wallet) action = `REL ${r.id}`;
      return {
        id: r.id,
        side,
        sideLabel: side ? t(SIDES[side]) : "",
        fund: symbolOf(r.fund),
        borrower: r.borrower,
        lender: r.lender,
        stablecoin: r.stablecoin ?? null,
        shares: big(r.shares),
        principal,
        rateBps: Number(r.rate_bps),
        interest: open && owed !== undefined && owed !== null ? big(owed) : null,
        due: open && owed !== undefined && owed !== null ? principal + big(owed) : null,
        hours: open ? chargedHours(Math.max(now - Number(r.opened_at), 0)) : null,
        maturity: Number(r.maturity),
        until,
        state,
        stateLabel: t(POSITION_STATES[state] ?? state),
        held,
        action,
      };
    });
}

/** Totals of the open rows: count, principal, and what is due now when every due is known. */
export function positionTotals(rows) {
  const open = (rows ?? []).filter((r) => r.state === "OPEN" || r.state === "LATE");
  const known = open.every((r) => r.due !== null);
  return {
    open: open.length,
    principal: open.reduce((s, r) => s + r.principal, 0n),
    due: known ? open.reduce((s, r) => s + r.due, 0n) : null,
    late: open.filter((r) => r.state === "LATE").length,
  };
}

// ---------------------------------------------------------------------------
// Tape
// ---------------------------------------------------------------------------

const human = (name) => String(name ?? "").replace(/_/g, " ");

/**
 * One tape line from a contract event, as the indexer exports it or as the
 * RPC returns it once decoded: `{ event, topics (name excluded), data,
 * closedAt, txHash }`. `ctx`: `{ sd, fd, code, sym, symbolOf(fund),
 * navDecimalsOf(fund), codeOfOffer(id), codeOfRepo(id), now }`. Returns
 * `{ time, code, text, tone, repoId, txHash, known }`, `code` and `text` in
 * the interface language; `known` is false for an event this table does not
 * name, shown with a generic code.
 */
export function tapeLine(e, ctx = {}) {
  const sd = ctx.sd ?? 7;
  const fd = ctx.fd ?? 7;
  const tp = e.topics ?? [];
  const d = e.data ?? {};
  const money = (v, c = ctx.code ?? "") => `${formatAmount(big(v), sd)}${c ? ` ${c}` : ""}`;
  const exact = (v, c = ctx.code ?? "") => `${formatUnits(big(v), sd)}${c ? ` ${c}` : ""}`;
  const shares = (v) => formatAmount(big(v), fd);
  const sym = (fund) => (ctx.symbolOf ? ctx.symbolOf(fund) : shortAddress(fund));
  const short = (a) => (a ? shortAddress(String(a)) : "—");
  const at = (secs) => tapeTime(new Date(Number(secs) * 1000).toISOString(), ctx.now ?? 0);
  const repoCode = (id) => ctx.codeOfRepo?.(Number(id)) ?? ctx.code ?? "";
  const offerCode = (id) => ctx.codeOfOffer?.(Number(id)) ?? ctx.code ?? "";
  const hash = () => String(d.wasm_hash).slice(0, 8);
  // A NAV-scaled amount needs the fund's NAV decimals, which only the fund's state carries.
  const navDecimals = (fund) => {
    const decimals = ctx.navDecimalsOf?.(fund);
    if (decimals === null || decimals === undefined || decimals === "") return null;
    const n = Number(decimals);
    return Number.isSafeInteger(n) && n >= 0 && n <= 38 ? n : null;
  };
  const rows = {
    repo_opened: () => ({
      code: t("OPEN"),
      tone: "ok",
      repoId: tp[0],
      text: t("#{id} {amount} @ {rate} · {shares} {fund} · offer #{offer} · {borrower}", {
        id: tp[0],
        amount: money(d.principal, offerCode(d.offer_id)),
        rate: formatRate(d.rate_bps),
        shares: shares(d.shares),
        fund: sym(d.fund),
        offer: d.offer_id,
        borrower: short(tp[1]),
      }),
    }),
    // rc5: the valuation behind an opening, published right after it. The
    // price is per share in the loan currency, with the fund's NAV decimals.
    repo_valued: () => {
      const decimals = navDecimals(tp[1]);
      const haircut = formatRate(big(d.haircut_bps));
      if (decimals === null) {
        return { code: t("VALUE"), tone: "dim", repoId: tp[0], text: t("#{id} {fund} valued, haircut {haircut}", { id: tp[0], fund: sym(tp[1]), haircut }) };
      }
      const unit = repoCode(tp[0]);
      const price = `${formatUnits(big(d.price), decimals, { digits: Math.min(4, decimals) })}${unit ? ` ${unit}` : ""}`;
      return { code: t("VALUE"), tone: "dim", repoId: tp[0], text: t("#{id} {fund} valued at {price} per share, haircut {haircut}", { id: tp[0], fund: sym(tp[1]), price, haircut }) };
    },
    repo_repurchased: () => ({ code: t("REPAY"), tone: "ok", repoId: tp[0], text: t("#{id} {principal} + {interest} interest", { id: tp[0], principal: money(d.principal, repoCode(tp[0])), interest: exact(d.interest, "") }) }),
    repo_seized: () => ({ code: t("SEIZE"), tone: "bad", repoId: tp[0], text: t("#{id} {shares} shares to the lender {to}", { id: tp[0], shares: shares(d.shares), to: short(d.to) }) }),
    release_deferred: () => ({ code: t("HELD"), tone: "warn", repoId: tp[0], text: t("#{id} {shares} shares owed to {to}: the share token refused the transfer", { id: tp[0], shares: shares(d.shares), to: short(d.to) }) }),
    release_redirected: () => ({ code: t("REDIR"), tone: "warn", repoId: tp[0], text: t("#{id} delivery redirected to {to}", { id: tp[0], to: short(d.to) }) }),
    shares_released: () => ({ code: t("DLVR"), tone: "ok", repoId: tp[0], text: t("#{id} {shares} shares delivered to {to}", { id: tp[0], shares: shares(d.shares), to: short(d.to) }) }),
    offer_created: () => ({
      code: t("OFFER"),
      tone: "id",
      text: t("#{id} {amount} @ {rate} up to {hours} h by {lender}", { id: tp[0], amount: money(d.amount, offerCode(tp[0])), rate: formatRate(d.rate_bps), hours: Math.floor(Number(d.max_term) / HOUR), lender: short(tp[1]) }),
    }),
    offer_withdrawn: () => ({ code: t("WDRAW"), tone: "dim", text: t("#{id} {amount} withdrawn", { id: tp[0], amount: money(d.amount, offerCode(tp[0])) }) }),
    sponsor_set: () => ({ code: t("DSG"), tone: "id", text: d.sponsor ? t("offer #{id} designated by the issuer", { id: tp[0] }) : t("offer #{id} no longer designated", { id: tp[0] }) }),
    pause_changed: () =>
      d.paused
        ? { code: t("PAUSE"), tone: "warn", text: t("new entries paused by {by}; exits still work", { by: short(d.by) }) }
        : { code: t("RESUME"), tone: "ok", text: t("entries reopened by {by}", { by: short(d.by) }) },
    fund_set: () => ({ code: t("FUND"), tone: "id", text: t("{fund} admitted, haircut {haircut}", { fund: sym(tp[0]), haircut: formatRate(d.haircut_bps) }) }),
    fund_removed: () => ({ code: t("FUND"), tone: "warn", text: t("{name} removed", { name: sym(tp[0]) }) }),
    fund_limits_set: () => ({
      code: t("LIMIT"),
      tone: "id",
      text: t("{fund} haircut {haircut}, {perRepo} per repo, cap {cap}", { fund: sym(tp[0]), haircut: formatRate(d.haircut_bps), perRepo: money(d.max_principal_per_repo), cap: money(d.max_outstanding) }),
    }),
    fund_frozen: () =>
      d.frozen
        ? { code: t("FREEZE"), tone: "warn", text: t("{fund} frozen by its issuer: no new repo", { fund: sym(tp[0]) }) }
        : { code: t("THAW"), tone: "ok", text: t("{fund} unfrozen", { fund: sym(tp[0]) }) },
    reference_updated: () => ({ code: t("NAVREF"), tone: "dim", text: t("{fund} NAV reference moved along the model path", { fund: sym(tp[0]) }) }),
    reanchored: () => ({ code: t("ANCHOR"), tone: "warn", text: t("{fund} NAV reference re-anchored with two keys", { fund: sym(tp[0]) }) }),
    lender_approval: () => ({
      code: t("APPRV"),
      tone: d.approved ? "id" : "warn",
      text: d.approved ? t("{lender} approved as lender on {fund}", { lender: short(tp[1]), fund: sym(tp[0]) }) : t("{lender} revoked as lender on {fund}", { lender: short(tp[1]), fund: sym(tp[0]) }),
    }),
    lender_attested: () => ({ code: t("ATTEST"), tone: "id", text: t("{lender} attested on {fund}", { lender: short(tp[1]), fund: sym(tp[0]) }) }),
    stablecoin_set: () => ({ code: t("STBL"), tone: "id", text: t("{token} accepted as {currency}", { token: short(tp[0]), currency: d.currency }) }),
    stablecoin_removed: () => ({ code: t("STBL"), tone: "warn", text: t("{name} removed", { name: short(tp[0]) }) }),
    currency_cap_set: () => ({ code: t("CAP"), tone: "id", text: t("{currency} cap {cap}", { currency: tp[0], cap: money(d.cap, String(tp[0])) }) }),
    upgrade_proposed: () => ({ code: t("UPG?"), tone: "warn", text: t("code {hash} proposed, applicable {eta} UTC", { hash: hash(), eta: at(d.eta) }) }),
    upgrade_cancelled: () => ({ code: t("UPG×"), tone: "ok", text: t("code {hash} cancelled by {by}", { hash: hash(), by: short(d.by) }) }),
    upgraded: () => ({ code: t("UPG"), tone: "warn", text: t("code {hash} installed", { hash: hash() }) }),
    migrated: () => ({ code: t("MIGR"), tone: "warn", text: t("stored layout migrated from version {from} to {to}", { from: d.from, to: d.to }) }),
    sentinel_changed: () => ({
      code: t("SNTL"),
      tone: "id",
      text: d.sentinel ? t("sentinel {sentinel} by {by}", { sentinel: short(d.sentinel), by: short(d.by) }) : t("sentinel removed by {by}", { by: short(d.by) }),
    }),
    timelock_delay_changed: () => ({ code: t("DELAY"), tone: "warn", text: t("time delay set to {delay}", { delay: compactDuration(d.delay) }) }),
    max_term_changed: () => ({ code: t("TERM"), tone: "id", text: t("term ceiling {hours} h", { hours: Math.floor(Number(d.max_term) / HOUR) }) }),
    guardian_changed: () => ({ code: t("GRDN"), tone: "warn", text: t("guardian {address}", { address: short(d.guardian) }) }),
    admin_changed: () => ({ code: t("GOVR"), tone: "warn", text: t("governor {address}", { address: short(d.admin) }) }),
    sole_lender_set: () => ({ code: t("SOLE"), tone: "id", text: t("sole lender {address}", { address: short(d.lender) }) }),
  };
  const name = String(e.event ?? "");
  const known = Object.prototype.hasOwnProperty.call(rows, name);
  let row = known ? rows[name]() : null;
  if (!row) {
    // Events this table does not know: the event name, as the contract spells it.
    const event = human(name);
    if (name.endsWith("_proposed")) row = { code: t("PROP"), tone: "warn", text: d && d.eta !== undefined ? t("{event}, applicable {eta} UTC", { event, eta: at(d.eta) }) : event };
    else if (name.endsWith("_cancelled")) row = { code: t("CANCEL"), tone: "ok", text: d?.by ? t("{event} by {by}", { event, by: short(d.by) }) : event };
    else row = { code: t("GOV"), tone: "dim", text: event };
  }
  return { time: tapeTime(e.closedAt, ctx.now ?? 0), txHash: e.txHash ?? null, repoId: row.repoId !== undefined ? Number(row.repoId) : null, code: row.code, tone: row.tone, text: row.text, known };
}

/** A stable key for an event, to merge the indexer's export with the RPC's events. */
export function eventKey(e) {
  return `${e.txHash ?? ""}|${e.event ?? ""}|${(e.topics ?? []).join(",")}|${JSON.stringify(e.data ?? null)}`;
}

/** Merges event lists without duplicates, oldest first, keeping at most `limit`. */
export function mergeEvents(lists, limit = 200) {
  const seen = new Map();
  for (const list of lists) for (const e of list ?? []) if (e && e.event) seen.set(eventKey(e), e);
  return [...seen.values()]
    .sort((a, b) => Number(a.ledger ?? 0) - Number(b.ledger ?? 0) || String(a.closedAt).localeCompare(String(b.closedAt)))
    .slice(-limit);
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

const check = (ok, text, block = true) => ({ ok, text, block: !ok && block });

function ticket(kind, title, rows, checks, note = "") {
  return { kind, title, rows, checks, note, blocking: checks.some((c) => c.block) };
}

const noWallet = () => t("No wallet connected: CONN to connect, then GO.");

/**
 * Ticket to open a repo. Amounts are units; `quote` is the contract's
 * `{ max_principal, price, price_decimals, haircut_bps }` for these shares.
 * Without `amount` the ticket proposes 90 % of the ceiling, never above the
 * offer's liquidity or the fund's limits, rounded down to the cent.
 */
export function openTicket(o) {
  const { offer, fund, sd = 7, fd = 7, code = "", sym = "", shares, termSecs, now = 0 } = o;
  const max = o.quote ? big(o.quote.max_principal) : null;
  const haircut = o.quote ? Number(o.quote.haircut_bps) : null;
  const available = big(offer.available);
  const limits = o.limits ?? [];
  const cent = 10n ** BigInt(Math.max(sd - 2, 0));
  let principal = o.amount ?? null;
  if (principal === null && max !== null) {
    const suggested = defaultPrincipal(max, available, ...limits);
    principal = suggested - (suggested % cent);
  }
  const known = principal !== null;
  principal ??= 0n;
  const maxHours = Math.floor(maxTermFor(offer, o.contractMaxTerm) / HOUR);
  const rateBps = Number(offer.rate_bps);
  const atTerm = interest(principal, rateBps, termSecs);
  const money = (v, r) => `${formatAmount(v, sd, r)} ${code}`;
  const ifKnown = (text) => (known ? text : "—");
  const offerText = { id: offer.id, rate: formatRate(rateBps) };
  const rows = [
    [t("Offer"), offer.sponsor ? t("#{id} · {rate} a year · designated", offerText) : t("#{id} · {rate} a year", offerText)],
    [t("Lock"), `${formatAmount(shares, fd)} ${sym}`],
    [t("Ceiling"), max === null ? t("— (see the checks)") : t("{ceiling} · haircut {haircut}", { ceiling: money(max, "floor"), haircut: formatRate(haircut) })],
    [t("Receive"), ifKnown(money(principal)), "strong"],
  ];
  if (max !== null && max > 0n && haircut !== null) rows.push(["LTV", formatRate(Number((principal * BigInt(10_000 - haircut)) / max))]);
  rows.push(
    [t("Term"), t("{hours} h · ends {date}", { hours: Math.floor(termSecs / HOUR), date: formatDateTime(now + termSecs) })],
    [t("Interest, 1st hour"), ifKnown(`${formatUnits(interest(principal, rateBps, HOUR), sd)} ${code}`)],
    [t("Interest at term"), ifKnown(`${formatUnits(atTerm, sd)} ${code}`)],
    [t("Repay at term"), ifKnown(money(principal + atTerm, "ceil")), "strong"],
  );
  const accepts = (offer.funds ?? []).includes(fund);
  const termOk = termSecs >= HOUR && termSecs <= maxHours * HOUR;
  const checks = [
    check(accepts, accepts ? t("Offer #{id} accepts {fund}", { id: offer.id, fund: sym }) : t("Offer #{id} does not accept {fund}", { id: offer.id, fund: sym })),
    check(!o.ownOffer, o.ownOffer ? t("This is your own offer") : t("Offer from another lender")),
    check(termOk, termOk ? t("Term within 1 to {max} h on this offer", { max: maxHours }) : t("Term outside 1 to {max} h on this offer", { max: maxHours })),
  ];
  if (o.quoteError) checks.push(check(false, o.quoteError));
  if (max !== null) {
    checks.push(
      check(
        principal > 0n && principal <= max,
        principal > max ? t("Over the ceiling of {amount}", { amount: money(max, "floor") }) : principal > 0n ? t("Within what the shares secure") : t("Nothing to borrow"),
      ),
    );
  }
  checks.push(check(principal <= available, principal <= available ? t("The offer holds enough") : t("The offer holds {amount}", { amount: money(available, "floor") })));
  if (limits[0] !== undefined) {
    checks.push(check(principal <= big(limits[0]), principal <= big(limits[0]) ? t("Within the per-repo limit") : t("Over the per-repo limit of {amount}", { amount: money(big(limits[0])) })));
  }
  if (limits[1] !== undefined) {
    checks.push(
      check(
        principal <= big(limits[1]),
        principal <= big(limits[1]) ? t("Within the fund's remaining capacity") : t("Over the fund's remaining capacity of {amount}", { amount: money(big(limits[1]), "floor") }),
      ),
    );
  }
  if (o.paused) checks.push(check(false, t("New loans are paused; repurchases still work")));
  if (o.frozen) checks.push(check(false, t("The fund issuer froze new loans on this fund")));
  if (o.sharesHeld !== null && o.sharesHeld !== undefined) {
    checks.push(check(shares <= o.sharesHeld, shares <= o.sharesHeld ? t("You hold the shares") : t("You hold {amount}", { amount: `${formatAmount(o.sharesHeld, fd)} ${sym}` })));
  }
  if (o.preflight) checks.push(check(false, o.preflight));
  const note = o.wallet ? "" : noWallet();
  const view = ticket("open", t("OPEN REPO · offer #{id}", { id: offer.id }), rows, checks, note);
  return { ...view, principal, args: { offerId: Number(offer.id), shares, principal, term: termSecs } };
}

/** Ticket to repurchase an open repo now. `interestDue` is the contract's `repo_due`. */
export function repurchaseTicket({ repo, interestDue = null, stableHeld = null, wallet = null, now = 0, sd = 7, fd = 7, code = "", sym = "" }) {
  const open = repo.status === "Open";
  const principal = big(repo.principal);
  const due = interestDue === null ? null : principal + big(interestDue);
  const step = nextInterestStep(repo.opened_at, now);
  const oneHour = interest(principal, Number(repo.rate_bps), HOUR);
  const rows = [
    [t("Repo"), t("#{id} · {rate} a year", { id: repo.id, rate: formatRate(repo.rate_bps) })],
    [t("Repay now"), due === null ? "—" : `${formatAmount(due, sd, "ceil")} ${code}`, "strong"],
    [t("Principal"), `${formatAmount(principal, sd)} ${code}`],
    [
      t("Interest so far"),
      interestDue === null ? "—" : t("{interest} · {hours} started h", { interest: `${formatUnits(big(interestDue), sd)} ${code}`, hours: chargedHours(Math.max(now - Number(repo.opened_at), 0)) }),
    ],
    [t("Shares back"), `${formatAmount(big(repo.shares), fd)} ${sym}`, "strong"],
    [t("Next hour starts"), `${formatDateTime(step)} · +${formatUnits(oneHour, sd)} ${code}`],
  ];
  const checks = [check(open, open ? t("Repo is open") : t("Repo #{id} is closed", { id: repo.id }))];
  if (interestDue === null && open) checks.push(check(false, t("The amount due could not be read; retry")));
  if (wallet) {
    checks.push(check(repo.borrower === wallet, repo.borrower === wallet ? t("You are its borrower") : t("Only its borrower {address} repurchases it", { address: shortAddress(repo.borrower) })));
  }
  if (stableHeld !== null && due !== null) {
    checks.push(
      check(
        stableHeld >= due,
        stableHeld >= due
          ? t("You hold enough to repay")
          : t("You hold {amount}: {missing} more needed", { amount: `${formatAmount(stableHeld, sd)} ${code}`, missing: formatAmount(due - stableHeld, sd, "ceil") }),
      ),
    );
  }
  const soon = step - now;
  if (open && soon <= 120) checks.push(check(false, t("Interest steps up in {wait}: if the transaction lands after, one more hour is due", { wait: compactDuration(soon) }), false));
  const note = wallet ? t("A pause never blocks a repurchase.") : noWallet();
  return ticket("repurchase", t("REPURCHASE · repo #{id}", { id: repo.id }), rows, checks, note);
}

/** Ticket to create an offer on the interface's fund. */
export function lendTicket({ amount, rateBps, termSecs, contractMaxTerm = 0, stableHeld = null, approved = false, wallet = null, paused = false, sd = 7, code = "", fundSymbol = "" }) {
  const maxHours = Math.floor(Number(contractMaxTerm) / HOUR);
  const rows = [
    [t("Deposit"), `${formatAmount(amount, sd)} ${code}`, "strong"],
    [t("Rate"), t("{rate} a year, per started hour", { rate: formatRate(rateBps) })],
    [t("Longest term"), `${Math.floor(termSecs / HOUR)} h`],
    [t("Accepts"), fundSymbol],
    [t("If fully lent 64 h"), t("{amount} interest", { amount: `${formatUnits(interest(amount, rateBps, WEEKEND_SECS), sd)} ${code}` })],
  ];
  const termOk = termSecs <= maxHours * HOUR;
  const checks = [check(termOk, termOk ? t("Term within the contract's {max} h", { max: maxHours }) : t("The contract allows at most {max} h", { max: maxHours }))];
  if (wallet) {
    checks.push(check(approved, approved ? t("Approved lender on {fund}", { fund: fundSymbol }) : t("Not an approved lender on {fund}: the fund issuer approves lenders", { fund: fundSymbol })));
  }
  if (stableHeld !== null) checks.push(check(amount <= stableHeld, amount <= stableHeld ? t("You hold the amount") : t("You hold {amount}", { amount: `${formatAmount(stableHeld, sd)} ${code}` })));
  if (paused) checks.push(check(false, t("New offers are paused")));
  const note = wallet ? t("Unlent funds can be withdrawn at any time, even while paused.") : noWallet();
  return ticket("lend", t("CREATE OFFER"), rows, checks, note);
}

/** Ticket to withdraw from one of the wallet's offers; `amount` null means everything available. */
export function withdrawTicket({ offer, amount = null, wallet = null, sd = 7, code = "" }) {
  const available = big(offer.available);
  const take = amount ?? available;
  const rows = [
    [t("Offer"), t("#{id} · {rate} a year", { id: offer.id, rate: formatRate(offer.rate_bps) })],
    [t("Withdraw"), `${formatAmount(take, sd)} ${code}`, "strong"],
    [t("Offer keeps"), `${formatAmount(available > take ? available - take : 0n, sd)} ${code}`],
  ];
  const checks = [check(available > 0n, available > 0n ? t("The offer holds unlent funds") : t("Nothing left to withdraw"))];
  if (wallet) {
    checks.push(check(offer.lender === wallet, offer.lender === wallet ? t("It is your offer") : t("Offer #{id} belongs to {address}", { id: offer.id, address: shortAddress(offer.lender) })));
  }
  checks.push(check(take <= available && take > 0n, take <= available ? t("Within what the offer holds") : t("The offer holds {amount}", { amount: `${formatAmount(available, sd)} ${code}` })));
  const note = wallet ? t("Withdrawal works even while the contract is paused.") : noWallet();
  return { ...ticket("withdraw", t("WITHDRAW · offer #{id}", { id: offer.id }), rows, checks, note), amount: take };
}

/** Ticket to take the shares of an unpaid repo from its maturity on. */
export function seizeTicket({ repo, wallet = null, now = 0, sd = 7, fd = 7, code = "", sym = "" }) {
  const state = seizeState(repo, now);
  const date = formatDateTime(repo.maturity);
  const rows = [
    [t("Repo"), t("#{id} · borrower {address}", { id: repo.id, address: shortAddress(repo.borrower) })],
    [t("Take"), `${formatAmount(big(repo.shares), fd)} ${sym}`, "strong"],
    [t("Unpaid principal"), `${formatAmount(big(repo.principal), sd)} ${code}`],
    [t("Term"), state.reason === "early" ? t("{date} · in {wait}", { date, wait: compactDuration(state.wait) }) : t("{date} · passed", { date })],
  ];
  const reason =
    state.reason === "closed"
      ? t("Repo #{id} is closed", { id: repo.id })
      : state.reason === "early"
        ? t("Not before the term, in {wait}", { wait: compactDuration(state.wait) })
        : t("Past its term, unpaid");
  const checks = [check(state.allowed, reason)];
  if (wallet) {
    checks.push(check(repo.lender === wallet, repo.lender === wallet ? t("You are its lender") : t("Only its lender {address} takes the shares", { address: shortAddress(repo.lender) })));
  }
  const note = wallet ? t("The shares go to your address, which the issuer approved; the borrower can still repurchase until this lands.") : noWallet();
  return ticket("seize", t("TAKE SHARES · repo #{id}", { id: repo.id }), rows, checks, note);
}

/** Ticket to retry the delivery of shares a token held back. */
export function releaseTicket({ repoId, pending = null, wallet = null, fd = 7, sym = "" }) {
  const rows = pending
    ? [
        [t("Repo"), `#${repoId}`],
        [t("Deliver"), `${formatAmount(big(pending.shares), fd)} ${sym}`, "strong"],
        [t("To"), shortAddress(pending.to)],
      ]
    : [[t("Repo"), `#${repoId}`]];
  const checks = [check(Boolean(pending), pending ? t("Shares are waiting for delivery") : t("No shares are waiting on repo #{id}", { id: repoId }))];
  const note = wallet
    ? t("Anyone may retry; the shares only go to the recorded beneficiary. If the issuer still blocks the token, nothing moves and the record stays.")
    : noWallet();
  return ticket("release", t("DELIVER · repo #{id}", { id: repoId }), rows, checks, note);
}

/** A quote view: what shares are worth and secure now, and the weekend cost at the best rate on that fund. */
export function quoteView({ shares, quote, fundSymbol = "", bestRateBps = null, sd = 7, fd = 7, code = "" }) {
  const max = big(quote.max_principal);
  const suggested = defaultPrincipal(max);
  const rows = [
    [t("Shares"), `${formatAmount(shares, fd)} ${fundSymbol}`],
    [t("Price"), t("{price} {code}/share", { price: formatUnits(big(quote.price), Number(quote.price_decimals), { digits: 4 }), code })],
    [t("Haircut"), formatRate(quote.haircut_bps)],
    [t("Ceiling"), `${formatAmount(max, sd, "floor")} ${code}`, "strong"],
  ];
  if (bestRateBps !== null) {
    rows.push([t("64 h on 90 % at {rate}", { rate: formatRate(bestRateBps) }), `${formatUnits(interest(suggested, bestRateBps, WEEKEND_SECS), sd)} ${code}`]);
  }
  return { kind: "quote", title: t("QUOTE · {fund}", { fund: fundSymbol }), rows, checks: [], note: "", blocking: false };
}

/**
 * Items of the top band: network, ledger clock, state, versions, every fund's
 * NAV and age, the exchange rate, open interest, time delay, pending changes.
 * Labels, values and titles are in the interface language.
 */
export function bandItems({ network = "", paused = null, version = null, schema = null, delay = null, funds = [], openInterest = null, pending = null, sd = 7, code = "" }) {
  const items = [{ label: network.toUpperCase(), value: "", tone: "amber" }];
  items.push(
    paused === true
      ? { label: t("STATE"), value: t("PAUSED"), tone: "warn", title: t("New offers and repos are suspended; exits still work") }
      : paused === false
        ? { label: t("STATE"), value: t("OPEN"), tone: "ok" }
        : { label: t("STATE"), value: "?", tone: "dim" },
  );
  if (version !== null) items.push({ label: t("CODE"), value: `v${version}${schema !== null ? `·s${schema}` : ""}`, tone: "id", title: t("Contract version and stored layout version") });
  for (const f of funds) {
    const bound = f.navMaxAge === null ? "?" : compactDuration(f.navMaxAge);
    const navTitle =
      f.navAge === null ? t("{name}: NAV unread, bound {bound}", { name: f.name, bound }) : t("{name}: NAV {age} old, bound {bound}", { name: f.name, age: compactDuration(f.navAge), bound });
    items.push({
      label: f.symbol,
      value: f.nav === null ? "—" : `${formatUnits(f.nav, f.navDecimals, { digits: 4 })} ${f.navCurrency}${f.navAge === null ? "" : ` ${compactDuration(f.navAge)}`}`,
      tone: f.frozen ? "warn" : f.navTone,
      title: f.frozen ? t("{text}; frozen by its issuer", { text: navTitle }) : navTitle,
    });
    if (f.fx !== null) {
      items.push({
        label: t("FX {symbol}", { symbol: f.symbol }),
        value: `${formatUnits(f.fx, f.fxDecimals, { digits: 4 })}${f.fxAge === null ? "" : ` ${compactDuration(f.fxAge)}`}`,
        tone: f.fxTone,
        title: t("Exchange rate of the {symbol} leg, bound {bound}", { symbol: f.symbol, bound: f.fxMaxAge === null ? "?" : compactDuration(f.fxMaxAge) }),
      });
    }
  }
  if (openInterest) {
    items.push({ label: t("OI"), value: `${openInterest.count} · ${formatAmount(openInterest.principal, sd)} ${code}`, tone: "id", title: t("Open repos on the instance and their principal") });
  }
  if (delay !== null) items.push({ label: t("DELAY"), value: compactDuration(delay), tone: "dim", title: t("Time delay of every loosening, upgrade and feed change") });
  if (pending !== null) {
    items.push({
      label: t("GOV"),
      value: pending === 0 ? t("none pending") : t("{n} pending", { n: pending }),
      tone: pending ? "warn" : "ok",
      title: t("Governance changes waiting for their time delay"),
    });
  }
  return items;
}
