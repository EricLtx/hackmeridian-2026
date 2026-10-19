// What the terminal shows, computed from chain facts: the band, the offer
// book, the funds, the positions blotter, the tape and the tickets. Pure: no
// DOM and no network; the arithmetic is the contract's (terms.js mirrors
// math.rs), so a ticket shows what the contract will take.

import { formatAmount, formatDateTime, formatRate, formatUnits, shortAddress } from "./format.js";
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

/**
 * One row per admitted fund: NAV and its age against the fund's bound,
 * exchange rate for a cross-priced fund, haircut, capacity used, state.
 * `funds` are board entries (deployment fund + `config` + `state`), `feeds`
 * maps a fund address to `{ nav, fx }` read through the contract.
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
      iface: Boolean(iface && f.shares === iface),
    };
  });
}

/**
 * The blotter: one row per repo, open ones first, newest first. `dues` maps
 * an open repo to the interest due now, `releases` a closed repo to the
 * shares the token held back. `viewer` is the address the rows are seen
 * from (the side column); actions are offered only when it is `wallet`,
 * the address that can sign.
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
 * codeOfOffer(id), codeOfRepo(id), now }`. Returns `{ time, code, text,
 * tone, repoId, txHash }`.
 */
export function tapeLine(e, ctx = {}) {
  const sd = ctx.sd ?? 7;
  const fd = ctx.fd ?? 7;
  const t = e.topics ?? [];
  const d = e.data ?? {};
  const money = (v, c = ctx.code ?? "") => `${formatAmount(big(v), sd)}${c ? ` ${c}` : ""}`;
  const exact = (v, c = ctx.code ?? "") => `${formatUnits(big(v), sd)}${c ? ` ${c}` : ""}`;
  const shares = (v) => formatAmount(big(v), fd);
  const sym = (fund) => (ctx.symbolOf ? ctx.symbolOf(fund) : shortAddress(fund));
  const short = (a) => (a ? shortAddress(String(a)) : "—");
  const at = (secs) => tapeTime(new Date(Number(secs) * 1000).toISOString(), ctx.now ?? 0);
  const repoCode = (id) => ctx.codeOfRepo?.(Number(id)) ?? ctx.code ?? "";
  const offerCode = (id) => ctx.codeOfOffer?.(Number(id)) ?? ctx.code ?? "";
  const rows = {
    repo_opened: () => ({ code: "OPEN", tone: "ok", repoId: t[0], text: `#${t[0]} ${money(d.principal, offerCode(d.offer_id))} @ ${formatRate(d.rate_bps)} · ${shares(d.shares)} ${sym(d.fund)} · offer #${d.offer_id} · ${short(t[1])}` }),
    repo_repurchased: () => ({ code: "REPAY", tone: "ok", repoId: t[0], text: `#${t[0]} ${money(d.principal, repoCode(t[0]))} + ${exact(d.interest, "")} interest` }),
    repo_seized: () => ({ code: "SEIZE", tone: "bad", repoId: t[0], text: `#${t[0]} ${shares(d.shares)} shares to the lender ${short(d.to)}` }),
    release_deferred: () => ({ code: "HELD", tone: "warn", repoId: t[0], text: `#${t[0]} ${shares(d.shares)} shares owed to ${short(d.to)}: the share token refused the transfer` }),
    release_redirected: () => ({ code: "REDIR", tone: "warn", repoId: t[0], text: `#${t[0]} delivery redirected to ${short(d.to)}` }),
    shares_released: () => ({ code: "DLVR", tone: "ok", repoId: t[0], text: `#${t[0]} ${shares(d.shares)} shares delivered to ${short(d.to)}` }),
    offer_created: () => ({ code: "OFFER", tone: "id", text: `#${t[0]} ${money(d.amount, offerCode(t[0]))} @ ${formatRate(d.rate_bps)} up to ${Math.floor(Number(d.max_term) / HOUR)} h by ${short(t[1])}` }),
    offer_withdrawn: () => ({ code: "WDRAW", tone: "dim", text: `#${t[0]} ${money(d.amount, offerCode(t[0]))} withdrawn` }),
    sponsor_set: () => ({ code: "DSG", tone: "id", text: `offer #${t[0]} ${d.sponsor ? "designated by the issuer" : "no longer designated"}` }),
    pause_changed: () => (d.paused ? { code: "PAUSE", tone: "warn", text: `new entries paused by ${short(d.by)}; exits still work` } : { code: "RESUME", tone: "ok", text: `entries reopened by ${short(d.by)}` }),
    fund_set: () => ({ code: "FUND", tone: "id", text: `${sym(t[0])} admitted, haircut ${formatRate(d.haircut_bps)}` }),
    fund_removed: () => ({ code: "FUND", tone: "warn", text: `${sym(t[0])} removed` }),
    fund_limits_set: () => ({ code: "LIMIT", tone: "id", text: `${sym(t[0])} haircut ${formatRate(d.haircut_bps)}, ${money(d.max_principal_per_repo)} per repo, cap ${money(d.max_outstanding)}` }),
    fund_frozen: () => (d.frozen ? { code: "FREEZE", tone: "warn", text: `${sym(t[0])} frozen by its issuer: no new repo` } : { code: "THAW", tone: "ok", text: `${sym(t[0])} unfrozen` }),
    reference_updated: () => ({ code: "NAVREF", tone: "dim", text: `${sym(t[0])} NAV reference moved along the model path` }),
    reanchored: () => ({ code: "ANCHOR", tone: "warn", text: `${sym(t[0])} NAV reference re-anchored with two keys` }),
    lender_approval: () => ({ code: "APPRV", tone: d.approved ? "id" : "warn", text: `${short(t[1])} ${d.approved ? "approved" : "revoked"} as lender on ${sym(t[0])}` }),
    lender_attested: () => ({ code: "ATTEST", tone: "id", text: `${short(t[1])} attested on ${sym(t[0])}` }),
    stablecoin_set: () => ({ code: "STBL", tone: "id", text: `${short(t[0])} accepted as ${d.currency}` }),
    stablecoin_removed: () => ({ code: "STBL", tone: "warn", text: `${short(t[0])} removed` }),
    currency_cap_set: () => ({ code: "CAP", tone: "id", text: `${t[0]} cap ${money(d.cap, String(t[0]))}` }),
    upgrade_proposed: () => ({ code: "UPG?", tone: "warn", text: `code ${String(d.wasm_hash).slice(0, 8)} proposed, applicable ${at(d.eta)} UTC` }),
    upgrade_cancelled: () => ({ code: "UPG×", tone: "ok", text: `code ${String(d.wasm_hash).slice(0, 8)} cancelled by ${short(d.by)}` }),
    upgraded: () => ({ code: "UPG", tone: "warn", text: `code ${String(d.wasm_hash).slice(0, 8)} installed` }),
    migrated: () => ({ code: "MIGR", tone: "warn", text: `stored layout migrated from version ${d.from} to ${d.to}` }),
    sentinel_changed: () => ({ code: "SNTL", tone: "id", text: `sentinel ${d.sentinel ? short(d.sentinel) : "removed"} by ${short(d.by)}` }),
    timelock_delay_changed: () => ({ code: "DELAY", tone: "warn", text: `time delay set to ${compactDuration(d.delay)}` }),
    max_term_changed: () => ({ code: "TERM", tone: "id", text: `term ceiling ${Math.floor(Number(d.max_term) / HOUR)} h` }),
    guardian_changed: () => ({ code: "GRDN", tone: "warn", text: `guardian ${short(d.guardian)}` }),
    admin_changed: () => ({ code: "GOVR", tone: "warn", text: `governor ${short(d.admin)}` }),
    sole_lender_set: () => ({ code: "SOLE", tone: "id", text: `sole lender ${short(d.lender)}` }),
  };
  const name = String(e.event ?? "");
  let row = rows[name]?.();
  if (!row) {
    const eta = d && d.eta !== undefined ? `, applicable ${at(d.eta)} UTC` : "";
    if (name.endsWith("_proposed")) row = { code: "PROP", tone: "warn", text: `${human(name)}${eta}` };
    else if (name.endsWith("_cancelled")) row = { code: "CANCEL", tone: "ok", text: `${human(name)}${d?.by ? ` by ${short(d.by)}` : ""}` };
    else row = { code: "GOV", tone: "dim", text: human(name) };
  }
  return { time: tapeTime(e.closedAt, ctx.now ?? 0), txHash: e.txHash ?? null, repoId: row.repoId !== undefined ? Number(row.repoId) : null, code: row.code, tone: row.tone, text: row.text };
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
  const rows = [
    ["Offer", `#${offer.id} · ${formatRate(rateBps)} a year${offer.sponsor ? " · designated" : ""}`],
    ["Lock", `${formatAmount(shares, fd)} ${sym}`],
    ["Ceiling", max === null ? "— (see the checks)" : `${money(max, "floor")} · haircut ${formatRate(haircut)}`],
    ["Receive", ifKnown(money(principal)), "strong"],
  ];
  if (max !== null && max > 0n && haircut !== null) rows.push(["LTV", formatRate(Number((principal * BigInt(10_000 - haircut)) / max))]);
  rows.push(
    ["Term", `${Math.floor(termSecs / HOUR)} h · ends ${formatDateTime(now + termSecs)}`],
    ["Interest, 1st hour", ifKnown(`${formatUnits(interest(principal, rateBps, HOUR), sd)} ${code}`)],
    ["Interest at term", ifKnown(`${formatUnits(atTerm, sd)} ${code}`)],
    ["Repay at term", ifKnown(money(principal + atTerm, "ceil")), "strong"],
  );
  const checks = [
    check((offer.funds ?? []).includes(fund), `Offer #${offer.id} ${(offer.funds ?? []).includes(fund) ? "accepts" : "does not accept"} ${sym}`),
    check(!o.ownOffer, o.ownOffer ? "This is your own offer" : "Offer from another lender"),
    check(termSecs >= HOUR && termSecs <= maxHours * HOUR, `Term ${termSecs >= HOUR && termSecs <= maxHours * HOUR ? "within" : "outside"} 1 to ${maxHours} h on this offer`),
  ];
  if (o.quoteError) checks.push(check(false, o.quoteError));
  if (max !== null) checks.push(check(principal > 0n && principal <= max, principal > max ? `Over the ceiling of ${money(max, "floor")}` : principal > 0n ? "Within what the shares secure" : "Nothing to borrow"));
  checks.push(check(principal <= available, principal <= available ? "The offer holds enough" : `The offer holds ${money(available, "floor")}`));
  if (limits[0] !== undefined) checks.push(check(principal <= big(limits[0]), principal <= big(limits[0]) ? "Within the per-repo limit" : `Over the per-repo limit of ${money(big(limits[0]))}`));
  if (limits[1] !== undefined) checks.push(check(principal <= big(limits[1]), principal <= big(limits[1]) ? "Within the fund's remaining capacity" : `Over the fund's remaining capacity of ${money(big(limits[1]), "floor")}`));
  if (o.paused) checks.push(check(false, "New loans are paused; repurchases still work"));
  if (o.frozen) checks.push(check(false, "The fund issuer froze new loans on this fund"));
  if (o.sharesHeld !== null && o.sharesHeld !== undefined) {
    checks.push(check(shares <= o.sharesHeld, shares <= o.sharesHeld ? "You hold the shares" : `You hold ${formatAmount(o.sharesHeld, fd)} ${sym}`));
  }
  if (o.preflight) checks.push(check(false, o.preflight));
  const note = o.wallet ? "" : "No wallet connected: CONN to connect, then GO.";
  const t = ticket("open", `OPEN REPO · offer #${offer.id}`, rows, checks, note);
  return { ...t, principal, args: { offerId: Number(offer.id), shares, principal, term: termSecs } };
}

