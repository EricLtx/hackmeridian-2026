// The history page: reads the indexer's export (`history.json`, written next
// to this page by `npm run export -- --json --web` in indexer/) and shows the
// repo registry and the latest events. No wallet, no network call to the
// chain: everything comes from the journal. A language switch re-renders
// from the export already loaded.

// Inter, served with the page (no font request to a third party).
import "@fontsource-variable/inter";
import { tapeLine } from "./blotter.js";
import { formatAmount, formatOrDash, formatRate, shortAddress } from "./format.js";
import { privacyLine } from "./deployment.js";
import { refuseFrame, refusesFrame } from "./frame.js";
import { applyStatic, bootLang, markLangButtons, persistLang, setLang, t, tk, tn } from "./i18n.js";
import { addr, contractLink, esc, explorerOf, exportDecimals, txLink, when } from "./journal.js";
import { initMotion, setLoading, transition } from "./motion.js";

const $ = (id) => document.getElementById(id);

/** Decimals of the amounts: both demo tokens use 7, read from deployment.testnet.json when it gives usable ones. */
let decimals = exportDecimals(null);
/** The explorer the links point to, checked like the deployment file's URLs; null for no link. */
let explorer = null;

const STATUS_LABEL = {
  open: [tk("Open"), "pill-ok"],
  repurchased: [tk("Repurchased"), "pill-muted"],
  seized: [tk("Seized"), "pill-danger"],
  release_pending: [tk("Release pending"), "pill-warn"],
};

/** What the page shows: the export once loaded, or the reason it could not be loaded, and the deployment file when it loads. */
const view = { history: null, error: null, deployment: null };

// An amount or a rate of the export, or a dash when the cell is empty or not an integer: a malformed export never stops the page.
const units = (raw, d) => formatOrDash(raw, (value) => formatAmount(value, d));
const rate = (raw) => formatOrDash(raw, formatRate);

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
  $("journal-meta").textContent = t("export of {time} UTC", { time: String(h.generatedAt ?? "").replace("T", " ").slice(0, 19) });
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
        <td data-label="${col.rate}" class="num">${esc(rate(r.rate_bps))}</td>
        <td data-label="${col.opened}">${when(r.opened_at)}</td>
        <td data-label="${col.maturity}">${when(r.maturity)}</td>
        <td data-label="${col.closed}">${when(r.closed_at)}${r.interest ? `<div class="small muted">${esc(t("interest {amount} {currency}", { amount: units(r.interest, decimals.stablecoin), currency: cur }))}</div>` : ""}</td>
        <td data-label="${col.lastTx}">${txLink(explorer, r.last_tx)}</td>
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
        <td data-label="Tx">${txLink(explorer, e.txHash)}</td>
      </tr>`,
    )
    .join("");
  $("events-body").innerHTML = `<table class="table is-new">
    <caption class="sr-only">${esc(t("Latest events of the contract"))}</caption>
    <thead><tr><th class="num">#</th><th>${col.time}</th><th>${col.event}</th><th>${col.topics}</th><th>${col.data}</th><th>Tx</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

function renderFoot(h) {
  $("foot").innerHTML = t("Contract {contract} on Stellar {network}. Journal and exports: <code>indexer/</code> in the repository.", {
    contract: contractLink(explorer, h.contract),
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
  // Who sees a visitor's IP address: shown whether or not the export loaded.
  $("foot-privacy").textContent = privacyLine(view.deployment, "history");
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

/** A file next to the page, revalidated with the host ("no-cache": a 304 while it is unchanged). */
async function loadJson(name) {
  const response = await fetch(`./${name}`, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  bootLang();
  // Inside another site's frame the page shows nothing but how to open it in its own tab.
  if (refusesFrame(window)) return refuseFrame(document);
  applyStatic();
  markLangButtons();
  initMotion();
  setLoading(true);
  wireLanguage();
  try {
    view.deployment = await loadJson("deployment.testnet.json");
    decimals = exportDecimals(view.deployment);
  } catch {
    // The deployment file is optional here: defaults apply.
  }
  try {
    view.history = await loadJson("history.json");
    explorer = explorerOf(view.history, view.deployment);
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
