// The terminal face: a dense, keyboard-first screen for desk users, in the
// spirit of a market terminal. A command line where Enter is GO, a band of
// live facts, the offer book, a ticket, the positions blotter, the funds and
// the tape. It reads the state main.js keeps, adds the reads only it needs
// (every fund's feeds, the market's repos, pending changes, contract events),
// and signs through the same chain functions as the guided view: nothing
// here writes to the chain on its own.

import { sv } from "./chain.js";
import { COMMANDS, NOTATION, completions, parseCommand } from "./command.js";
import {
  bandItems,
  bookRows,
  compactDuration,
  fundRows,
  lendTicket,
  mergeEvents,
  openTicket,
  positionRows,
  positionTotals,
  quoteView,
  releaseTicket,
  repurchaseTicket,
  seizeTicket,
  tapeLine,
  withdrawTicket,
} from "./blotter.js";
import { describeError } from "./errors.js";
import { formatAmount, formatRate, formatUnits, shortAddress } from "./format.js";
import { HOUR, nextInterestStep } from "./terms.js";

const SLOW_EVERY = 4; // pending changes and layout version: one refresh in four, about a minute
const CONSOLE_LINES = 8;
const TAPE_LINES = 40;
const CLOSED_ROWS = 12;
const HISTORY_KEY = "openwindow.terminal.history";

/**
 * `ctx` comes from main.js: `{ S, $, esc, now, setHTML, runTx, connect,
 * refreshAll, setFace, fundLimits, onboardCommand }`.
 */