/** Ticket to repurchase an open repo now. `interestDue` is the contract's `repo_due`. */
export function repurchaseTicket({ repo, interestDue = null, stableHeld = null, wallet = null, now = 0, sd = 7, fd = 7, code = "", sym = "" }) {
  const open = repo.status === "Open";
  const principal = big(repo.principal);
  const due = interestDue === null ? null : principal + big(interestDue);
  const step = nextInterestStep(repo.opened_at, now);
  const oneHour = interest(principal, Number(repo.rate_bps), HOUR);
  const rows = [
    ["Repo", `#${repo.id} · ${formatRate(repo.rate_bps)} a year`],
    ["Repay now", due === null ? "—" : `${formatAmount(due, sd, "ceil")} ${code}`, "strong"],
    ["Principal", `${formatAmount(principal, sd)} ${code}`],
    ["Interest so far", interestDue === null ? "—" : `${formatUnits(big(interestDue), sd)} ${code} · ${chargedHours(Math.max(now - Number(repo.opened_at), 0))} started h`],
    ["Shares back", `${formatAmount(big(repo.shares), fd)} ${sym}`, "strong"],
    ["Next hour starts", `${formatDateTime(step)} · +${formatUnits(oneHour, sd)} ${code}`],
  ];
  const checks = [check(open, open ? "Repo is open" : `Repo #${repo.id} is closed`)];
  if (interestDue === null && open) checks.push(check(false, "The amount due could not be read; retry"));
  if (wallet) checks.push(check(repo.borrower === wallet, repo.borrower === wallet ? "You are its borrower" : `Only its borrower ${shortAddress(repo.borrower)} repurchases it`));
  if (stableHeld !== null && due !== null) {
    checks.push(check(stableHeld >= due, stableHeld >= due ? "You hold enough to repay" : `You hold ${formatAmount(stableHeld, sd)} ${code}: ${formatAmount(due - stableHeld, sd, "ceil")} more needed`));
  }
  const soon = step - now;
  if (open && soon <= 120) checks.push(check(false, `Interest steps up in ${compactDuration(soon)}: if the transaction lands after, one more hour is due`, false));
  const note = wallet ? "A pause never blocks a repurchase." : "No wallet connected: CONN to connect, then GO.";
  return ticket("repurchase", `REPURCHASE · repo #${repo.id}`, rows, checks, note);
}

