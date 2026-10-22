import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EVENT_LABELS,
  bandItems,
  bookRows,
  compactDuration,
  feedTone,
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
  tapeTime,
  withdrawTicket,
} from "../src/blotter.js";
import { setLang } from "../src/i18n.js";

const ONE = 10_000_000n;
const H = 3600;
const T0 = 1_792_000_000;
const F1 = "CFUNDONEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";
const F2 = "CFUNDTWOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2";
const ME = "GWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM";
const LENDER = "GLENDERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAL";
const OTHER = "GOTHERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAO";
const deployFunds = [
  { symbol: "tMMF", name: "T-bill share", navCurrency: "USD", shares: F1 },
  { symbol: "tSHARE", name: "Classic share", navCurrency: "EUR", shares: F2, tokenCode: "stellar-asset-contract" },
];

test("feed tone: fresh, past three quarters of the bound, beyond it", () => {
  assert.equal(feedTone(60, H), "ok");
  assert.equal(feedTone(2700, H), "warn");
  assert.equal(feedTone(H, H), "warn");
  assert.equal(feedTone(H + 1, H), "bad");
  assert.equal(feedTone(undefined, H), "bad");
  assert.equal(feedTone(10, 0), "bad");
});

test("compact durations and tape times", () => {
  assert.equal(compactDuration(45), "45s");
  assert.equal(compactDuration(723), "12m03s");
  assert.equal(compactDuration(3 * H + 300), "3h05m");
  assert.equal(compactDuration(52 * H), "2d04h");
  const now = Date.UTC(2026, 9, 19, 12, 0, 0) / 1000;
  assert.equal(tapeTime("2026-10-19T09:15:42Z", now), "09:15:42");
  assert.equal(tapeTime("2026-10-18T21:47:03Z", now), "10-18 21:47");
  assert.equal(tapeTime("nonsense", now), "--:--:--");
});

test("the book lists offers with money, best rate first, then the deepest", () => {
  const offers = [
    { id: 1, lender: LENDER, available: 300_000n * ONE, rate_bps: 250, max_term: 168 * H, funds: [F1], sponsor: true },
    { id: 2, lender: LENDER, available: 0n, rate_bps: 100, max_term: 168 * H, funds: [F1], sponsor: false },
    { id: 3, lender: ME, available: 1_000n * ONE, rate_bps: 250, max_term: 24 * H, funds: [F1, F2], sponsor: false },
    { id: 4, lender: OTHER, available: 50n * ONE, rate_bps: 325, max_term: 168 * H, funds: [F2], sponsor: false },
  ];
  const rows = bookRows(offers, { funds: deployFunds, fund: F1, wallet: ME, maxTerm: 168 * H });
  assert.deepEqual(rows.map((r) => r.id), [1, 3, 4]);
  assert.deepEqual(rows[1].funds, ["tMMF", "tSHARE"]);
  assert.equal(rows[0].designated, true);
  assert.equal(rows[1].mine, true);
  assert.equal(rows[1].termSecs, 24 * H);
  assert.equal(rows[2].takesFund, false);
});

test("fund rows grade every feed against its own bound and name the fund state", () => {
  const now = T0;
  const funds = [
    {
      ...deployFunds[0],
      config: { value: { haircut_bps: 200, nav_max_age_secs: 26 * H, source: ["Cross", { haircut_bps: 200, max_age_secs: 72 * H }], max_outstanding: 500_000n * ONE, max_principal_per_repo: 100_000n * ONE } },
      state: { value: { outstanding: 900n * ONE, frozen: false, nav_decimals: 14, fx_decimals: 14 } },
    },
    {
      ...deployFunds[1],
      config: { value: { haircut_bps: 100, nav_max_age_secs: 64 * H, source: "Direct", max_outstanding: 150_000n * ONE, max_principal_per_repo: 50_000n * ONE } },
      state: { value: { outstanding: 0n, frozen: false, nav_decimals: 14, fx_decimals: 14 } },
    },
  ];
  const feeds = new Map([
    [F1, { nav: { value: { price: 108_530_000_000_000n, timestamp: BigInt(now - H) } }, fx: { value: { price: 112_450_000_000_000n, timestamp: BigInt(now - 70 * H) } } }],
    [F2, { nav: { value: { price: 100_200_000_000_000n, timestamp: BigInt(now - 70 * H) } }, fx: { value: null } }],
  ]);
  const [one, two] = fundRows(funds, { feeds, now, iface: F1 });
  assert.equal(one.navTone, "ok");
  assert.equal(one.fxTone, "warn");
  assert.equal(one.source, "CROSS");
  assert.equal(one.usedPct, 0.1);
  assert.equal(one.state, "OPEN");
  assert.equal(one.iface, true);
  assert.equal(two.token, "SAC");
  assert.equal(two.navTone, "bad");
  assert.equal(two.state, "STALE");
  funds[1].state.value.frozen = true;
  assert.equal(fundRows(funds, { feeds, now })[1].state, "FROZEN");
});