export function createTerminal(ctx) {
  const { S, $, esc, now, setHTML } = ctx;
  const T = {
    active: false,
    refreshing: false,
    again: false,
    refreshes: 0,
    updatedAt: null,
    feeds: new Map(),
    pending: null,
    schema: null,
    market: { repos: new Map(), next: 1, dues: new Map(), releases: new Map(), toCheck: new Set(), loaded: false },
    tape: { events: [], nextLedger: null, error: null },
    scope: "auto",
    ticket: null,
    quote: null,
    log: [],
    seq: 0,
    history: [],
    historyAt: -1,
    clock: null,
    focused: null,
    helpMode: false,
    wired: false,
  };

  // -------------------------------------------------------------------------
  // Names and numbers of this deployment
  // -------------------------------------------------------------------------

  const sd = () => S.dep.stablecoin.decimals;
  const fd = () => S.dep.fund.decimals;
  const code = () => S.dep.stablecoin.code;
  const sym = () => S.dep.fund.symbol;
  const iface = () => S.chain.fund;
  const wallet = () => S.wallet?.address ?? null;
  const funds = () =>
    S.dep.funds?.length
      ? S.dep.funds
      : [{ symbol: S.dep.fund.symbol, name: S.dep.fund.name, navCurrency: S.dep.fund.navCurrency, shares: S.dep.contracts.fundShares }];
  const symbolOf = (address) => funds().find((f) => f.shares === address)?.symbol ?? shortAddress(address ?? "");
  const codeOf = (address) => (S.dep.stablecoins ?? []).find((c) => c.contract === address)?.code ?? code();
  const money = (units, rounding) => `${formatAmount(units, sd(), rounding)} ${code()}`;
  const shareText = (units, symbol = sym()) => `${formatAmount(units, fd())} ${symbol}`;
  const tone = (t) => (t ? ` t-${t}` : "");
  const sentence = (text) => (/[.!?]$/.test(String(text).trim()) ? String(text).trim() : `${String(text).trim()}.`);
  const offerCoin = (id) => (S.offers ?? []).find((o) => o.id === id)?.stablecoin ?? null;
  // The book is known once the board has returned offers at least once;
  // before that, an empty book or a missing offer means "not read yet".
  const bookKnown = () => {
    if (S.board?.offers?.value) T.bookSeen = true;
    return Boolean(T.bookSeen);
  };
  const BOOK_UNREAD = "The offer book is still being read from the chain. Try again in a moment, or REF to read it now.";
  const coinSuffix = (address) => (address && codeOf(address) !== code() ? ` <span class="t-dim">${esc(codeOf(address))}</span>` : "");
  const txLink = (hash) =>
    hash
      ? `<a class="t-tx" href="${esc(S.chain.explorerTx(hash))}" target="_blank" rel="noopener" title="Transaction ${esc(hash)}">${esc(hash.slice(0, 6))}</a>`
      : "";

  // -------------------------------------------------------------------------
  // Console and command history
  // -------------------------------------------------------------------------

  function say(kind, text) {
    T.seq += 1;
    T.log.push({ seq: T.seq, kind, text });
    T.log = T.log.slice(-CONSOLE_LINES * 3);
    renderConsole();
  }

  function loadHistory() {
    try {
      const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
      if (Array.isArray(saved)) T.history = saved.filter((x) => typeof x === "string").slice(-30);
    } catch {
      // Storage blocked or unreadable: the history lives for this page only.
    }
  }

  function remember(line) {
    if (T.history[T.history.length - 1] !== line) T.history.push(line);
    T.history = T.history.slice(-30);
    T.historyAt = -1;
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(T.history));
    } catch {
      // ignore
    }
  }

  // -------------------------------------------------------------------------
  // Reads only the terminal needs
  // -------------------------------------------------------------------------

  async function refreshFeeds() {
    const list = (S.board?.funds ?? []).filter((f) => f.config?.value);
    const results = await Promise.all(list.map((f) => S.chain.feeds(f.shares, f.config.value).then((r) => [f.shares, r])));
    T.feeds = new Map(results);
  }

  async function refreshMarket() {
    const m = T.market;
    const fresh = await S.chain.repos(m.next);
    for (const r of fresh) {
      m.repos.set(r.id, r);
      m.next = Math.max(m.next, r.id + 1);
      if (r.status !== "Open") m.toCheck.add(r.id);
    }
    const freshIds = new Set(fresh.map((r) => r.id));
    const stale = [...m.repos.values()].filter((r) => r.status === "Open" && !freshIds.has(r.id));
    for (const r of await Promise.all(stale.map((x) => S.chain.repo(x.id).catch(() => null)))) {
      if (!r) continue;
      if (r.status !== "Open") m.toCheck.add(r.id);
      m.repos.set(r.id, r);
    }
    const open = [...m.repos.values()].filter((r) => r.status === "Open");
    await Promise.all(
      open.map(async (r) => {
        try {
          m.dues.set(r.id, await S.chain.repoDue(r.id));
        } catch {
          m.dues.delete(r.id);
        }
      }),
    );
    for (const id of [...m.dues.keys()]) if (m.repos.get(id)?.status !== "Open") m.dues.delete(id);
    // Shares a token held back: checked once when a repo closes, then while they wait.
    const ids = [...new Set([...m.toCheck, ...m.releases.keys()])];
    await Promise.all(
      ids.map(async (id) => {
        try {
          const pending = await S.chain.pendingRelease(id);
          if (pending) m.releases.set(id, pending);
          else m.releases.delete(id);
          m.toCheck.delete(id);
        } catch {
          // Retried on the next refresh.
        }
      }),
    );
    m.loaded = true;
  }

  async function refreshTape() {
    try {
      const { events, nextLedger } = await S.chain.contractEvents(T.tape.nextLedger);
      T.tape.events = mergeEvents([S.history?.events ?? [], T.tape.events, events], 300);
      T.tape.nextLedger = nextLedger;
      T.tape.error = null;
    } catch (error) {
      T.tape.events = mergeEvents([S.history?.events ?? [], T.tape.events], 300);
      T.tape.error = describeError(error).text;
    }
  }

  async function refreshPending() {
    const result = await S.chain.pendingChanges(funds());
    T.pending = result;
    if (result.schema?.value !== undefined && result.schema.value !== null) T.schema = Number(result.schema.value);
  }

  /** Terminal reads; main.js calls it after its own refresh. */
  async function refresh({ force = false } = {}) {
    if (!T.active || !S.chain) return;
    if (T.refreshing) {
      // A request while a pass runs (the board just arrived, a write just landed) runs once more right after it.
      T.again = true;
      return;
    }
    T.refreshing = true;
    try {
      const tasks = [refreshFeeds(), refreshMarket(), refreshTape()];
      if (force || T.refreshes % SLOW_EVERY === 0) tasks.push(refreshPending());
      T.refreshes += 1;
      const results = await Promise.allSettled(tasks);
      for (const r of results) if (r.status === "rejected") console.warn("terminal read", r.reason);
      T.updatedAt = now();
    } finally {
      T.refreshing = false;
      render();
    }
    if (T.again) {
      T.again = false;
      await refresh();
    }
  }

  // -------------------------------------------------------------------------
  // Derived views
  // -------------------------------------------------------------------------

  function feedsWithBoard() {
    const feeds = new Map(T.feeds);
    if (S.board && !feeds.has(iface())) feeds.set(iface(), { nav: S.board.nav, fx: S.board.fx });
    return feeds;
  }

  function pendingItems() {
    const p = T.pending;
    if (!p) return null;
    const items = [];
    const add = (label, r) => {
      if (r?.value) items.push({ label, eta: r.value.eta !== undefined ? Number(r.value.eta) : null });
    };
    add("UPGRADE", p.upgrade);
    add("GOVERNOR", p.admin);
    add("GUARDIAN", p.guardian);
    add("ENVELOPE", p.envelope);
    add("TERM", p.maxTerm);
    add(`CAP ${S.dep.stablecoin.currency}`, p.cap);
    for (const f of p.funds ?? []) add(`FUND ${f.symbol}`, f.change);
    return items;
  }

  function scopeOf() {
    if (T.scope === "auto") return wallet() ? "me" : "all";
    if (T.scope === "me" && !wallet()) return "all";
    return T.scope;
  }

  function scopedRepos() {
    const scope = scopeOf();
    const all = [...T.market.repos.values()];
    if (scope === "all") return all;
    const who = scope === "me" ? wallet() : scope;
    return all.filter((r) => r.borrower === who || r.lender === who);
  }

  function scopeLabel() {
    const scope = scopeOf();
    if (scope === "all") return "ALL MARKET";
    if (scope === "me") return `MINE ${shortAddress(wallet())}`;
    return `WATCH ${shortAddress(scope)}`;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  function renderBand() {
    const rows = fundRows(S.board?.funds ?? [], { feeds: feedsWithBoard(), now: now(), iface: iface() });
    const openRepos = [...T.market.repos.values()].filter((r) => r.status === "Open");
    const items = bandItems({
      network: S.dep.network,
      paused: S.board?.paused?.value ?? null,
      version: S.version,
      schema: T.schema,
      delay: S.delay,
      funds: rows,
      openInterest: T.market.loaded ? { count: openRepos.length, principal: openRepos.reduce((s, r) => s + BigInt(r.principal), 0n) } : null,
      pending: T.pending ? pendingItems().length : null,
      sd: sd(),
      code: code(),
    });
    const clock = `<span class="tb-item"><span class="tb-k">UTC</span> <span class="tb-v" data-clock>${clockText()}</span></span>`;
    const html = items
      .map(
        (i) =>
          `<span class="tb-item"${i.title ? ` title="${esc(i.title)}"` : ""}><span class="tb-k">${esc(i.label)}</span>${
            i.value ? ` <span class="tb-v${tone(i.tone)}">${esc(i.value)}</span>` : ""
          }</span>`,
      )
      .join("");
    setHTML($("t-band"), clock + html);
  }

  function clockText() {
    return new Date(now() * 1000).toISOString().slice(11, 19);
  }

  /**
   * The console changes line by line: lines leaving the window are removed,
   * new ones appended, the others left in place, so a screen reader reading
   * the log announces only what is new.
   */
  function renderConsole() {
    const box = $("t-console");
    if (!box) return;
    box.classList.toggle("is-help", T.helpMode);
    const lines = T.helpMode ? T.log : T.log.slice(-CONSOLE_LINES);
    if (!lines.length) {
      if (!box.querySelector('[data-seq="hint"]')) {
        const hint = document.createElement("p");
        hint.className = "tc tc-out";
        hint.dataset.seq = "hint";
        hint.textContent = "Type a command and press Enter, the GO key. HELP lists every command. Q 1000 values 1,000 shares.";
        box.replaceChildren(hint);
      }
      return;
    }
    const keep = new Set(lines.map((l) => String(l.seq)));
    for (const child of [...box.children]) if (!keep.has(child.dataset.seq ?? "")) child.remove();
    const present = new Set([...box.children].map((c) => c.dataset.seq));
    for (const l of lines) {
      if (present.has(String(l.seq))) continue;
      const p = document.createElement("p");
      p.className = `tc tc-${l.kind}`;
      p.dataset.seq = String(l.seq);
      p.textContent = l.text;
      box.appendChild(p);
    }
    box.scrollTop = box.scrollHeight;
  }

  function renderBook() {
    const rows = bookRows(S.offers, { funds: funds(), fund: iface(), wallet: wallet(), maxTerm: S.maxTerm });
    const best = rows.find((r) => r.takesFund && !r.mine)?.id ?? null;
    const known = bookKnown();
    $("t-book-meta").textContent = known ? `${rows.length} offer${rows.length === 1 ? "" : "s"} with funds · best rate first` : "reading the chain";
    if (!rows.length) {
      setHTML($("t-book"), `<p class="t-empty">${known ? "No offer has money available." : "Reading the offer book…"}</p>`);
      return;
    }
    const body = rows
      .map((r) => {
        const fill = r.mine ? `W ${r.id} ` : r.takesFund ? `O ${r.id} 1K 64` : null;
        const flags = [r.id === best ? `<span class="t-flag t-ok">BEST</span>` : "", r.designated ? `<span class="t-flag t-amber">DSG</span>` : "", r.mine ? `<span class="t-flag t-id">YOU</span>` : ""].join("");
        const coin = codeOf(offerCoin(r.id));
        return `<tr>
          <td>${fill ? `<button type="button" class="t-pick" data-fill="${esc(fill)}" title="${esc(fill.trim())}">#${r.id}</button>` : `#${r.id}`}</td>
          <td class="n${r.id === best ? " t-ok" : ""}">${esc(formatRate(r.rateBps))}</td>
          <td class="n">${esc(formatAmount(r.available, sd(), "floor"))}${coin === code() ? "" : ` <span class="t-dim">${esc(coin)}</span>`}</td>
          <td class="n">${Math.floor(r.termSecs / HOUR)}h</td>
          <td>${esc(r.funds.join(" "))}</td>
          <td>${flags}</td>
          <td class="t-dim">${esc(shortAddress(r.lender))}</td>
        </tr>`;
      })
      .join("");
    setHTML(
      $("t-book"),
      `<table class="tt"><caption class="sr-only">Offer book, best rate first</caption>
        <thead><tr><th scope="col">OFFER</th><th scope="col" class="n">RATE</th><th scope="col" class="n">AVAILABLE</th><th scope="col" class="n">TERM</th><th scope="col">FUNDS</th><th scope="col">FLAGS</th><th scope="col">LENDER</th></tr></thead>
        <tbody>${body}</tbody></table>`,
    );
  }

  function renderTicket() {
    const box = $("t-ticket");
    const view = T.ticket?.view ?? T.quote;
    $("t-ticket-title").textContent = view ? view.title : "TICKET";
    if (!view) {
      setHTML(
        box,
        `<div class="t-start">
          <p>Start here:</p>
          <p><kbd>Q 1000</kbd> values 1,000 ${esc(sym())} shares.</p>
          <p><kbd>O &lt;offer&gt; &lt;shares&gt; &lt;term&gt;</kbd> prepares a loan: <kbd>O 1 1K 64</kbd>.</p>
          <p><kbd>R &lt;repo&gt;</kbd> repurchases, <kbd>L 10K 3.25 168</kbd> lends.</p>
          <p class="t-dim">A ticket shows every number and check before anything is signed. Enter (GO) signs, Esc cancels.</p>
        </div>`,
      );
      return;
    }
    const rows = view.rows
      .map(([label, value, style]) => `<dt>${esc(label)}</dt><dd${style === "strong" ? ` class="strong"` : ""}>${esc(value)}</dd>`)
      .join("");
    const checks = view.checks
      .map((c) => `<li class="${c.ok ? "ok" : c.block ? "fail" : "warn"}">${esc(c.text)}</li>`)
      .join("");
    let action = "";
    if (T.ticket) {
      if (T.ticket.state === "sending") action = `<p class="t-act t-warn">Signing and sending…</p>`;
      else if (view.blocking) action = `<p class="t-act t-bad">Blocked: fix the line marked ✗, or CANCEL.</p>`;
      else if (!wallet()) action = `<p class="t-act t-warn">CONN, then GO to sign.</p>`;
      else action = `<p class="t-act"><span class="t-key t-key-go">GO</span> Enter to sign in Freighter · <span class="t-key t-key-cancel">CANCEL</span> Esc</p>`;
    }
    setHTML(
      box,
      `<dl class="t-dl">${rows}</dl>${checks ? `<ul class="t-checks">${checks}</ul>` : ""}${view.note ? `<p class="t-note">${esc(view.note)}</p>` : ""}${action}`,
    );
  }

  function renderPositions() {
    const scope = scopeOf();
    const rows = positionRows(scopedRepos(), {
      now: now(),
      dues: T.market.dues,
      releases: T.market.releases,
      wallet: wallet(),
      viewer: scope === "all" ? null : scope === "me" ? wallet() : scope,
      funds: funds(),
    });
    const open = rows.filter((r) => r.state === "OPEN" || r.state === "LATE");
    const closed = rows.filter((r) => !(r.state === "OPEN" || r.state === "LATE")).slice(0, CLOSED_ROWS);
    const totals = positionTotals(rows);
    $("t-pos-meta").textContent = `${scopeLabel()} · ${totals.open} open${totals.late ? `, ${totals.late} past term` : ""}`;
    if (!T.market.loaded) {
      setHTML($("t-pos"), `<p class="t-empty">Reading the repos…</p>`);
      return;
    }
    if (!rows.length) {
      setHTML(
        $("t-pos"),
        `<p class="t-empty">${scopeOf() === "all" ? "No repo on this instance yet." : "No repo for this address."}${wallet() ? "" : " POS ALL shows the whole market; CONN connects a wallet."}</p>`,
      );
      return;
    }
    const stateTone = { OPEN: "ok", LATE: "bad", REPAID: "dim", SEIZED: "warn", HELD: "warn" };
    const line = (r) => `<tr>
        <td>${r.action ? `<button type="button" class="t-pick" data-fill="${esc(r.action)}" title="${esc(r.action)}">#${r.id}</button>` : `#${r.id}`}</td>
        <td class="t-id">${esc(r.side || "—")}</td>
        <td>${esc(r.fund)}</td>
        <td class="n">${esc(formatAmount(r.principal, sd()))}${coinSuffix(r.stablecoin)}</td>
        <td class="n">${esc(formatRate(r.rateBps))}</td>
        <td class="n">${r.due === null ? (r.held ? esc(shareText(BigInt(r.held.shares), r.fund)) : "—") : esc(formatAmount(r.due, sd(), "ceil"))}</td>
        <td class="n">${r.hours === null ? "—" : r.hours}</td>
        <td class="n">${r.state === "OPEN" ? `<span data-cd="${r.maturity}" data-cd-after="PAST">${esc(compactDuration(r.until))}</span>` : r.state === "LATE" ? "PAST" : "—"}</td>
        <td class="t-${stateTone[r.state] ?? "dim"}">${r.state}</td>
        <td class="t-dim">${esc(shortAddress(r.borrower))}</td>
      </tr>`;
    const total = `<tr class="t-total"><td colspan="3">OPEN ${totals.open}</td><td class="n">${esc(formatAmount(totals.principal, sd()))}</td><td></td><td class="n">${
      totals.due === null ? "—" : esc(formatAmount(totals.due, sd(), "ceil"))
    }</td><td colspan="4"></td></tr>`;
    setHTML(
      $("t-pos"),
      `<table class="tt"><caption class="sr-only">Positions: ${esc(scopeLabel())}</caption>
        <thead><tr><th scope="col">REPO</th><th scope="col">SIDE</th><th scope="col">FUND</th><th scope="col" class="n">PRINCIPAL</th><th scope="col" class="n">RATE</th><th scope="col" class="n">DUE NOW</th><th scope="col" class="n">HRS</th><th scope="col" class="n">TERM IN</th><th scope="col">STATE</th><th scope="col">BORROWER</th></tr></thead>
        <tbody>${open.map(line).join("")}${open.length ? total : ""}${closed.map(line).join("")}</tbody></table>`,
    );
  }

  function renderFunds() {
    const rows = fundRows(S.board?.funds ?? [], { feeds: feedsWithBoard(), now: now(), iface: iface() });
    $("t-funds-meta").textContent = `${rows.length} admitted · ◆ this screen's fund`;
    if (!rows.length) {
      setHTML($("t-funds"), `<p class="t-empty">Reading the funds…</p>`);
      return;
    }
    const stateTone = { OPEN: "ok", FROZEN: "warn", STALE: "bad", "FX STALE": "bad" };
    const body = rows
      .map(
        (f) => `<tr>
          <td><button type="button" class="t-pick" data-fill="${esc(`Q 1K ${f.symbol}`)}" title="${esc(`${f.name}: Q 1K ${f.symbol}`)}">${esc(f.symbol)}</button>${f.iface ? `<span class="t-amber" title="The fund this screen borrows against">◆</span>` : ""} <span class="t-dim" title="${f.token === "SAC" ? "Classic Stellar asset held through the Stellar Asset Contract" : "SEP-41 share token"}">${f.token === "SAC" ? "SAC" : "41"}</span></td>
          <td class="n" title="NAV in ${esc(f.navCurrency)}">${f.nav === null ? "—" : esc(formatUnits(f.nav, f.navDecimals, { digits: 4 }))} <span class="t-dim">${esc(f.navCurrency)}</span></td>
          <td class="n${tone(f.navTone)}" title="Age of the NAV; the contract refuses it beyond ${f.navMaxAge === null ? "its bound" : esc(compactDuration(f.navMaxAge))}">${f.navAge === null ? "—" : esc(compactDuration(f.navAge))}</td>
          <td class="n${tone(f.fxTone)}" title="${f.source === "CROSS" ? `Exchange rate, ${f.fxAge === null ? "unread" : `${esc(compactDuration(f.fxAge))} old`}, bound ${f.fxMaxAge === null ? "?" : esc(compactDuration(f.fxMaxAge))}` : "NAV in the loan currency: no exchange-rate leg"}">${f.source === "CROSS" ? (f.fx === null ? "—" : esc(formatUnits(f.fx, f.fxDecimals, { digits: 4 }))) : "—"}</td>
          <td class="n" title="${f.fxHaircutBps ? `NAV haircut plus exchange-rate haircut ${esc(formatRate(f.fxHaircutBps))}` : "NAV haircut"}">${f.haircutBps === null ? "—" : esc(formatRate(f.haircutBps + (f.fxHaircutBps ?? 0)))}</td>
          <td class="n" title="${f.outstanding === null ? "" : `${esc(formatAmount(f.outstanding, sd(), "round"))} of ${f.cap === null ? "?" : esc(formatAmount(f.cap, sd()))} lent`}">${f.usedPct === null ? "—" : `${f.usedPct.toFixed(1)} %`}</td>
          <td class="t-${stateTone[f.state] ?? "dim"}">${esc(f.state)}</td>
        </tr>`,
      )
      .join("");
    setHTML(
      $("t-funds"),
      `<table class="tt"><caption class="sr-only">Admitted funds</caption>
        <thead><tr><th scope="col">FUND</th><th scope="col" class="n">NAV</th><th scope="col" class="n">AGE</th><th scope="col" class="n">FX</th><th scope="col" class="n">HCUT</th><th scope="col" class="n">USED</th><th scope="col">STATE</th></tr></thead>
        <tbody>${body}</tbody></table>`,
    );
  }

  function renderTape() {
    const offers = new Map((S.offers ?? []).map((o) => [o.id, o]));
    const lineCtx = {
      sd: sd(),
      fd: fd(),
      code: code(),
      now: now(),
      symbolOf,
      codeOfOffer: (id) => (offers.get(id) ? codeOf(offers.get(id).stablecoin) : null),
      codeOfRepo: (id) => (T.market.repos.get(id) ? codeOf(T.market.repos.get(id).stablecoin) : null),
    };
    const events = T.tape.events.slice(-TAPE_LINES).reverse();
    $("t-tape-meta").textContent = `${T.tape.events.length} event${T.tape.events.length === 1 ? "" : "s"} · newest first`;
    const warn = T.tape.error ? `<p class="t-empty t-warn">Live events unavailable: ${esc(T.tape.error)}</p>` : "";
    if (!events.length) {
      setHTML($("t-tape"), `${warn}<p class="t-empty">No event yet in the window the RPC keeps.</p>`);
      return;
    }
    const body = events
      .map((e) => {
        const l = tapeLine(e, lineCtx);
        return `<tr><td class="t-dim">${esc(l.time)}</td><td class="t-code${tone(l.tone)}">${esc(l.code)}</td><td class="t-wrap">${esc(l.text)}</td><td>${txLink(l.txHash)}</td></tr>`;
      })
      .join("");
    setHTML($("t-tape"), `${warn}<table class="tt tt-tape"><caption class="sr-only">Contract events, newest first</caption><tbody>${body}</tbody></table>`);
  }

  function renderStatus() {
    const parts = [];
    const w = wallet();
    if (!w) {
      parts.push(`<span class="tb-item"><span class="tb-k">WALLET</span> <span class="tb-v t-warn">none</span> <span class="t-dim">CONN to connect Freighter</span></span>`);
    } else {
      const b = S.balances;
      parts.push(`<span class="tb-item"><span class="tb-k">WALLET</span> <span class="tb-v t-id">${esc(shortAddress(w))}</span></span>`);
      if (b) {
        parts.push(`<span class="tb-item"><span class="tb-k">XLM</span> <span class="tb-v">${b.xlm === null ? "—" : esc(formatAmount(b.xlm, 7))}</span></span>`);
        parts.push(`<span class="tb-item"><span class="tb-k">${esc(code())}</span> <span class="tb-v">${b.stablecoin === null ? "no trustline" : esc(formatAmount(b.stablecoin, sd()))}</span></span>`);
        parts.push(`<span class="tb-item"><span class="tb-k">${esc(sym())}</span> <span class="tb-v">${esc(formatAmount(b.shares, fd()))}</span></span>`);
        parts.push(`<span class="tb-item"><span class="tb-k">LENDER</span> <span class="tb-v ${S.approved ? "t-ok" : "t-dim"}">${S.approved ? "approved" : "no"}</span></span>`);
      }
      const mineOpen = [...T.market.repos.values()].filter((r) => r.status === "Open" && r.borrower === w);
      if (mineOpen.length) {
        const next = mineOpen.map((r) => ({ id: r.id, at: nextInterestStep(r.opened_at, now()) })).sort((a, b) => a.at - b.at)[0];
        parts.push(`<span class="tb-item" title="Interest is charged per started hour"><span class="tb-k">NEXT HOUR</span> <span class="tb-v">#${next.id} in <span data-cd="${next.at}" data-cd-after="now">${esc(compactDuration(next.at - now()))}</span></span></span>`);
      }
    }
    const pend = pendingItems();
    if (pend?.length) {
      for (const p of pend.slice(0, 3)) {
        parts.push(`<span class="tb-item"><span class="tb-k t-warn">${esc(p.label)}</span> <span class="tb-v t-warn">${p.eta === null ? "pending" : `applicable in <span data-cd="${p.eta}" data-cd-after="now">${esc(compactDuration(p.eta - now()))}</span>`}</span></span>`);
      }
    }
    if (T.updatedAt) parts.push(`<span class="tb-item t-dim">updated <span data-since="${T.updatedAt}">just now</span></span>`);
    else parts.push(`<span class="tb-item t-warn">reading the chain…</span>`);
    parts.push(`<span class="tb-item tb-help t-dim">/ command · ↑↓ history · Tab completes · Esc cancels</span>`);
    setHTML($("t-status"), parts.join(""));
  }

  function render() {
    if (!T.active || !S.dep) return;
    renderBand();
    renderConsole();
    renderBook();
    renderTicket();
    renderPositions();
    renderFunds();
    renderTape();
    renderStatus();
    for (const id of ["t-book-panel", "t-ticket-panel", "t-pos-panel", "t-funds-panel", "t-tape-panel"]) {
      $(id)?.classList.toggle("is-focus", T.focused === id);
    }
  }

  function clockTick() {
    if (!T.active) return;
    const t = now();
    for (const el of document.querySelectorAll("#terminal [data-clock]")) el.textContent = clockText();
    for (const el of document.querySelectorAll("#terminal [data-cd]")) {
      const left = Number(el.dataset.cd) - t;
      el.textContent = left > 0 ? compactDuration(left) : (el.dataset.cdAfter ?? "0s");
    }
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  function focusPanel(id, text) {
    T.focused = id;
    render();
    $(id)?.scrollIntoView({ block: "nearest" });
    if (text) say("out", text);
  }

  function setTicket(view, run) {
    T.ticket = { view, run, state: "ready" };
    T.focused = "t-ticket-panel";
    render();
    const blocked = view.checks.find((c) => c.block);
    if (blocked) say("err", `${view.title}: ${sentence(blocked.text)}`);
    else if (!wallet()) say("warn", `${view.title} ready. CONN to connect a wallet, then GO.`);
    else say("out", `${view.title} ready. Enter (GO) signs, Esc cancels.`);
  }

  function cancel() {
    if (!T.ticket) return say("out", "No ticket to cancel.");
    const title = T.ticket.view.title;
    T.ticket = null;
    render();
    say("out", `${title} cancelled. Nothing was signed.`);
  }

  /** Runs a write through main.js's runTx and reports the outcome in the console. */
  function send(context, action, message) {
    let outcome = null;
    const watched = async (onStatus) => {
      try {
        const result = await action(onStatus);
        outcome = { ok: true, text: message(result) };
        return result;
      } catch (error) {
        outcome = { ok: false, text: describeError(error, context).text };
        throw error;
      }
    };
    return ctx.runTx($("t-tx"), context, watched, (result) => message(result)).then(() => outcome);
  }

  async function go(implicit) {
    const t = T.ticket;
    if (!t) {
      if (!implicit) say("warn", "No ticket to confirm. Prepare one with Q, O, R, L, W, S or REL.");
      return;
    }
    if (t.state === "sending") return say("warn", "This ticket is already being signed.");
    if (t.view.blocking) return say("err", `Blocked: ${sentence(t.view.checks.find((c) => c.block).text)} Fix it or CANCEL.`);
    if (!wallet()) return say("warn", "No wallet connected. Type CONN, then GO.");
    if (S.busy) return say("warn", "Another transaction is running. Wait for it.");
    t.state = "sending";
    render();
    say("out", `${t.view.title}: asking Freighter to sign…`);
    const outcome = await t.run();
    if (outcome?.ok) {
      say("ok", outcome.text);
      T.ticket = null;
    } else {
      say("err", `${outcome?.text ?? "Not sent."} The ticket stays: GO to retry, CANCEL to drop it.`);
      if (T.ticket) T.ticket.state = "ready";
    }
    render();
  }

  async function quote({ shares, fund }) {
    const f = fund ? funds().find((x) => x.symbol === fund) : (funds().find((x) => x.shares === iface()) ?? null);
    const address = f?.shares ?? iface();
    const symbol = f?.symbol ?? sym();
    say("out", `Valuing ${shareText(shares, symbol)} with the contract…`);
    try {
      const q = await S.chain.quote(shares, address);
      const best = bookRows(S.offers, { funds: funds(), fund: address, maxTerm: S.maxTerm }).find((r) => r.takesFund && !r.mine);
      T.quote = quoteView({ shares, quote: q, fundSymbol: symbol, bestRateBps: best ? best.rateBps : null, sd: sd(), fd: fd(), code: code() });
      if (!T.ticket) T.focused = "t-ticket-panel";
      render();
      say("ok", `${shareText(shares, symbol)} secure up to ${money(BigInt(q.max_principal), "floor")} (haircut ${formatRate(q.haircut_bps)}).`);
    } catch (error) {
      say("err", describeError(error).text);
    }
  }

  function errorContext(extra = {}) {
    return { code: code(), command: wallet() ? ctx.onboardCommand(wallet()) : undefined, ...extra };
  }

  async function prepareOpen({ offerId, shares, termSecs, amount }) {
    const offer = (S.offers ?? []).find((o) => o.id === offerId);
    if (!offer) return say("err", bookKnown() ? `Offer #${offerId} does not exist. OFF shows the book.` : BOOK_UNREAD);
    say("out", `Valuing ${shareText(shares)} for offer #${offerId}…`);
    let q = null;
    let quoteError = null;
    try {
      q = await S.chain.quote(shares);
    } catch (error) {
      quoteError = describeError(error).text;
    }
    const base = {
      offer,
      fund: iface(),
      sd: sd(),
      fd: fd(),
      code: codeOf(offer.stablecoin),
      sym: sym(),
      shares,
      termSecs,
      amount,
      quote: q,
      quoteError,
      contractMaxTerm: S.maxTerm,
      limits: ctx.fundLimits(),
      sharesHeld: wallet() && S.balances ? S.balances.shares : null,
      paused: S.board?.paused?.value === true,
      frozen: Boolean(S.board?.state?.value?.frozen),
      wallet: wallet(),
      ownOffer: Boolean(wallet() && offer.lender === wallet()),
      now: now(),
    };
    let view = openTicket(base);
    const context = errorContext({
      max: q ? money(BigInt(q.max_principal), "floor") : null,
      available: money(BigInt(offer.available), "floor"),
      term: `1 to ${Math.floor(Math.min(Number(offer.max_term), S.maxTerm) / HOUR)} hours`,
    });
    // With a wallet, simulate the call: a refusal lands on the ticket before anything is signed.
    if (wallet() && !view.blocking) {
      const args = [sv.address(wallet()), sv.u64(offerId), sv.address(iface()), sv.i128(shares), sv.i128(view.principal), sv.u64(termSecs)];
      const refusal = await S.chain.probe("open_repo", args);
      if (refusal) view = openTicket({ ...base, preflight: `The contract would refuse: ${describeError(refusal, context).text}` });
    }
    setTicket(view, () =>
      send(
        context,
        (onStatus) => S.chain.openRepo(S.wallet, view.args, onStatus),
        (result) => `Repo #${result.repoId} opened: ${money(view.principal)} sent to your wallet.`,
      ),
    );
  }

  /** The repo from the blotter, else from the chain; a read failure is not "missing". */
  async function findRepo(repoId) {
    const known = T.market.repos.get(repoId);
    if (known) return { repo: known, error: null };
    try {
      return { repo: await S.chain.repo(repoId), error: null };
    } catch (error) {
      return { repo: null, error };
    }
  }

  const unreadRepo = (repoId, error) => `Repo #${repoId} could not be read: ${sentence(describeError(error).text)} REF reads the chain again.`;

  async function prepareRepurchase({ repoId }) {
    const { repo, error } = await findRepo(repoId);
    if (error) return say("err", unreadRepo(repoId, error));
    if (!repo) return say("err", `Repo #${repoId} does not exist. POS ALL lists the repos.`);
    let due = null;
    if (repo.status === "Open") {
      try {
        due = await S.chain.repoDue(repoId);
      } catch {
        due = null;
      }
    }
    const sameCoin = repo.stablecoin === S.dep.contracts.stablecoin;
    const view = repurchaseTicket({
      repo,
      interestDue: due,
      stableHeld: wallet() && S.balances && sameCoin ? S.balances.stablecoin : null,
      wallet: wallet(),
      now: now(),
      sd: sd(),
      fd: fd(),
      code: codeOf(repo.stablecoin),
      sym: symbolOf(repo.fund),
    });
    setTicket(view, () =>
      send(
        errorContext(),
        (onStatus) => S.chain.repurchase(S.wallet, repoId, onStatus),
        () => `Repo #${repoId} repurchased: ${shareText(BigInt(repo.shares), symbolOf(repo.fund))} back in your wallet.`,
      ),
    );
  }

  function prepareLend({ amount, rateBps, termSecs }) {
    const view = lendTicket({
      amount,
      rateBps,
      termSecs,
      contractMaxTerm: S.maxTerm,
      stableHeld: wallet() && S.balances ? S.balances.stablecoin : null,
      approved: S.approved,
      wallet: wallet(),
      paused: S.board?.paused?.value === true,
      sd: sd(),
      code: code(),
      fundSymbol: sym(),
    });
    setTicket(view, () =>
      send(
        errorContext({ action: "create_offer", term: `1 to ${Math.floor(S.maxTerm / HOUR)} hours` }),
        (onStatus) => S.chain.createOffer(S.wallet, { amount, rateBps, maxTerm: termSecs }, onStatus),
        (result) => `Offer #${result.offerId} created: ${money(amount)} at ${formatRate(rateBps)}.`,
      ),
    );
  }

  function prepareWithdraw({ offerId, amount }) {
    const offer = (S.offers ?? []).find((o) => o.id === offerId);
    if (!offer) return say("err", bookKnown() ? `Offer #${offerId} does not exist. OFF shows the book.` : BOOK_UNREAD);
    const view = withdrawTicket({ offer, amount, wallet: wallet(), sd: sd(), code: codeOf(offer.stablecoin) });
    setTicket(view, () =>
      send(
        errorContext({ available: money(BigInt(offer.available)) }),
        (onStatus) => S.chain.withdrawOffer(S.wallet, offerId, view.amount, onStatus),
        () => `${money(view.amount)} withdrawn from offer #${offerId}.`,
      ),
    );
  }

  async function prepareSeize({ repoId }) {
    const { repo, error } = await findRepo(repoId);
    if (error) return say("err", unreadRepo(repoId, error));
    if (!repo) return say("err", `Repo #${repoId} does not exist. POS ALL lists the repos.`);
    const view = seizeTicket({ repo, wallet: wallet(), now: now(), sd: sd(), fd: fd(), code: codeOf(repo.stablecoin), sym: symbolOf(repo.fund) });
    setTicket(view, () =>
      send(
        errorContext({ action: "seize" }),
        (onStatus) => S.chain.seize(S.wallet, repoId, onStatus),
        () => `Repo #${repoId} closed: ${shareText(BigInt(repo.shares), symbolOf(repo.fund))} sent to your wallet.`,
      ),
    );
  }

  async function prepareRelease({ repoId }) {
    let pending = T.market.releases.get(repoId) ?? null;
    if (!pending) pending = await S.chain.pendingRelease(repoId).catch(() => null);
    const repo = T.market.repos.get(repoId);
    const view = releaseTicket({ repoId, pending, wallet: wallet(), fd: fd(), sym: repo ? symbolOf(repo.fund) : sym() });
    setTicket(view, () =>
      send(
        errorContext({ action: "release" }),
        (onStatus) => S.chain.release(S.wallet, repoId, onStatus),
        (result) => (result.value ? `Repo #${repoId}: shares delivered.` : `Repo #${repoId}: the issuer still blocks the transfer; the shares stay recorded.`),
      ),
    );
  }

  function help() {
    const next = () => (T.seq += 1);
    T.log = [
      ...COMMANDS.map((c) => ({ seq: next(), kind: "help", text: `${c.usage.padEnd(36)} ${c.help}` })),
      ...NOTATION.map((n) => ({ seq: next(), kind: "help", text: n })),
    ];
    T.helpMode = true;
    renderConsole();
  }

  async function execute(line) {
    const text = String(line ?? "").trim();
    if (T.helpMode) {
      T.helpMode = false;
      T.log = [];
    }
    if (text) {
      remember(text);
      say("in", text.toUpperCase());
    }
    const parsed = parseCommand(text, { shareDecimals: fd(), stableDecimals: sd(), funds: funds().map((f) => f.symbol) });
    if (!parsed.ok) return say("err", parsed.usage ? `${parsed.error} Usage: ${parsed.usage}` : parsed.error);
    switch (parsed.cmd) {
      case "help":
        return help();
      case "go":
        return go(parsed.implicit);
      case "cancel":
        return cancel();
      case "offers":
        return focusPanel("t-book-panel", "Offer book: best rate first. Click an offer number to load a ticket.");
      case "funds":
        return focusPanel("t-funds-panel", "Funds: NAV age against each fund's bound; amber past three quarters, red when the contract would refuse it.");
      case "tape":
        return focusPanel("t-tape-panel", "Tape: every contract event, newest first, with its transaction.");
      case "positions":
        T.scope = parsed.scope;
        return focusPanel("t-pos-panel", `Positions: ${scopeLabel()}.`);
      case "connect":
        say("out", "Asking Freighter…");
        await ctx.connect();
        return wallet() ? say("ok", `Connected ${shortAddress(wallet())}.`) : say("err", S.walletProblem ?? "Freighter did not connect.");
      case "refresh":
        say("out", "Reading the chain…");
        await ctx.refreshAll();
        await refresh({ force: true });
        return say("ok", "Up to date.");
      case "clear":
        T.log = [];
        return renderConsole();
      case "guide":
        return ctx.setFace("guide");
      case "quote":
        return quote(parsed);
      case "open":
        return prepareOpen(parsed);
      case "repurchase":
        return prepareRepurchase(parsed);
      case "lend":
        return prepareLend(parsed);
      case "withdraw":
        return prepareWithdraw(parsed);
      case "seize":
        return prepareSeize(parsed);
      case "release":
        return prepareRelease(parsed);
      default:
        return say("err", "Not available.");
    }
  }

  // -------------------------------------------------------------------------
  // Keyboard and pointer
  // -------------------------------------------------------------------------

  function focusInput() {
    const input = $("t-input");
    if (!input) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }

  function onDocKey(event) {
    if (!T.active) return;
    const tag = document.activeElement?.tagName;
    const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(tag);
    if (!typing && (event.key === "/" || event.key === ":")) {
      event.preventDefault();
      focusInput();
    } else if (!typing && event.key === "Escape" && T.ticket) {
      cancel();
    }
  }

  function wire() {
    if (T.wired) return;
    T.wired = true;
    const input = $("t-input");
    $("t-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const line = input.value;
      input.value = "";
      execute(line);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (input.value) input.value = "";
        else if (T.ticket) cancel();
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        if (!T.history.length) return;
        event.preventDefault();
        const last = T.history.length - 1;
        if (event.key === "ArrowUp") T.historyAt = T.historyAt < 0 ? last : Math.max(T.historyAt - 1, 0);
        else T.historyAt = T.historyAt < 0 ? -1 : T.historyAt + 1 > last ? -1 : T.historyAt + 1;
        input.value = T.historyAt < 0 ? "" : T.history[T.historyAt];
      } else if (event.key === "Tab" && !event.shiftKey && input.value.trim() && !/\s/.test(input.value.trim())) {
        const found = completions(input.value);
        if (found.length === 1) {
          event.preventDefault();
          input.value = `${found[0]} `;
        } else if (found.length > 1) {
          event.preventDefault();
          say("out", `Matches: ${found.join(", ")}`);
        }
      }
    });
    $("terminal").addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.dataset.fill !== undefined) {
        input.value = button.dataset.fill;
        focusInput();
      } else if (button.dataset.cmd !== undefined) {
        execute(button.dataset.cmd);
        focusInput();
      }
    });
    document.addEventListener("keydown", onDocKey);
  }

  // -------------------------------------------------------------------------
  // Life cycle
  // -------------------------------------------------------------------------

  function mount() {
    if (T.active) return;
    T.active = true;
    loadHistory();
    wire();
    render();
    focusInput();
    clearInterval(T.clock);
    T.clock = setInterval(clockTick, 1000);
    refresh({ force: true });
  }

  function unmount() {
    T.active = false;
    clearInterval(T.clock);
    T.clock = null;
  }

  return { mount, unmount, refresh, render, isActive: () => T.active };
}