/** Ticket to create an offer on the interface's fund. */
export function lendTicket({ amount, rateBps, termSecs, contractMaxTerm = 0, stableHeld = null, approved = false, wallet = null, paused = false, sd = 7, code = "", fundSymbol = "" }) {
  const maxHours = Math.floor(Number(contractMaxTerm) / HOUR);
  const rows = [
    ["Deposit", `${formatAmount(amount, sd)} ${code}`, "strong"],
    ["Rate", `${formatRate(rateBps)} a year, per started hour`],
    ["Longest term", `${Math.floor(termSecs / HOUR)} h`],
    ["Accepts", fundSymbol],
    ["If fully lent 64 h", `${formatUnits(interest(amount, rateBps, WEEKEND_SECS), sd)} ${code} interest`],
  ];
  const checks = [check(termSecs <= maxHours * HOUR, termSecs <= maxHours * HOUR ? `Term within the contract's ${maxHours} h` : `The contract allows at most ${maxHours} h`)];
  if (wallet) checks.push(check(approved, approved ? `Approved lender on ${fundSymbol}` : `Not an approved lender on ${fundSymbol}: the fund issuer approves lenders`));
  if (stableHeld !== null) checks.push(check(amount <= stableHeld, amount <= stableHeld ? "You hold the amount" : `You hold ${formatAmount(stableHeld, sd)} ${code}`));
  if (paused) checks.push(check(false, "New offers are paused"));
  const note = wallet ? "Unlent funds can be withdrawn at any time, even while paused." : "No wallet connected: CONN to connect, then GO.";
  return ticket("lend", "CREATE OFFER", rows, checks, note);
}