test("the blotter puts open repos first, marks late ones and offers the right action", () => {
  const base = { fund: F1, rate_bps: 300, opened_at: T0, shares: 1_000n * ONE, stablecoin: "C" };
  const repos = [
    { ...base, id: 1, status: "Open", borrower: ME, lender: LENDER, principal: 900n * ONE, maturity: T0 + 64 * H },
    { ...base, id: 2, status: "Open", borrower: OTHER, lender: ME, principal: 500n * ONE, maturity: T0 + H },
    { ...base, id: 3, status: "Repurchased", borrower: ME, lender: LENDER, principal: 100n * ONE, maturity: T0 + H },
    { ...base, id: 4, status: "Defaulted", borrower: ME, lender: LENDER, principal: 200n * ONE, maturity: T0 + H },
  ];
  const now = T0 + 2 * H + 300;
  const rows = positionRows(repos, {
    now,
    dues: new Map([
      [1, 100n],
      [2, 50n],
    ]),
    releases: new Map([[4, { to: ME, shares: 10n * ONE }]]),
    wallet: ME,
    funds: deployFunds,
  });
  assert.deepEqual(rows.map((r) => [r.id, r.side, r.state, r.action]), [
    [2, "LND", "LATE", "S 2"],
    [1, "BOR", "OPEN", "R 1"],
    [4, "BOR", "HELD", "REL 4"],
    [3, "BOR", "REPAID", null],
  ]);
  assert.equal(rows[1].due, 900n * ONE + 100n);
  assert.equal(rows[1].hours, 3);
  assert.equal(rows[1].fund, "tMMF");
  // Seen from another address: sides follow it, and nothing can be signed for it.
  const watched = positionRows(repos, { now, wallet: null, viewer: OTHER, funds: deployFunds });
  assert.deepEqual(watched.map((r) => [r.id, r.side, r.action]), [
    [2, "BOR", null],
    [1, "", null],
    [4, "", null],
    [3, "", null],
  ]);
  const totals = positionTotals(rows);
  assert.deepEqual(totals, { open: 2, principal: 1_400n * ONE, due: 1_400n * ONE + 150n, late: 1 });
});

test("tape lines read both the indexer's export and decoded RPC events", () => {
  const ctx = { sd: 7, fd: 7, code: "tEUR", now: T0, symbolOf: (a) => (a === F1 ? "tMMF" : "?") };
  const opened = tapeLine(
    {
      event: "repo_opened",
      topics: ["3", ME],
      data: { fund: F1, lender: LENDER, maturity: "1792501802", offer_id: "1", principal: "9000000000", rate_bps: 350, shares: "10000000000" },
      closedAt: new Date(T0 * 1000).toISOString(),
      txHash: "abcdef0123",
    },
    ctx,
  );
  assert.equal(opened.code, "OPEN");
  assert.equal(opened.repoId, 3);
  assert.equal(opened.text, `#3 900.00 tEUR @ 3.50 % · 1,000.00 tMMF · offer #1 · GWAL…AAAM`);
  assert.equal(opened.txHash, "abcdef0123");
  assert.equal(tapeLine({ event: "repo_repurchased", topics: ["3"], data: { principal: "9000000000", interest: "237929" } }, ctx).text, "#3 900.00 tEUR + 0.0237929 interest");
  const paused = tapeLine({ event: "pause_changed", topics: [], data: { paused: true, by: LENDER } }, ctx);
  assert.deepEqual([paused.code, paused.tone], ["PAUSE", "warn"]);
  const proposed = tapeLine({ event: "steward_backup_change_proposed", topics: [F1], data: { eta: String(T0 + 300) } }, ctx);
  assert.equal(proposed.code, "PROP");
  assert.match(proposed.text, /^steward backup key change proposed, applicable /);
  assert.equal(tapeLine({ event: "something_new", topics: [], data: {} }, ctx).code, "GOV");
});

