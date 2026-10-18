// The timeline of one repo: what happened, what is running, what comes next.
// Pure: it takes the repo as the chain returns it, the clock, the opening
// transaction when the RPC still has it, the events the indexer exported for
// that repo (optional), and the deferred release record (optional). It returns
// ordered steps the page renders; nothing here touches the network or the DOM.

import { chargedHours } from "./terms.js";

/** Step states: `done` happened, `now` is running, `next` is due later, `late` needs attention, `off` did not happen. */
export const STATES = ["done", "now", "next", "late", "off"];

const unix = (iso) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);
const first = (events, name) => events.find((e) => e.event === name) ?? null;

/**
 * Events of the export that belong to `repoId`: the id sits in the topics
 * (`#[topic] repo_id`) or, in older exports, in the data.
 */
export function eventsOfRepo(events, repoId) {
  const id = String(repoId);
  return (events ?? []).filter((e) => (e.topics ?? []).some((t) => String(t) === id) || String(e.data?.repo_id ?? "") === id);
}

/**
 * @param repo  { id, status, opened_at, maturity, principal, rate_bps, shares }
 * @param opts  { now, opening?: { txHash }, events?: [], pendingRelease?: { shares, to } }
 * @returns [{ key, label, at, tx, state, detail }] with `at` in Unix seconds or null
 */
export function timelineOf(repo, { now, opening = null, events = [], pendingRelease = null } = {}) {
  const openedAt = Number(repo.opened_at);
  const maturity = Number(repo.maturity);
  const isOpen = repo.status === "Open";
  const repurchased = repo.status === "Repurchased";
  const opened = first(events, "repo_opened");
  const closedEvent = first(events, "repo_repurchased") ?? first(events, "repo_seized");
  const deferred = first(events, "release_deferred");
  const released = first(events, "shares_released");
  const closedAt = closedEvent ? unix(closedEvent.closedAt) : null;
  const steps = [];

  steps.push({
    key: "opened",
    label: "Opened",
    at: openedAt,
    tx: opening?.txHash ?? opened?.txHash ?? null,
    state: "done",
    detail: "shares locked, stablecoins received, in one transaction",
  });

  const until = isOpen ? now : (closedAt ?? now);
  const hours = chargedHours(Math.max(until - openedAt, 0));
  steps.push({
    key: "interest",
    label: isOpen ? "Interest running" : "Interest charged",
    at: null,
    tx: null,
    state: isOpen ? "now" : "done",
    detail: `${hours} started hour${hours === 1 ? "" : "s"}${isOpen ? " so far, one more at each started hour" : closedAt ? "" : " (closing time not on chain)"}`,
  });

  if (isOpen) {
    const late = now >= maturity;
    steps.push({
      key: "maturity",
      label: "Term ends",
      at: maturity,
      tx: null,
      state: late ? "late" : "next",
      detail: late ? "past term: the lender may take the shares; repurchase still possible until it does" : "repurchase any time before; after, the lender may take the shares",
    });
    return steps;
  }

  steps.push({
    key: "maturity",
    label: "Term end",
    at: maturity,
    tx: null,
    state: closedAt !== null && closedAt < maturity ? "off" : "done",
    detail: closedAt !== null && closedAt < maturity ? "closed before the term" : "term reached",
  });
  steps.push({
    key: "closed",
    label: repurchased ? "Repurchased" : "Shares taken by the lender",
    at: closedAt,
    tx: closedEvent?.txHash ?? null,
    state: "done",
    detail: repurchased ? "principal and interest returned to the offer" : "the borrower did not repurchase by the term",
  });
  if (pendingRelease) {
    steps.push({
      key: "release",
      label: "Shares held back",
      at: deferred ? unix(deferred.closedAt) : null,
      tx: deferred?.txHash ?? null,
      state: "late",
      detail: "the share token refused the transfer; the shares are recorded for the beneficiary and can be released once the issuer allows",
    });
  } else if (deferred || released) {
    steps.push({
      key: "release",
      label: "Shares delivered",
      at: released ? unix(released.closedAt) : null,
      tx: released?.txHash ?? null,
      state: "done",
      detail: deferred ? "held back by the share token at closing, delivered after the issuer allowed it" : "delivered",
    });
  }
  return steps;
}
