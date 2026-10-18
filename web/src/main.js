// The page: a market board anyone can read, and the borrower and lender
// actions for a connected Freighter wallet. All chain access goes through
// chain.js; this file only renders and wires events.

import { Chain } from "./chain.js";
import { describeError } from "./errors.js";
import {
  formatAge,
  formatAmount,
  formatCountdown,
  formatDateTime,
  formatRate,
  formatTerm,
  formatUnits,
  shortAddress,
  toUnits,
  unitsToInput,
} from "./format.js";
import {
  HOUR,
  WEEKEND_SECS,
  defaultPrincipal,
  interest,
  maxTermFor,
  nextInterestStep,
  pickOffer,
  seizeState,
  sortOffers,
  withdrawalAmount,
} from "./terms.js";
import { ROLES, ROLE_TITLES, guideTerms, roleGuide } from "./guide.js";
import { eventsOfRepo, timelineOf } from "./timeline.js";
import { connectFreighter, watchFreighter } from "./wallet.js";

const REFRESH_MS = 15_000;
const REMEMBER_KEY = "openwindow.connect";

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const S = {
  chain: null,
  dep: null,
  board: null,
  offers: [],
  maxTerm: 0,
  offset: 0, // ledger clock minus local clock, seconds
  quoteShares: 0n,
  wallet: null,
  walletProblem: null,
  stopWatch: null,
  balances: null,
  approved: false,
  mine: new Map(), // repos I borrowed, by id
  lent: new Map(), // repos on my offers, by id
  nextRepo: 1, // first repo id not scanned yet
  dues: new Map(),
  openings: new Map(), // repo id -> opening tx, from events
  releases: new Map(), // closed repo id -> shares the token refused to deliver
  history: null, // the indexer's export (history.json) when the page can read it: events by repo, for the timelines
  delay: null, // the contract's time delay, seconds
  version: null, // contract version
  guideRole: "borrower",
  eventsFrom: null,
  busy: false,
  refreshing: false,
  borrowQuote: null, // { shares, max } for the borrow form
  principalEdited: false,
  offerEdited: false,
  termEdited: false,
  borrowSharesSet: false,
};

const now = () => Math.floor(Date.now() / 1000 + S.offset);
const SD = () => S.dep.stablecoin.decimals;
const FD = () => S.dep.fund.decimals;
const code = () => S.dep.stablecoin.code;
const sym = () => S.dep.fund.symbol;
const money = (units, rounding) => `${formatAmount(units, SD(), rounding)} ${code()}`;
const exact = (units) => `${formatUnits(units, SD())} ${code()}`;
const shareAmount = (units) => `${formatAmount(units, FD())} ${sym()}`;
const onboardCommand = (address, lender = false) => `cd demo && npm run onboard -- ${address}${lender ? " --role=lender" : ""}`;

/** Replaces an element's markup only when it changed, so focus and selection survive refreshes. */
function setHTML(el, html) {
  if (el._html === html) return;
  el._html = html;
  el.innerHTML = html;
}

const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;

function copyButton(text, label = "Copy") {
  return `<button type="button" class="btn btn-ghost btn-small" data-copy="${esc(text)}">${esc(label)}</button>`;
}

function commandBox(command) {
  return `<div class="command"><code>${esc(command)}</code>${copyButton(command)}</div>`;
}

// ---------------------------------------------------------------------------
// Transactions: one at a time, every state shown
// ---------------------------------------------------------------------------

