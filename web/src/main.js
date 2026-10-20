// The page: a market board anyone can read, and the borrower and lender
// actions for a connected Freighter wallet. All chain access goes through
// chain.js; this file only renders and wires events.

// Inter, served with the page (no font request to a third party).
import "@fontsource-variable/inter";
import { Chain, rpcChangeText } from "./chain.js";
import { checkDeployment, privacyLine } from "./deployment.js";
import { refuseFrame, refusesFrame } from "./frame.js";
import { describeError } from "./errors.js";
import {
  UNSHOWABLE,
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
import { closingLine, eventsOfRepo, heldNote, stillHeldLine, timelineOf } from "./timeline.js";
import { createTerminal } from "./terminal.js";
import { connectFreighter, watchFreighter } from "./wallet.js";
import { applyStatic, bootLang, lang, markLangButtons, numberStyle, persistLang, setLang, t } from "./i18n.js";
import { flashChanges, initMotion, setLoading, snapshot, toast, transition } from "./motion.js";

const REFRESH_MS = 15_000;
const REMEMBER_KEY = "openwindow.connect";
const FACE_KEY = "openwindow.face";

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
  historyDue: false, // fetch the export again on the next pass (REF, the page back in view)
  delay: null, // the contract's time delay, seconds
  version: null, // contract version
  guideRole: "borrower",
  face: "guide", // "guide": the explained page; "terminal": the dense keyboard view
  eventsFrom: null,
  busy: false,
  refreshing: false,
  borrowQuote: null, // { shares, max } for the borrow form
  principalEdited: false,
  offerEdited: false,
  termEdited: false,
  borrowSharesSet: false,
  updatedAt: null, // ledger time of the last complete refresh
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
/** A number written with a dot ("1.5"), with the decimal separator of the interface language. */
const decimalText = (text) => String(text).replace(".", numberStyle().decimal);

/** The terminal face: same state, same reads, same signing; its own screen. */
const terminal = createTerminal({
  S,
  $,
  esc,
  now,
  setHTML: (el, html) => setHTML(el, html),
  runTx: (el, context, action, message) => runTx(el, context, action, message),
  connect: () => connect(),
  refreshAll: (options) => refreshAll(options),
  setFace: (face) => setFace(face),
  fundLimits: () => fundLimits(),
  onboardCommand,
  setLanguage: (choice) => setLanguage(choice),
});

/**
 * Replaces an element's markup only when it changed, so focus and selection
 * survive refreshes. Figures marked data-k flash when they move (motion.js).
 */
function setHTML(el, html) {
  if (el._html === html) return;
  // Markup written in another language is not compared: only its separators differ, not its figures.
  const before = el._html === undefined || el._lang !== lang() ? null : snapshot(el);
  el._html = html;
  el._lang = lang();
  el.innerHTML = html;
  flashChanges(el, before);
}

/** The entrance class the first time `key` is shown (its animation plays once), "" afterwards. */
function firstShow(key) {
  S.shown ??= new Set();
  if (S.shown.has(key)) return "";
  S.shown.add(key);
  return key === "bar" ? " bar-enter" : " is-new";
}

const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;

function copyButton(text, label = t("Copy")) {
  return `<button type="button" class="btn btn-ghost btn-small" data-copy="${esc(text)}">${esc(label)}</button>`;
}

function commandBox(command) {
  return `<div class="command"><code>${esc(command)}</code>${copyButton(command)}</div>`;
}

// ---------------------------------------------------------------------------
// Transactions: one at a time, every state shown
// ---------------------------------------------------------------------------

function tracker(el) {
  const hashLink = (hash) => (hash ? ` ${link(S.chain.explorerTx(hash), t("Transaction {hash}…", { hash: hash.slice(0, 8) }))}` : "");
  return {
    update({ stage, text, hash }) {
      el.className = `tx tx-active tx-${stage}`;
      el.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${esc(text)}</span>${hashLink(hash)}`;
    },
    success(message, { hash, seconds }) {
      el.className = "tx tx-ok";
      el.innerHTML = `<span class="icon" aria-hidden="true">✓</span><span>${esc(message)} ${esc(t("Confirmed in {seconds} s.", { seconds: decimalText(seconds.toFixed(1)) }))}</span>${
        hash ? ` ${link(S.chain.explorerTx(hash), t("View on Stellar Expert"))}` : ""
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
  const track = tracker(el);
  try {
    const result = await action((status) => track.update(status));
    if (result?.hash) {
      track.success(message(result), result);
      toast(message(result), { tone: "ok", announce: false });
    }
    else track.note(message(result));
  } catch (error) {
    console.error(error);
    track.fail(error, typeof context === "function" ? context() : context);
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
  return `<div class="tile ${tone}"><p class="tile-label">${label}</p><p class="tile-value" data-k="tile:${label}">${value}</p><p class="tile-sub">${sub}</p></div>`;
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
        `<button type="button" role="tab" class="tab" id="tab-${r}" aria-selected="${r === S.guideRole}" aria-controls="guide-body" data-role="${r}">${esc(t(ROLE_TITLES[r]))}</button>`,
    ).join(""),
  );
  const g = roleGuide(S.guideRole, ctx);
  const list = (items) => `<ul class="guide-list">${items.map((i) => `<li>${esc(t(i))}</li>`).join("")}</ul>`;
  setHTML(
    body,
    `<p class="guide-intro">${esc(t(g.intro))}</p>
     <div class="guide-grid">
       <div><h3 class="sub">${esc(t("What you need"))}</h3>${list(g.need)}</div>
       <div><h3 class="sub">${esc(t("What you do"))}</h3><ol class="guide-list guide-steps">${g.steps.map((i) => `<li>${esc(t(i))}</li>`).join("")}</ol></div>
       <div><h3 class="sub">${esc(t("What you commit to, and what protects you"))}</h3>${list(g.terms)}</div>
     </div>`,
  );
  if (b) {
    let rows = null;
    try {
      rows = guideTerms({ dep: S.dep, board: b, maxTermSecs: ctx.maxTermSecs, delaySecs: ctx.delaySecs, version: S.version, paused: b.paused.value });
    } catch (error) {
      // A value the page cannot show leaves the terms as last drawn; the board goes on.
      console.warn("guide terms", error);
    }
    if (rows) setHTML(terms, rows.map(([label, value, note]) => `<div><dt>${esc(t(label))}</dt><dd>${esc(value)}${note ? `<span class="muted small"> ${esc(t(note))}</span>` : ""}</dd></div>`).join(""));
    $("guide-meta").textContent = S.dep.network === "testnet" ? t("terms read from the chain on testnet") : t("terms read from the chain");
  }
}

function renderBoard() {
  const b = S.board;
  const config = b.config.value;
  const state = b.state.value;
  const ts = now();

  const status = $("board-status");
  if (b.paused.value === true) {
    status.className = "pill pill-warn";
    status.textContent = t("Paused");
    status.title = t("New loans and offers are suspended. Repurchases still work.");
  } else if (state?.frozen) {
    status.className = "pill pill-warn";
    status.textContent = t("Fund frozen");
    status.title = t("The fund issuer suspended new loans on this fund.");
  } else if (b.paused.value === false && config) {
    status.className = "pill pill-ok";
    status.textContent = t("Open for loans");
    status.title = "";
  } else {
    status.className = "pill";
    status.textContent = t("Unknown");
  }

  const tiles = [];
  const navCurrency = S.dep.fund.navCurrency;
  const tooOld = `${esc(t("Too old to lend against."))} `;
  const since = (timestamp) => `<span data-since="${esc(String(timestamp))}"></span>`;
  // Each tile is drawn on its own: a value the page cannot show blanks its tile, never the board.
  const draw = (label, build) => {
    try {
      tiles.push(build());
    } catch (error) {
      console.warn("board tile", error);
      tiles.push(tile(label, "—", `<span class="text-error">${esc(t(UNSHOWABLE))}</span>`, "tile-warn"));
    }
  };
  draw(esc(t("Fund share NAV")), () => {
    if (!b.nav.value || !state) return tile(esc(t("Fund share NAV")), "—", b.nav.error ? errorLine(b.nav) : "");
    const old = config && ts - Number(b.nav.value.timestamp) > Number(config.nav_max_age_secs);
    return tile(
      esc(t("Fund share NAV")),
      `${formatUnits(b.nav.value.price, state.nav_decimals, { digits: 4 })} <span class="unit-inline">${navCurrency}</span>`,
      `${old ? tooOld : ""}${t("Published {age}", { age: since(b.nav.value.timestamp) })}`,
      old ? "tile-warn" : "",
    );
  });

  const leg = Array.isArray(config?.source) && config.source[0] === "Cross" ? config.source[1] : null;
  if (leg) {
    draw(`${S.dep.stablecoin.currency}/${navCurrency}`, () => {
      if (!b.fx.value || !state) return tile(`${S.dep.stablecoin.currency}/${navCurrency}`, "—", b.fx.error ? errorLine(b.fx) : esc(t("No rate")));
      const old = ts - Number(b.fx.value.timestamp) > Number(leg.max_age_secs);
      return tile(
        `${S.dep.stablecoin.currency}/${navCurrency}`,
        formatUnits(b.fx.value.price, state.fx_decimals, { digits: 4 }),
        `${old ? tooOld : ""}${t("Exchange rate, {age}", { age: since(b.fx.value.timestamp) })}`,
        old ? "tile-warn" : "",
      );
    });
  }

  if (b.quote.value || b.quote.error) {
    draw(esc(t("Share value in {code}", { code: code() })), () => {
      if (!b.quote.value) return tile(esc(t("Share value in {code}", { code: code() })), "—", errorLine(b.quote), "tile-warn");
      const q = b.quote.value;
      return tile(
        esc(t("Share value in {code}", { code: code() })),
        formatUnits(q.price, q.price_decimals, { digits: 4 }),
        esc(t("Lent against with a {haircut} haircut", { haircut: formatRate(q.haircut_bps) })),
      );
    });
  }

  if (config && state) {
    draw(esc(t("Lent against this fund")), () => {
      const used = BigInt(state.outstanding);
      const cap = BigInt(config.max_outstanding);
      const pct = cap > 0n ? Number((used * 1000n) / cap) / 10 : 0;
      return tile(
        esc(t("Lent against this fund")),
        `${formatAmount(used, SD(), "round")} <span class="unit-inline">${esc(t("of {cap}", { cap: `${formatAmount(cap, SD())} ${code()}` }))}</span>`,
        `<span class="bar${firstShow("bar")}" role="img" aria-label="${esc(t("{pct} percent of the fund cap used", { pct: decimalText(pct.toFixed(1)) }))}"><span style="width:${Math.min(pct, 100)}%"></span></span>${esc(
          t("Up to {amount} per loan", { amount: money(config.max_principal_per_repo) }),
        )}`,
      );
    });
  }
  setHTML($("tiles"), tiles.join(""));
  tick();
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
  const heads = [t("Fund share"), t("NAV in"), t("FX leg"), t("Haircut"), t("Max NAV age"), t("Lent")].map((h) => esc(h));
  const rows = funds.map((f) => {
    // Each row is drawn on its own: one fund's unreadable value blanks its row only.
    try {
      const cfg = f.config.value;
      const st = f.state.value;
      const source = Array.isArray(cfg?.source) ? cfg.source[0] : cfg?.source;
      const lent =
        cfg && st
          ? esc(t("{used} of {cap}", { used: formatAmount(BigInt(st.outstanding), SD(), "round"), cap: `${formatAmount(BigInt(cfg.max_outstanding), SD())} ${code()}` }))
          : "—";
      const leg = source === "Cross" ? esc(t("exchange-rate leg")) : source === "Direct" ? esc(t("none")) : "—";
      const maxAge = cfg ? `${decimalText(Number(cfg.nav_max_age_secs) / 3600)} h` : "—";
      return `<tr><td data-label="${heads[0]}">${esc(f.symbol)} <span class="muted small">${esc(f.name)}</span></td><td data-label="${heads[1]}">${esc(f.navCurrency)}</td><td data-label="${heads[2]}">${leg}</td><td data-label="${heads[3]}">${cfg ? formatRate(cfg.haircut_bps) : "—"}</td><td data-label="${heads[4]}">${maxAge}</td><td data-label="${heads[5]}">${lent}</td></tr>`;
    } catch (error) {
      console.warn("fund row", error);
      return `<tr><td data-label="${heads[0]}">${esc(f.symbol)} <span class="text-error small">${esc(t(UNSHOWABLE))}</span></td>${heads
        .slice(1)
        .map((h) => `<td data-label="${h}">—</td>`)
        .join("")}</tr>`;
    }
  });
  setHTML(
    out,
    `<h3 class="sub">${esc(t("Funds admitted"))}</h3>
     <p class="muted small">${esc(t("Each fund is admitted by the governor and its own issuer, with its own NAV feed and settings. The contract is the same for all of them."))}</p>
     <table class="table${firstShow("table:funds")}"><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`,
  );
}

function renderQuote(result, shares) {
  const out = $("quote-out");
  if (!shares || shares <= 0n) {
    setHTML(out, `<span class="muted">${esc(t("Enter a number of shares."))}</span>`);
  } else if (result?.value) {
    setHTML(out, t("{shares} can secure up to <strong>{amount}</strong>", { shares: esc(shareAmount(shares)), amount: esc(money(result.value.max_principal, "floor")) }));
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
    setHTML($("offers"), `<p class="muted">${esc(t("No offer has {code} available right now.", { code: code() }))}</p>`);
    return;
  }
  const label = { offer: esc(t("Offer")), available: esc(t("Available")), rate: esc(t("Rate")), term: esc(t("Longest term")) };
  const rows = offers
    .map(
      (o) => `<tr>
        <td data-label="${label.offer}"><span class="strong">#${o.id}</span>${o.sponsor ? ` <span class="badge" title="${esc(t("An independent lender the fund issuer designates"))}">${esc(t("Designated"))}</span>` : ""}
          <span class="muted small mono">${esc(shortAddress(o.lender))}</span>${S.wallet && o.lender === S.wallet.address ? ` <span class="badge badge-muted">${esc(t("You"))}</span>` : ""}</td>
        <td data-label="${label.available}" class="num">${esc(money(o.available, "floor"))}</td>
        <td data-label="${label.rate}" class="num">${esc(formatRate(o.rate_bps))} <span class="muted small">${esc(t("a year"))}</span></td>
        <td data-label="${label.term}" class="num">${esc(formatTerm(maxTermFor(o, S.maxTerm || o.max_term)))}</td>
      </tr>`,
    )
    .join("");
  setHTML(
    $("offers"),
    `<table class="table${firstShow("table:offers")}"><caption class="sr-only">${esc(t("Offers open to these fund shares, issuer first, then cheapest"))}</caption>
      <thead><tr><th scope="col">${label.offer}</th><th scope="col" class="num">${label.available}</th><th scope="col" class="num">${label.rate}</th><th scope="col" class="num">${label.term}</th></tr></thead>
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
      setHTML($("quote-out"), `<span class="text-error">${esc(t("Enter a number, up to {decimals} decimals.", { decimals: FD() }))}</span>`);
      return;
    }
    S.quoteShares = shares;
    if (shares === 0n) return renderQuote(null, 0n);
    setHTML($("quote-out"), `<span class="muted">${esc(t("Asking the contract…"))}</span>`);
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
    setHTML(chip, `<button type="button" class="btn btn-primary" id="connect">${esc(t("Connect Freighter"))}</button>`);
    return;
  }
  setHTML(
    chip,
    `<span class="addr mono" title="${esc(S.wallet.address)}"><span class="dot" aria-hidden="true"></span>${esc(shortAddress(S.wallet.address))}</span>
     <button type="button" class="btn btn-ghost btn-small" id="disconnect">${esc(t("Disconnect"))}</button>`,
  );
}

function step(done, title, body) {
  return `<li class="${done ? "done" : "todo"}"><span class="step-mark" aria-hidden="true">${done ? "✓" : ""}</span>
    <div><p class="step-title">${title}${done ? ` <span class="sr-only">${esc(t("(done)"))}</span>` : ""}</p>${done ? "" : body}</div></li>`;
}

function renderWallet() {
  renderWalletChip();
  const body = $("wallet-body");
  if (!S.wallet) {
    setHTML(
      body,
      `<p>${esc(t("Connect Freighter to borrow, repurchase or lend. The market above needs no wallet."))}</p>
       ${S.walletProblem ? `<p class="notice notice-error" role="alert">${esc(S.walletProblem)}</p>` : ""}
       <p class="muted small">${esc(t("Freighter must be set to Testnet. Your keys stay in Freighter: this page only asks it to sign."))}</p>`,
    );
    return;
  }
  const a = S.wallet.address;
  const b = S.balances;
  if (!b) {
    setHTML(body, `<p class="muted">${esc(t("Reading balances…"))}</p>`);
    return;
  }
  const funded = b.xlm !== null;
  const trust = b.stablecoin !== null;
  const ready = b.shares > 0n;
  const steps = [
    step(
      funded,
      esc(t("Test XLM for network fees")),
      `<p>${esc(t("This account does not exist on testnet yet."))}</p><button type="button" class="btn btn-secondary btn-small" data-write data-friendbot>${esc(t("Get test XLM"))}</button>`,
    ),
    step(
      trust,
      esc(t("Accept {code}", { code: code() })),
      `<p>${esc(t("Add a trustline so this account can hold {code}. Freighter asks you to sign.", { code: code() }))}</p><button type="button" class="btn btn-secondary btn-small" data-write data-trust ${
        funded ? "" : `data-blocked="1"`
      }>${esc(t("Add {code}", { code: code() }))}</button>`,
    ),
    step(
      ready || S.approved,
      esc(t("Test shares and tokens from the operator")),
      `<p>${esc(t("Only the operator keys can allowlist this wallet and mint test fund shares. Send them your address, or run this from a checkout that holds the demo keys:"))}</p>
       ${commandBox(onboardCommand(a))}
       <p class="muted small">${esc(t("To lend instead of borrow:"))}</p>${commandBox(onboardCommand(a, true))}`,
    ),
  ];
  const allDone = funded && trust && (ready || S.approved);
  setHTML(
    body,
    `<dl class="facts facts-wallet">
       <div><dt>${esc(t("Address"))}</dt><dd class="mono">${link(S.chain.explorerAccount(a), shortAddress(a))} ${copyButton(a, t("Copy address"))}</dd></div>
       <div><dt>XLM</dt><dd class="num">${b.xlm === null ? "—" : esc(formatAmount(b.xlm, 7))}</dd></div>
       <div><dt>${esc(code())}</dt><dd class="num">${trust ? esc(formatAmount(b.stablecoin, SD())) : `<span class="muted">${esc(t("No trustline"))}</span>`}</dd></div>
       <div><dt>${esc(sym())}</dt><dd class="num">${esc(formatAmount(b.shares, FD()))}</dd></div>
     </dl>
     ${
       allDone
         ? `<p class="muted small">${esc(t("Ready."))}${S.approved ? ` ${esc(t("This address is an approved lender."))}` : ""}</p>`
         : `<h3 class="sub">${esc(t("Get started"))}</h3><ol class="steps">${steps.join("")}</ol>`
     }`,
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
      disconnect(
        t("Freighter switched to {network}. This interface runs on Testnet only. Switch back, then connect again.", {
          network: change.network || t("another network"),
        }),
      );
    } else if (change.address && change.address !== S.wallet.address) {
      disconnect(t("Freighter switched to another account. Connect again to use it."));
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
  terminal.render();
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
    .map((o) => {
      const parts = [
        `#${o.id}${o.sponsor ? ` · ${t("Designated")}` : ""}`,
        formatRate(o.rate_bps),
        t("{amount} available", { amount: money(o.available, "floor") }),
        t("up to {hours} h", { hours: Math.floor(maxTermFor(o, S.maxTerm) / HOUR) }),
      ];
      return `<option value="${o.id}">${esc(parts.join(" · "))}</option>`;
    })
    .join("");
  setHTML(select, html || `<option value="">${esc(t("No offer available"))}</option>`);
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
  if (!S.wallet) message = t("Connect a wallet to borrow. The market above shows what your shares can secure.");
  else if (!S.balances) message = t("Reading your balances…");
  else if (S.balances.stablecoin === null) message = t("Add {code} to your wallet first, under Your wallet.", { code: code() });
  else if (S.balances.shares === 0n) message = t("This wallet holds no {sym} shares yet. Ask the operator to onboard it, under Your wallet.", { sym: sym() });
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
    setHelp("b-shares-help", t("Enter how many shares to lock."), true);
    valid = false;
  } else if (shares > S.balances.shares) {
    setHelp("b-shares-help", t("You hold {amount}.", { amount: shareAmount(S.balances.shares) }), true);
    valid = false;
  } else {
    setHelp("b-shares-help", t("You hold {amount}.", { amount: shareAmount(S.balances.shares) }));
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
    setHelp("b-principal-help", t("Enter an amount."), true);
    valid = false;
  } else if (q && principal > q.max) {
    setHelp("b-principal-help", t("This is more than the shares can secure. The maximum is {max}.", { max: money(q.max, "floor") }), true);
    valid = false;
  } else if (offer && principal > offer.available) {
    setHelp("b-principal-help", t("This offer holds {amount}. Pick another offer or borrow less.", { amount: money(offer.available, "floor") }), true);
    valid = false;
  } else {
    setHelp("b-principal-help", q ? t("These shares secure up to {max}. The suggestion is 90 % of that.", { max: money(q.max, "floor") }) : t("Valuing the shares…"));
  }

  const maxHours = offer ? Math.floor(maxTermFor(offer, S.maxTerm) / HOUR) : 0;
  $("b-term").max = String(maxHours || 1);
  if (maxHours && !S.termEdited && Number($("b-term").value) > maxHours) $("b-term").value = String(maxHours);
  const hours = Number($("b-term").value);
  if (!Number.isInteger(hours) || hours < 1 || (maxHours && hours > maxHours)) {
    setHelp("b-term-help", t("Choose 1 to {max} hours.", { max: maxHours }), true);
    valid = false;
  } else {
    setHelp("b-term-help", t("1 to {max} hours on this offer. The term is your deadline, not what you pay.", { max: maxHours }));
  }
  if (!offer) valid = false;

  const preview = [];
  if (offer && principal && hours >= 1) {
    const term = Math.min(hours, maxHours || hours) * HOUR;
    const atTerm = interest(principal, offer.rate_bps, term);
    const row = (label, value, strong = false) =>
      `<div><dt>${esc(label)}</dt><dd class="num">${strong ? `<strong>${esc(value)}</strong>` : esc(value)}</dd></div>`;
    preview.push(
      row(t("Rate"), t("{rate} a year, offer #{id}", { rate: formatRate(offer.rate_bps), id: offer.id })),
      row(t("Interest for the first hour"), exact(interest(principal, offer.rate_bps, HOUR))),
      row(t("Interest if repaid at term ({hours} h)", { hours }), exact(atTerm)),
      row(t("Interest for a 64-hour weekend"), exact(interest(principal, offer.rate_bps, WEEKEND_SECS))),
      row(t("To repay at term"), money(principal + atTerm, "ceil"), true),
      row(t("Term ends"), formatDateTime(now() + term)),
    );
  }
  setHTML($("b-preview"), preview.join("") || `<p class="muted">${esc(t("Fill in the form to see the cost."))}</p>`);

  const paused = S.board?.paused.value === true;
  const submit = $("b-submit");
  submit.dataset.blocked = valid && !paused ? "0" : "1";
  submit.textContent = paused ? t("New loans are paused") : valid ? t("Borrow {amount}", { amount: money(principal) }) : t("Borrow");
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
    term: t("1 to {max} hours", { max: order.maxHours }),
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
      return t("Repo #{id} opened: {amount} sent to your wallet.", { id: result.repoId, amount: money(order.principal) });
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
    setHTML(body, `<p class="muted">${esc(t("Connect a wallet to see your positions."))}</p>`);
    return;
  }
  const repos = [...S.mine.values()].sort((a, b) => b.id - a.id);
  const open = repos.filter((r) => r.status === "Open");
  const closed = repos.filter((r) => r.status !== "Open");
  meta.textContent = repos.length ? t("{open} open, {closed} closed", { open: open.length, closed: closed.length }) : "";
  if (!repos.length) {
    setHTML(body, `<p class="muted">${esc(t("No positions yet. Borrow above to open one."))}</p>`);
    return;
  }
  const ts = now();
  const balance = S.balances?.stablecoin ?? 0n;
  const nowLabel = esc(t("now"));
  const openingLink = (id) => (S.openings.get(id) ? link(S.chain.explorerTx(S.openings.get(id).txHash), t("Opening transaction")) : "");
  const cards = open.map((r) => {
    const due = S.dues.get(r.id);
    const total = due === undefined ? null : BigInt(r.principal) + due;
    const step = nextInterestStep(r.opened_at, ts);
    const matured = ts >= Number(r.maturity);
    const short = total !== null && balance < total ? total - balance : 0n;
    return `<article class="position${matured ? " position-late" : ""}${firstShow(`repo:${r.id}`)}" aria-labelledby="repo-${r.id}">
      <header><h3 id="repo-${r.id}">Repo #${r.id}</h3><span class="pill ${matured ? "pill-danger" : "pill-ok"}">${esc(matured ? t("Past term") : t("Open"))}</span></header>
      <dl class="facts">
        <div><dt>${esc(t("Borrowed"))}</dt><dd class="num">${esc(money(r.principal))}</dd></div>
        <div><dt>${esc(t("Shares locked"))}</dt><dd class="num">${esc(shareAmount(r.shares))}</dd></div>
        <div><dt>${esc(t("Rate"))}</dt><dd class="num">${esc(t("{rate} a year, offer #{id}", { rate: formatRate(r.rate_bps), id: r.offer_id }))}</dd></div>
        <div><dt>${esc(t("Due now"))}</dt><dd class="num"><strong>${total === null ? "—" : esc(money(total, "ceil"))}</strong>${
          due === undefined ? "" : `<span class="muted small"> ${esc(t("including {amount} interest", { amount: exact(due) }))}</span>`
        }</dd></div>
        <div><dt>${esc(t("Next hour of interest"))}</dt><dd class="num">${t("starts {when}", { when: `<span data-until="${step}" data-after="${nowLabel}"></span>` })}</dd></div>
        <div><dt>${esc(t("Term ends"))}</dt><dd class="num">${esc(formatDateTime(r.maturity))}, <span data-until="${r.maturity}" data-after="${esc(t("passed: the lender may now keep the shares"))}"></span></dd></div>
      </dl>
      ${timelineMarkup(r)}
      ${short > 0n ? `<p class="text-error small">${esc(t("You hold {balance}. You need {short} more to repurchase.", { balance: money(balance), short: money(short, "ceil") }))}</p>` : ""}
      <div class="actions">
        <button type="button" class="btn btn-primary" data-write data-repurchase="${r.id}" ${short > 0n ? `data-blocked="1"` : ""}>${esc(
          total === null ? t("Repurchase") : t("Repurchase for {amount}", { amount: money(total, "ceil") }),
        )}</button>
        ${openingLink(r.id)}
      </div>
    </article>`;
  });
  const history = closed
    .slice(0, 10)
    .map(
      (r) =>
        `<li><details class="tl-closed"><summary><span class="strong">Repo #${r.id}</span> <span class="pill ${r.status === "Repurchased" ? "pill-muted" : "pill-danger"}">${esc(
          r.status === "Repurchased" ? t("Repurchased") : t("Shares kept by lender"),
        )}</span> <span class="num">${esc(money(r.principal))}</span>${releaseNote(r.id)}</summary>${timelineMarkup(r)}</details></li>`,
    );
  setHTML(
    body,
    `${cards.join("") || `<p class="muted">${esc(t("No open position."))}</p>`}
     ${history.length ? `<h3 class="sub">${esc(t("Closed positions"))}</h3><ul class="history">${history.join("")}</ul>` : ""}`,
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
    (result) => closingLine("repurchase", { id, shares: shareAmount(repo.shares), deferred: result.deferred }),
  );
}