test("the valuation behind an opening has its own tape line: price per share and haircut (rc5)", () => {
  const valued = {
    event: "repo_valued",
    topics: ["12", F1],
    data: { nav: "108500000000000", nav_time: "1792000000", fx: "111880000000000", fx_applied: "111980000000000", fx_time: "1792000000", price: "96892302196820", haircut_bps: 400 },
    closedAt: new Date(T0 * 1000).toISOString(),
    txHash: "feedface01",
  };
  const ctx = { sd: 7, fd: 7, code: "tEUR", now: T0, symbolOf: (a) => (a === F1 ? "tMMF" : "?"), navDecimalsOf: (a) => (a === F1 ? 14 : null) };
  const line = tapeLine(valued, ctx);
  assert.deepEqual([line.code, line.tone, line.repoId, line.known], ["VALUE", "dim", 12, true]);
  assert.equal(line.text, "#12 tMMF valued at 0.9689 tEUR per share, haircut 4.00 %");
  // The repo's own stablecoin names the price, as for the other amounts of the repo.
  assert.equal(tapeLine(valued, { ...ctx, codeOfRepo: (id) => (id === 12 ? "tEURB" : null) }).text, "#12 tMMF valued at 0.9689 tEURB per share, haircut 4.00 %");
  // Without the fund's NAV decimals (a fund the board has not read), no price rather than a wrong one.
  for (const navDecimalsOf of [undefined, () => null, () => 99, () => "x"]) {
    assert.equal(tapeLine(valued, { ...ctx, navDecimalsOf }).text, "#12 tMMF valued, haircut 4.00 %");
  }
  // A coarse feed shows its own digits; a malformed value never throws.
  assert.equal(tapeLine({ ...valued, data: { ...valued.data, price: "97" } }, { ...ctx, navDecimalsOf: () => 2 }).text, "#12 tMMF valued at 0.97 tEUR per share, haircut 4.00 %");
  assert.equal(tapeLine({ ...valued, data: { price: "oops", haircut_bps: "oops" } }, ctx).text, "#12 tMMF valued at 0.0000 tEUR per share, haircut 0.00 %");
});

test("a valuation priced by the fund's backup feed says so on the tape (rc5, RepoValued.fallback)", () => {
  const valued = (fallback) => ({
    event: "repo_valued",
    topics: ["12", F1],
    data: { nav: "108500000000000", nav_time: "1792000000", fx: "0", fx_applied: "0", fx_time: "0", price: "96892302196820", haircut_bps: 400, ...(fallback === undefined ? {} : { fallback }) },
    closedAt: new Date(T0 * 1000).toISOString(),
    txHash: "feedface02",
  });
  const ctx = { sd: 7, fd: 7, code: "tEUR", now: T0, symbolOf: (a) => (a === F1 ? "tMMF" : "?"), navDecimalsOf: (a) => (a === F1 ? 14 : null) };
  const backup = tapeLine(valued(true), ctx);
  assert.deepEqual([backup.code, backup.tone, backup.repoId, backup.known], ["VALUE", "warn", 12, true]);
  assert.equal(backup.text, "#12 tMMF valued by the backup feed at 0.9689 tEUR per share, haircut 4.00 %");
  assert.equal(tapeLine(valued(true), { ...ctx, navDecimalsOf: () => null }).text, "#12 tMMF valued by the backup feed, haircut 4.00 %");
  // The primary feed, or an event published before the field existed: the line as before.
  for (const fallback of [false, undefined, "true", 1]) {
    const line = tapeLine(valued(fallback), ctx);
    assert.deepEqual([line.tone, line.text], ["dim", "#12 tMMF valued at 0.9689 tEUR per share, haircut 4.00 %"], String(fallback));
  }
  try {
    setLang("fr");
    assert.equal(tapeLine(valued(true), ctx).text, "#12 tMMF valorisé par le flux de secours à 0,9689 tEUR par part, décote 4,00 %");
    setLang("es");
    assert.equal(tapeLine(valued(true), ctx).text, "#12 tMMF valorado por la fuente de respaldo a 0,9689 tEUR por participación, recorte 4,00 %");
  } finally {
    setLang("en");
  }
});

