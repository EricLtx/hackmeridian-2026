import assert from "node:assert/strict";
import { test } from "node:test";

import { chainLine } from "../lib/chain.mjs";
import { REGISTRY_COLUMNS, SFTR_COLUMNS, eventsTable, registry, sftr, toCsv } from "../lib/views.mjs";

// Fixture events in the shape the contract emits (contracts/night-window/src/events.rs):
// topic 0 is the event name, then the #[topic] fields, then the other fields in `data`.
const CONTRACT = "CBDS6BZ2JOU6AGIR6FSFK6MNIS25DVYYD2ZHHHEWIPXH4ZDCVWWX7XGL";
const FUND = "CAEXP2UGZVWDXIVOMSZSE5MDSTD5LRBU55FPTERGFSPHTMKONBNJ5XHB";
const EURO = "CC7Z4ENDJV4PBCJMKAOEENJRRU6FFY3FS7W252MNJZ2SUW7ZEVAIP4QX";
const LENDER = "GCUGRDNQC6H57MYVVZJZKAV7VCCWWOTXEAYUOCI6EU7XVQSELO65642R";
const BORROWER = "GAOLESTCJHYYSTQ5G3IM46B4KT33RM22JEQXVIF5KHZF5DTTOB3MYZNN";
const OTHER = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

let n = 0;
const at = (ledger, closedAt, name, topics, data) => {
  n += 1;
  return { ledger, closedAt, txHash: `tx${n}`.padEnd(64, "0"), id: `${String(ledger).padStart(10, "0")}0000000000-${String(n).padStart(10, "0")}`, contract: CONTRACT, topics: [name, ...topics], data };
};

function chain(events) {
  const lines = [];
  for (const e of events) lines.push(chainLine(lines[lines.length - 1] ?? null, e));
  return lines;
}

const FIXTURE = chain([
  at(100, "2026-10-15T21:42:37Z", "stablecoin_set", [EURO], { currency: "EUR" }),
  at(101, "2026-10-15T21:43:00Z", "fund_set", [FUND], { oracle: "CORACLE", haircut_bps: 200 }),
  at(102, "2026-10-15T21:44:42Z", "offer_created", ["1", LENDER], { amount: "3000000000000", max_term: "604800", rate_bps: 250, stablecoin: EURO }),
  at(103, "2026-10-15T21:44:57Z", "repo_opened", ["1", BORROWER], { fund: FUND, lender: LENDER, maturity: "1792104297", offer_id: "1", principal: "9000000000", rate_bps: 250, shares: "10000000000" }),
  at(104, "2026-10-15T21:55:02Z", "repo_opened", ["2", BORROWER], { fund: FUND, lender: LENDER, maturity: "1792104902", offer_id: "1", principal: "500000000", rate_bps: 250, shares: "1000000000" }),
  at(105, "2026-10-15T21:55:12Z", "repo_repurchased", ["2"], { interest: "1998", principal: "500000000" }),
  at(105, "2026-10-15T21:55:12Z", "release_deferred", ["2"], { shares: "1000000000", to: BORROWER }),
  at(106, "2026-10-15T21:56:00Z", "release_redirected", ["2"], { to: OTHER }),
  at(107, "2026-10-15T21:56:30Z", "shares_released", ["2"], { shares: "1000000000", to: OTHER }),
  at(108, "2026-10-15T22:10:00Z", "fund_limits_set", [FUND], { haircut_bps: 300, max_principal_per_repo: "1", max_outstanding: "2" }),
  at(109, "2026-10-15T22:11:00Z", "repo_opened", ["3", BORROWER], { fund: FUND, lender: LENDER, maturity: "1792200000", offer_id: "9", principal: "1000000", rate_bps: 250, shares: "2000000" }),
  at(110, "2026-10-17T13:11:22Z", "repo_seized", ["1"], { shares: "10000000000", to: LENDER }),
  at(111, "2026-10-17T13:12:00Z", "repo_repurchased", ["7"], { interest: "5", principal: "100" }),
]);

