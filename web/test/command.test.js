import assert from "node:assert/strict";
import { test } from "node:test";

import { COMMANDS, completions, findCommand, id, parseCommand, quantity, rate, term } from "../src/command.js";

const ONE = 10_000_000n;
const ctx = { shareDecimals: 7, stableDecimals: 7, funds: ["tMMF", "tEMMF", "tSHARE"] };

test("quantities accept grouping, decimals and K or M, and nothing else", () => {
  assert.equal(quantity("1000", 7), 1000n * ONE);
  assert.equal(quantity("1,000.5", 7), 10_005_000_000n);
  assert.equal(quantity("5K", 7), 5000n * ONE);
  assert.equal(quantity("1.5m", 7), 1_500_000n * ONE);
  assert.equal(quantity(".5", 7), 5_000_000n);
  for (const bad of ["0", "-5", "1e3", "abc", "1.12345678", "5KK", ""]) assert.equal(quantity(bad, 7), null, bad);
});

test("terms are hours by default, D for days, W for weeks, one hour at least", () => {
  assert.equal(term("64"), 64 * 3600);
  assert.equal(term("64h"), 64 * 3600);
  assert.equal(term("2D"), 48 * 3600);
  assert.equal(term("1w"), 168 * 3600);
  for (const bad of ["0", "1.5", "-1", "1M", "", "999999"]) assert.equal(term(bad), null, bad);
});

test("rates in percent or in basis points, at most 100 %", () => {
  assert.equal(rate("3.25"), 325);
  assert.equal(rate("3.25%"), 325);
  assert.equal(rate("325bp"), 325);
  assert.equal(rate("100"), 10_000);
  for (const bad of ["100.01", "10001BP", "3.255", "-1", "abc", ""]) assert.equal(rate(bad), null, bad);
});

test("ids accept a hash sign and refuse zero", () => {
  assert.equal(id("7"), 7);
  assert.equal(id("#7"), 7);
  assert.equal(id("0"), null);
  assert.equal(id("x"), null);
});

test("O builds a request for an open ticket; the amount is optional", () => {
  assert.deepEqual(parseCommand("o #3 5k 2d", ctx), { ok: true, cmd: "open", offerId: 3, shares: 5000n * ONE, termSecs: 48 * 3600, amount: null });
  assert.equal(parseCommand("OPEN 3 5000 64 4,500.5", ctx).amount, 45_005_000_000n);
  const missing = parseCommand("O 3 5000", ctx);
  assert.equal(missing.ok, false);
  assert.match(missing.usage, /^O <offer> <shares> <term>/);
  assert.match(parseCommand("O 3 5000 0", ctx).error, /not a term/);
  assert.match(parseCommand("O x 5000 64", ctx).error, /not an offer number/);
});

test("Q takes an optional fund ticker, matched in any case", () => {
  assert.deepEqual(parseCommand("q 1k tshare", ctx), { ok: true, cmd: "quote", shares: 1000n * ONE, fund: "tSHARE" });
  assert.equal(parseCommand("Q 1000", ctx).fund, null);
  assert.match(parseCommand("Q 1000 XYZ", ctx).error, /Unknown fund XYZ\. Funds: tMMF, tEMMF, tSHARE\./);
});

test("R, S and REL take a repo; L takes an amount, a rate and a term; W takes ALL or an amount", () => {
  assert.deepEqual(parseCommand("R 7", ctx), { ok: true, cmd: "repurchase", repoId: 7 });
  assert.deepEqual(parseCommand("seize #2", ctx), { ok: true, cmd: "seize", repoId: 2 });
  assert.deepEqual(parseCommand("REL 2", ctx), { ok: true, cmd: "release", repoId: 2 });
  assert.deepEqual(parseCommand("L 10K 3.25 1W", ctx), { ok: true, cmd: "lend", amount: 10_000n * ONE, rateBps: 325, termSecs: 168 * 3600 });
  assert.deepEqual(parseCommand("W 5 ALL", ctx), { ok: true, cmd: "withdraw", offerId: 5, amount: null });
  assert.equal(parseCommand("W 5 250", ctx).amount, 250n * ONE);
  assert.match(parseCommand("L 10K 101 168", ctx).error, /not a rate/);
});

test("POS: mine, the market, or any address", () => {
  assert.deepEqual(parseCommand("POS", ctx), { ok: true, cmd: "positions", scope: "auto" });
  assert.equal(parseCommand("pos all", ctx).scope, "all");
  assert.equal(parseCommand("pos me", ctx).scope, "me");
  const address = "GAOLESTCJHYYSTQ5G3IM46B4KT33RM22JEQXVIF5KHZF5DTTOB3MYZNN";
  assert.equal(parseCommand(`POS ${address.toLowerCase()}`, ctx).scope, address);
  assert.equal(parseCommand("POS bob", ctx).ok, false);
});

test("an empty line is GO; unknown words and stray arguments are refused", () => {
  assert.deepEqual(parseCommand("   ", ctx), { ok: true, cmd: "go", implicit: true });
  assert.deepEqual(parseCommand("go", ctx), { ok: true, cmd: "go" });
  assert.deepEqual(parseCommand("?", ctx), { ok: true, cmd: "help" });
  assert.deepEqual(parseCommand("esc", ctx), { ok: true, cmd: "cancel" });
  assert.match(parseCommand("BUY 3", ctx).error, /Unknown command BUY/);
  assert.match(parseCommand("OFF 3", ctx).error, /takes no argument/);
});

test("Tab completes the command word only", () => {
  assert.deepEqual(completions("po"), ["POS", "POSITIONS"]);
  assert.deepEqual(completions("with"), ["WITHDRAW"]);
  assert.deepEqual(completions("REL"), []);
  assert.deepEqual(completions("O 3"), []);
  assert.deepEqual(completions(""), []);
});

test("every command has a usage and a help line, and every alias resolves to it", () => {
  for (const c of COMMANDS) {
    assert.ok(c.usage && c.help, c.name);
    for (const word of [c.name, ...c.aliases]) assert.equal(findCommand(word.toLowerCase()), c);
  }
});
