// The history page: reads the indexer's export (`history.json`, written next
// to this page by `npm run export -- --json --web` in indexer/) and shows the
// repo registry and the latest events. No wallet, no network call to the
// chain: everything comes from the journal.

import { formatAmount, formatRate, shortAddress } from "./format.js";

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Decimals of the amounts: both demo tokens use 7, read from deployment.testnet.json when present. */
const decimals = { shares: 7, stablecoin: 7, code: "" };

const STATUS_LABEL = {
  open: ["Open", "pill-ok"],
  repurchased: ["Repurchased", "pill-muted"],
  seized: ["Seized", "pill-danger"],
  release_pending: ["Release pending", "pill-warn"],
};

const when = (iso) => (iso ? esc(iso.replace("T", " ").replace(/(:\d\d)Z$/, "$1 UTC")) : "—");
const txLink = (explorer, hash) =>
  hash ? `<a href="${esc(explorer)}/tx/${esc(hash)}" target="_blank" rel="noopener noreferrer" title="${esc(hash)}">${esc(hash.slice(0, 8))}…</a>` : "—";
const addr = (a) => (a ? `<span title="${esc(a)}">${esc(shortAddress(a))}</span>` : "—");
const units = (raw, d) => (raw === "" || raw === null || raw === undefined ? "—" : formatAmount(BigInt(raw), d));

function tile(label, value, sub = "") {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${value}</div>${sub ? `<div class="tile-sub">${sub}</div>` : ""}</div>`;
}

function renderJournal(h) {
  const j = h.journal;
  $("journal-meta").textContent = `export of ${h.generatedAt.replace("T", " ").slice(0, 19)} UTC`;
  $("journal-tiles").innerHTML = [
    tile("Events journaled", esc(j.lines)),
    tile("First event", when(j.firstClosedAt), j.firstLedger ? `ledger ${esc(j.firstLedger)}` : ""),
    tile("Last event", when(j.lastClosedAt), j.lastLedger ? `ledger ${esc(j.lastLedger)}` : ""),
    tile("Gaps declared", esc(j.gaps?.length ?? 0), j.gaps?.length ? "ledgers the RPC no longer served when indexing resumed" : "none"),
  ].join("");
  $("journal-hash").innerHTML = `Last hash of the chain: <code>${esc(j.lastHash)}</code>. Recompute it with <code>npm run verify</code> in <code>indexer/</code>; a different value means the journal changed.`;
}

function renderRegistry(h) {
  const rows = h.registry ?? [];
  const count = (s) => rows.filter((r) => r.status === s).length;
  $("registry-meta").textContent = `${rows.length} repo${rows.length === 1 ? "" : "s"}: ${count("open")} open, ${count("repurchased")} repurchased, ${count("seized")} seized, ${count("release_pending")} release pending`;
  if (!rows.length) {
    $("registry-body").innerHTML = `<p class="muted">No repo in the journal.</p>`;
    return;
  }
  const body = rows
    .map((r) => {
      const [label, cls] = STATUS_LABEL[r.status] ?? [r.status || "unknown", "pill-muted"];
      const cur = r.currency || decimals.code || "";
      return `<tr>
        <td data-label="Repo">#${esc(r.repo_id)}</td>
        <td data-label="Status"><span class="pill ${cls}">${esc(label)}</span>${r.release_shares ? `<div class="small muted">${units(r.release_shares, decimals.shares)} shares held back</div>` : ""}</td>
        <td data-label="Lender">${addr(r.lender)}</td>
        <td data-label="Borrower">${addr(r.borrower)}</td>
        <td data-label="Shares" class="num">${units(r.shares, decimals.shares)}</td>
        <td data-label="Principal" class="num">${units(r.principal, decimals.stablecoin)} ${esc(cur)}</td>
        <td data-label="Rate" class="num">${r.rate_bps === "" ? "—" : esc(formatRate(Number(r.rate_bps)))}</td>
        <td data-label="Opened">${when(r.opened_at)}</td>
        <td data-label="Maturity">${when(r.maturity)}</td>
        <td data-label="Closed">${when(r.closed_at)}${r.interest ? `<div class="small muted">interest ${units(r.interest, decimals.stablecoin)} ${esc(cur)}</div>` : ""}</td>
        <td data-label="Last tx">${txLink(h.explorer, r.last_tx)}</td>
      </tr>`;
    })
    .join("");
  $("registry-body").innerHTML = `<table class="table">
    <caption class="sr-only">Repos rebuilt from the journal</caption>
    <thead><tr><th>Repo</th><th>Status</th><th>Lender</th><th>Borrower</th><th class="num">Shares</th><th class="num">Principal</th><th class="num">Rate</th><th>Opened</th><th>Maturity</th><th>Closed</th><th>Last tx</th></tr></thead>
    <tbody>${body}</tbody></table>
    <p class="muted small">Amounts in token units; the currency comes from the <code>stablecoin_set</code> event of the repo's stablecoin. A blank cell is a fact the chain does not carry or an event outside the journal.</p>`;
}

function renderEvents(h) {
  const events = h.events ?? [];
  $("events-meta").textContent = `${events.length} most recent, newest first`;
  if (!events.length) {
    $("events-body").innerHTML = `<p class="muted">No event in the journal.</p>`;
    return;
  }
  const body = events
    .map(
      (e) => `<tr>
        <td data-label="#" class="num">${esc(e.seq)}</td>
        <td data-label="Time">${when(e.closedAt)}</td>
        <td data-label="Event"><code>${esc(e.event)}</code></td>
        <td data-label="Topics">${esc((e.topics ?? []).map((t) => (typeof t === "string" && /^[GC][A-Z2-7]{55}$/.test(t) ? shortAddress(t) : t)).join(", ")) || "—"}</td>
        <td data-label="Data"><code class="small">${esc(JSON.stringify(e.data))}</code></td>
        <td data-label="Tx">${txLink(h.explorer, e.txHash)}</td>
      </tr>`,
    )
    .join("");
  $("events-body").innerHTML = `<table class="table">
    <caption class="sr-only">Latest events of the contract</caption>
    <thead><tr><th class="num">#</th><th>Time</th><th>Event</th><th>Topics</th><th>Data</th><th>Tx</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

async function loadJson(name) {
  const response = await fetch(`./${name}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  try {
    const dep = await loadJson("deployment.testnet.json");
    decimals.shares = dep.fund?.decimals ?? 7;
    decimals.stablecoin = dep.stablecoin?.decimals ?? 7;
    decimals.code = dep.stablecoin?.code ?? "";
  } catch {
    // The deployment file is optional here: defaults apply.
  }
  let h;
  try {
    h = await loadJson("history.json");
  } catch (error) {
    const box = $("load-error");
    box.hidden = false;
    box.className = "notice notice-error";
    box.innerHTML = `No history export found (${esc(error.message)}). Produce it from the repository with <code>cd indexer &amp;&amp; npm run index &amp;&amp; npm run export -- --json --web</code>, which writes <code>web/public/history.json</code>.`;
    return;
  }
  renderJournal(h);
  renderRegistry(h);
  renderEvents(h);
  $("foot").innerHTML = `Contract ${h.contract ? `<a href="${esc(h.explorer)}/contract/${esc(h.contract)}" target="_blank" rel="noopener noreferrer">${esc(shortAddress(h.contract))}</a>` : "—"} on Stellar ${esc(h.network)}. Journal and exports: <code>indexer/</code> in the repository.`;
}

main();