// ---------------------------------------------------------------------------
// Lend
// ---------------------------------------------------------------------------

function renderLend() {
  const gate = $("lend-gate");
  const form = $("lend-form");
  if (!S.wallet || !S.balances) {
    setHTML(gate, `<p class="muted">${esc(S.wallet ? t("Reading your balances…") : t("Connect a wallet to lend."))}</p>`);
    form.hidden = true;
    setHTML($("my-offers"), "");
    renderLent();
    return;
  }
  if (!S.approved) {
    setHTML(
      gate,
      `<p>${esc(t("This address is not an approved lender for the fund. The fund issuer approves lenders, so a seized position always goes to a known holder."))}</p>
       <p class="muted small">${esc(t("On testnet, the operator approves it and sends test {code} with:", { code: code() }))}</p>${commandBox(onboardCommand(S.wallet.address, true))}`,
    );
    form.hidden = true;
  } else {
    setHTML(gate, `<p class="muted">${esc(t("You are an approved lender. Repaid principal and interest flow back into your offer, where you withdraw them."))}</p>`);
    form.hidden = false;
    const hold = S.balances.stablecoin;
    setHelp("l-amount-help", hold === null ? t("Add {code} first.", { code: code() }) : t("You hold {amount}.", { amount: money(hold) }));
    const maxHours = Math.floor(S.maxTerm / HOUR);
    $("l-term").max = String(maxHours || 1);
    setHelp("l-term-help", maxHours ? t("1 to {max} hours, the contract's limit.", { max: maxHours }) : "");
  }
  renderMyOffers();
  renderLent();
}

