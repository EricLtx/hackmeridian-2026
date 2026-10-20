// Values decoded from the chain are checked at the boundary: an RPC or an
// outside price feed cannot slip markup, an odd id or a huge exponent into
// the page where a number or an address is expected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Account, Asset, Networks, Operation, SorobanDataBuilder, TransactionBuilder, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  Chain,
  MAX_RESOURCE_FEE,
  checkDecimals,
  checkFee,
  checkFund,
  checkFundState,
  checkInt,
  checkPendingRelease,
  checkPrice,
  checkShape,
  resourceFeeOf,
  sv,
} from "../src/chain.js";

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

// A fund and its state as testnet decoded them on 20 October (tMMF, priced through EUR/USD).
const C = "CBOVFFTT3CWDZAF5YKH3EBGQHFL6LRBO2UQITXOQF7TJXRF5KFB35EYG";
const crossFund = () => ({
  corridor_floor_bps: 10,
  currency: "EUR",
  haircut_bps: 200,
  max_outstanding: 5_000_000_000_000n,
  max_principal_per_repo: 1_000_000_000_000n,
  max_yield_bps: 500,
  nav_max_age_secs: 93_600n,
  oracle: C,
  oracle_asset: ["Stellar", "CAEXP2UGZVWDXIVOMSZSE5MDSTD5LRBU55FPTERGFSPHTMKONBNJ5XHB"],
  source: ["Cross", { asset: ["Other", "EUR"], band_bps: 200, haircut_bps: 200, max_age_secs: 259_200n, oracle: "CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W" }],
  steward: "GBEMFR6BTJVUXII6DJWYJTTI7RTTGY4FNM4N5I6JOFQGUGXUR63LX2TX",
});
const fundState = () => ({
  currency: "EUR",
  frozen: false,
  fx_decimals: 14,
  nav_decimals: 14,
  outstanding: 9_000_000_000n,
  reference_fx: 112_450_099_157_802n,
  reference_nav: 108_529_815_480_720n,
  reference_time: 1_792_317_272n,
  share_decimals: 7,
});

test("a fund's settings and state are what the contract returns, or refused", () => {
  assert.deepEqual(checkFund(crossFund()), crossFund());
  assert.deepEqual(checkFund({ ...crossFund(), source: ["Direct"] }).source, ["Direct"]);
  assert.equal(checkFund(null), null, "a fund not admitted");
  const leg = crossFund().source[1];
  for (const source of [["Cross", { ...leg, asset: 5 }], ["Cross", { ...leg, asset: ["Stellar", markup] }], ["Cross"], ["Other"], "Direct", ["Cross", { ...leg, oracle: markup }], ["Cross", { ...leg, max_age_secs: "1" }]]) {
    assert.throws(() => checkFund({ ...crossFund(), source }), TypeError, JSON.stringify(source, (k, v) => (typeof v === "bigint" ? String(v) : v)));
  }
  assert.throws(() => checkFund({ ...crossFund(), haircut_bps: markup }), TypeError);
  assert.throws(() => checkFund({ ...crossFund(), currency: markup }), TypeError);
  const missing = crossFund();
  delete missing.max_outstanding;
  assert.throws(() => checkFund(missing), /missing fund\.max_outstanding/);

  assert.deepEqual(checkFundState(fundState()), fundState());
  assert.equal(checkFundState(undefined), null);
  assert.throws(() => checkFundState({ ...fundState(), frozen: "no" }), TypeError);
  assert.throws(() => checkFundState({ ...fundState(), nav_decimals: 1_000_000 }), TypeError);
  assert.throws(() => checkFundState({ ...fundState(), outstanding: markup }), TypeError);
  const noOutstanding = fundState();
  delete noOutstanding.outstanding;
  assert.throws(() => checkFundState(noOutstanding), /missing fund state\.outstanding/);
});

