// The deployment file and the history export are data fetched next to the
// page: what they say about the network, URLs, addresses and decimals is
// checked before anything uses it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Networks } from "@stellar/stellar-sdk";
import { checkDeployment, httpsUrl, isDecimals, isTicker } from "../src/deployment.js";
import { addr, contractLink, explorerOf, exportDecimals, txLink, when } from "../src/journal.js";

const dep = JSON.parse(readFileSync(new URL("../public/deployment.testnet.json", import.meta.url), "utf8"));
const copy = () => JSON.parse(JSON.stringify(dep));
const HASH = "8c386cf1a0e39346e3012d4beba576583448542098c760ce35899a8644febc22";

test("the published deployment file passes", () => {
  assert.equal(checkDeployment(copy()).contracts.openWindow, dep.contracts.openWindow);
});

test("a deployment file for any network but testnet is refused, whatever else it says", () => {
  for (const passphrase of [Networks.PUBLIC, Networks.FUTURENET, "Test SDF Network ; September 2015 ", undefined]) {
    const edited = { ...copy(), networkPassphrase: passphrase };
    assert.throws(() => checkDeployment(edited), /unexpected network: this interface runs on the Stellar test network only/, String(passphrase));
  }
  // The label "testnet" is not what decides: the passphrase is.
  assert.throws(() => checkDeployment({ ...copy(), network: "testnet", networkPassphrase: Networks.PUBLIC }), /unexpected network/);
});

test("symbols, URLs, decimals and contract addresses are checked", () => {
  const refused = (edit, pattern) => {
    const edited = copy();
    edit(edited);
    assert.throws(() => checkDeployment(edited), pattern);
  };
  refused((d) => (d.stablecoin.code = "<b>x</b>"), /unexpected asset symbol/);
  refused((d) => (d.explorer = "javascript:alert(1)"), /unexpected URL/);
  refused((d) => (d.rpcFallbacks = ["http://rpc.example"]), /unexpected URL/);
  refused((d) => (d.rpcFallbacks = "https://rpc.example"), /unexpected URL/);
  for (const decimals of [39, -1, 1.5, 1e9, "7"]) refused((d) => (d.fund.decimals = decimals), /unexpected decimals/);
  refused((d) => (d.contracts.openWindow = "GABC"), /unexpected contract address/);
  refused((d) => delete d.contracts.openWindow, /unexpected contract address/);
  refused((d) => (d.funds[1].shares = "<img>"), /unexpected contract address/);
  refused((d) => (d.stablecoins[1].contract = 42), /unexpected contract address/);
  refused((d) => (d.funds = { shares: dep.contracts.fundShares }), /unexpected contract address/);
  // Optional entries may be absent.
  const lean = copy();
  delete lean.funds;
  delete lean.stablecoins;
  delete lean.rpcFallbacks;
  assert.doesNotThrow(() => checkDeployment(lean));
});

test("the small checks the two pages share", () => {
  assert.ok(isDecimals(0) && isDecimals(7) && isDecimals(38));
  assert.ok(![39, -1, 1.5, "7", null, Number.NaN].some(isDecimals));
  assert.ok(isTicker("tEUR") && !isTicker("t EUR") && !isTicker(7) && !isTicker("ABCDEFGHIJKLM"));
  assert.equal(httpsUrl("https://stellar.expert/explorer/testnet"), "https://stellar.expert/explorer/testnet");
  for (const url of ["javascript:alert(1)", "http://stellar.expert", "https://x.example/\"><script>", "https://a b", 5, null]) assert.equal(httpsUrl(url), null, String(url));
});

test("the History page bounds the decimals it reads and links only to an https explorer", () => {
  assert.deepEqual(exportDecimals(dep), { shares: 7, stablecoin: 7, code: "tEUR" });
  assert.deepEqual(exportDecimals({ fund: { decimals: 6 }, stablecoin: { decimals: 18, code: "USDC" } }), { shares: 6, stablecoin: 18, code: "USDC" });
  assert.deepEqual(exportDecimals({ fund: { decimals: 1e9 }, stablecoin: { decimals: -1, code: "<b>" } }), { shares: 7, stablecoin: 7, code: "" });
  assert.deepEqual(exportDecimals(null), { shares: 7, stablecoin: 7, code: "" });

  assert.equal(explorerOf({ explorer: "https://stellar.expert/explorer/testnet" }, null), "https://stellar.expert/explorer/testnet");
  assert.equal(explorerOf({ explorer: "javascript:alert(1)" }, dep), dep.explorer, "the deployment file's explorer stands in");
  assert.equal(explorerOf({ explorer: "javascript:alert(1)" }, { explorer: "data:text/html,x" }), null);
  assert.equal(explorerOf(null, null), null);

  assert.equal(txLink(null, HASH), `<span title="${HASH}">8c386cf1…</span>`, "no usable explorer: the hash alone");
  assert.match(txLink(dep.explorer, HASH), /^<a href="https:\/\/stellar\.expert\/explorer\/testnet\/tx\/8c386cf1/);
  assert.equal(txLink(dep.explorer, ""), "—");
  assert.doesNotThrow(() => txLink(dep.explorer, 12345));
  assert.equal(contractLink(null, dep.contracts.openWindow), `<span title="${dep.contracts.openWindow}">CBDS…7XGL</span>`);
  assert.match(contractLink(dep.explorer, dep.contracts.openWindow), /\/contract\/CBDS6BZ2/);
  // Cells of a malformed export never throw and never carry markup.
  assert.equal(when("2026-10-15T21:44:57Z"), "2026-10-15 21:44:57 UTC");
  assert.equal(when(1792000000), "1792000000");
  assert.equal(when(""), "—");
  assert.equal(addr("<img src=x>"), `<span title="&lt;img src=x&gt;">&lt;img…c=x&gt;</span>`);
  assert.doesNotThrow(() => addr(42));
});