function tracker(el) {
  const hashLink = (hash) => (hash ? ` ${link(S.chain.explorerTx(hash), `Transaction ${hash.slice(0, 8)}…`)}` : "");
  return {
    update({ stage, text, hash }) {
      el.className = `tx tx-active tx-${stage}`;
      el.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(text)}</span>${hashLink(hash)}`;
    },
    success(message, { hash, seconds }) {
      el.className = "tx tx-ok";
      el.innerHTML = `<span class="icon" aria-hidden="true">✓</span><span>${esc(message)} Confirmed in ${seconds.toFixed(1)} s.</span>${
        hash ? ` ${link(S.chain.explorerTx(hash), "View on Stellar Expert")}` : ""
      }`;
    },
    fail(error, context) {
      const { text, name } = describeError(error, context);
      el.className = "tx tx-error";
      el.innerHTML = `<span class="icon" aria-hidden="true">!</span><span>${esc(text)} <code class="err">${esc(name)}</code></span>${hashLink(error?.hash)}`;
    },
    note(message) {
      el.className = "tx tx-ok";
      el.innerHTML = `<span class="icon" aria-hidden="true">✓</span><span>${esc(message)}</span>`;
    },
  };
}

function syncWriteButtons() {
  for (const button of document.querySelectorAll("[data-write]")) {
    button.disabled = S.busy || button.dataset.blocked === "1";
  }
}

/**
 * Runs one write. `context` feeds the error sentences; `message(result)`
 * is the success line. Everything is refreshed afterwards either way.
 */
async function runTx(el, context, action, message) {
  if (S.busy) return;
  S.busy = true;
  syncWriteButtons();
  const t = tracker(el);
  try {
    const result = await action((status) => t.update(status));
    if (result?.hash) t.success(message(result), result);
    else t.note(message(result));
  } catch (error) {
    console.error(error);
    t.fail(error, typeof context === "function" ? context() : context);
  } finally {
    S.busy = false;
    syncWriteButtons();
    refreshAll();
  }
}

// ---------------------------------------------------------------------------
// Market board
// ---------------------------------------------------------------------------

function tile(label, value, sub = "", tone = "") {
  return `<div class="tile ${tone}"><p class="tile-label">${label}</p><p class="tile-value">${value}</p><p class="tile-sub">${sub}</p></div>`;
}

const errorLine = (result, context) => {
  const { text, name } = describeError(result.error, context);
  return `<span class="text-error">${esc(text)}</span> <code class="err">${esc(name)}</code>`;
};

/** The in-page guide: a tab per party, its steps and commitments, and the live terms of the instance. */
function renderGuide() {
  const tabs = $("guide-tabs");
  const body = $("guide-body");
  const terms = $("guide-terms");
  if (!tabs || !body || !terms) return;
  const b = S.board;
  const config = b?.config.value;
  const ctx = {
    code: code(),
    sym: sym(),
    maxTermSecs: S.maxTerm || 7 * 24 * 3600,
    delaySecs: S.delay ?? 48 * 3600,
    haircutBps: config ? Number(config.haircut_bps) : null,
  };
  setHTML(
    tabs,
    ROLES.map(
      (r) =>
        `<button type="button" role="tab" class="tab" id="tab-${r}" aria-selected="${r === S.guideRole}" aria-controls="guide-body" data-role="${r}">${esc(ROLE_TITLES[r])}</button>`,
    ).join(""),
  );
  const g = roleGuide(S.guideRole, ctx);
  const list = (items) => `<ul class="guide-list">${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
  setHTML(
    body,
    `<p class="guide-intro">${esc(g.intro)}</p>
     <div class="guide-grid">
       <div><h3 class="sub">What you need</h3>${list(g.need)}</div>
       <div><h3 class="sub">What you do</h3><ol class="guide-list guide-steps">${g.steps.map((i) => `<li>${esc(i)}</li>`).join("")}</ol></div>
       <div><h3 class="sub">What you commit to, and what protects you</h3>${list(g.terms)}</div>
     </div>`,
  );
  if (b) {
    const rows = guideTerms({ dep: S.dep, board: b, maxTermSecs: ctx.maxTermSecs, delaySecs: ctx.delaySecs, version: S.version, paused: b.paused.value });
    setHTML(terms, rows.map(([label, value, note]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}${note ? `<span class="muted small"> ${esc(note)}</span>` : ""}</dd></div>`).join(""));
    $("guide-meta").textContent = `terms read from the chain ${S.dep.network === "testnet" ? "on testnet" : ""}`.trim();
  }
}

function renderBoard() {
  const b = S.board;
  const config = b.config.value;
  const state = b.state.value;
  const t = now();

  const status = $("board-status");
  if (b.paused.value === true) {
    status.className = "pill pill-warn";
    status.textContent = "Paused";
    status.title = "New loans and offers are suspended. Repurchases still work.";
  } else if (state?.frozen) {
    status.className = "pill pill-warn";
    status.textContent = "Fund frozen";
    status.title = "The fund issuer suspended new loans on this fund.";
  } else if (b.paused.value === false && config) {
    status.className = "pill pill-ok";
    status.textContent = "Open for loans";
    status.title = "";
  } else {
    status.className = "pill";
    status.textContent = "Unknown";
  }

  const tiles = [];
  const navCurrency = S.dep.fund.navCurrency;
  if (b.nav.value && state) {
    const old = config && t - Number(b.nav.value.timestamp) > Number(config.nav_max_age_secs);
    tiles.push(
      tile(
        "Fund share NAV",
        `${formatUnits(b.nav.value.price, state.nav_decimals, { digits: 4 })} <span class="unit-inline">${navCurrency}</span>`,
        `${old ? "Too old to lend against. " : ""}Published <span data-since="${b.nav.value.timestamp}">${formatAge(b.nav.value.timestamp, t)}</span>`,
        old ? "tile-warn" : "",
      ),
    );
  } else {
    tiles.push(tile("Fund share NAV", "—", b.nav.error ? errorLine(b.nav) : ""));
  }

  const leg = Array.isArray(config?.source) && config.source[0] === "Cross" ? config.source[1] : null;
  if (leg && b.fx.value && state) {
    const old = t - Number(b.fx.value.timestamp) > Number(leg.max_age_secs);
    tiles.push(
      tile(
        `${S.dep.stablecoin.currency}/${navCurrency}`,
        formatUnits(b.fx.value.price, state.fx_decimals, { digits: 4 }),
        `${old ? "Too old to lend against. " : ""}Exchange rate, <span data-since="${b.fx.value.timestamp}">${formatAge(b.fx.value.timestamp, t)}</span>`,
        old ? "tile-warn" : "",
      ),
    );
  } else if (leg) {
    tiles.push(tile(`${S.dep.stablecoin.currency}/${navCurrency}`, "—", b.fx.error ? errorLine(b.fx) : "No rate"));
  }

  if (b.quote.value) {
    const q = b.quote.value;
    tiles.push(
      tile(
        `Share value in ${code()}`,
        formatUnits(q.price, q.price_decimals, { digits: 4 }),
        `Lent against with a ${formatRate(q.haircut_bps)} haircut`,
      ),
    );
  } else if (b.quote.error) {
    tiles.push(tile(`Share value in ${code()}`, "—", errorLine(b.quote), "tile-warn"));
  }

  if (config && state) {
    const used = BigInt(state.outstanding);
    const cap = BigInt(config.max_outstanding);
    const pct = cap > 0n ? Number((used * 1000n) / cap) / 10 : 0;
    tiles.push(
      tile(
        "Lent against this fund",
        `${formatAmount(used, SD(), "round")} <span class="unit-inline">of ${formatAmount(cap, SD())} ${code()}</span>`,
        `<span class="bar" role="img" aria-label="${pct.toFixed(1)} percent of the fund cap used"><span style="width:${Math.min(pct, 100)}%"></span></span>Up to ${money(config.max_principal_per_repo)} per loan`,
      ),
    );
  }
  setHTML($("tiles"), tiles.join(""));
  renderFunds(b.funds ?? []);
  renderGuide();

  renderQuote(b.quote, S.quoteShares);
  renderOffers();
}

/** The funds this instance admits, each with its own issuer, feed and settings; shown when there is more than one. */
function renderFunds(funds) {
  const out = $("funds");
  if (!out) return;
  if (funds.length < 2) {
    setHTML(out, "");
    return;
  }
  const rows = funds.map((f) => {
    const cfg = f.config.value;
    const st = f.state.value;
    const source = Array.isArray(cfg?.source) ? cfg.source[0] : cfg?.source;
    const lent = cfg && st ? `${formatAmount(BigInt(st.outstanding), SD(), "round")} of ${formatAmount(BigInt(cfg.max_outstanding), SD())} ${esc(code())}` : "—";
    return `<tr><td data-label="Fund share">${esc(f.symbol)} <span class="muted small">${esc(f.name)}</span></td><td data-label="NAV in">${esc(f.navCurrency)}</td><td data-label="FX leg">${source === "Cross" ? "exchange-rate leg" : source === "Direct" ? "none" : "—"}</td><td data-label="Haircut">${cfg ? formatRate(cfg.haircut_bps) : "—"}</td><td data-label="Max NAV age">${cfg ? `${Number(cfg.nav_max_age_secs) / 3600} h` : "—"}</td><td data-label="Lent">${lent}</td></tr>`;
  });
  setHTML(
    out,
    `<h3 class="sub">Funds admitted</h3>
     <p class="muted small">Each fund is admitted by the governor and its own issuer, with its own NAV feed and settings. The contract is the same for all of them.</p>
     <table class="table"><thead><tr><th>Fund share</th><th>NAV in</th><th>FX leg</th><th>Haircut</th><th>Max NAV age</th><th>Lent</th></tr></thead><tbody>${rows.join("")}</tbody></table>`,
  );
}

function renderQuote(result, shares) {
  const out = $("quote-out");
  if (!shares || shares <= 0n) {
    setHTML(out, `<span class="muted">Enter a number of shares.</span>`);
  } else if (result?.value) {
    setHTML(out, `${esc(shareAmount(shares))} can secure up to <strong>${esc(money(result.value.max_principal, "floor"))}</strong>`);
  } else if (result?.error) {
    setHTML(out, errorLine(result));
  }
}

function renderOffers() {
  const fund = S.chain.fund;
  const offers = S.offers.filter((o) => o.funds.includes(fund) && o.available > 0n);
  if (S.board?.offers.error && !S.offers.length) {
    setHTML($("offers"), `<p>${errorLine(S.board.offers)}</p>`);
    return;
  }
  if (!offers.length) {
    setHTML($("offers"), `<p class="muted">No offer has ${esc(code())} available right now.</p>`);
    return;
  }
  const rows = offers
    .map(
      (o) => `<tr>
        <td data-label="Offer"><span class="strong">#${o.id}</span>${o.sponsor ? ` <span class="badge" title="An independent lender the fund issuer designates">Designated</span>` : ""}
          <span class="muted small mono">${esc(shortAddress(o.lender))}</span>${S.wallet && o.lender === S.wallet.address ? ` <span class="badge badge-muted">You</span>` : ""}</td>
        <td data-label="Available" class="num">${esc(money(o.available, "floor"))}</td>
        <td data-label="Rate" class="num">${esc(formatRate(o.rate_bps))} <span class="muted small">a year</span></td>
        <td data-label="Longest term" class="num">${esc(formatTerm(maxTermFor(o, S.maxTerm || o.max_term)))}</td>
      </tr>`,
    )
    .join("");
  setHTML(
    $("offers"),
    `<table class="table"><caption class="sr-only">Offers open to these fund shares, issuer first, then cheapest</caption>
      <thead><tr><th scope="col">Offer</th><th scope="col" class="num">Available</th><th scope="col" class="num">Rate</th><th scope="col" class="num">Longest term</th></tr></thead>
      <tbody>${rows}</tbody></table>`,
  );
}

let quoteTimer = null;
function onQuoteInput() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(async () => {
    const shares = toUnits($("quote-shares").value, FD());
    const field = $("quote-shares");
    field.setAttribute("aria-invalid", shares === null ? "true" : "false");
    if (shares === null) {
      setHTML($("quote-out"), `<span class="text-error">Enter a number, up to ${FD()} decimals.</span>`);
      return;
    }
    S.quoteShares = shares;
    if (shares === 0n) return renderQuote(null, 0n);
    setHTML($("quote-out"), `<span class="muted">Asking the contract…</span>`);
    let result;
    try {
      result = { value: await S.chain.quote(shares) };
    } catch (error) {
      result = { error };
    }
    if (S.quoteShares === shares) renderQuote(result, shares);
  }, 350);
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

function renderWalletChip() {
  const chip = $("wallet-chip");
  if (!S.wallet) {
    setHTML(chip, `<button type="button" class="btn btn-primary" id="connect">Connect Freighter</button>`);
    return;
  }
  setHTML(
    chip,
    `<span class="addr mono" title="${esc(S.wallet.address)}"><span class="dot" aria-hidden="true"></span>${esc(shortAddress(S.wallet.address))}</span>
     <button type="button" class="btn btn-ghost btn-small" id="disconnect">Disconnect</button>`,
  );
}

function step(done, title, body) {
  return `<li class="${done ? "done" : "todo"}"><span class="step-mark" aria-hidden="true">${done ? "✓" : ""}</span>
    <div><p class="step-title">${title}${done ? ` <span class="sr-only">(done)</span>` : ""}</p>${done ? "" : body}</div></li>`;
}

function renderWallet() {
  renderWalletChip();
  const body = $("wallet-body");
  if (!S.wallet) {
    setHTML(
      body,
      `<p>Connect Freighter to borrow, repurchase or lend. The market above needs no wallet.</p>
       ${S.walletProblem ? `<p class="notice notice-error" role="alert">${esc(S.walletProblem)}</p>` : ""}
       <p class="muted small">Freighter must be set to Testnet. Your keys stay in Freighter: this page only asks it to sign.</p>`,
    );
    return;
  }
  const a = S.wallet.address;
  const b = S.balances;
  if (!b) {
    setHTML(body, `<p class="muted">Reading balances…</p>`);
    return;
  }
  const funded = b.xlm !== null;
  const trust = b.stablecoin !== null;
  const ready = b.shares > 0n;
  const steps = [
    step(
      funded,
      "Test XLM for network fees",
      `<p>This account does not exist on testnet yet.</p><button type="button" class="btn btn-secondary btn-small" data-write data-friendbot>Get test XLM</button>`,
    ),
    step(
      trust,
      `Accept ${esc(code())}`,
      `<p>Add a trustline so this account can hold ${esc(code())}. Freighter asks you to sign.</p><button type="button" class="btn btn-secondary btn-small" data-write data-trust ${
        funded ? "" : `data-blocked="1"`
      }>Add ${esc(code())}</button>`,
    ),
    step(
      ready || S.approved,
      "Test shares and tokens from the operator",
      `<p>Only the operator keys can allowlist this wallet and mint test fund shares. Send them your address, or run this from a checkout that holds the demo keys:</p>
       ${commandBox(onboardCommand(a))}
       <p class="muted small">To lend instead of borrow:</p>${commandBox(onboardCommand(a, true))}`,
    ),
  ];
  const allDone = funded && trust && (ready || S.approved);
  setHTML(
    body,
    `<dl class="facts facts-wallet">
       <div><dt>Address</dt><dd class="mono">${link(S.chain.explorerAccount(a), shortAddress(a))} ${copyButton(a, "Copy address")}</dd></div>
       <div><dt>XLM</dt><dd class="num">${b.xlm === null ? "—" : esc(formatAmount(b.xlm, 7))}</dd></div>
       <div><dt>${esc(code())}</dt><dd class="num">${trust ? esc(formatAmount(b.stablecoin, SD())) : `<span class="muted">No trustline</span>`}</dd></div>
       <div><dt>${esc(sym())}</dt><dd class="num">${esc(formatAmount(b.shares, FD()))}</dd></div>
     </dl>
     ${allDone ? `<p class="muted small">Ready.${S.approved ? " This address is an approved lender." : ""}</p>` : `<h3 class="sub">Get started</h3><ol class="steps">${steps.join("")}</ol>`}`,
  );
  syncWriteButtons();
}

async function connect({ silent = false } = {}) {
  S.walletProblem = null;
  try {
    const wallet = await connectFreighter(S.dep.networkPassphrase);
    adoptWallet(wallet);
    try {
      localStorage.setItem(REMEMBER_KEY, "1");
    } catch {
      // Storage blocked: the page just will not reconnect on reload.
    }
  } catch (error) {
    if (!silent) S.walletProblem = describeError(error).text;
    renderWallet();
  }
}

function adoptWallet(wallet) {
  S.wallet = wallet;
  S.balances = null;
  S.approved = false;
  S.mine = new Map();
  S.lent = new Map();
  S.nextRepo = 1;
  S.dues = new Map();
  S.openings = new Map();
  S.releases = new Map();
  S.eventsFrom = null;
  S.borrowSharesSet = false;
  S.stopWatch?.();
  S.stopWatch = watchFreighter((change) => {
    if (!S.wallet) return;
    if (change.networkPassphrase && change.networkPassphrase !== S.dep.networkPassphrase) {
      disconnect(`Freighter switched to ${change.network || "another network"}. This interface runs on Testnet only. Switch back, then connect again.`);
    } else if (change.address && change.address !== S.wallet.address) {
      disconnect("Freighter switched to another account. Connect again to use it.");
    }
  });
  renderAllWalletViews();
  refreshAll();
}

function disconnect(reason = null) {
  S.stopWatch?.();
  S.stopWatch = null;
  S.wallet = null;
  S.walletProblem = reason;
  S.balances = null;
  S.mine = new Map();
  S.lent = new Map();
  try {
    localStorage.removeItem(REMEMBER_KEY);
  } catch {
    // ignore
  }
  for (const id of ["wallet-tx", "borrow-tx", "positions-tx", "lend-tx"]) {
    $(id).className = "tx";
    $(id).innerHTML = "";
  }
  renderAllWalletViews();
}

function renderAllWalletViews() {
  renderWallet();
  renderBorrow();
  renderPositions();
  renderLend();
  if (S.board) renderOffers();
}

// ---------------------------------------------------------------------------
// Borrow
// ---------------------------------------------------------------------------

function selectedOffer() {
  const id = Number($("b-offer").value);
  return S.offers.find((o) => o.id === id) ?? null;
}

function fundLimits() {
  const config = S.board?.config.value;
  const state = S.board?.state.value;
  if (!config || !state) return [];
  return [BigInt(config.max_principal_per_repo), BigInt(config.max_outstanding) - BigInt(state.outstanding)];
}

function renderBorrowOffers() {
  const select = $("b-offer");
  const fund = S.chain.fund;
  const offers = S.offers.filter((o) => o.funds.includes(fund) && o.available > 0n && (!S.wallet || o.lender !== S.wallet.address));
  const previous = select.value;
  const html = offers
    .map(
      (o) =>
        `<option value="${o.id}">#${o.id}${o.sponsor ? " · Designated" : ""} · ${formatRate(o.rate_bps)} · ${money(o.available, "floor")} available · up to ${Math.floor(
          maxTermFor(o, S.maxTerm) / HOUR,
        )} h</option>`,
    )
    .join("");
  setHTML(select, html || `<option value="">No offer available</option>`);
  if (offers.some((o) => String(o.id) === previous)) select.value = previous;
  if (!S.offerEdited) {
    const want = S.borrowQuote ? defaultPrincipal(S.borrowQuote.max, ...fundLimits()) : 0n;
    const pick = pickOffer(offers, fund, want) ?? [...offers].sort((a, b) => (b.available > a.available ? 1 : -1))[0];
    if (pick) select.value = String(pick.id);
  }
}

function renderBorrow() {
  const gate = $("borrow-gate");
  const form = $("borrow-form");
  let message = "";
  if (!S.wallet) message = "Connect a wallet to borrow. The market above shows what your shares can secure.";
  else if (!S.balances) message = "Reading your balances…";
  else if (S.balances.stablecoin === null) message = `Add ${code()} to your wallet first, under Your wallet.`;
  else if (S.balances.shares === 0n) message = `This wallet holds no ${sym()} shares yet. Ask the operator to onboard it, under Your wallet.`;
  gate.textContent = message;
  gate.hidden = !message;
  form.hidden = Boolean(message);
  if (message) return;

  if (!S.borrowSharesSet) {
    S.borrowSharesSet = true;
    const start = S.balances.shares < 1_000n * 10n ** BigInt(FD()) ? S.balances.shares : 1_000n * 10n ** BigInt(FD());
    $("b-shares").value = unitsToInput(start, FD());
    fetchBorrowQuote();
  }
  renderBorrowOffers();
  updateBorrowForm();
}

let borrowQuoteTimer = null;
function fetchBorrowQuote() {
  clearTimeout(borrowQuoteTimer);
  borrowQuoteTimer = setTimeout(async () => {
    const shares = toUnits($("b-shares").value, FD());
    if (!shares) {
      S.borrowQuote = null;
      return updateBorrowForm();
    }
    try {
      const q = await S.chain.quote(shares);
      if (toUnits($("b-shares").value, FD()) !== shares) return;
      S.borrowQuote = { shares, max: BigInt(q.max_principal), error: null };
    } catch (error) {
      S.borrowQuote = { shares, max: 0n, error };
    }
    renderBorrowOffers();
    updateBorrowForm();
  }, 300);
}

function setHelp(id, text, isError = false) {
  const help = $(id);
  help.textContent = text;
  help.classList.toggle("help-error", isError);
  const input = document.querySelector(`[aria-describedby~="${id}"]`);
  input?.setAttribute("aria-invalid", isError ? "true" : "false");
}

/** Reads the borrow form, fills helpers and the cost preview. Returns the order, or null if invalid. */
function updateBorrowForm() {
  if (!S.wallet || !S.balances || $("borrow-form").hidden) return null;
  const offer = selectedOffer();
  const shares = toUnits($("b-shares").value, FD());
  const q = S.borrowQuote && S.borrowQuote.shares === shares ? S.borrowQuote : null;
  let valid = true;

  if (shares === null || shares === 0n) {
    setHelp("b-shares-help", "Enter how many shares to lock.", true);
    valid = false;
  } else if (shares > S.balances.shares) {
    setHelp("b-shares-help", `You hold ${shareAmount(S.balances.shares)}.`, true);
    valid = false;
  } else {
    setHelp("b-shares-help", `You hold ${shareAmount(S.balances.shares)}.`);
  }

  if (q && !q.error && !S.principalEdited) {
    // Rounded down to the cent: a round figure is easier to read and stays under the ceiling.
    const cent = 10n ** BigInt(Math.max(SD() - 2, 0));
    const suggested = defaultPrincipal(q.max, offer?.available, ...fundLimits());
    $("b-principal").value = unitsToInput(suggested - (suggested % cent), SD());
  }
  const principal = toUnits($("b-principal").value, SD());
  if (q?.error) {
    setHelp("b-principal-help", describeError(q.error).text, true);
    valid = false;
  } else if (principal === null || principal === 0n) {
    setHelp("b-principal-help", "Enter an amount.", true);
    valid = false;
  } else if (q && principal > q.max) {
    setHelp("b-principal-help", `This is more than the shares can secure. The maximum is ${money(q.max, "floor")}.`, true);
    valid = false;
  } else if (offer && principal > offer.available) {
    setHelp("b-principal-help", `This offer holds ${money(offer.available, "floor")}. Pick another offer or borrow less.`, true);
    valid = false;
  } else {
    setHelp("b-principal-help", q ? `These shares secure up to ${money(q.max, "floor")}. The suggestion is 90 % of that.` : "Valuing the shares…");
  }

  const maxHours = offer ? Math.floor(maxTermFor(offer, S.maxTerm) / HOUR) : 0;
  $("b-term").max = String(maxHours || 1);
  if (maxHours && !S.termEdited && Number($("b-term").value) > maxHours) $("b-term").value = String(maxHours);
  const hours = Number($("b-term").value);
  if (!Number.isInteger(hours) || hours < 1 || (maxHours && hours > maxHours)) {
    setHelp("b-term-help", `Choose 1 to ${maxHours} hours.`, true);
    valid = false;
  } else {
    setHelp("b-term-help", `1 to ${maxHours} hours on this offer. The term is your deadline, not what you pay.`);
  }
  if (!offer) valid = false;

  const preview = [];
  if (offer && principal && hours >= 1) {
    const term = Math.min(hours, maxHours || hours) * HOUR;
    const atTerm = interest(principal, offer.rate_bps, term);
    const row = (label, value, strong = false) =>
      `<div><dt>${esc(label)}</dt><dd class="num">${strong ? `<strong>${esc(value)}</strong>` : esc(value)}</dd></div>`;
    preview.push(
      row("Rate", `${formatRate(offer.rate_bps)} a year, offer #${offer.id}`),
      row("Interest for the first hour", exact(interest(principal, offer.rate_bps, HOUR))),
      row(`Interest if repaid at term (${hours} h)`, exact(atTerm)),
      row("Interest for a 64-hour weekend", exact(interest(principal, offer.rate_bps, WEEKEND_SECS))),
      row("To repay at term", money(principal + atTerm, "ceil"), true),
      row("Term ends", formatDateTime(now() + term)),
    );
  }
  setHTML($("b-preview"), preview.join("") || `<p class="muted">Fill in the form to see the cost.</p>`);

  const paused = S.board?.paused.value === true;
  const submit = $("b-submit");
  submit.dataset.blocked = valid && !paused ? "0" : "1";
  submit.textContent = paused ? "New loans are paused" : valid ? `Borrow ${money(principal)}` : "Borrow";
  syncWriteButtons();
  return valid && !paused ? { offer, shares, principal, term: hours * HOUR, maxHours, max: q?.max } : null;
}

function submitBorrow(event) {
  event.preventDefault();
  const order = updateBorrowForm();
  if (!order) return;
  const context = {
    max: order.max !== undefined ? money(order.max, "floor") : null,
    available: money(order.offer.available, "floor"),
    term: `1 to ${order.maxHours} hours`,
    code: code(),
    command: onboardCommand(S.wallet.address),
  };
  runTx(
    $("borrow-tx"),
    context,
    (onStatus) =>
      S.chain.openRepo(S.wallet, { offerId: order.offer.id, shares: order.shares, principal: order.principal, term: order.term }, onStatus),
    (result) => {
      S.principalEdited = false;
      return `Repo #${result.repoId} opened: ${money(order.principal)} sent to your wallet.`;
    },
  );
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

async function refreshPositions() {
  const address = S.wallet?.address;
  if (!address) return;
  const fresh = await S.chain.repos(S.nextRepo);
  if (S.wallet?.address !== address) return;
  const keep = (repo) => {
    if (repo.borrower === address) S.mine.set(repo.id, repo);
    if (repo.lender === address) S.lent.set(repo.id, repo);
  };
  for (const repo of fresh) {
    keep(repo);
    S.nextRepo = Math.max(S.nextRepo, repo.id + 1);
  }
  // Closed repos never change; open ones close by repurchase or seizure.
  const freshIds = new Set(fresh.map((r) => r.id));
  const tracked = new Map([...S.mine, ...S.lent]);
  const recheck = [...tracked.values()].filter((r) => r.status === "Open" && !freshIds.has(r.id));
  for (const repo of await Promise.all(recheck.map((r) => S.chain.repo(r.id)))) {
    if (repo) keep(repo);
  }
  const open = [...new Map([...S.mine, ...S.lent]).values()].filter((r) => r.status === "Open");
  await Promise.all(
    open.map(async (r) => {
      try {
        S.dues.set(r.id, await S.chain.repoDue(r.id));
      } catch {
        S.dues.delete(r.id);
      }
    }),
  );
  // A closed repo may still owe shares the issuer's token refused to move.
  const closedIds = [...new Map([...S.mine, ...S.lent]).values()].filter((r) => r.status !== "Open").map((r) => r.id);
  await Promise.all(
    closedIds.map(async (id) => {
      try {
        const pending = await S.chain.pendingRelease(id);
        if (pending) S.releases.set(id, pending);
        else S.releases.delete(id);
      } catch {
        // Older contract versions have no deferred release.
      }
    }),
  );
  renderPositions();
  // Opening transactions come from events, which the RPC keeps for a limited
  // window. Best effort: positions are complete without them.
  try {
    const { openings, nextLedger } = await S.chain.repoOpenings(address, S.eventsFrom);
    if (S.wallet?.address !== address) return;
    for (const [id, opening] of openings) S.openings.set(id, opening);
    S.eventsFrom = nextLedger;
    renderPositions();
  } catch (error) {
    console.warn("repo_opened events unavailable", error);
  }
}

function renderPositions() {
  const body = $("positions-body");
  const meta = $("positions-meta");
  if (!S.wallet) {
    meta.textContent = "";
    setHTML(body, `<p class="muted">Connect a wallet to see your positions.</p>`);
    return;
  }
  const repos = [...S.mine.values()].sort((a, b) => b.id - a.id);
  const open = repos.filter((r) => r.status === "Open");
  const closed = repos.filter((r) => r.status !== "Open");
  meta.textContent = repos.length ? `${open.length} open, ${closed.length} closed` : "";
  if (!repos.length) {
    setHTML(body, `<p class="muted">No positions yet. Borrow above to open one.</p>`);
    return;
  }
  const t = now();
  const balance = S.balances?.stablecoin ?? 0n;
  const openingLink = (id) => (S.openings.get(id) ? link(S.chain.explorerTx(S.openings.get(id).txHash), "Opening transaction") : "");
  const cards = open.map((r) => {
    const due = S.dues.get(r.id);
    const total = due === undefined ? null : BigInt(r.principal) + due;
    const step = nextInterestStep(r.opened_at, t);
    const matured = t >= Number(r.maturity);
    const short = total !== null && balance < total ? total - balance : 0n;
    return `<article class="position${matured ? " position-late" : ""}" aria-labelledby="repo-${r.id}">
      <header><h3 id="repo-${r.id}">Repo #${r.id}</h3><span class="pill ${matured ? "pill-danger" : "pill-ok"}">${matured ? "Past term" : "Open"}</span></header>
      <dl class="facts">
        <div><dt>Borrowed</dt><dd class="num">${esc(money(r.principal))}</dd></div>
        <div><dt>Shares locked</dt><dd class="num">${esc(shareAmount(r.shares))}</dd></div>
        <div><dt>Rate</dt><dd class="num">${esc(formatRate(r.rate_bps))} a year, offer #${r.offer_id}</dd></div>
        <div><dt>Due now</dt><dd class="num"><strong>${total === null ? "—" : esc(money(total, "ceil"))}</strong>${
          due === undefined ? "" : `<span class="muted small"> including ${esc(exact(due))} interest</span>`
        }</dd></div>
        <div><dt>Next hour of interest</dt><dd class="num">starts <span data-until="${step}" data-after="now"></span></dd></div>
        <div><dt>Term ends</dt><dd class="num">${esc(formatDateTime(r.maturity))}, <span data-until="${r.maturity}" data-after="passed: the lender may now keep the shares"></span></dd></div>
      </dl>
      ${timelineMarkup(r)}
      ${short > 0n ? `<p class="text-error small">You hold ${esc(money(balance))}. You need ${esc(money(short, "ceil"))} more to repurchase.</p>` : ""}
      <div class="actions">
        <button type="button" class="btn btn-primary" data-write data-repurchase="${r.id}" ${short > 0n ? `data-blocked="1"` : ""}>Repurchase${
          total === null ? "" : ` for ${esc(money(total, "ceil"))}`
        }</button>
        ${openingLink(r.id)}
      </div>
    </article>`;
  });
  const history = closed
    .slice(0, 10)
    .map(
      (r) =>
        `<li><details class="tl-closed"><summary><span class="strong">Repo #${r.id}</span> <span class="pill ${r.status === "Repurchased" ? "pill-muted" : "pill-danger"}">${
          r.status === "Repurchased" ? "Repurchased" : "Shares kept by lender"
        }</span> <span class="num">${esc(money(r.principal))}</span>${releaseNote(r.id)}</summary>${timelineMarkup(r)}</details></li>`,
    );
  setHTML(
    body,
    `${cards.join("") || `<p class="muted">No open position.</p>`}
     ${history.length ? `<h3 class="sub">Closed</h3><ul class="history">${history.join("")}</ul>` : ""}`,
  );
  syncWriteButtons();
  renderLent();
  tick();
}

function onRepurchase(id) {
  const repo = S.mine.get(id);
  runTx(
    $("positions-tx"),
    { code: code() },
    (onStatus) => S.chain.repurchase(S.wallet, id, onStatus),
    () => `Repo #${id} repurchased: ${shareAmount(repo.shares)} back in your wallet.`,
  );
}

// ---------------------------------------------------------------------------
// Lend
// ---------------------------------------------------------------------------

function renderLend() {
  const gate = $("lend-gate");
  const form = $("lend-form");
  if (!S.wallet || !S.balances) {
    setHTML(gate, `<p class="muted">${S.wallet ? "Reading your balances…" : "Connect a wallet to lend."}</p>`);
    form.hidden = true;
    setHTML($("my-offers"), "");
    renderLent();
    return;
  }
  if (!S.approved) {
    setHTML(
      gate,
      `<p>This address is not an approved lender for the fund. The fund issuer approves lenders, so a seized position always goes to a known holder.</p>
       <p class="muted small">On testnet, the operator approves it and sends test ${esc(code())} with:</p>${commandBox(onboardCommand(S.wallet.address, true))}`,
    );
    form.hidden = true;
  } else {
    setHTML(gate, `<p class="muted">You are an approved lender. Repaid principal and interest flow back into your offer, where you withdraw them.</p>`);
    form.hidden = false;
    const hold = S.balances.stablecoin;
    setHelp("l-amount-help", hold === null ? `Add ${code()} first.` : `You hold ${money(hold)}.`);
    const maxHours = Math.floor(S.maxTerm / HOUR);
    $("l-term").max = String(maxHours || 1);
    setHelp("l-term-help", maxHours ? `1 to ${maxHours} hours, the contract's limit.` : "");
  }
  renderMyOffers();
  renderLent();
}

function renderMyOffers() {
  if (!S.wallet) return setHTML($("my-offers"), "");
  const mine = S.offers.filter((o) => o.lender === S.wallet.address).sort((a, b) => b.id - a.id);
  if (!mine.length) {
    setHTML($("my-offers"), S.approved ? `<p class="muted">You have no offer yet.</p>` : "");
    return;
  }
  const rows = mine
    .map(
      (o) => `<tr>
        <td data-label="Offer"><span class="strong">#${o.id}</span>${o.sponsor ? ` <span class="badge">Designated</span>` : ""}</td>
        <td data-label="Available" class="num">${esc(money(o.available))}</td>
        <td data-label="Rate" class="num">${esc(formatRate(o.rate_bps))}</td>
        <td data-label="Longest term" class="num">${esc(formatTerm(o.max_term))}</td>
        <td data-label="Withdraw" class="num">${
          o.available > 0n
            ? `<div class="withdraw"><label class="sr-only" for="w-amount-${o.id}">Amount to withdraw from offer #${o.id}</label>
                <div class="input-unit input-small"><input id="w-amount-${o.id}" inputmode="decimal" autocomplete="off" value="${esc(
                  unitsToInput(o.available, SD()),
                )}" /><span class="unit">${esc(code())}</span></div>
                <button type="button" class="btn btn-secondary btn-small" data-write data-withdraw="${o.id}">Withdraw</button></div>`
            : `<span class="muted small">Nothing to withdraw</span>`
        }</td>
      </tr>`,
    )
    .join("");
  setHTML(
    $("my-offers"),
    `<h3 class="sub">Your offers</h3><table class="table"><caption class="sr-only">Your offers</caption>
      <thead><tr><th scope="col">Offer</th><th scope="col" class="num">Available</th><th scope="col" class="num">Rate</th><th scope="col" class="num">Longest term</th><th scope="col" class="num">Withdraw</th></tr></thead>
      <tbody>${rows}</tbody></table>`,
  );
  syncWriteButtons();
}

