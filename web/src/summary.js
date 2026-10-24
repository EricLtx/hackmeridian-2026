// The positions summary: what a borrower owes across its open repos and
// when the next term ends, what a lender has out and what it is owed, added
// up from the rows and the interest due the page already holds. No chain
// read of its own, no DOM: `summaryMarkup` returns escaped HTML. Every
// amount stays a BigInt, so a book of any size adds up exactly.

import { formatAmount, formatDateTime } from "./format.js";
import { t, tn } from "./i18n.js";
import { esc } from "./journal.js";
import { seizeState } from "./terms.js";

const openRows = (rows) => (rows ?? []).filter((r) => r.status === "Open");

/** `value` rounded up to a multiple of `unit`: the total a card shows, to the cent. */
const ceilTo = (value, unit) => (unit > 1n && value % unit ? value + unit - (value % unit) : value);

/**
 * Σ (principal + interest) over the open rows, each total ceiled to `unit`
 * as its card shows it, or null while any interest is unread (`dues` lacks
 * the row, or is not there at all): never a sum over some of the repos.
 */
function owed(open, dues, unit) {
  let total = 0n;
  let missing = 0;
  for (const r of open) {
    const interest = dues?.get(r.id);
    if (interest === undefined) missing += 1;
    else total += ceilTo(BigInt(r.principal) + BigInt(interest), unit);
  }
  return { total: missing ? null : total, partial: missing > 0, missing };
}

/**
 * A borrower's open repos: `borrowed` (Σ principal), `dueNow` (principal
 * and interest, null while one is unread, with `partial` and `missing`),
 * `nextMaturity` (the nearest term still ahead of `now`, Unix seconds, or
 * null) and `pastTerm` (repos whose term `now` has reached). `unit` is the
 * granularity each card rounds its total up to. Null when no repo is open.
 */
export function borrowerSummary(rows, dues, now, { unit = 1n } = {}) {
  const open = openRows(rows);
  if (!open.length) return null;
  const ts = Number(now);
  let borrowed = 0n;
  let nextMaturity = null;
  let pastTerm = 0;
  for (const r of open) {
    borrowed += BigInt(r.principal);
    const maturity = Number(r.maturity);
    if (ts >= maturity) pastTerm += 1;
    else if (nextMaturity === null || maturity < nextMaturity) nextMaturity = maturity;
  }
  const { total, partial, missing } = owed(open, dues, unit);
  return { open: open.length, borrowed, dueNow: total, partial, missing, nextMaturity, pastTerm };
}

/**
 * A lender's open repos: `lent` (Σ principal), `owedNow` (principal and
 * interest, null while one is unread) and `keepable`, the repos past their
 * term and unpaid, whose shares the lender may take now. Null when none is open.
 */
export function lenderSummary(rows, dues, now, { unit = 1n } = {}) {
  const open = openRows(rows);
  if (!open.length) return null;
  const lent = open.reduce((sum, r) => sum + BigInt(r.principal), 0n);
  const keepable = open.filter((r) => seizeState(r, now).allowed).length;
  const { total, partial, missing } = owed(open, dues, unit);
  return { open: open.length, lent, owedNow: total, partial, missing, keepable };
}

function tile(kind, label, value, sub = "", tone = "") {
  return `<div class="tile${tone ? ` ${tone}` : ""}"><p class="tile-label">${esc(label)}</p><p class="tile-value" data-k="summary:${kind}:${esc(label)}">${value}</p>${sub ? `<p class="tile-sub">${sub}</p>` : ""}</div>`;
}

/**
 * The tiles of a summary, `kind` "borrower" or "lender", as escaped HTML;
 * an empty string without a model. Amounts are shown with `decimals` and
 * `code`; an unread total shows a dash with "Reading…" while `reading`,
 * else how many amounts could not be read. The tiles are not announced:
 * the cards below carry the detail.
 */
export function summaryMarkup(model, kind, { decimals = 7, code = "", reading = false } = {}) {
  if (!model) return "";
  const money = (units, rounding) => `${esc(formatAmount(units, decimals, rounding))} <span class="unit-inline">${esc(code)}</span>`;
  const total = (units) => (units === null ? "—" : money(units, "ceil"));
  const note = model.partial ? esc(reading ? t("Reading…") : tn("{n} amount could not be read", "{n} amounts could not be read", model.missing)) : "";
  const count = (n) => esc(String(n));
  const tiles =
    kind === "lender"
      ? [
          tile(kind, t("Lent"), money(model.lent)),
          tile(kind, t("Owed now"), total(model.owedNow), note),
          tile(kind, t("You may keep the shares now"), count(model.keepable), "", model.keepable > 0 ? "tile-warn" : ""),
        ]
      : [
          tile(kind, t("Borrowed"), money(model.borrowed)),
          tile(kind, t("Due now"), total(model.dueNow), note),
          tile(
            kind,
            t("Next term ends"),
            model.nextMaturity === null ? "—" : esc(formatDateTime(model.nextMaturity)),
            model.nextMaturity === null ? "" : `<span data-until="${esc(model.nextMaturity)}" data-after="${esc(t("now"))}"></span>`,
          ),
          tile(kind, t("Past term"), count(model.pastTerm), "", model.pastTerm > 0 ? "tile-warn" : ""),
        ];
  return `<div class="tiles summary" aria-live="off">${tiles.join("")}</div>`;
}
