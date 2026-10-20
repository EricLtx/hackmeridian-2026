// The history page: reads the indexer's export (`history.json`, written next
// to this page by `npm run export -- --json --web` in indexer/) and shows the
// repo registry and the latest events. No wallet, no network call to the
// chain: everything comes from the journal. A language switch re-renders
// from the export already loaded.

// Inter, served with the page (no font request to a third party).
import "@fontsource-variable/inter";
import { tapeLine } from "./blotter.js";
import { formatAmount, formatRate, shortAddress } from "./format.js";
import { applyStatic, bootLang, markLangButtons, persistLang, setLang, t, tk, tn } from "./i18n.js";
import { initMotion, setLoading, transition } from "./motion.js";

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Decimals of the amounts: both demo tokens use 7, read from deployment.testnet.json when present. */
const decimals = { shares: 7, stablecoin: 7, code: "" };

const STATUS_LABEL = {
  open: [tk("Open"), "pill-ok"],
  repurchased: [tk("Repurchased"), "pill-muted"],
  seized: [tk("Seized"), "pill-danger"],
  release_pending: [tk("Release pending"), "pill-warn"],
};

/** What the page shows: the export once loaded, or the reason it could not be loaded. */
const view = { history: null, error: null };

const when = (iso) => (iso ? esc(iso.replace("T", " ").replace(/(:\d\d)Z$/, "$1 UTC")) : "—");
const txLink = (explorer, hash) =>
  hash ? `<a href="${esc(explorer)}/tx/${esc(hash)}" target="_blank" rel="noopener noreferrer" title="${esc(hash)}">${esc(hash.slice(0, 8))}…</a>` : "—";
const addr = (a) => (a ? `<span title="${esc(a)}">${esc(shortAddress(a))}</span>` : "—");
const units = (raw, d) => (raw === "" || raw === null || raw === undefined ? "—" : formatAmount(BigInt(raw), d));

/**
 * The short code the terminal's tape gives an event (OPEN, VALUE, SEIZE...),
 * in the interface language, or null for an event the tape does not name:
 * that one keeps only its contract name. A malformed exported event gets no
 * code rather than stopping the page.
 */
function eventCode(e) {
  try {
    const line = tapeLine(e, { sd: decimals.stablecoin, fd: decimals.shares, code: decimals.code });
    return line.known ? line.code : null;
  } catch {
    return null;
  }
}