function submitLend(event) {
  event.preventDefault();
  const amount = toUnits($("l-amount").value, SD());
  const rate = toUnits($("l-rate").value, 2); // percent with two decimals = basis points
  const hours = Number($("l-term").value);
  const maxHours = Math.floor(S.maxTerm / HOUR);
  let valid = true;
  if (!amount) {
    setHelp("l-amount-help", "Enter an amount.", true);
    valid = false;
  } else if (S.balances?.stablecoin !== null && amount > S.balances.stablecoin) {
    setHelp("l-amount-help", `You hold ${money(S.balances.stablecoin)}.`, true);
    valid = false;
  }
  if (rate === null || rate > 10_000n) {
    setHelp("l-rate-help", "Enter a rate from 0 to 100 %, up to two decimals.", true);
    valid = false;
  } else {
    setHelp("l-rate-help", "Up to two decimals. Charged per started hour.");
  }
  if (!Number.isInteger(hours) || hours < 1 || (maxHours && hours > maxHours)) {
    setHelp("l-term-help", `Choose 1 to ${maxHours} hours.`, true);
    valid = false;
  }
  if (!valid) return;
  runTx(
    $("lend-tx"),
    { code: code(), term: `1 to ${maxHours} hours`, action: "create_offer" },
    (onStatus) => S.chain.createOffer(S.wallet, { amount, rateBps: Number(rate), maxTerm: hours * HOUR }, onStatus),
    (result) => `Offer #${result.offerId} created with ${money(amount)} at ${formatRate(Number(rate))}.`,
  );
}

