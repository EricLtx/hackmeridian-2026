import assert from "node:assert/strict";
import { test } from "node:test";

import { ROLES, effectiveHaircutBps, guideTerms, roleGuide } from "../src/guide.js";

const ctx = { code: "tEUR", sym: "tMMF", maxTermSecs: 7 * 24 * 3600, delaySecs: 48 * 3600, haircutBps: 200 };

test("every role has an intro, needs, steps and terms, with the live names in them", () => {
  for (const role of ROLES) {
    const g = roleGuide(role, ctx);
    assert.ok(g.intro.length > 40);
    assert.ok(g.need.length >= 2 && g.steps.length >= 3 && g.terms.length >= 3);
  }
  const b = roleGuide("borrower", ctx);
  assert.match(b.intro, /tMMF/);
  assert.match(b.steps[1], /2\.00 % haircut/);
  assert.match(b.steps[1], /one hour to 7 d/);
  assert.match(roleGuide("issuer", ctx).terms[0], /48 h|2 d/);
});

test("the terms rows read the deployment and the board", () => {
  const dep = {
    network: "testnet",
    stablecoin: { code: "tEUR", currency: "EUR", decimals: 7 },
    stablecoins: [{ code: "tEUR", currency: "EUR" }, { code: "tEURB", currency: "EUR" }],
  };
  const board = {
    paused: { value: false },
    cap: { value: 1_000_000n * 10_000_000n },
    funds: [
      { symbol: "tMMF", navCurrency: "USD", config: { value: { haircut_bps: 200, nav_max_age_secs: 26 * 3600, source: ["Cross", {}], max_principal_per_repo: 100_000n * 10_000_000n, max_outstanding: 500_000n * 10_000_000n } } },
      { symbol: "tSHARE", navCurrency: "EUR", config: { value: { haircut_bps: 100, nav_max_age_secs: 64 * 3600, source: "Direct", max_principal_per_repo: 1n, max_outstanding: 1n } } },
    ],
  };
  const rows = guideTerms({ dep, board, maxTermSecs: 168 * 3600, delaySecs: 300, version: 4, paused: false });
  const byLabel = Object.fromEntries(rows.map(([l, v]) => [l, v]));
  assert.match(byLabel["Loan currency"], /tEUR \(EUR\), tEURB \(EUR\)/);
  assert.match(byLabel["Funds admitted"], /tMMF: 2\.00 % haircut, NAV in USD through an exchange-rate feed/);
  assert.match(byLabel["Funds admitted"], /tSHARE: 1\.00 % haircut, NAV in EUR, NAV at most 2 d/);
  assert.match(byLabel.Caps, /100,000(\.00)? tEUR per repo, 500,000(\.00)? tEUR per fund \(tMMF\), 1,000,000(\.00)? tEUR for the currency/);
  assert.match(byLabel.Changes, /^5 min time delay/);
  assert.equal(byLabel.Pause, "open");
  assert.match(byLabel.Network, /testnet, contract version 4/);
});

test("effectiveHaircutBps adds the exchange-rate leg's haircut: the quote applies both", () => {
  assert.equal(effectiveHaircutBps({ haircut_bps: 200, source: ["Cross", { haircut_bps: 200 }] }), 400);
  assert.equal(effectiveHaircutBps({ haircut_bps: 150, source: "Direct" }), 150);
  assert.equal(effectiveHaircutBps({ haircut_bps: 100, source: ["Direct"] }), 100);
  assert.equal(effectiveHaircutBps(null), null);
  assert.equal(effectiveHaircutBps(undefined), null);
});

test("the borrower's guide states the total haircut of a cross-priced fund", () => {
  const b = roleGuide("borrower", { ...ctx, haircutBps: effectiveHaircutBps({ haircut_bps: 200, source: ["Cross", { haircut_bps: 200 }] }) });
  assert.match(b.steps[1], /4\.00 % haircut/);
});