test("the registry rebuilds one row per repo from the lifecycle events", () => {
  const rows = registry(FIXTURE);
  assert.deepEqual(rows.map((r) => r.repo_id), ["1", "2", "3", "7"]);
  for (const r of rows) assert.deepEqual(Object.keys(r), REGISTRY_COLUMNS);

  const [r1, r2, r3, r7] = rows;
  assert.equal(r1.status, "seized");
  assert.equal(r1.lender, LENDER);
  assert.equal(r1.borrower, BORROWER);
  assert.equal(r1.fund, FUND);
  assert.equal(r1.shares, "10000000000");
  assert.equal(r1.principal, "9000000000");
  assert.equal(r1.stablecoin, EURO);
  assert.equal(r1.currency, "EUR");
  assert.equal(r1.rate_bps, "250");
  assert.equal(r1.opened_at, "2026-10-15T21:44:57Z");
  assert.equal(r1.maturity, "2026-10-15T22:44:57Z");
  assert.equal(r1.closed_at, "2026-10-17T13:11:22Z");
  assert.equal(r1.release_to, LENDER);
  assert.equal(r1.last_tx, FIXTURE[11].txHash);

  // Repurchased, delivery deferred, redirected, then released: back to repurchased.
  assert.equal(r2.status, "repurchased");
  assert.equal(r2.closure, "repurchased");
  assert.equal(r2.interest, "1998");
  assert.equal(r2.release_to, OTHER);
  assert.equal(r2.release_shares, "");
  assert.match(r2.source, /release_deferred@7 release_redirected@8 shares_released@9/);

  // Open, on an offer whose creation the chain does not hold.
  assert.equal(r3.status, "open");
  assert.equal(r3.stablecoin, "");
  assert.equal(r3.currency, "");
  assert.match(r3.source, /offer_created not in chain/);

  // Closed, but opened before the first journaled ledger.
  assert.equal(r7.status, "repurchased");
  assert.equal(r7.principal, "100");
  assert.equal(r7.borrower, "");
  assert.match(r7.source, /^repo_opened not in chain/);
});

test("a deferred release shows as release pending until the shares are delivered", () => {
  const rows = registry(FIXTURE.slice(0, 8)); // up to release_redirected
  const r2 = rows.find((r) => r.repo_id === "2");
  assert.equal(r2.status, "release_pending");
  assert.equal(r2.closure, "repurchased");
  assert.equal(r2.release_shares, "1000000000");
  assert.equal(r2.release_to, OTHER);
});

test("the SFTR view carries only what the chain holds and names its sources", () => {
  const rows = sftr(FIXTURE);
  for (const r of rows) assert.deepEqual(Object.keys(r), SFTR_COLUMNS);
  const [r1, r2, r3] = rows;
  assert.equal(r1.uti, "1");
  assert.equal(r1.sft_type, "REPO");
  assert.equal(r1.action_type, "ETRM");
  assert.equal(r1.reporting_counterparty_lei, "");
  assert.equal(r1.master_agreement_type, "");
  assert.equal(r1.execution_timestamp, "2026-10-15T21:44:57Z");
  assert.equal(r1.value_date, r1.execution_timestamp);
  assert.equal(r1.maturity_date, "2026-10-15T22:44:57Z");
  assert.equal(r1.termination_date, "2026-10-17T13:11:22Z");
  assert.equal(r1.principal_currency, "EUR");
  assert.equal(r1.fixed_rate_pct, "2.50");
  assert.equal(r1.collateral_quantity, "10000000000");
  assert.equal(r1.collateral_haircut_bps, "200"); // fund_set before the opening
  assert.equal(r1.principal_amount_maturity_date, ""); // seized: nothing repaid
  assert.equal(r2.principal_amount_maturity_date, "500001998"); // principal + interest
  assert.equal(r3.action_type, "NEWT");
  assert.equal(r3.collateral_haircut_bps, "300"); // fund_limits_set at 22:10 precedes the 22:11 opening
  assert.match(r3.source, /haircut:fund_set\/fund_limits_set/);
});

test("the SFTR haircut is the one the opening applied, from repo_valued, when the journal has it (arith-6)", () => {
  // Repo 3 is priced through an exchange rate: the opening applied 300 bps on the fund plus 150 on the rate.
  const valued = chainLine(FIXTURE[FIXTURE.length - 1], at(109, "2026-10-15T22:11:00Z", "repo_valued", ["3", FUND], {
    fx: "111880000000000", fx_applied: "111980000000000", fx_time: "1792199000", haircut_bps: 450, nav: "108500000000000", nav_time: "1792198000", price: "96892302196820",
  }));
  const rows = sftr([...FIXTURE, valued]);
  const r3 = rows.find((r) => r.uti === "3");
  assert.equal(r3.collateral_haircut_bps, "450");
  assert.match(r3.source, /haircut:repo_valued/);
  assert.doesNotMatch(r3.source, /fund_set/);
  // A repo opened before rc5 has no valuation event: the fund's haircut, and the source says so.
  const r1 = rows.find((r) => r.uti === "1");
  assert.equal(r1.collateral_haircut_bps, "200");
  assert.match(r1.source, /haircut:fund_set\/fund_limits_set/);
  // The registry is the same with or without the valuation.
  assert.deepEqual(registry([...FIXTURE, valued]), registry(FIXTURE));
});

test("CSV quotes fields with commas or quotes and keeps a header", () => {
  const text = toCsv(["a", "b"], [{ a: "x,y", b: 'say "hi"' }, { a: null, b: 1 }]);
  assert.equal(text, 'a,b\n"x,y","say ""hi"""\n,1\n');
  const table = eventsTable(FIXTURE.slice(0, 1));
  assert.equal(table[0].event, "stablecoin_set");
  assert.equal(table[0].topics, JSON.stringify([EURO]));
});