/** Ticket to withdraw from one of the wallet's offers; `amount` null means everything available. */
export function withdrawTicket({ offer, amount = null, wallet = null, sd = 7, code = "" }) {
  const available = big(offer.available);
  const take = amount ?? available;
  const rows = [
    ["Offer", `#${offer.id} · ${formatRate(offer.rate_bps)} a year`],
    ["Withdraw", `${formatAmount(take, sd)} ${code}`, "strong"],
    ["Offer keeps", `${formatAmount(available > take ? available - take : 0n, sd)} ${code}`],
  ];
  const checks = [check(available > 0n, available > 0n ? "The offer holds unlent funds" : "Nothing left to withdraw")];
  if (wallet) checks.push(check(offer.lender === wallet, offer.lender === wallet ? "It is your offer" : `Offer #${offer.id} belongs to ${shortAddress(offer.lender)}`));
  checks.push(check(take <= available && take > 0n, take <= available ? "Within what the offer holds" : `The offer holds ${formatAmount(available, sd)} ${code}`));
  const note = wallet ? "Withdrawal works even while the contract is paused." : "No wallet connected: CONN to connect, then GO.";
  return { ...ticket("withdraw", `WITHDRAW · offer #${offer.id}`, rows, checks, note), amount: take };
}

/** Ticket to take the shares of an unpaid repo from its maturity on. */
export function seizeTicket({ repo, wallet = null, now = 0, sd = 7, fd = 7, code = "", sym = "" }) {
  const state = seizeState(repo, now);
  const rows = [
    ["Repo", `#${repo.id} · borrower ${shortAddress(repo.borrower)}`],
    ["Take", `${formatAmount(big(repo.shares), fd)} ${sym}`, "strong"],
    ["Unpaid principal", `${formatAmount(big(repo.principal), sd)} ${code}`],
    ["Term", `${formatDateTime(repo.maturity)}${state.reason === "early" ? ` · in ${compactDuration(state.wait)}` : " · passed"}`],
  ];
  const reason = state.reason === "closed" ? `Repo #${repo.id} is closed` : state.reason === "early" ? `Not before the term, in ${compactDuration(state.wait)}` : "Past its term, unpaid";
  const checks = [check(state.allowed, reason)];
  if (wallet) checks.push(check(repo.lender === wallet, repo.lender === wallet ? "You are its lender" : `Only its lender ${shortAddress(repo.lender)} takes the shares`));
  const note = wallet ? "The shares go to your address, which the issuer approved; the borrower can still repurchase until this lands." : "No wallet connected: CONN to connect, then GO.";
  return ticket("seize", `TAKE SHARES · repo #${repo.id}`, rows, checks, note);
}

