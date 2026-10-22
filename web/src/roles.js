// The roles a wallet holds on this instance, from facts read on the chain.
// Pure: the reads live in chain.js (`roleFacts`). A role is granted only by a
// read that answered and names the wallet; a read that failed leaves the role
// unknown, never granted (design: role workspaces, phase 0).

import { t } from "./i18n.js";

/** The roles the page recognises, in the order it shows them. */
export const ROLE_ORDER = ["governor", "guardian", "guardianBackup", "sentinel", "trustee", "soleLender", "steward", "stewardBackup", "approvedLender"];

const SINGLE = [
  ["guardian", "guardian"],
  ["guardianBackup", "guardianBackup"],
  ["sentinel", "sentinel"],
  ["trustee", "trustee"],
  ["soleLender", "soleLender"],
];

/**
 * `{ held, unknown }`, each a list of `{ role, fund? }`, for `address` given
 * `facts` = `{ admin, adminSigners, guardian, guardianBackup, sentinel,
 * trustee, soleLender, funds: [{ symbol, steward, stewardBackup, approved }] }`,
 * every field a settled read `{ value } | { error }`.
 */
export function rolesOf(address, facts) {
  const held = [];
  const unknown = [];
  if (!address || !facts) return { held, unknown };
  const add = (outcome, role, fund) => {
    const entry = fund === undefined ? { role } : { role, fund };
    if (outcome === true) held.push(entry);
    else if (outcome === null) unknown.push(entry);
  };
  /** true when the read names the wallet, false when it answered otherwise, null when it failed. */
  const is = (read) => {
    if (!read || read.error) return null;
    return read.value === address;
  };

  // The governor: the account itself, or one of its signers with a weight.
  const admin = facts.admin;
  if (!admin || admin.error) add(null, "governor");
  else if (admin.value === address) add(true, "governor");
  else {
    const signers = facts.adminSigners;
    if (!signers || signers.error || !Array.isArray(signers.value)) add(null, "governor");
    else add(signers.value.some((s) => s && s.key === address && Number(s.weight) > 0), "governor");
  }

  for (const [field, role] of SINGLE) add(is(facts[field]), role);

  for (const f of facts.funds ?? []) {
    add(is(f.steward), "steward", f.symbol);
    add(is(f.stewardBackup), "stewardBackup", f.symbol);
    const approved = f.approved;
    add(!approved || approved.error ? null : approved.value === true, "approvedLender", f.symbol);
  }
  return { held, unknown };
}

const NAMES = {
  governor: () => t("Governor"),
  guardian: () => t("Guardian"),
  guardianBackup: () => t("Guardian backup"),
  sentinel: () => t("Sentinel"),
  trustee: () => t("Trustee"),
  soleLender: () => t("Sole lender"),
  steward: () => t("Steward"),
  stewardBackup: () => t("Steward backup"),
  approvedLender: () => t("Approved lender"),
};

const OF_FUND = {
  steward: (fund) => t("Steward of {fund}", { fund }),
  stewardBackup: (fund) => t("Steward backup of {fund}", { fund }),
  approvedLender: (fund) => t("Approved lender of {fund}", { fund }),
};

/** The label of a role entry, in the page's language: "Steward of tMMF", "Governor". */
export function roleLabel({ role, fund }) {
  if (fund !== undefined && Object.hasOwn(OF_FUND, role)) return OF_FUND[role](fund);
  return Object.hasOwn(NAMES, role) ? NAMES[role]() : role;
}
