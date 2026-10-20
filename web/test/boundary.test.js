// Values decoded from the chain are checked at the boundary: an RPC or an
// outside price feed cannot slip markup, an odd id or a huge exponent into
// the page where a number or an address is expected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RESOURCE_FEE, checkDecimals, checkPrice, checkShape } from "../src/chain.js";

const G = "GAOLESTCJHYYSTQ5G3IM46B4KT33RM22JEQXVIF5KHZF5DTTOB3MYZNN";
const markup = "\"><img src=x onerror=alert(1)>";

test("a price must be two integers", () => {
  assert.deepEqual(checkPrice({ value: { price: 108500000000000n, timestamp: 1792460000n } }).value.price, 108500000000000n);
  assert.ok(checkPrice({ value: { price: 1n, timestamp: markup } }).error instanceof TypeError);
  assert.ok(checkPrice({ value: { price: markup, timestamp: 1n } }).error instanceof TypeError);
  assert.ok(checkPrice({ value: { price: 1n } }).error instanceof TypeError);
  assert.deepEqual(checkPrice({ value: null }), { value: null });
});

test("integers and addresses are what they claim to be", () => {
  assert.doesNotThrow(() => checkShape({ maturity: 5n, rate_bps: 250, lender: G }, { ints: ["maturity", "rate_bps"], addresses: ["lender"] }));
  assert.throws(() => checkShape({ maturity: markup }, { ints: ["maturity"] }), TypeError);
  assert.throws(() => checkShape({ maturity: 1.5 }, { ints: ["maturity"] }), TypeError);
  assert.throws(() => checkShape({ lender: markup }, { addresses: ["lender"] }), TypeError);
  assert.throws(() => checkShape(null), TypeError);
});

test("decimals stay between 0 and 38", () => {
  assert.doesNotThrow(() => checkDecimals({ nav_decimals: 14, fx_decimals: 14, price_decimals: 0 }));
  assert.throws(() => checkDecimals({ nav_decimals: 1000000 }), TypeError);
  assert.throws(() => checkDecimals({ price_decimals: -1 }), TypeError);
  assert.throws(() => checkDecimals({ fx_decimals: markup }), TypeError);
});

test("the resource fee a simulation may ask is capped at 25 XLM", () => {
  assert.equal(MAX_RESOURCE_FEE, 250_000_000n);
});
