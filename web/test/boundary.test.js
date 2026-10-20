// Values decoded from the chain are checked at the boundary: an RPC or an
// outside price feed cannot slip markup, an odd id or a huge exponent into
// the page where a number or an address is expected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Account, Asset, Networks, Operation, SorobanDataBuilder, TransactionBuilder } from "@stellar/stellar-sdk";
import { Chain, MAX_RESOURCE_FEE, checkDecimals, checkFee, checkPrice, checkShape, resourceFeeOf, sv } from "../src/chain.js";

const G = "GAOLESTCJHYYSTQ5G3IM46B4KT33RM22JEQXVIF5KHZF5DTTOB3MYZNN";
const markup = "\"><img src=x onerror=alert(1)>";
const dep = JSON.parse(readFileSync(new URL("../public/deployment.testnet.json", import.meta.url), "utf8"));

/** A Soroban call as assembleTransaction leaves it: the inclusion bid plus the resource fee of its data. */
const assembled = ({ fee = "100000", resourceFee = 1_067_412n } = {}) =>
  new TransactionBuilder(new Account(G, "1"), { fee, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeContractFunction({ contract: dep.contracts.openWindow, function: "repurchase", args: [sv.u64(1)] }))
    .setSorobanData(new SorobanDataBuilder().setResourceFee(resourceFee).build())
    .setTimeout(180)
    .build();

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

test("the fee checked is the one the wallet signs: the assembled transaction's", () => {
  const refused = (pattern) => (error) => error.name === "TxRefused" && pattern.test(error.message);
  // A withdrawal as testnet simulated it on 20 October: 1,067,412 stroops of resources, on both endpoints.
  assert.equal(resourceFeeOf(assembled()), 1_067_412n);
  assert.equal(checkFee(assembled(), { estimate: 1_067_412n }), 1_067_412n);
  assert.equal(checkFee(assembled()), 1_067_412n, "no estimate to compare: the envelope alone decides");
  assert.equal(checkFee(assembled({ resourceFee: MAX_RESOURCE_FEE })), MAX_RESOURCE_FEE);
  // Over the cap, up to the u32 ceiling of the total fee (429.5 XLM).
  assert.throws(() => checkFee(assembled({ resourceFee: MAX_RESOURCE_FEE + 1n })), refused(/unusually high fee \(25\.00 XLM\)/));
  assert.throws(() => checkFee(assembled({ resourceFee: 4_294_867_295n }), { estimate: 1_000_000n }), refused(/unusually high fee \(429\.49 XLM\)/));
  // A total fee that is not the inclusion bid plus the declared resources, or an estimate that differs.
  assert.throws(() => checkFee(assembled({ fee: "200000" })), refused(/does not match/));
  assert.throws(() => checkFee(assembled(), { estimate: 1_000_000n }), refused(/does not match/));
  assert.throws(() => checkFee(assembled(), { estimate: -1n }), refused(/does not match/));
  // A transaction with no resource data is not a contract call this page signs.
  const classic = new TransactionBuilder(new Account(G, "1"), { fee: "100000", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset(dep.stablecoin.code, dep.stablecoin.issuer) }))
    .setTimeout(180)
    .build();
  assert.equal(resourceFeeOf(classic), null);
  assert.throws(() => checkFee(classic), refused(/does not match/));
});

test("an RPC that reports a small fee and sets a large one is refused before the wallet is asked", async () => {
  // The verifier's case: the simulation's summary says 0.1 XLM, its transaction data 429.5 XLM.
  const stub = {
    getAccount: async () => new Account(G, "1"),
    simulateTransaction: async () => ({
      latestLedger: 1,
      minResourceFee: "1000000",
      transactionData: new SorobanDataBuilder().setResourceFee(4_294_867_295n).build().toXdr("base64"),
      results: [{ auth: [], xdr: "" }],
    }),
  };
  const chain = new Chain(dep);
  chain.endpoints = [{ url: "https://stub.example", host: "stub.example", server: stub, lastMs: null, failures: 0 }];
  chain.active = 0;
  let asked = 0;
  const signer = {
    address: G,
    sign: async () => {
      asked += 1;
      throw new Error("the wallet must not be asked");
    },
  };
  await assert.rejects(chain.repurchase(signer, 1), (error) => error.name === "TxRefused" && /429\.49 XLM/.test(error.message));
  assert.equal(asked, 0);
});