function renderMyOffers() {
  if (!S.wallet) return setHTML($("my-offers"), "");
  const mine = S.offers.filter((o) => o.lender === S.wallet.address).sort((a, b) => b.id - a.id);
  if (!mine.length) {
    setHTML($("my-offers"), S.approved ? `<p class="muted">${esc(t("You have no offer yet."))}</p>` : "");
    return;
  }
  const label = {
    offer: esc(t("Offer")),
    available: esc(t("Available")),
    rate: esc(t("Rate")),
    term: esc(t("Longest term")),
    withdraw: esc(t("Withdraw")),
  };
  const rows = mine
    .map(
      (o) => `<tr>
        <td data-label="${label.offer}"><span class="strong">#${o.id}</span>${o.sponsor ? ` <span class="badge">${esc(t("Designated"))}</span>` : ""}</td>
        <td data-label="${label.available}" class="num">${esc(money(o.available))}</td>
        <td data-label="${label.rate}" class="num">${esc(formatRate(o.rate_bps))}</td>
        <td data-label="${label.term}" class="num">${esc(formatTerm(o.max_term))}</td>
        <td data-label="${label.withdraw}" class="num">${
          o.available > 0n
            ? `<div class="withdraw"><label class="sr-only" for="w-amount-${o.id}">${esc(t("Amount to withdraw from offer #{id}", { id: o.id }))}</label>
                <div class="input-unit input-small"><input id="w-amount-${o.id}" inputmode="decimal" autocomplete="off" value="${esc(
                  unitsToInput(o.available, SD()),
                )}" /><span class="unit">${esc(code())}</span></div>
                <button type="button" class="btn btn-secondary btn-small" data-write data-withdraw="${o.id}">${label.withdraw}</button></div>`
            : `<span class="muted small">${esc(t("Nothing to withdraw"))}</span>`
        }</td>
      </tr>`,
    )
    .join("");
  setHTML(
    $("my-offers"),
    `<h3 class="sub">${esc(t("Your offers"))}</h3><table class="table${firstShow("table:mine")}"><caption class="sr-only">${esc(t("Your offers"))}</caption>
      <thead><tr><th scope="col">${label.offer}</th><th scope="col" class="num">${label.available}</th><th scope="col" class="num">${label.rate}</th><th scope="col" class="num">${label.term}</th><th scope="col" class="num">${label.withdraw}</th></tr></thead>
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
    setHelp("l-amount-help", t("Enter an amount."), true);
    valid = false;
  } else if (S.balances?.stablecoin !== null && amount > S.balances.stablecoin) {
    setHelp("l-amount-help", t("You hold {amount}.", { amount: money(S.balances.stablecoin) }), true);
    valid = false;
  }
  if (rate === null || rate > 10_000n) {
    setHelp("l-rate-help", t("Enter a rate from 0 to 100 %, up to two decimals."), true);
    valid = false;
  } else {
    setHelp("l-rate-help", t("Up to two decimals. Charged per started hour."));
  }
  if (!Number.isInteger(hours) || hours < 1 || (maxHours && hours > maxHours)) {
    setHelp("l-term-help", t("Choose 1 to {max} hours.", { max: maxHours }), true);
    valid = false;
  }
  if (!valid) return;
  runTx(
    $("lend-tx"),
    { code: code(), term: t("1 to {max} hours", { max: maxHours }), action: "create_offer" },
    (onStatus) => S.chain.createOffer(S.wallet, { amount, rateBps: Number(rate), maxTerm: hours * HOUR }, onStatus),
    (result) => t("Offer #{id} created with {amount} at {rate}.", { id: result.offerId, amount: money(amount), rate: formatRate(Number(rate)) }),
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
    return showProblem($("lend-tx"), t("Offer #{id}: {error} It holds {amount}.", { id, error: t(checked.error), amount: money(offer.available) }));
  }
  const amount = checked.amount;
  runTx(
    $("lend-tx"),
    { code: code(), available: money(amount) },
    (onStatus) => S.chain.withdrawOffer(S.wallet, id, amount, onStatus),
    () => t("{amount} withdrawn from offer #{id}.", { amount: money(amount), id }),
  );
}

/** Repos funded by my offers: what borrowers owe me, and the default path. */
function renderLent() {
  const box = $("lent");
  if (!S.wallet || !S.lent.size) return setHTML(box, "");
  const ts = now();
  const nowLabel = esc(t("now"));
  const repos = [...S.lent.values()].sort((a, b) => b.id - a.id);
  const open = repos.filter((r) => r.status === "Open");
  const closed = repos.filter((r) => r.status !== "Open").slice(0, 10);
  const cards = open.map((r) => {
    const state = seizeState(r, ts);
    const due = S.dues.get(r.id);
    return `<article class="position${state.allowed ? " position-late" : ""}${firstShow(`lent:${r.id}`)}" aria-labelledby="lent-${r.id}">
      <header><h3 id="lent-${r.id}">Repo #${r.id}</h3><span class="pill ${state.allowed ? "pill-danger" : "pill-ok"}">${esc(
        state.allowed ? t("Past term, unpaid") : t("Open"),
      )}</span></header>
      <dl class="facts">
        <div><dt>${esc(t("Borrower"))}</dt><dd class="mono">${link(S.chain.explorerAccount(r.borrower), shortAddress(r.borrower))}</dd></div>
        <div><dt>${esc(t("Lent"))}</dt><dd class="num">${esc(t("{amount} at {rate}, offer #{id}", { amount: money(r.principal), rate: formatRate(r.rate_bps), id: r.offer_id }))}</dd></div>
        <div><dt>${esc(t("Owed now"))}</dt><dd class="num">${due === undefined ? "—" : esc(money(BigInt(r.principal) + due, "ceil"))}</dd></div>
        <div><dt>${esc(t("Collateral"))}</dt><dd class="num">${esc(shareAmount(r.shares))}</dd></div>
        <div><dt>${esc(t("Term ends"))}</dt><dd class="num">${esc(formatDateTime(r.maturity))}, <span data-until="${r.maturity}" data-after="${esc(t("passed"))}"></span></dd></div>
      </dl>
      ${timelineMarkup(r)}
      <p class="muted small">${esc(
        state.allowed
          ? t("The borrower has not repurchased by the term. You may take the shares now; the borrower can still repurchase until you do.")
          : t("If the borrower has not repurchased by the term, you may take the shares. Until then they stay locked in the contract."),
      )}</p>
      <div class="actions">
        <button type="button" class="btn ${state.allowed ? "btn-primary" : "btn-secondary"}" data-write data-seize="${r.id}" ${
          state.allowed ? "" : `data-blocked="1" aria-describedby="lent-wait-${r.id}"`
        }>${esc(t("Take the shares"))}</button>
        ${
          state.allowed
            ? ""
            : `<span class="muted small" id="lent-wait-${r.id}">${t("Available {when}", { when: `<span data-until="${r.maturity}" data-after="${nowLabel}"></span>` })}</span>`
        }
      </div>
    </article>`;
  });
  const history = closed.map(
    (r) =>
      `<li><details class="tl-closed"><summary><span class="strong">Repo #${r.id}</span> <span class="pill ${r.status === "Repurchased" ? "pill-muted" : "pill-danger"}">${esc(
        r.status === "Repurchased" ? t("Repaid") : t("Shares taken"),
      )}</span> <span class="num">${esc(money(r.principal))}</span>${releaseNote(r.id)}</summary>${timelineMarkup(r)}</details></li>`,
  );
  setHTML(
    box,
    `<h3 class="sub">${esc(t("Repos on your offers"))}</h3>${cards.join("") || `<p class="muted">${esc(t("No open repo on your offers."))}</p>`}
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
  const nowLabel = esc(t("now"));
  const items = steps.map((st) => {
    const time =
      st.at === null
        ? ""
        : st.state === "next"
          ? `${esc(formatDateTime(st.at))}, <span data-until="${st.at}" data-after="${nowLabel}"></span>`
          : esc(formatDateTime(st.at));
    const tx = st.tx ? link(S.chain.explorerTx(st.tx), t("transaction")) : "";
    return `<li class="tl-${st.state}"><div class="tl-head"><span class="tl-label">${esc(t(st.label))}</span>${time ? `<span class="tl-time">${time}</span>` : ""}${tx ? `<span class="small">${tx}</span>` : ""}</div><p class="tl-detail">${esc(t(st.detail))}</p></li>`;
  });
  return `<ol class="timeline" aria-label="${esc(t("Timeline of repo {id}", { id: repo.id }))}">${items.join("")}</ol>`;
}