test("a malformed event never stops the tape", () => {
  const ctx = { sd: 7, fd: 7, code: "tEUR", now: T0, symbolOf: (a) => (a === F1 ? "tMMF" : a.slice(0, 4)) };
  // An RPC or an export can carry a rate that is not a number: it reads as 0, it does not throw.
  const opened = tapeLine({ event: "repo_opened", topics: ["1", ME], data: { principal: "10000000", rate_bps: "abc", shares: "10000000", fund: F1, offer_id: "1" } }, ctx);
  assert.equal(opened.code, "OPEN");
  assert.match(opened.text, /@ 0\.00 % · 1\.00 tMMF/);
  assert.match(tapeLine({ event: "fund_limits_set", topics: [F1], data: { haircut_bps: "x" } }, ctx).text, /tMMF haircut 0\.00 %/);
  // A date that is not one keeps a placeholder time.
  assert.equal(tapeLine({ event: "upgrade_proposed", topics: [], data: { wasm_hash: "abcdef0123", eta: "abc" } }, ctx).text, "code abcdef01 proposed, applicable --:--:-- UTC");
  assert.equal(tapeLine({ event: "fallback_proposed", topics: [], data: { eta: 1e300 } }, ctx).text, "backup feed proposed, applicable --:--:-- UTC");
  // A known event whose line cannot be made keeps the generic line of its name.
  const odd = tapeLine({ event: "fund_set", topics: [5], data: { haircut_bps: 100 } }, ctx);
  assert.deepEqual([odd.code, odd.text, odd.known], ["GOV", "fund set", true]);
});

test("an event the tape does not name is marked unknown, whatever its name", () => {
  for (const event of ["something_new", "constructor", "toString", "__proto__", ""]) {
    const line = tapeLine({ event, topics: [], data: {} }, {});
    assert.equal(line.known, false, event);
    assert.equal(line.code, "GOV", event);
  }
  assert.equal(tapeLine({ event: "fallback_proposed", topics: [], data: {} }, {}).known, false);
  assert.equal(tapeLine({ event: "repo_seized", topics: ["1"], data: { shares: "10", to: LENDER } }, {}).known, true);
});

test("merging the export with live events keeps one copy of each, in ledger order", () => {
  const a = { ledger: 10, event: "repo_opened", topics: ["1"], data: { x: "1" }, txHash: "t1", closedAt: "2026-10-18T00:00:00Z" };
  const b = { ledger: 12, event: "repo_repurchased", topics: ["1"], data: { x: "2" }, txHash: "t2", closedAt: "2026-10-18T00:01:00Z" };
  const merged = mergeEvents([[b, a], [{ ...a }], [null, { event: "" }]]);
  assert.deepEqual(merged.map((e) => e.txHash), ["t1", "t2"]);
  assert.equal(mergeEvents([[a, b]], 1).length, 1);
});

const offer = { id: 2, lender: LENDER, stablecoin: "C", available: 5_000n * ONE, rate_bps: 300, max_term: 168 * H, funds: [F1], sponsor: false };
const quote = { max_principal: 1_000n * ONE, price: 965_200n, price_decimals: 6, haircut_bps: 400 };
const openBase = {
  offer,
  fund: F1,
  code: "tEUR",
  sym: "tMMF",
  shares: 1_000n * ONE,
  termSecs: 64 * H,
  amount: null,
  quote,
  contractMaxTerm: 168 * H,
  limits: [100_000n * ONE, 499_100n * ONE],
  sharesHeld: 50_000n * ONE,
  wallet: ME,
  now: T0,
};
const row = (t, label) => t.rows.find((r) => r[0] === label)?.[1];

