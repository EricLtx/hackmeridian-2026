// The Operate space, read-only: the instance's health, who holds each role,
// and every pending proposal with the moment it can apply. Pure: the reads
// live in chain.js (`roleFacts`, `pendingAll`) and the markup in main.js
// (design: role workspaces, phase 0).

import { formatDuration } from "./format.js";
import { t } from "./i18n.js";
import { rolesOf } from "./roles.js";

/** Share of a fund's cap from which its use is a warning. */
const CAP_WARN = 0.8;

const SINGLE_ROLES = [
  ["admin", () => t("Governor")],
  ["guardian", () => t("Guardian")],
  ["guardianBackup", () => t("Guardian backup")],
  ["sentinel", () => t("Sentinel")],
  ["trustee", () => t("Trustee")],
  ["soleLender", () => t("Sole lender")],
];

/**
 * The model the Operate space draws: `{ health, roles, proposals, unreadable }`.
 * - `health`: `[{ label, value, tone }]`, tone "ok", "warn" or "dim" (unknown);
 * - `roles`: `[{ label, address, unknown, you }]`, address null when the role is empty or unread;
 * - `proposals`: `[{ label, eta, due, whoCan }]`, sorted by `eta`, `due` once it can apply,
 *   `whoCan` the party the contract lets apply it ("anyone", "governor", "proposedGovernor");
 * - `unreadable`: how many proposal reads failed;
 * - `proposalsState`: "read" (every read answered), "partial" (some failed) or "unknown" (none read):
 *   only "read" with an empty list may say that nothing is pending.
 */
export function operateModel({ pending, roleFacts, board, now, wallet = null, version = null }) {
  return {
    health: health(board, pending, now, version),
    roles: roles(roleFacts, wallet),
    ...proposals(pending, now),
  };
}

function health(board, pending, now, version) {
  const rows = [];
  const paused = board?.paused;
  if (!paused || paused.error || typeof paused.value !== "boolean") rows.push({ label: t("New loans"), value: t("Unknown"), tone: "dim" });
  else if (paused.value) rows.push({ label: t("New loans"), value: t("Paused: repurchase, withdrawal and seizure stay open"), tone: "warn" });
  else rows.push({ label: t("New loans"), value: t("Open"), tone: "ok" });

  const schema = pending?.schema?.value;
  const isInt = (v) => typeof v === "bigint" || Number.isSafeInteger(v);
  rows.push(
    isInt(version) && isInt(schema)
      ? { label: t("Contract"), value: t("version {version}, stored layout {schema}", { version: String(version), schema: String(schema) }), tone: "ok" }
      : { label: t("Contract"), value: t("Unknown"), tone: "dim" },
  );

  for (const f of board?.funds ?? []) {
    const cfg = f.config?.value;
    const st = f.state?.value;
    if (!cfg || !st) {
      rows.push({ label: t("{fund}: state", { fund: f.symbol }), value: t("Unknown"), tone: "dim" });
      continue;
    }
    const bound = Number(cfg.nav_max_age_secs);
    const age = Math.max(0, now - Number(st.reference_time));
    rows.push(
      age > bound
        ? {
            label: t("{fund}: price reference", { fund: f.symbol }),
            value: t("{age} old, beyond its {bound} bound: the keeper steps it while the NAV is newer", { age: formatDuration(age), bound: formatDuration(bound) }),
            tone: "warn",
          }
        : { label: t("{fund}: price reference", { fund: f.symbol }), value: t("{age} old, within its {bound} bound", { age: formatDuration(age), bound: formatDuration(bound) }), tone: "ok" },
    );
    const cap = Number(cfg.max_outstanding);
    const used = cap > 0 ? Number(st.outstanding) / cap : 0;
    rows.push({
      label: t("{fund}: cap used", { fund: f.symbol }),
      value: t("{percent} %", { percent: (used * 100).toFixed(1) }),
      tone: used >= CAP_WARN ? "warn" : "ok",
    });
    if (st.frozen === true) rows.push({ label: t("{fund}: frozen", { fund: f.symbol }), value: t("Frozen by its steward: no new loan on this fund"), tone: "warn" });
  }
  return rows;
}

function roles(facts, wallet) {
  if (!facts) return [];
  const row = (label, read, you = (a) => a === wallet) => {
    if (!read || read.error) return { label, address: null, unknown: true, you: false };
    const address = read.value ?? null;
    return { label, address, unknown: false, you: Boolean(wallet && address && you(address)) };
  };
  // The governor row marks the wallet by the same rule as its roles: a signer with a weight, or a contract governor's address.
  const governs = Boolean(wallet) && rolesOf(wallet, facts).held.some((h) => h.role === "governor");
  const rows = SINGLE_ROLES.map(([field, label]) => (field === "admin" ? row(label(), facts.admin, () => governs) : row(label(), facts[field])));
  for (const f of facts.funds ?? []) {
    rows.push(row(t("Steward of {fund}", { fund: f.symbol }), f.steward));
    rows.push(row(t("Steward backup of {fund}", { fund: f.symbol }), f.stewardBackup));
  }
  return rows;
}

function proposals(pending, now) {
  const list = [];
  let unreadable = 0;
  const add = (label, read, whoCan = "anyone") => {
    if (!read) return;
    if (read.error) {
      unreadable += 1;
      return;
    }
    if (read.value && read.value.eta !== undefined) {
      const eta = Number(read.value.eta);
      list.push({ label, eta, due: eta <= now, whoCan });
    }
  };
  if (pending) {
    // Who the contract lets apply each kind: the governor installs an upgrade, applies a forced guardian
    // change and a stablecoin registration; the proposed governor accepts a handover; anyone applies the rest.
    add(t("Code upgrade"), pending.upgrade, "governor");
    add(t("Governor handover"), pending.admin, "proposedGovernor");
    add(t("Guardian change"), pending.guardian);
    add(t("Forced guardian change"), pending.forced, "governor");
    add(t("Risk envelope change"), pending.envelope);
    add(t("Term ceiling change"), pending.maxTerm);
    add(t("Currency cap change: {currency}", { currency: pending.currency ?? "" }), pending.cap);
    for (const f of pending.funds ?? []) {
      add(t("Fund change: {fund}", { fund: f.symbol }), f.change);
      add(t("Fund limits change: {fund}", { fund: f.symbol }), f.limits);
      add(t("Backup feed: {fund}", { fund: f.symbol }), f.fallback);
      add(t("Re-anchor: {fund}", { fund: f.symbol }), f.reanchor);
      add(t("Steward backup key change: {fund}", { fund: f.symbol }), f.stewardBackup);
      add(t("Steward recovery: {fund}", { fund: f.symbol }), f.stewardRecovery);
    }
    for (const s of pending.stablecoins ?? []) add(t("Stablecoin registration: {code}", { code: s.code }), s.change, "governor");
  }
  list.sort((a, b) => a.eta - b.eta);
  const proposalsState = !pending ? "unknown" : unreadable ? "partial" : "read";
  return { proposals: list, unreadable, proposalsState };
}

/** What a due proposal's row says, by who the contract lets apply it. */
export function whoCanApply(whoCan) {
  if (whoCan === "governor") return t("the governor can apply it now");
  if (whoCan === "proposedGovernor") return t("the proposed governor can accept it now");
  return t("anyone can apply it now");
}