/** Held-back shares on a closed repo: a note, and a Release button for the beneficiary. */
function releaseNote(id) {
  const pending = S.releases.get(id);
  if (!pending) return "";
  const mine = pending.to === S.wallet?.address;
  const status = (S.mine.get(id) ?? S.lent.get(id))?.status;
  return ` <span class="pill pill-danger">${esc(heldNote(status, shareAmount(pending.shares)))}</span>${
    mine ? ` <button type="button" class="btn btn-secondary" data-write data-release="${id}">${esc(t("Release"))}</button>` : ""
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
        ? t("Repo #{id}: {shares} delivered to your wallet.", { id, shares: shareAmount(pending?.shares ?? 0n) })
        : stillHeldLine((S.mine.get(id) ?? S.lent.get(id))?.status, id),
  );
}

function onSeize(id) {
  const repo = S.lent.get(id);
  if (!repo || !seizeState(repo, now()).allowed) return;
  runTx(
    $("lend-tx"),
    { action: "seize", when: formatDateTime(repo.maturity) },
    (onStatus) => S.chain.seize(S.wallet, id, onStatus),
    (result) => closingLine("seize", { id, shares: shareAmount(repo.shares), deferred: result.deferred }),
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
  // The terminal keeps its own view of every repo; the guided view's positions catch up when it returns.
  if (S.face !== "terminal") await refreshPositions();
}

/**
 * One pass over every view. `history` also fetches the indexer's export
 * again: on REF and when the page comes back into view, not on every 15 s
 * pass, since it changes only when the export is published. A request made
 * while a pass runs is kept for the next one.
 */
async function refreshAll({ history = false } = {}) {
  if (history) S.historyDue = true;
  if (S.refreshing || !S.chain) return;
  S.refreshing = true;
  const updated = $("board-updated");
  try {
    // An endpoint that answers but lags is left first, so the pass and its clock read a current ledger.
    await S.chain.checkHeights();
    await refreshBoard();
    if (S.historyDue) {
      S.historyDue = false;
      await loadHistory();
    }
    await refreshWallet();
    await terminal.refresh();
    S.updatedAt = now();
    renderUpdated();
    $("load-error").hidden = true;
  } catch (error) {
    console.error(error);
    updated.textContent = t("{error} Trying again in {seconds} s.", { error: describeError(error).text, seconds: REFRESH_MS / 1000 });
  } finally {
    S.refreshing = false;
  }
}

/** The board's "Updated … ago" line, after a complete refresh. */
function renderUpdated() {
  if (S.updatedAt === null) return;
  $("board-updated").innerHTML = t("Updated {age}", { age: `<span data-since="${S.updatedAt}">${esc(t("just now"))}</span>` });
}

function tick() {
  const ts = now();
  for (const el of document.querySelectorAll("[data-since]")) el.textContent = formatAge(el.dataset.since, ts);
  for (const el of document.querySelectorAll("[data-until]")) {
    const left = Number(el.dataset.until) - ts;
    el.textContent = left > 0 ? t("in {countdown}", { countdown: formatCountdown(left) }) : (el.dataset.after ?? t("now"));
  }
}

// ---------------------------------------------------------------------------
// Views: the guided page, or the terminal
// ---------------------------------------------------------------------------

/** Shows one face. The choice is kept in the URL (?view=terminal) and, when allowed, in local storage. */
function setFace(face, { persist = true, refresh = true } = {}) {
  const term = face === "terminal";
  S.face = term ? "terminal" : "guide";
  document.body.classList.toggle("face-terminal", term);
  $("main").hidden = term;
  $("terminal").hidden = !term;
  for (const button of document.querySelectorAll("[data-face]")) button.setAttribute("aria-pressed", String(button.dataset.face === S.face));
  document.querySelector(".skip")?.setAttribute("href", term ? "#t-input" : "#main");
  if (persist) {
    try {
      localStorage.setItem(FACE_KEY, S.face);
    } catch {
      // Storage blocked: the URL still carries the choice.
    }
    const url = new URL(window.location.href);
    if (term) url.searchParams.set("view", "terminal");
    else url.searchParams.delete("view");
    window.history.replaceState(null, "", url);
  }
  if (term) terminal.mount();
  else {
    terminal.unmount();
    if (refresh) refreshAll();
  }
}

/** The face to open with: the URL first, then the remembered choice, then the guided page. */
function initialFace() {
  const asked = new URLSearchParams(window.location.search).get("view");
  if (asked === "terminal" || asked === "guide") return asked;
  try {
    return localStorage.getItem(FACE_KEY) === "terminal" ? "terminal" : "guide";
  } catch {
    return "guide";
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
    $(`tab-${S.guideRole}`)?.focus();
  });
  document.addEventListener("click", async (event) => {
    const target = event.target.closest("button");
    if (!target) return;
    if (target.id === "connect") return connect();
    if (target.id === "disconnect") return disconnect();
    if (target.id === "refresh") return refreshAll({ history: true });
    if (target.dataset.face) return transition(() => setFace(target.dataset.face));
    if (target.dataset.gotoFace) {
      window.scrollTo({ top: 0 });
      return transition(() => setFace(target.dataset.gotoFace));
    }
    if (target.dataset.lang) return transition(() => setLanguage(target.dataset.lang));
    if (target.dataset.copy !== undefined) {
      try {
        await navigator.clipboard.writeText(target.dataset.copy);
        const label = target.textContent;
        target.textContent = t("Copied");
        setTimeout(() => (target.textContent = label), 1500);
      } catch {
        window.prompt(t("Copy this:"), target.dataset.copy);
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
      return runTx($("wallet-tx"), { code: code() }, (onStatus) => S.chain.addTrustline(S.wallet, onStatus), () => t("{code} added to your wallet.", { code: code() }));
    }
    if (target.dataset.friendbot !== undefined) {
      return runTx(
        $("wallet-tx"),
        {},
        async (onStatus) => {
          onStatus({ stage: "pending", text: t("Asking the testnet faucet for XLM.") });
          await S.chain.friendbot(S.wallet.address);
          return null;
        },
        () => t("Test XLM received."),
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
    if (!document.hidden) refreshAll({ history: true });
  });
}

/**
 * The indexer's export, when it sits next to the page: it dates and links the
 * closing steps of the timelines. Optional. "no-cache" revalidates it with
 * the host, which answers 304 while it is unchanged.
 */
async function loadHistory() {
  try {
    const response = await fetch("./history.json", { cache: "no-cache" });
    if (!response.ok) return;
    const h = await response.json();
    if (Array.isArray(h?.events)) S.history = { generatedAt: h.generatedAt, events: h.events };
  } catch {
    // No export: the timelines show what the chain alone tells.
  }
}

/** The footer: the contracts behind the page, each linked to the explorer, the endpoint in use and who sees the visitor's reads. */
function renderFoot() {
  const C = S.dep.contracts;
  $("foot").innerHTML =
    t(
      "Open Window contract {contract} on Stellar {network}. Fund shares {shares}, {code} {stablecoin}. Every figure is read from the chain; nothing here has real value. Apache-2.0.",
      {
        contract: link(S.chain.explorerAccount(C.openWindow), shortAddress(C.openWindow)),
        network: esc(S.dep.network),
        shares: link(S.chain.explorerAccount(C.fundShares), shortAddress(C.fundShares)),
        code: esc(code()),
        stablecoin: link(S.chain.explorerAccount(C.stablecoin), shortAddress(C.stablecoin)),
      },
    ) +
    ` <span class="rpc-note">${esc(t("Chain read through {host}.", { host: S.chain.rpcInfo().host }))}</span>` +
    `<span class="rpc-note">${esc(privacyLine(S.dep, "market"))}</span>`;
}

/**
 * Switches the interface language and redraws every view that holds text:
 * the static page, the footer, the guide, the board, the wallet, borrow,
 * positions and lend cards, and the terminal. The choice is kept on the
 * device and in the URL unless `persist` is false.
 */
function setLanguage(choice, { persist = true } = {}) {
  setLang(choice);
  if (persist) persistLang();
  applyStatic();
  markLangButtons();
  if (!S.dep || !S.chain) return;
  renderFoot();
  if (S.board) renderBoard();
  else renderGuide();
  renderAllWalletViews();
  renderUpdated();
  tick();
}

async function start() {
  // The language comes first: every text below, the load error included, is written in it.
  bootLang();
  // Inside another site's frame the page does nothing: no read, no wallet, no button wired.
  if (refusesFrame(window)) return refuseFrame(document);
  applyStatic();
  markLangButtons();
  initMotion();
  setLoading(true);
  try {
    const response = await fetch("./deployment.testnet.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    S.dep = checkDeployment(await response.json());
  } catch (error) {
    const box = $("load-error");
    box.hidden = false;
    setLoading(false);
    $("tiles").replaceChildren();
    box.textContent = t("The deployment file could not be loaded ({reason}). The interface needs deployment.testnet.json next to this page.", {
      reason: error.message,
    });
    return;
  }
  S.chain = new Chain(S.dep);
  // A slow or failing RPC is left for the next endpoint; both views say where the data now comes from.
  let rpcToastAt = -Infinity;
  S.chain.onRpcChange = (change) => {
    renderFoot();
    terminal.rpcChanged(change);
    if (S.face === "terminal" || Date.now() - rpcToastAt < REFRESH_MS) return;
    rpcToastAt = Date.now();
    toast(rpcChangeText(change), { tone: change.reason === "level" ? "info" : "warn" });
  };
  // The terminal shows at once and fills as its own reads land; the guided
  // page waits for the instance settings below.
  if (initialFace() === "terminal") setFace("terminal", { persist: false });
  wire();
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
  renderFoot();

  renderAllWalletViews();
  if (S.face !== "terminal") setFace(initialFace(), { persist: false, refresh: false });
  await refreshAll();
  setLoading(false);
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