test("an open ticket proposes 90 % of the ceiling and prices it with the contract's rule", () => {
  const t = openTicket(openBase);
  assert.equal(t.blocking, false);
  assert.equal(t.principal, 900n * ONE);
  assert.equal(row(t, "Receive"), "900.00 tEUR");
  assert.equal(row(t, "LTV"), "86.40 %");
  // 900 tEUR at 3.00 % for 64 h: ceil(9e9 * 300 * 230,400 / (10,000 * 31,536,000)) = 1,972,603 units.
  assert.equal(row(t, "Interest at term"), "0.1972603 tEUR");
  assert.equal(row(t, "Repay at term"), "900.20 tEUR");
  assert.deepEqual(t.args, { offerId: 2, shares: 1_000n * ONE, principal: 900n * ONE, term: 64 * H });
  assert.equal(t.note, "");
});

test("an open ticket blocks what the contract would refuse, before anything is signed", () => {
  const over = openTicket({ ...openBase, amount: 1_001n * ONE });
  assert.equal(over.blocking, true);
  assert.ok(over.checks.some((c) => c.block && /Over the ceiling of 1,000.00 tEUR/.test(c.text)));
  assert.equal(openTicket({ ...openBase, ownOffer: true }).blocking, true);
  assert.ok(openTicket({ ...openBase, termSecs: 200 * H }).checks.some((c) => c.block && /outside 1 to 168 h/.test(c.text)));
  assert.ok(openTicket({ ...openBase, sharesHeld: 10n * ONE }).checks.some((c) => c.block && /You hold 10.00 tMMF/.test(c.text)));
  assert.ok(openTicket({ ...openBase, paused: true }).blocking);
  assert.ok(openTicket({ ...openBase, preflight: "The contract would refuse: stale price" }).blocking);
  const unpriced = openTicket({ ...openBase, quote: null, quoteError: "The fund price is too old." });
  assert.equal(row(unpriced, "Receive"), "—");
  assert.equal(row(unpriced, "Repay at term"), "—");
  assert.ok(unpriced.checks.some((c) => c.block && c.text === "The fund price is too old."));
  const noWallet = openTicket({ ...openBase, wallet: null, sharesHeld: null });
  assert.equal(noWallet.blocking, false);
  assert.match(noWallet.note, /CONN/);
  const foreign = openTicket({ ...openBase, offer: { ...offer, funds: [F2] } });
  assert.ok(foreign.checks.some((c) => c.block && /does not accept tMMF/.test(c.text)));
});

test("a repurchase ticket shows the amount due now and warns before the next hour starts", () => {
  const repo = { id: 7, status: "Open", borrower: ME, lender: LENDER, fund: F1, principal: 900n * ONE, rate_bps: 300, opened_at: T0, maturity: T0 + 64 * H, shares: 1_000n * ONE };
  const t = repurchaseTicket({ repo, interestDue: 123_288n, stableHeld: 1_000n * ONE, wallet: ME, now: T0 + 3 * H + 10, code: "tEUR", sym: "tMMF" });
  assert.equal(t.blocking, false);
  assert.equal(row(t, "Repay now"), "900.02 tEUR");
  assert.match(row(t, "Interest so far"), /4 started h$/);
  assert.ok(!t.checks.some((c) => !c.ok));
  const late = repurchaseTicket({ repo, interestDue: 123_288n, stableHeld: 1_000n * ONE, wallet: ME, now: T0 + 4 * H - 60 });
  const warn = late.checks.find((c) => !c.ok);
  assert.equal(warn.block, false);
  assert.match(warn.text, /Interest steps up in 1m00s/);
  assert.equal(repurchaseTicket({ repo, interestDue: 0n, stableHeld: 10n * ONE, wallet: ME, now: T0 + H }).blocking, true);
  assert.equal(repurchaseTicket({ repo, interestDue: 0n, wallet: OTHER, now: T0 + H }).blocking, true);
  assert.equal(repurchaseTicket({ repo: { ...repo, status: "Repurchased" }, now: T0 }).blocking, true);
});

