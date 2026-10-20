// The indexer's export (history.json) as the History page shows it, and as
// the market page reads it for its timelines. The export is a committed file
// the page fetches, read with the care the deployment file gets: its
// explorer must be an https URL, its cells may be anything, and the decimals
// come from the deployment file only when they are usable. Pure: no DOM, and
// no network but the fetch a caller hands to `loadExport`.

import { httpsUrl, isDecimals, isTicker } from "./deployment.js";
import { shortAddress } from "./format.js";

/** How long the market page waits for the export before it draws without it. */
export const EXPORT_WAIT_MS = 2000;

/**
 * The export for the market page's timelines: `fetchExport()` resolves the
 * parsed file (or null), and this resolves `{ generatedAt, events }`, or
 * null when the export is missing, unreachable or malformed, or not there
 * within `waitMs`. The export is optional: a render never waits longer for
 * it, and one that lands later is handed to `onLate`, which fills the
 * timelines then.
 */
export async function loadExport(fetchExport, { waitMs = EXPORT_WAIT_MS, onLate = () => {} } = {}) {
  const loading = Promise.resolve()
    .then(fetchExport)
    .then((h) => (Array.isArray(h?.events) ? { generatedAt: h.generatedAt, events: h.events } : null))
    .catch(() => null);
  const late = Symbol("late");
  let timer;
  const bound = new Promise((resolve) => {
    timer = setTimeout(resolve, waitMs, late);
  });
  const first = await Promise.race([loading, bound]);
  clearTimeout(timer);
  if (first !== late) return first;
  loading.then((h) => {
    if (h) onLate(h);
  });
  return null;
}

/** Text made safe for markup. */
export const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Decimals and code of the amounts: the deployment file's when usable, else the demo tokens' 7 and no code. */
export function exportDecimals(dep) {
  return {
    shares: isDecimals(dep?.fund?.decimals) ? dep.fund.decimals : 7,
    stablecoin: isDecimals(dep?.stablecoin?.decimals) ? dep.stablecoin.decimals : 7,
    code: isTicker(dep?.stablecoin?.code) ? dep.stablecoin.code : "",
  };
}

/** The explorer the page links to: the export's when it is an https URL, else the deployment file's, else none (null). */
export const explorerOf = (history, dep) => httpsUrl(history?.explorer) ?? httpsUrl(dep?.explorer);

/** A close time of the export, "2026-10-15T21:44:57Z", as "2026-10-15 21:44:57 UTC", escaped; a dash when there is none. */
export const when = (iso) => (iso ? esc(String(iso).replace("T", " ").replace(/(:\d\d)Z$/, "$1 UTC")) : "—");

/** A transaction's short hash, linked to the explorer when there is a usable one. */
export function txLink(explorer, hash) {
  if (!hash) return "—";
  const text = `${esc(String(hash).slice(0, 8))}…`;
  return explorer ? `<a href="${esc(explorer)}/tx/${esc(hash)}" target="_blank" rel="noopener noreferrer" title="${esc(hash)}">${text}</a>` : `<span title="${esc(hash)}">${text}</span>`;
}

/** A contract's short address, linked to the explorer when there is a usable one. */
export function contractLink(explorer, contract) {
  if (!contract) return "—";
  const text = esc(shortAddress(String(contract)));
  return explorer ? `<a href="${esc(explorer)}/contract/${esc(contract)}" target="_blank" rel="noopener noreferrer">${text}</a>` : `<span title="${esc(contract)}">${text}</span>`;
}

/** An account's short address, with the whole one as its title. */
export const addr = (a) => (a ? `<span title="${esc(a)}">${esc(shortAddress(String(a)))}</span>` : "—");