function showProblem(el, text) {
  el.className = "tx tx-error";
  el.innerHTML = `<span class="icon" aria-hidden="true">!</span><span>${esc(text)}</span>`;
}

function onWithdraw(id) {
  const offer = S.offers.find((o) => o.id === id);
  if (!offer || offer.available <= 0n) return;
  const input = $(`w-amount-${id}`);
  const checked = withdrawalAmount(toUnits(input?.value ?? "", SD()), offer.available);
  input?.setAttribute("aria-invalid", checked.error ? "true" : "false");
  if (checked.error) {
    return showProblem($("lend-tx"), `Offer #${id}: ${checked.error} It holds ${money(offer.available)}.`);
  }
  const amount = checked.amount;
  runTx(
    $("lend-tx"),
    { code: code(), available: money(amount) },
    (onStatus) => S.chain.withdrawOffer(S.wallet, id, amount, onStatus),
    () => `${money(amount)} withdrawn from offer #${id}.`,
  );
}

/** Repos funded by my offers: what borrowers owe me, and the default path. */
function renderLent() {
  const box = $("lent");
  if (!S.wallet || !S.lent.size) return setHTML(box, "");
  const t = now();
  const repos = [...S.lent.values()].sort((a, b) => b.id - a.id);
  const open = repos.filter((r) => r.status === "Open");
  const closed = repos.filter((r) => r.status !== "Open").slice(0, 10);
  const cards = open.map((r) => {
    const state = seizeState(r, t);
    const due = S.dues.get(r.id);
    return `<article class="position${state.allowed ? " position-late" : ""}" aria-labelledby="lent-${r.id}">
      <header><h3 id="lent-${r.id}">Repo #${r.id}</h3><span class="pill ${state.allowed ? "pill-danger" : "pill-ok"}">${
        state.allowed ? "Past term, unpaid" : "Open"
      }</span></header>
      <dl class="facts">
        <div><dt>Borrower</dt><dd class="mono">${link(S.chain.explorerAccount(r.borrower), shortAddress(r.borrower))}</dd></div>
        <div><dt>Lent</dt><dd class="num">${esc(money(r.principal))} at ${esc(formatRate(r.rate_bps))}, offer #${r.offer_id}</dd></div>
        <div><dt>Owed now</dt><dd class="num">${due === undefined ? "—" : esc(money(BigInt(r.principal) + due, "ceil"))}</dd></div>
        <div><dt>Collateral</dt><dd class="num">${esc(shareAmount(r.shares))}</dd></div>
        <div><dt>Term ends</dt><dd class="num">${esc(formatDateTime(r.maturity))}, <span data-until="${r.maturity}" data-after="passed"></span></dd></div>
      </dl>
      ${timelineMarkup(r)}
      <p class="muted small">${
        state.allowed
          ? "The borrower has not repurchased by the term. You may take the shares now; the borrower can still repurchase until you do."
          : "If the borrower has not repurchased by the term, you may take the shares. Until then they stay locked in the contract."
      }</p>
      <div class="actions">
        <button type="button" class="btn ${state.allowed ? "btn-primary" : "btn-secondary"}" data-write data-seize="${r.id}" ${
          state.allowed ? "" : `data-blocked="1" aria-describedby="lent-wait-${r.id}"`
        }>Take the shares</button>
        ${state.allowed ? "" : `<span class="muted small" id="lent-wait-${r.id}">Available <span data-until="${r.maturity}" data-after="now"></span></span>`}
      </div>
    </article>`;
  });
  const history = closed.map(
    (r) =>
      `<li><details class="tl-closed"><summary><span class="strong">Repo #${r.id}</span> <span class="pill ${r.status === "Repurchased" ? "pill-muted" : "pill-danger"}">${
        r.status === "Repurchased" ? "Repaid" : "Shares taken"
      }</span> <span class="num">${esc(money(r.principal))}</span>${releaseNote(r.id)}</summary>${timelineMarkup(r)}</details></li>`,
  );
  setHTML(
    box,
    `<h3 class="sub">Repos on your offers</h3>${cards.join("") || `<p class="muted">No open repo on your offers.</p>`}
     ${history.length ? `<ul class="history">${history.join("")}</ul>` : ""}`,
  );
  syncWriteButtons();
  tick();
}