test("seize, withdraw, lend and release tickets", () => {
  const repo = { id: 9, status: "Open", borrower: OTHER, lender: ME, fund: F1, principal: 500n * ONE, rate_bps: 300, opened_at: T0, maturity: T0 + 64 * H, shares: 600n * ONE };
  const early = seizeTicket({ repo, wallet: ME, now: T0 + 10 * H, code: "tEUR", sym: "tMMF" });
  assert.equal(early.blocking, true);
  assert.match(early.checks[0].text, /in 2d06h$/);
  assert.equal(seizeTicket({ repo, wallet: ME, now: T0 + 65 * H }).blocking, false);
  assert.equal(seizeTicket({ repo, wallet: OTHER, now: T0 + 65 * H }).blocking, true);

  const mine = { id: 5, lender: ME, available: 500n * ONE, rate_bps: 325 };
  const all = withdrawTicket({ offer: mine, wallet: ME, code: "tEUR" });
  assert.equal(all.amount, 500n * ONE);
  assert.equal(row(all, "Offer keeps"), "0.00 tEUR");
  assert.equal(withdrawTicket({ offer: mine, amount: 600n * ONE, wallet: ME }).blocking, true);
  assert.equal(withdrawTicket({ offer: { ...mine, lender: OTHER }, wallet: ME }).blocking, true);

  const lend = lendTicket({ amount: 10_000n * ONE, rateBps: 325, termSecs: 168 * H, contractMaxTerm: 168 * H, stableHeld: 20_000n * ONE, approved: true, wallet: ME, code: "tEUR", fundSymbol: "tMMF" });
  assert.equal(lend.blocking, false);
  // 10,000 tEUR at 3.25 % for 64 h: ceil(1e11 * 325 * 230,400 / 3.1536e11) = 23,744,293 units.
  assert.equal(row(lend, "If fully lent 64 h"), "2.3744293 tEUR interest");
  assert.equal(lendTicket({ amount: ONE, rateBps: 325, termSecs: 200 * H, contractMaxTerm: 168 * H, wallet: ME, approved: true }).blocking, true);
  assert.equal(lendTicket({ amount: ONE, rateBps: 325, termSecs: H, contractMaxTerm: 168 * H, wallet: ME, approved: false }).blocking, true);

  assert.equal(releaseTicket({ repoId: 4, pending: null }).blocking, true);
  assert.equal(releaseTicket({ repoId: 4, pending: { to: ME, shares: 10n * ONE }, wallet: ME, sym: "tMMF" }).blocking, false);
});

test("a deferred delivery waits for the share token or for the lender's approval (rc5)", () => {
  const deferred = tapeLine({ event: "release_deferred", topics: ["4"], data: { to: LENDER, shares: "10000000000" }, closedAt: new Date(T0 * 1000).toISOString() }, { now: T0 });
  assert.deepEqual([deferred.code, deferred.tone, deferred.repoId], ["HELD", "warn", 4]);
  assert.equal(deferred.text, "#4 1,000.00 shares owed to GLEN…AAAL: the delivery waits for the share token or for the lender's approval");
  const note = releaseTicket({ repoId: 4, pending: { to: ME, shares: 10n * ONE }, wallet: ME, sym: "tMMF" }).note;
  assert.match(note, /While the share token refuses them, or a lender beneficiary is not approved for the fund, nothing moves/);
});

test("the seize ticket says the shares wait in the contract when the lender is not approved (WEB-8)", () => {
  // Since rc5 a lender whose approval was revoked may still seize: the repo settles, the shares wait in the contract.
  const repo = { id: 7, status: "Open", borrower: OTHER, lender: ME, fund: F1, principal: 500n * ONE, rate_bps: 300, opened_at: T0, maturity: T0 + 64 * H, shares: 600n * ONE };
  const note = () => seizeTicket({ repo, wallet: ME, now: T0 + 65 * H, code: "tEUR", sym: "tMMF" }).note;
  assert.doesNotMatch(note(), /which the issuer approved/, "no promise the ticket cannot check");
  assert.equal(
    note(),
    "The shares go to your address if the issuer approves you as lender for this fund; if not, the repo still settles and the shares wait in the contract until it approves you again (REL then delivers them). The borrower can still repurchase until this lands.",
  );
  try {
    setLang("fr");
    assert.match(note(), /sinon, le repo est tout de même dénoué et les parts attendent dans le contrat/);
    setLang("es");
    assert.match(note(), /si no, el repo se liquida igualmente y las participaciones esperan en el contrato/);
  } finally {
    setLang("en");
  }
});

