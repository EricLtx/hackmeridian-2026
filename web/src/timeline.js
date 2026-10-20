// The timeline of one repo: what happened, what is running, what comes next.
// Pure: it takes the repo as the chain returns it, the clock, the opening
// transaction when the RPC still has it, the events the indexer exported for
// that repo (optional), and the deferred release record (optional). It returns
// ordered steps the page renders; nothing here touches the network or the DOM.

import { t, tn } from "./i18n.js";
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
  return (events ?? []).filter((e) => (e.topics ?? []).some((topic) => String(topic) === id) || String(e.data?.repo_id ?? "") === id);
}

/**
 * @param repo  { id, status, opened_at, maturity, principal, rate_bps, shares }
 * @param opts  { now, opening?: { txHash }, events?: [], pendingRelease?: { shares, to } }
 * @returns [{ key, label, at, tx, state, detail }] with `at` in Unix seconds or null;
 *   `label` and `detail` are in the interface language, `key` and `state` are codes
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
    label: t("Opened"),
    at: openedAt,
    tx: opening?.txHash ?? opened?.txHash ?? null,
    state: "done",
    detail: t("shares locked, stablecoins received, in one transaction"),
  });

  const until = isOpen ? now : (closedAt ?? now);
  const hours = chargedHours(Math.max(until - openedAt, 0));
  steps.push({
    key: "interest",
    label: isOpen ? t("Interest running") : t("Interest charged"),
    at: null,
    tx: null,
    state: isOpen ? "now" : "done",
    detail: isOpen
      ? tn("{n} started hour so far, one more at each started hour", "{n} started hours so far, one more at each started hour", hours)
      : closedAt
        ? tn("{n} started hour", "{n} started hours", hours)
        : tn("{n} started hour (closing time not on chain)", "{n} started hours (closing time not on chain)", hours),
  });

  if (isOpen) {
    const late = now >= maturity;
    steps.push({
      key: "maturity",
      label: t("Term ends"),
      at: maturity,
      tx: null,
      state: late ? "late" : "next",
      detail: late
        ? t("past term: the lender may take the shares; repurchase still possible until it does")
        : t("repurchase any time before; after, the lender may take the shares"),
    });
    return steps;
  }

  steps.push({
    key: "maturity",
    label: t("Term end"),
    at: maturity,
    tx: null,
    state: closedAt !== null && closedAt < maturity ? "off" : "done",
    detail: closedAt !== null && closedAt < maturity ? t("closed before the term") : t("term reached"),
  });
  steps.push({
    key: "closed",
    label: repurchased ? t("Repurchased") : t("Shares taken by the lender"),
    at: closedAt,
    tx: closedEvent?.txHash ?? null,
    state: "done",
    detail: repurchased ? t("principal and interest returned to the offer") : t("the borrower did not repurchase by the term"),
  });
  // Shares of a repurchase wait only for the share token; seized shares also
  // wait for the lender's approval (since rc5 a seizure settles for a lender
  // whose approval was revoked, and the shares wait until it is restored).
  if (pendingRelease) {
    steps.push({
      key: "release",
      label: t("Shares held back"),
      at: deferred ? unix(deferred.closedAt) : null,
      tx: deferred?.txHash ?? null,
      state: "late",
      detail: repurchased
        ? t("the share token refused the transfer; the shares are recorded for the beneficiary and can be released once the issuer allows")
        : t("the delivery waits for the share token or for the lender's approval for the fund; the shares are recorded for the lender and can be released once both allow it"),
    });
  } else if (deferred || released) {
    steps.push({
      key: "release",
      label: t("Shares delivered"),
      at: released ? unix(released.closedAt) : null,
      tx: released?.txHash ?? null,
      state: "done",
      detail: !deferred
        ? t("delivered")
        : repurchased
          ? t("held back by the share token at closing, delivered after the issuer allowed it")
          : t("held back at closing until the share token and the lender's approval allowed it, then delivered"),
    });
  }
  return steps;
}

/** The note beside a closed repo whose shares wait in the contract. */
export function heldNote(status, shares) {
  return status === "Repurchased"
    ? t("{shares} held: the issuer blocks the transfer", { shares })
    : t("{shares} held: waiting for the share token or the lender's approval", { shares });
}

/**
 * The line that reports a repurchase or a seizure by where its shares went:
 * to the wallet (`deferred` false), recorded in the contract for later
 * delivery (true), or unknown when the read after it failed (null).
 */
export function closingLine(kind, { id, shares, deferred }) {
  if (kind === "repurchase") {
    if (deferred === true) return t("Repo #{id} repurchased: {shares} are recorded for you, since the share token refused the transfer; release them once it allows.", { id, shares });
    if (deferred === false) return t("Repo #{id} repurchased: {shares} back in your wallet.", { id, shares });
    return t("Repo #{id} repurchased.", { id });
  }
  if (deferred === true) return t("Repo #{id} closed: {shares} are recorded for you and wait for the share token or for your approval as lender.", { id, shares });
  if (deferred === false) return t("Repo #{id} closed: {shares} sent to your wallet.", { id, shares });
  return t("Repo #{id} closed.", { id });
}

/** The line after a delivery retry that moved nothing, by the repo's status. */
export function stillHeldLine(status, id) {
  return status === "Repurchased"
    ? t("Repo #{id}: the issuer still blocks the transfer. The shares stay reserved for you; try again later.", { id })
    : t("Repo #{id}: the delivery still waits for the share token or for your approval as lender. The shares stay reserved for you; try again later.", { id });
}