/**
 * The timeline of a repo: opened, interest, term, closing, delivery. Times and
 * transactions of the closing steps come from the indexer's export when the
 * page could load it; the chain alone gives the opening and the term.
 */
function timelineMarkup(repo) {
  const steps = timelineOf(repo, {
    now: now(),
    opening: S.openings.get(repo.id) ?? null,
    events: S.history ? eventsOfRepo(S.history.events, repo.id) : [],
    pendingRelease: S.releases.get(repo.id) ?? null,
  });
  const items = steps.map((st) => {
    const time =
      st.at === null
        ? ""
        : st.state === "next"
          ? `${esc(formatDateTime(st.at))}, <span data-until="${st.at}" data-after="now"></span>`
          : esc(formatDateTime(st.at));
    const tx = st.tx ? link(S.chain.explorerTx(st.tx), "transaction") : "";
    return `<li class="tl-${st.state}"><div class="tl-head"><span class="tl-label">${esc(st.label)}</span>${time ? `<span class="tl-time">${time}</span>` : ""}${tx ? `<span class="small">${tx}</span>` : ""}</div><p class="tl-detail">${esc(st.detail)}</p></li>`;
  });
  return `<ol class="timeline" aria-label="Timeline of repo ${repo.id}">${items.join("")}</ol>`;
}