test("held-back shares, integers and booleans read on chain are checked before they reach BigInt()", async () => {
  const pending = { fund: dep.contracts.fundShares, to: G, shares: 10_000_000n };
  assert.deepEqual(checkPendingRelease(pending), pending);
  assert.equal(checkPendingRelease(null), null);
  assert.throws(() => checkPendingRelease({ ...pending, shares: "1e9" }), TypeError);
  assert.throws(() => checkPendingRelease({ ...pending, to: markup }), TypeError);
  assert.throws(() => checkPendingRelease({ fund: pending.fund, to: G }), /missing pending release\.shares/);
  assert.equal(checkInt(5n), 5n);
  assert.throws(() => checkInt("5"), TypeError);

  const chain = new Chain(dep);
  chain.read = async (contract, fn) => ({ pending_release: { ...pending, to: markup }, is_lender_approved: "yes", repo_due: "12" })[fn];
  await assert.rejects(chain.pendingRelease(1), TypeError);
  assert.equal(await chain.isLenderApproved(G), false, "anything but true reads as not approved");
  await assert.rejects(chain.repoDue(1), TypeError);
});

test("a malformed fund source fails its own fields, not the board pass", async () => {
  const chain = new Chain(dep);
  const leg = crossFund().source[1];
  let rateReads = 0;
  chain.settle = async (contract, fn) => {
    const values = {
      get_fund: { ...crossFund(), source: ["Cross", { ...leg, asset: 5 }] },
      get_fund_state: fundState(),
      is_paused: false,
      max_term: 604_800n,
      fund_price: { price: 108_547_853_399_289n, timestamp: 1_792_448_341n },
      currency_cap: 10_000_000_000_000n,
      currency_outstanding: 9_000_000_000n,
    };
    if (fn === "lastprice") rateReads += 1;
    return { value: values[fn] ?? null };
  };
  chain.offers = async () => [];
  chain.ledgerTime = async () => 1_792_448_400;
  const board = await chain.board(0n);
  assert.ok(board.config.error instanceof TypeError, "the fund's settings are refused");
  assert.deepEqual(board.fx, { value: null });
  assert.equal(rateReads, 0, "no exchange rate is read from a source the page cannot use");
  assert.equal(board.nav.value.price, 108_547_853_399_289n);
  assert.equal(board.state.value.outstanding, 9_000_000_000n);
  assert.equal(board.paused.value, false);
  assert.ok(board.funds.length > 0 && board.funds.every((f) => f.config.error instanceof TypeError && f.state.value));
  // Read directly, a source the page cannot use is the exchange rate's error.
  assert.ok((await chain.exchangeRate({ source: ["Cross", { ...leg, asset: 5 }] })).error);
  assert.deepEqual(await chain.exchangeRate({ source: ["Direct"] }), { value: null });
});

// Structs as the contract returns them: maps with sorted symbol keys. The values are those of the
// deployed instance's offers, repos and quotes, which carried every field on 20 October.
const scMap = (entries) =>
  xdr.ScVal.scvMap(
    Object.entries(entries)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v })),
  );
const scAddress = (a) => nativeToScVal(a, { type: "address" });
const offerFields = () => ({
  available: nativeToScVal(5_000_000_000n, { type: "i128" }),
  funds: xdr.ScVal.scvVec([scAddress(dep.contracts.fundShares)]),
  lender: scAddress(G),
  max_term: nativeToScVal(604_800n, { type: "u64" }),
  rate_bps: nativeToScVal(325, { type: "u32" }),
  sponsor: xdr.ScVal.scvBool(false),
  stablecoin: scAddress(dep.contracts.stablecoin),
});
const repoFields = () => ({
  borrower: scAddress(G),
  fund: scAddress(dep.contracts.fundShares),
  lender: scAddress(G),
  maturity: nativeToScVal(1_800_000_000n, { type: "u64" }),
  offer_id: nativeToScVal(1n, { type: "u64" }),
  opened_at: nativeToScVal(1_700_000_000n, { type: "u64" }),
  principal: nativeToScVal(9_000_000_000n, { type: "i128" }),
  rate_bps: nativeToScVal(350, { type: "u32" }),
  shares: nativeToScVal(10_000_000_000n, { type: "i128" }),
  stablecoin: scAddress(dep.contracts.stablecoin),
  status: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Open")]),
});
const quoteFields = () => ({
  haircut_bps: nativeToScVal(400, { type: "u32" }),
  max_principal: nativeToScVal(8_700_000_000n, { type: "i128" }),
  nav_timestamp: nativeToScVal(1_792_448_341n, { type: "u64" }),
  price: nativeToScVal(96_705_213_504_883n, { type: "i128" }),
  price_decimals: nativeToScVal(14, { type: "u32" }),
});
const without = (fields, key) => {
  const copy = { ...fields };
  delete copy[key];
  return copy;
};