test("the quote view and the band", () => {
  const q = quoteView({ shares: 1_000n * ONE, quote, fundSymbol: "tMMF", bestRateBps: 250, code: "tEUR" });
  assert.equal(row(q, "Ceiling"), "1,000.00 tEUR");
  assert.equal(row(q, "Price"), "0.9652 tEUR/share");
  assert.ok(q.rows.some((r) => r[0] === "64 h on 90 % at 2.50 %"));
  const band = bandItems({ network: "testnet", paused: true, version: 4, schema: 2, delay: 300, funds: [], openInterest: { count: 1, principal: 900n * ONE }, pending: 0, code: "tEUR" });
  assert.deepEqual(band.map((i) => [i.label, i.value]), [
    ["TESTNET", ""],
    ["STATE", "PAUSED"],
    ["CODE", "v4·s2"],
    ["OI", "1 · 900.00 tEUR"],
    ["DELAY", "5m00s"],
    ["GOV", "none pending"],
  ]);
});

test("a fund whose value cannot be formatted marks its own band item, not the band", () => {
  const fund = (symbol, extra = {}) => ({
    symbol,
    name: symbol,
    navCurrency: "USD",
    nav: 108_500_000_000_000n,
    navDecimals: 14,
    navAge: 60,
    navMaxAge: H,
    navTone: "ok",
    fx: null,
    frozen: false,
    ...extra,
  });
  const band = bandItems({ network: "testnet", paused: false, funds: [fund("tBAD", { navDecimals: 99 }), fund("tOK"), fund("tFX", { fx: 1n, fxDecimals: -3 })] });
  assert.deepEqual(band.map((i) => [i.label, i.value, i.tone]), [
    ["TESTNET", "", "amber"],
    ["STATE", "OPEN", "ok"],
    ["tBAD", "—", "bad"],
    ["tOK", "1.0850 USD 1m00s", "ok"],
    ["tFX", "—", "bad"],
  ]);
  assert.equal(band[2].title, "The chain returned a value this page cannot show.");
  // A coarse feed's NAV shows with the four digits asked, padded.
  assert.equal(bandItems({ funds: [fund("tTWO", { nav: 97n, navDecimals: 2 })] })[2].value, "0.9700 USD 1m00s");
});

test("every contract event has a dedicated tape row or a translated label", async () => {
  const { readFile } = await import("node:fs/promises");
  const events = await readFile(new URL("../../contracts/night-window/src/events.rs", import.meta.url), "utf8");
  const names = [...events.matchAll(/#\[contractevent\]\s*pub struct (\w+)/g)].map((m) => m[1].replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase());
  assert.ok(names.length > 60, "the contract's events were found");
  const source = await readFile(new URL("../src/blotter.js", import.meta.url), "utf8");
  const rows = new Set([...source.matchAll(/^\s+([a-z_]+): \(\) =>/gm)].map((m) => m[1]));
  const missing = names.filter((n) => !rows.has(n) && !(n in EVENT_LABELS));
  assert.deepEqual(missing, [], "events with neither a row nor a label");
});

test("in French and Spanish a governance event the tape has no row for reads in that language", () => {
  const e = { event: "stablecoin_change_cancelled", topics: ["stablecoin_change_cancelled"], data: { by: "GD2KQ6ZJEXAMPLEADDRESSFORTESTSONLYXXXXXXXXXXXXXXXXXJQC2" }, closedAt: "2026-10-21T22:47:00Z" };
  try {
    setLang("fr");
    const fr = tapeLine(e, { now: 0 }).text;
    assert.match(fr, /changement de stablecoin annulé par/);
    assert.doesNotMatch(fr, /stablecoin change cancelled/);
    setLang("es");
    assert.match(tapeLine(e, { now: 0 }).text, /cambio de stablecoin cancelado por/);
  } finally {
    setLang("en");
  }
  assert.match(tapeLine(e, { now: 0 }).text, /^stablecoin change cancelled by /);
});