/** Held-back shares on a closed repo: a note, and a Release button for the beneficiary. */
function releaseNote(id) {
  const pending = S.releases.get(id);
  if (!pending) return "";
  const mine = pending.to === S.wallet?.address;
  return ` <span class="pill pill-danger">${esc(shareAmount(pending.shares))} held: the issuer blocks the transfer</span>${
    mine ? ` <button type="button" class="btn btn-secondary" data-write data-release="${id}">Release</button>` : ""
  }`;
}

function onRelease(id) {
  const pending = S.releases.get(id);
  runTx(
    $("positions-tx"),
    { action: "release" },
    (onStatus) => S.chain.release(S.wallet, id, onStatus),
    (result) =>
      result.value
        ? `Repo #${id}: ${shareAmount(pending?.shares ?? 0n)} delivered to your wallet.`
        : `Repo #${id}: the issuer still blocks the transfer. The shares stay reserved for you; try again later.`,
  );
}

function onSeize(id) {
  const repo = S.lent.get(id);
  if (!repo || !seizeState(repo, now()).allowed) return;
  runTx(
    $("lend-tx"),
    { action: "seize", when: formatDateTime(repo.maturity) },
    (onStatus) => S.chain.seize(S.wallet, id, onStatus),
    () => `Repo #${id} closed: ${shareAmount(repo.shares)} sent to your wallet.`,
  );
}

