// The positions summary adds up the open repos the page already holds: a
// borrower's debt and next term, a lender's exposure and what it may keep.
// Pure: rows and dues in, a model or markup out; BigInt throughout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { borrowerSummary, lenderSummary, summaryMarkup } from "../src/summary.js";

const NOW = 1_792_500_000;
const ONE = 10_000_000n;
const CENT = 100_000n; // one hundredth of a 7-decimal unit: what a card shows

const row = (fields = {}) => ({ id: 1, status: "Open", principal: 9_000n * ONE, maturity: NOW + 86_400, ...fields });
const dues = (entries) => new Map(entries);
const view = { decimals: 7, code: "tEUR" };

test("no open row, no summary", () => {
  assert.equal(borrowerSummary([], dues([]), NOW), null);
  assert.equal(lenderSummary([], dues([]), NOW), null);
  assert.equal(borrowerSummary([row({ status: "Repurchased" })], dues([]), NOW), null);
  assert.equal(summaryMarkup(null, "borrower", view), "");
  assert.equal(summaryMarkup(null, "lender", view), "");
});

test("a borrower's totals over two open repos and one past its term", () => {
  const rows = [
    row({ id: 1, principal: 1_000n * ONE, maturity: NOW + 7_200 }),
    row({ id: 2, principal: 2_000n * ONE, maturity: NOW + 3_600 }),
    row({ id: 3, principal: 4_000n * ONE, maturity: NOW - 60 }),
    row({ id: 4, status: "Repurchased", principal: 8_000n * ONE, maturity: NOW - 600 }),
  ];
  const m = borrowerSummary(rows, dues([[1, 28_539n], [2, 57_078n], [3, 1n], [4, 5n]]), NOW, { unit: CENT });
  assert.equal(m.open, 3);
  assert.equal(m.borrowed, 7_000n * ONE, "the closed repo is left out");
  // Each card shows its total rounded up to the cent: the tile is the sum of what the cards show.
  assert.equal(m.dueNow, 1_000n * ONE + 100_000n + (2_000n * ONE + 100_000n) + (4_000n * ONE + 100_000n));
  assert.equal(m.partial, false);
  assert.equal(m.missing, 0);
  assert.equal(m.pastTerm, 1);
  assert.equal(m.nextMaturity, NOW + 3_600, "the nearest term still ahead, never a past one");
  const html = summaryMarkup(m, "borrower", view);
  assert.match(html, /aria-live="off"/);
  assert.match(html, /Borrowed<\/p><p class="tile-value"[^>]*>7,000\.00 <span class="unit-inline">tEUR<\/span>/);
  assert.match(html, /Due now<\/p><p class="tile-value"[^>]*>7,000\.03 <span class="unit-inline">tEUR/);
  assert.match(html, new RegExp(`Next term ends.*data-until="${NOW + 3_600}" data-after="now"`));
  assert.match(html, /tile tile-warn"><p class="tile-label">Past term<\/p><p class="tile-value"[^>]*>1</, "past term in amber when there is one");
  assert.doesNotMatch(html, /could not be read|Reading…/);
});

test("the next term is a dash once every open repo is past its term, and the tile stays quiet when none is", () => {
  const past = borrowerSummary([row({ maturity: NOW - 1 })], dues([[1, 0n]]), NOW);
  assert.equal(past.nextMaturity, null);
  assert.equal(past.pastTerm, 1);
  assert.match(summaryMarkup(past, "borrower", view), /Next term ends<\/p><p class="tile-value"[^>]*>—</);
  const ahead = borrowerSummary([row({ maturity: NOW })], dues([[1, 0n]]), NOW - 1);
  assert.equal(ahead.pastTerm, 0);
  assert.doesNotMatch(summaryMarkup(ahead, "borrower", view), /tile-warn/);
});

test("a lender's exposure, and a repo past its term unpaid counts as one it may keep", () => {
  const rows = [row({ id: 1, principal: 1_000n * ONE, maturity: NOW + 60 }), row({ id: 2, principal: 500n * ONE, maturity: NOW }), row({ id: 3, status: "Seized", maturity: NOW - 9 })];
  const m = lenderSummary(rows, dues([[1, 10n * ONE], [2, 5n * ONE]]), NOW);
  assert.equal(m.open, 2);
  assert.equal(m.lent, 1_500n * ONE);
  assert.equal(m.owedNow, 1_515n * ONE);
  assert.equal(m.keepable, 1, "the term reached, not yet repurchased; never the one already closed");
  const html = summaryMarkup(m, "lender", view);
  assert.match(html, /Lent<\/p><p class="tile-value"[^>]*>1,500\.00 /);
  assert.match(html, /Owed now<\/p><p class="tile-value"[^>]*>1,515\.00 /);
  assert.match(html, /You may keep the shares now<\/p><p class="tile-value"[^>]*>1</);
  assert.equal(lenderSummary([row({ maturity: NOW + 1 })], dues([[1, 0n]]), NOW).keepable, 0);
});

test("an interest not yet read leaves the due total out rather than partial", () => {
  const rows = [row({ id: 1 }), row({ id: 2 }), row({ id: 3 })];
  const m = borrowerSummary(rows, dues([[1, 1n]]), NOW);
  assert.equal(m.partial, true);
  assert.equal(m.missing, 2);
  assert.equal(m.dueNow, null, "never a sum over some of the repos");
  assert.equal(m.borrowed, 27_000n * ONE, "what is known still adds up");
  const failed = summaryMarkup(m, "borrower", view);
  assert.match(failed, /Due now<\/p><p class="tile-value"[^>]*>—</);
  assert.match(failed, /2 amounts could not be read/);
  const reading = summaryMarkup(m, "borrower", { ...view, reading: true });
  assert.match(reading, /Due now<\/p><p class="tile-value"[^>]*>—</);
  assert.match(reading, /Reading…/);
  assert.doesNotMatch(reading, /could not be read/);
  assert.match(summaryMarkup(borrowerSummary([row()], dues([]), NOW), "borrower", view), /1 amount could not be read/);
  // No map at all (before the first read, or after a failed one) reads the same.
  const none = lenderSummary(rows, undefined, NOW);
  assert.equal(none.partial, true);
  assert.equal(none.missing, 3);
  assert.equal(none.owedNow, null);
  assert.match(summaryMarkup(none, "lender", view), /Owed now<\/p><p class="tile-value"[^>]*>—</);
});

test("a hostile stablecoin code is escaped", () => {
  const m = borrowerSummary([row()], dues([[1, 0n]]), NOW);
  const html = summaryMarkup(m, "borrower", { decimals: 7, code: '<img src=x onerror="1">' });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=&quot;1&quot;&gt;/);
});

test("the sums stay exact past the range of a double", () => {
  const big = 2n ** 70n; // about 1.18e21 units, past Number's 2^53
  const rows = [row({ id: 1, principal: big }), row({ id: 2, principal: big + 1n })];
  const m = borrowerSummary(rows, dues([[1, 1n], [2, 1n]]), NOW);
  assert.equal(m.borrowed, 2n * big + 1n);
  assert.equal(m.dueNow, 2n * big + 3n);
  const l = lenderSummary(rows, dues([[1, big], [2, 0n]]), NOW);
  assert.equal(l.lent, 2n * big + 1n);
  assert.equal(l.owedNow, 3n * big + 1n);
  // Principals the chain hands over as strings add up the same way.
  assert.equal(borrowerSummary([row({ principal: String(big) })], dues([[1, "1"]]), NOW).dueNow, big + 1n);
});