function tile(label, value, sub = "") {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${value}</div>${sub ? `<div class="tile-sub">${sub}</div>` : ""}</div>`;
}

function renderJournal(h) {
  const j = h.journal;
  $("journal-meta").textContent = t("export of {time} UTC", { time: h.generatedAt.replace("T", " ").slice(0, 19) });
  $("journal-tiles").innerHTML = [
    tile(t("Events journaled"), esc(j.lines)),
    tile(t("First event"), when(j.firstClosedAt), j.firstLedger ? esc(t("ledger {ledger}", { ledger: j.firstLedger })) : ""),
    tile(t("Last event"), when(j.lastClosedAt), j.lastLedger ? esc(t("ledger {ledger}", { ledger: j.lastLedger })) : ""),
    tile(t("Gaps declared"), esc(j.gaps?.length ?? 0), esc(j.gaps?.length ? t("ledgers the RPC no longer served when indexing resumed") : t("none"))),
  ].join("");
  $("journal-hash").innerHTML = t(
    "Last hash of the chain: <code>{hash}</code>. Recompute it with <code>npm run verify</code> in <code>indexer/</code>; a different value means the journal changed.",
    { hash: esc(j.lastHash) },
  );
}

function renderRegistry(h) {
  const rows = h.registry ?? [];
  const count = (s) => rows.filter((r) => r.status === s).length;
  $("registry-meta").textContent = tn(
    "{n} repo: {open} open, {repurchased} repurchased, {seized} seized, {pending} release pending",
    "{n} repos: {open} open, {repurchased} repurchased, {seized} seized, {pending} release pending",
    rows.length,
    { open: count("open"), repurchased: count("repurchased"), seized: count("seized"), pending: count("release_pending") },
  );
  if (!rows.length) {
    $("registry-body").innerHTML = `<p class="muted">${esc(t("No repo in the journal."))}</p>`;
    return;
  }
  // Column names, also shown before each cell at phone width (data-label).
  const col = {
    repo: esc(t("Repo")),
    status: esc(t("Status")),
    lender: esc(t("Lender")),
    borrower: esc(t("Borrower")),
    shares: esc(t("Shares")),
    principal: esc(t("Principal")),
    rate: esc(t("Rate")),
    opened: esc(t("Opened")),
    maturity: esc(t("Maturity")),
    closed: esc(t("Closed")),
    lastTx: esc(t("Last tx")),
  };
  const body = rows
    .map((r) => {
      const known = STATUS_LABEL[r.status];
      const label = known ? t(known[0]) : r.status || t("unknown");
      const cls = known ? known[1] : "pill-muted";
      const cur = r.currency || decimals.code || "";
      return `<tr>
        <td data-label="${col.repo}">#${esc(r.repo_id)}</td>
        <td data-label="${col.status}"><span class="pill ${cls}">${esc(label)}</span>${r.release_shares ? `<div class="small muted">${esc(t("{shares} shares held back", { shares: units(r.release_shares, decimals.shares) }))}</div>` : ""}</td>
        <td data-label="${col.lender}">${addr(r.lender)}</td>
        <td data-label="${col.borrower}">${addr(r.borrower)}</td>
        <td data-label="${col.shares}" class="num">${units(r.shares, decimals.shares)}</td>
        <td data-label="${col.principal}" class="num">${units(r.principal, decimals.stablecoin)} ${esc(cur)}</td>
        <td data-label="${col.rate}" class="num">${r.rate_bps === "" ? "—" : esc(formatRate(Number(r.rate_bps)))}</td>
        <td data-label="${col.opened}">${when(r.opened_at)}</td>
        <td data-label="${col.maturity}">${when(r.maturity)}</td>
        <td data-label="${col.closed}">${when(r.closed_at)}${r.interest ? `<div class="small muted">${esc(t("interest {amount} {currency}", { amount: units(r.interest, decimals.stablecoin), currency: cur }))}</div>` : ""}</td>
        <td data-label="${col.lastTx}">${txLink(h.explorer, r.last_tx)}</td>
      </tr>`;
    })
    .join("");
  $("registry-body").innerHTML = `<table class="table is-new">
    <caption class="sr-only">${esc(t("Repos rebuilt from the journal"))}</caption>
    <thead><tr><th>${col.repo}</th><th>${col.status}</th><th>${col.lender}</th><th>${col.borrower}</th><th class="num">${col.shares}</th><th class="num">${col.principal}</th><th class="num">${col.rate}</th><th>${col.opened}</th><th>${col.maturity}</th><th>${col.closed}</th><th>${col.lastTx}</th></tr></thead>
    <tbody>${body}</tbody></table>
    <p class="muted small">${t(
      "Amounts in token units; the currency comes from the <code>stablecoin_set</code> event of the repo's stablecoin. A blank cell is a fact the chain does not carry or an event outside the journal.",
    )}</p>`;
}

function renderEvents(h) {
  const events = h.events ?? [];
  $("events-meta").textContent = t("{n} most recent, newest first", { n: events.length });
  if (!events.length) {
    $("events-body").innerHTML = `<p class="muted">${esc(t("No event in the journal."))}</p>`;
    return;
  }
  const col = { time: esc(t("Time")), event: esc(t("Event")), topics: esc(t("Topics")), data: esc(t("Data")) };
  const body = events
    .map((e) => ({ e, label: eventCode(e) }))
    .map(
      ({ e, label }) => `<tr>
        <td data-label="#" class="num">${esc(e.seq)}</td>
        <td data-label="${col.time}">${when(e.closedAt)}</td>
        <td data-label="${col.event}">${label ? `<span class="badge badge-muted">${esc(label)}</span> ` : ""}<code>${esc(e.event)}</code></td>
        <td data-label="${col.topics}">${esc((e.topics ?? []).map((topic) => (typeof topic === "string" && /^[GC][A-Z2-7]{55}$/.test(topic) ? shortAddress(topic) : topic)).join(", ")) || "—"}</td>
        <td data-label="${col.data}"><code class="small">${esc(JSON.stringify(e.data))}</code></td>
        <td data-label="Tx">${txLink(h.explorer, e.txHash)}</td>
      </tr>`,
    )
    .join("");
  $("events-body").innerHTML = `<table class="table is-new">
    <caption class="sr-only">${esc(t("Latest events of the contract"))}</caption>
    <thead><tr><th class="num">#</th><th>${col.time}</th><th>${col.event}</th><th>${col.topics}</th><th>${col.data}</th><th>Tx</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

function renderFoot(h) {
  const contract = h.contract
    ? `<a href="${esc(h.explorer)}/contract/${esc(h.contract)}" target="_blank" rel="noopener noreferrer">${esc(shortAddress(h.contract))}</a>`
    : "—";
  $("foot").innerHTML = t("Contract {contract} on Stellar {network}. Journal and exports: <code>indexer/</code> in the repository.", {
    contract,
    network: esc(h.network),
  });
}

function renderLoadError(error) {
  const box = $("load-error");
  box.hidden = false;
  box.className = "notice notice-error";
  box.innerHTML = t(
    "No history export found ({error}). Produce it from the repository with <code>cd indexer &amp;&amp; npm run index &amp;&amp; npm run export -- --json --web</code>, which writes <code>web/public/history.json</code>.",
    { error: esc(error.message) },
  );
}

/** Renders the page in the language in use, from what is already loaded. */
function render() {
  if (view.error) {
    renderLoadError(view.error);
    return;
  }
  if (!view.history) return;
  renderJournal(view.history);
  renderRegistry(view.history);
  renderEvents(view.history);
  renderFoot(view.history);
}

/** The language switch of the header: no new fetch, the page renders again. */
function wireLanguage() {
  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-lang]");
    if (!button) return;
    transition(() => {
      setLang(button.dataset.lang);
      persistLang();
      applyStatic();
      markLangButtons();
      render();
    });
  });
}

async function loadJson(name) {
  const response = await fetch(`./${name}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  bootLang();
  applyStatic();
  markLangButtons();
  initMotion();
  setLoading(true);
  wireLanguage();
  try {
    const dep = await loadJson("deployment.testnet.json");
    decimals.shares = dep.fund?.decimals ?? 7;
    decimals.stablecoin = dep.stablecoin?.decimals ?? 7;
    decimals.code = dep.stablecoin?.code ?? "";
  } catch {
    // The deployment file is optional here: defaults apply.
  }
  try {
    view.history = await loadJson("history.json");
  } catch (error) {
    view.error = error;
  }
  try {
    render();
  } finally {
    setLoading(false);
  }
}

main();