// ---------------------------------------------------------------------------
// Refresh loop and clock
// ---------------------------------------------------------------------------

async function refreshBoard() {
  const board = await S.chain.board(S.quoteShares);
  S.board = board;
  if (board.now.value) S.offset = board.now.value - Date.now() / 1000;
  if (board.maxTerm.value) S.maxTerm = Number(board.maxTerm.value);
  if (board.offers.value) S.offers = sortOffers(board.offers.value);
  renderBoard();
}

async function refreshWallet() {
  const address = S.wallet?.address;
  if (!address) return;
  const [balances, approved] = await Promise.all([S.chain.balances(address), S.chain.isLenderApproved(address)]);
  if (S.wallet?.address !== address) return;
  S.balances = balances;
  S.approved = approved;
  renderWallet();
  renderBorrow();
  renderLend();
  await refreshPositions();
}

async function refreshAll() {
  if (S.refreshing || !S.chain) return;
  S.refreshing = true;
  const updated = $("board-updated");
  try {
    await refreshBoard();
    await loadHistory();
    await refreshWallet();
    updated.innerHTML = `Updated <span data-since="${now()}">just now</span>`;
    $("load-error").hidden = true;
  } catch (error) {
    console.error(error);
    updated.textContent = `${describeError(error).text} Trying again in ${REFRESH_MS / 1000} s.`;
  } finally {
    S.refreshing = false;
  }
}