/** Ticket to retry the delivery of shares a token held back. */
export function releaseTicket({ repoId, pending = null, wallet = null, fd = 7, sym = "" }) {
  const rows = pending
    ? [
        ["Repo", `#${repoId}`],
        ["Deliver", `${formatAmount(big(pending.shares), fd)} ${sym}`, "strong"],
        ["To", shortAddress(pending.to)],
      ]
    : [["Repo", `#${repoId}`]];
  const checks = [check(Boolean(pending), pending ? "Shares are waiting for delivery" : `No shares are waiting on repo #${repoId}`)];
  const note = wallet
    ? "Anyone may retry; the shares only go to the recorded beneficiary. If the issuer still blocks the token, nothing moves and the record stays."
    : "No wallet connected: CONN to connect, then GO.";
  return ticket("release", `DELIVER · repo #${repoId}`, rows, checks, note);
}

/** A quote view: what shares are worth and secure now, and the weekend cost at the best rate on that fund. */
export function quoteView({ shares, quote, fundSymbol = "", bestRateBps = null, sd = 7, fd = 7, code = "" }) {
  const max = big(quote.max_principal);
  const suggested = defaultPrincipal(max);
  const rows = [
    ["Shares", `${formatAmount(shares, fd)} ${fundSymbol}`],
    ["Price", `${formatUnits(big(quote.price), Number(quote.price_decimals), { digits: 4 })} ${code}/share`],
    ["Haircut", formatRate(quote.haircut_bps)],
    ["Ceiling", `${formatAmount(max, sd, "floor")} ${code}`, "strong"],
  ];
  if (bestRateBps !== null) {
    rows.push([`64 h on 90 % at ${formatRate(bestRateBps)}`, `${formatUnits(interest(suggested, bestRateBps, WEEKEND_SECS), sd)} ${code}`]);
  }
  return { kind: "quote", title: `QUOTE · ${fundSymbol}`, rows, checks: [], note: "", blocking: false };
}

/**
 * Items of the top band: network, ledger clock, state, versions, every fund's
 * NAV and age, the exchange rate, open interest, time delay, pending changes.
 */
export function bandItems({ network = "", paused = null, version = null, schema = null, delay = null, funds = [], openInterest = null, pending = null, sd = 7, code = "" }) {
  const items = [{ label: network.toUpperCase(), value: "", tone: "amber" }];
  items.push(paused === true ? { label: "STATE", value: "PAUSED", tone: "warn", title: "New offers and repos are suspended; exits still work" } : paused === false ? { label: "STATE", value: "OPEN", tone: "ok" } : { label: "STATE", value: "?", tone: "dim" });
  if (version !== null) items.push({ label: "CODE", value: `v${version}${schema !== null ? `·s${schema}` : ""}`, tone: "id", title: "Contract version and stored layout version" });
  for (const f of funds) {
    items.push({
      label: f.symbol,
      value: f.nav === null ? "—" : `${formatUnits(f.nav, f.navDecimals, { digits: 4 })} ${f.navCurrency}${f.navAge === null ? "" : ` ${compactDuration(f.navAge)}`}`,
      tone: f.frozen ? "warn" : f.navTone,
      title: `${f.name}: NAV ${f.navAge === null ? "unread" : `${compactDuration(f.navAge)} old`}, bound ${f.navMaxAge === null ? "?" : compactDuration(f.navMaxAge)}${f.frozen ? "; frozen by its issuer" : ""}`,
    });
    if (f.fx !== null) {
      items.push({
        label: `FX ${f.symbol}`,
        value: `${formatUnits(f.fx, f.fxDecimals, { digits: 4 })}${f.fxAge === null ? "" : ` ${compactDuration(f.fxAge)}`}`,
        tone: f.fxTone,
        title: `Exchange rate of the ${f.symbol} leg, bound ${f.fxMaxAge === null ? "?" : compactDuration(f.fxMaxAge)}`,
      });
    }
  }
  if (openInterest) items.push({ label: "OI", value: `${openInterest.count} · ${formatAmount(openInterest.principal, sd)} ${code}`, tone: "id", title: "Open repos on the instance and their principal" });
  if (delay !== null) items.push({ label: "DELAY", value: compactDuration(delay), tone: "dim", title: "Time delay of every loosening, upgrade and feed change" });
  if (pending !== null) items.push({ label: "GOV", value: pending === 0 ? "none pending" : `${pending} pending`, tone: pending ? "warn" : "ok", title: "Governance changes waiting for their time delay" });
  return items;
}
