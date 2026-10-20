// Views rebuilt from the journal: the repo registry and an SFTR-shaped table.
// Every field comes from an event the contract emits (contracts/night-window/
// src/events.rs); nothing is read from storage or inferred. A field the chain
// does not carry stays empty and the `source` column says so.

import { eventName } from "./decode.mjs";

export const STATUS = { OPEN: "open", REPURCHASED: "repurchased", SEIZED: "seized", RELEASE_PENDING: "release_pending" };

export const REGISTRY_COLUMNS = [
  "repo_id", "lender", "borrower", "fund", "shares", "principal", "stablecoin", "currency", "rate_bps",
  "opened_at", "maturity", "status", "closure", "closed_at", "interest", "release_to", "release_shares", "last_tx", "source",
];

/** Unix seconds to the RPC's close-time format (`2026-10-15T21:44:57Z`). */
const iso = (unixSeconds) => (unixSeconds === null || unixSeconds === undefined || unixSeconds === "" ? "" : new Date(Number(unixSeconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"));
const str = (v) => (v === null || v === undefined ? "" : String(v));

/**
 * One row per repo, from the repo lifecycle events: `repo_opened`,
 * `repo_repurchased`, `repo_seized`, `release_deferred`, `release_redirected`,
 * `shares_released`. The stablecoin comes from the `offer_created` event of
 * the repo's offer and the currency from the `stablecoin_set` event of that
 * stablecoin, when the chain holds them. `opened_at` and `closed_at` are the
 * close times of the ledgers that carried the events, which is the timestamp
 * the contract itself stored.
 */
export function registry(lines) {
  const offers = new Map(); // offer_id -> { stablecoin, lender, rate_bps }
  const currencies = new Map(); // stablecoin -> currency
  const repos = new Map(); // repo_id -> row
  const row = (id) => {
    if (!repos.has(id)) {
      const blank = Object.fromEntries(REGISTRY_COLUMNS.map((c) => [c, ""]));
      repos.set(id, { ...blank, repo_id: id, source: [], _opened: false, _offer: "" });
    }
    return repos.get(id);
  };
  for (const line of lines) {
    const name = eventName(line);
    const t = line.topics ?? [];
    const d = line.data ?? {};
    if (name === "offer_created") offers.set(str(t[1]), { stablecoin: str(d.stablecoin), lender: str(t[2]), rate_bps: str(d.rate_bps) });
    else if (name === "stablecoin_set") currencies.set(str(t[1]), str(d.currency));
    else if (name === "repo_opened") {
      const r = row(str(t[1]));
      Object.assign(r, {
        borrower: str(t[2]), lender: str(d.lender), fund: str(d.fund), shares: str(d.shares), principal: str(d.principal), rate_bps: str(d.rate_bps),
        opened_at: line.closedAt, maturity: iso(d.maturity), status: STATUS.OPEN, last_tx: line.txHash, _opened: true, _offer: str(d.offer_id),
      });
      r.source.push(`repo_opened@${line.seq}`);
    } else if (name === "repo_repurchased") {
      const r = row(str(t[1]));
      Object.assign(r, { status: STATUS.REPURCHASED, closure: STATUS.REPURCHASED, closed_at: line.closedAt, interest: str(d.interest), last_tx: line.txHash });
      if (!r.principal) r.principal = str(d.principal);
      r.source.push(`repo_repurchased@${line.seq}`);
    } else if (name === "repo_seized") {
      const r = row(str(t[1]));
      Object.assign(r, { status: STATUS.SEIZED, closure: STATUS.SEIZED, closed_at: line.closedAt, release_to: str(d.to), last_tx: line.txHash });
      if (!r.shares) r.shares = str(d.shares);
      r.source.push(`repo_seized@${line.seq}`);
    } else if (name === "release_deferred") {
      const r = row(str(t[1]));
      Object.assign(r, { status: STATUS.RELEASE_PENDING, release_to: str(d.to), release_shares: str(d.shares), last_tx: line.txHash });
      r.source.push(`release_deferred@${line.seq}`);
    } else if (name === "release_redirected") {
      const r = row(str(t[1]));
      Object.assign(r, { release_to: str(d.to), last_tx: line.txHash });
      r.source.push(`release_redirected@${line.seq}`);
    } else if (name === "shares_released") {
      const r = row(str(t[1]));
      Object.assign(r, { status: r.closure || r.status, release_to: str(d.to), release_shares: "", last_tx: line.txHash });
      r.source.push(`shares_released@${line.seq}`);
    }
  }
  const rows = [...repos.values()].sort((a, b) => Number(a.repo_id) - Number(b.repo_id));
  for (const r of rows) {
    const offer = offers.get(r._offer);
    if (offer) {
      r.stablecoin = offer.stablecoin;
      r.source.push("stablecoin:offer_created");
      const currency = currencies.get(offer.stablecoin);
      if (currency) {
        r.currency = currency;
        r.source.push("currency:stablecoin_set");
      } else r.source.push("currency:not in chain");
    } else if (r._opened) r.source.push("stablecoin:offer_created not in chain");
    if (!r._opened) r.source.unshift("repo_opened not in chain");
    r.source = r.source.join(" ");
  }
  return rows.map((r) => Object.fromEntries(REGISTRY_COLUMNS.map((c) => [c, r[c]])));
}

export const SFTR_COLUMNS = [
  "uti", "sft_type", "action_type", "reporting_counterparty_lei", "other_counterparty_lei", "reporting_counterparty_side",
  "master_agreement_type", "execution_timestamp", "value_date", "maturity_date", "termination_date",
  "principal_amount_value_date", "principal_amount_maturity_date", "principal_currency", "fixed_rate_pct", "rate_bps",
  "collateral_type", "collateral_component", "collateral_quantity", "collateral_haircut_bps", "settlement_venue", "source",
];

/**
 * An SFTR-shaped line per repo (Regulation (EU) 2015/2365, RTS Annex I,
 * tables 1 and 2), from what the chain carries. `uti` is the repo id;
 * both legs settle in one transaction (DVP), so the value date is the
 * execution timestamp. The haircut is the one the opening applied, fund
 * plus exchange rate, from the repo's `repo_valued` event (rc5) when the
 * journal has it; otherwise the fund's `haircut_bps` from the latest
 * `fund_set` or `fund_limits_set` before the opening, which leaves out the
 * exchange-rate haircut of a cross-priced fund. `source` says which, and
 * `nav:fallback` when the fund's backup feed supplied the NAV the opening
 * was valued at (the primary being stale or silent; `fallback` in
 * `repo_valued`, review finding VAL-5).
 */
export function sftr(lines) {
  const rows = registry(lines);
  const haircuts = []; // { fund, at (ISO), bps }
  const applied = new Map(); // repo_id -> haircut_bps of its repo_valued event
  const onFallback = new Set(); // repo_ids whose repo_valued says the backup feed priced them
  for (const line of lines) {
    const name = eventName(line);
    if (name === "fund_set" || name === "fund_limits_set") haircuts.push({ fund: str(line.topics?.[1]), at: line.closedAt, bps: str(line.data?.haircut_bps) });
    else if (name === "repo_valued") {
      if (str(line.data?.haircut_bps) !== "") applied.set(str(line.topics?.[1]), str(line.data.haircut_bps));
      if (line.data?.fallback === true) onFallback.add(str(line.topics?.[1]));
    }
  }
  const haircutAt = (fund, at) => {
    const known = haircuts.filter((h) => h.fund === fund && h.at <= at);
    return known.length ? known[known.length - 1].bps : "";
  };
  return rows.map((r) => {
    const closed = r.closure !== "";
    const repaid = r.closure === STATUS.REPURCHASED && r.principal !== "" && r.interest !== "";
    const valued = applied.get(r.repo_id);
    const haircut = valued ?? (r.fund && r.opened_at ? haircutAt(r.fund, r.opened_at) : "");
    const notes = [r.source];
    if (valued !== undefined) notes.push("haircut:repo_valued");
    else if (r.fund && r.opened_at) notes.push(haircut ? "haircut:fund_set/fund_limits_set" : "haircut:not in chain");
    if (onFallback.has(r.repo_id)) notes.push("nav:fallback");
    const values = {
      uti: r.repo_id,
      sft_type: "REPO",
      action_type: closed ? "ETRM" : r.opened_at ? "NEWT" : "",
      reporting_counterparty_lei: "",
      other_counterparty_lei: "",
      reporting_counterparty_side: r.lender ? "COLLATERAL_TAKER" : "",
      master_agreement_type: "",
      execution_timestamp: r.opened_at,
      value_date: r.opened_at,
      maturity_date: r.maturity,
      termination_date: closed ? r.closed_at : "",
      principal_amount_value_date: r.principal,
      principal_amount_maturity_date: repaid ? (BigInt(r.principal) + BigInt(r.interest)).toString() : "",
      principal_currency: r.currency,
      fixed_rate_pct: r.rate_bps === "" ? "" : (Number(r.rate_bps) / 100).toFixed(2),
      rate_bps: r.rate_bps,
      collateral_type: r.fund ? "FUND_SHARES" : "",
      collateral_component: r.fund,
      collateral_quantity: r.shares,
      collateral_haircut_bps: haircut,
      settlement_venue: "stellar-testnet",
      source: notes.join(" "),
    };
    return Object.fromEntries(SFTR_COLUMNS.map((c) => [c, values[c]]));
  });
}

/** Flat event table: one row per journal line, topics (without the name) and data as JSON. */
export const EVENTS_COLUMNS = ["seq", "ledger", "closedAt", "txHash", "id", "contract", "event", "topics", "data", "prevHash", "hash"];
export function eventsTable(lines) {
  return lines.map((l) => ({
    seq: l.seq, ledger: l.ledger, closedAt: l.closedAt, txHash: l.txHash, id: l.id, contract: l.contract,
    event: eventName(l), topics: JSON.stringify((l.topics ?? []).slice(1)), data: JSON.stringify(l.data), prevHash: l.prevHash, hash: l.hash,
  }));
}

/** RFC 4180 CSV, UTF-8, LF line endings. */
export function toCsv(columns, rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map(cell).join(",");
  const body = rows.map((r) => columns.map((c) => cell(r[c])).join(","));
  return `${[head, ...body].join("\n")}\n`;
}