function tick() {
  const t = now();
  for (const el of document.querySelectorAll("[data-since]")) el.textContent = formatAge(el.dataset.since, t);
  for (const el of document.querySelectorAll("[data-until]")) {
    const left = Number(el.dataset.until) - t;
    el.textContent = left > 0 ? `in ${formatCountdown(left)}` : (el.dataset.after ?? "now");
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

function wire() {
  $("guide-tabs")?.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-role]");
    if (!tab) return;
    S.guideRole = tab.dataset.role;
    renderGuide();
  });
  document.addEventListener("click", async (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.id === "connect") return connect();
    if (target.id === "disconnect") return disconnect();
    if (target.id === "refresh") return refreshAll();
    if (target.dataset.copy !== undefined) {
      try {
        await navigator.clipboard.writeText(target.dataset.copy);
        const label = target.textContent;
        target.textContent = "Copied";
        setTimeout(() => (target.textContent = label), 1500);
      } catch {
        window.prompt("Copy this:", target.dataset.copy);
      }
      return;
    }
    if (target.dataset.term) {
      const offer = selectedOffer();
      const max = offer ? Math.floor(maxTermFor(offer, S.maxTerm) / HOUR) : 1;
      $("b-term").value = target.dataset.term === "max" ? String(max) : String(Math.min(Number(target.dataset.term), max));
      return updateBorrowForm();
    }
    if (target.disabled) return;
    if (target.dataset.repurchase) return onRepurchase(Number(target.dataset.repurchase));
    if (target.dataset.withdraw) return onWithdraw(Number(target.dataset.withdraw));
    if (target.dataset.seize) return onSeize(Number(target.dataset.seize));
    if (target.dataset.release) return onRelease(Number(target.dataset.release));
    if (target.dataset.trust !== undefined) {
      return runTx($("wallet-tx"), { code: code() }, (onStatus) => S.chain.addTrustline(S.wallet, onStatus), () => `${code()} added to your wallet.`);
    }
    if (target.dataset.friendbot !== undefined) {
      return runTx(
        $("wallet-tx"),
        {},
        async (onStatus) => {
          onStatus({ stage: "pending", text: "Asking the testnet faucet for XLM." });
          await S.chain.friendbot(S.wallet.address);
          return null;
        },
        () => "Test XLM received.",
      );
    }
  });

  $("quote-form").addEventListener("submit", (e) => e.preventDefault());
  $("quote-shares").addEventListener("input", onQuoteInput);
  $("b-shares").addEventListener("input", () => {
    S.principalEdited = false;
    fetchBorrowQuote();
    updateBorrowForm();
  });
  $("b-principal").addEventListener("input", () => {
    S.principalEdited = true;
    updateBorrowForm();
  });
  $("b-offer").addEventListener("change", () => {
    S.offerEdited = true;
    S.principalEdited = false;
    updateBorrowForm();
  });
  $("b-term").addEventListener("input", () => {
    S.termEdited = true;
    updateBorrowForm();
  });
  $("borrow-form").addEventListener("submit", submitBorrow);
  $("lend-form").addEventListener("submit", submitLend);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshAll();
  });
}

/**
 * The deployment file's symbols and URLs end up in markup and links; accept
 * only plain tickers and https URLs so a tampered file cannot inject either.
 */
function checkDeployment(dep) {
  const ticker = /^[A-Za-z0-9]{1,12}$/;
  const symbols = [dep?.stablecoin?.code, dep?.stablecoin?.currency, dep?.fund?.symbol, dep?.fund?.navCurrency];
  if (!symbols.every((s) => ticker.test(String(s)))) throw new Error("unexpected asset symbol");
  if (![dep.rpcUrl, dep.explorer].every((u) => /^https:\/\/[^\s"'<>]+$/.test(String(u)))) throw new Error("unexpected URL");
  if (!Number.isInteger(dep.stablecoin.decimals) || !Number.isInteger(dep.fund.decimals)) throw new Error("unexpected decimals");
  return dep;
}

/** The indexer's export, when it sits next to the page: it dates and links the closing steps of the timelines. Optional. */
async function loadHistory() {
  try {
    const response = await fetch("./history.json", { cache: "no-store" });
    if (!response.ok) return;
    const h = await response.json();
    if (Array.isArray(h?.events)) S.history = { generatedAt: h.generatedAt, events: h.events };
  } catch {
    // No export: the timelines show what the chain alone tells.
  }
}

async function start() {
  try {
    const response = await fetch("./deployment.testnet.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    S.dep = checkDeployment(await response.json());
  } catch (error) {
    const box = $("load-error");
    box.hidden = false;
    box.textContent = `The deployment file could not be loaded (${error.message}). The interface needs deployment.testnet.json next to this page.`;
    return;
  }
  S.chain = new Chain(S.dep);
  await loadHistory();
  const ow = S.dep.contracts.openWindow;
  const [delay, version] = await Promise.all([S.chain.settle(ow, "timelock_delay"), S.chain.settle(ow, "version")]);
  S.delay = delay.value === undefined ? null : Number(delay.value);
  S.version = version.value === undefined ? null : Number(version.value);
  renderGuide();
  S.quoteShares = toUnits($("quote-shares").value, FD()) ?? 0n;
  for (const el of document.querySelectorAll("[data-fund-symbol]")) el.textContent = sym();
  for (const el of document.querySelectorAll("[data-stable-code]")) el.textContent = code();
  $("network").textContent = S.dep.network === "testnet" ? "Testnet" : S.dep.network;
  const C = S.dep.contracts;
  $("foot").innerHTML = `Open Window contract ${link(S.chain.explorerAccount(C.openWindow), shortAddress(C.openWindow))} on Stellar ${esc(
    S.dep.network,
  )}. Fund shares ${link(S.chain.explorerAccount(C.fundShares), shortAddress(C.fundShares))}, ${esc(code())} ${link(
    S.chain.explorerAccount(C.stablecoin),
    shortAddress(C.stablecoin),
  )}. Every figure is read from the chain; nothing here has real value. Apache-2.0.`;

  wire();
  renderAllWalletViews();
  await refreshAll();
  setInterval(() => {
    if (!document.hidden) refreshAll();
  }, REFRESH_MS);
  setInterval(tick, 1000);

  let remembered = false;
  try {
    remembered = localStorage.getItem(REMEMBER_KEY) === "1";
  } catch {
    // Storage blocked: start disconnected.
  }
  if (remembered) connect({ silent: true });
}

start();