/** The function and arguments of a contract call, as SDK 17 decodes its operation. */
function callOf(tx) {
  const invoke = tx.operations[0].func.invokeContract;
  return { fn: new TextDecoder().decode(invoke.functionName.bytes), args: invoke.args.map((arg) => scValToNative(arg)) };
}

/** A chain on a stand-in RPC whose simulations return `answer(fn, args)`, or None. */
function chainAnswering(answer) {
  const chain = new Chain(dep);
  const server = {
    simulateTransaction: async (tx) => {
      const { fn, args } = callOf(tx);
      return { latestLedger: 1, minResourceFee: "0", result: { auth: [], retval: answer(fn, args) ?? xdr.ScVal.scvVoid() } };
    },
    getLatestLedger: async () => ({ sequence: 1, closeTime: "1792500000" }),
  };
  chain.endpoints = [{ url: "https://stub.example", host: "stub.example", server, lastMs: null, failures: 0 }];
  chain.active = 0;
  return chain;
}

test("an offer, a repo or a quote missing any field is refused at the boundary, naming the field (WEB-5)", async () => {
  const first = (fn, value) => (name, [id]) => (name === fn && id === 1n ? value : null);
  // Complete, as the deployed instance returns them.
  assert.equal((await chainAnswering(first("get_offer", scMap(offerFields()))).offers()).length, 1);
  assert.equal((await chainAnswering(first("get_repo", scMap(repoFields()))).repos(1))[0].principal, 9_000_000_000n);
  assert.equal((await chainAnswering(() => scMap(quoteFields())).quote(1n)).max_principal, 8_700_000_000n);
  for (const key of Object.keys(offerFields())) {
    await assert.rejects(chainAnswering(first("get_offer", scMap(without(offerFields(), key)))).offers(), new RegExp(`missing offer\\.${key} `), key);
  }
  for (const key of Object.keys(repoFields())) {
    const chain = chainAnswering(first("get_repo", scMap(without(repoFields(), key))));
    await assert.rejects(chain.repos(1), new RegExp(`missing repo\\.${key} `), key);
    await assert.rejects(chain.repo(1), new RegExp(`missing repo\\.${key} `), key);
  }
  for (const key of ["haircut_bps", "max_principal", "price", "price_decimals"]) {
    await assert.rejects(chainAnswering(() => scMap(without(quoteFields(), key))).quote(1n), new RegExp(`missing quote\\.${key} `), key);
  }
  // The designation is a boolean, as the contract's Offer has it.
  await assert.rejects(chainAnswering(first("get_offer", scMap({ ...offerFields(), sponsor: nativeToScVal(1, { type: "u32" }) }))).offers(), /unexpected offer\.sponsor/);
});

test("an offer missing a field is the offer table's error; the board pass goes on (WEB-5)", async () => {
  const chain = chainAnswering((fn, [id]) => (fn === "get_offer" && id === 1n ? scMap(without(offerFields(), "rate_bps")) : fn === "is_paused" ? xdr.ScVal.scvBool(false) : null));
  const board = await chain.board(0n);
  assert.match(board.offers.error.message, /missing offer\.rate_bps/);
  assert.equal(board.paused.value, false, "the other reads of the pass stand");
  assert.equal(board.now.value, 1_792_500_000);
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
