// A write shows as confirmed only once a second RPC endpoint sees it: the
// endpoint in use could report SUCCESS for a transaction it never forwarded.
// No network: the endpoints are stand-ins, the transaction is built locally.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Account, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { Chain } from "../src/chain.js";
import { TransactionError, describeError } from "../src/errors.js";

const dep = JSON.parse(readFileSync(new URL("../public/deployment.testnet.json", import.meta.url), "utf8"));
const G = "GAOLESTCJHYYSTQ5G3IM46B4KT33RM22JEQXVIF5KHZF5DTTOB3MYZNN";
const fake = (host, server) => ({ url: `https://${host}`, host, server, lastMs: null, failures: 0 });
const nowSecs = () => Math.floor(Date.now() / 1000);

/** A transaction valid until `maxTime`, as the wallet would return it signed. */
const signed = (maxTime = nowSecs() + 180) =>
  new TransactionBuilder(new Account(G, "1"), { fee: "100", networkPassphrase: Networks.TESTNET, timebounds: { minTime: 0, maxTime } })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .build();

const success = (fee) => ({ status: "SUCCESS", ledger: 10, resultXdr: { feeCharged: fee } });
const notFound = (closeTime) => ({ status: "NOT_FOUND", latestLedger: 10, latestLedgerCloseTime: String(closeTime) });

/** The endpoint in use accepts the transaction and reports it applied. */
const reporting = (answer = success(111n)) => fake("first.example", { sendTransaction: async () => ({ status: "PENDING" }), getTransaction: async () => answer });

function chainWith(...endpoints) {
  const chain = new Chain(dep);
  chain.endpoints = endpoints;
  chain.active = 0;
  chain.pollMs = 5;
  return chain;
}

function stages() {
  const seen = [];
  return { seen, onStatus: (s) => seen.push(s.stage) };
}

test("a success reported by the endpoint in use shows only once a second endpoint sees it", async () => {
  let looks = 0;
  const second = fake("second.example", {
    getTransaction: async () => {
      looks += 1;
      return looks < 3 ? notFound(nowSecs()) : success(222n);
    },
  });
  const chain = chainWith(reporting(), second);
  const { seen, onStatus } = stages();
  const out = await chain.submit(signed(), onStatus);
  assert.equal(looks, 3, "the second endpoint is asked until it sees the transaction");
  assert.ok(seen.indexOf("confirming") >= 0 && seen.indexOf("confirming") < seen.indexOf("confirmed"), seen.join(","));
  assert.equal(out.fee, 222n, "the facts shown are the confirming endpoint's");
});

test("a transaction the second endpoint does not know once its window has passed is not confirmed", async () => {
  const maxTime = nowSecs() + 180;
  const chain = chainWith(reporting(), fake("second.example", { getTransaction: async () => notFound(maxTime + 60) }));
  const { seen, onStatus } = stages();
  await assert.rejects(chain.submit(signed(maxTime), onStatus), (error) => error.name === "TxUnconfirmed" && /second\.example does not know it/.test(error.message) && /^[0-9a-f]{64}$/.test(error.hash));
  assert.ok(!seen.includes("confirmed"));
});

test("a failure reported by the second endpoint, or its silence past the window, is not confirmed either", async () => {
  const failed = chainWith(reporting(), fake("second.example", { getTransaction: async () => ({ status: "FAILED", resultXdr: {} }) }));
  await assert.rejects(failed.submit(signed()), (error) => error.name === "TxUnconfirmed" && /reports it failed/.test(error.message));

  // A window already past: the grace after it is spent as soon as the second endpoint fails to answer.
  const down = async () => {
    throw new TypeError("Failed to fetch");
  };
  const silent = chainWith(reporting(), fake("second.example", { getTransaction: down }));
  await assert.rejects(silent.submit(signed(nowSecs() - 120)), (error) => error.name === "TxUnconfirmed" && /did not confirm it in time/.test(error.message));
});

test("with a single endpoint, its answer is the confirmation", async () => {
  const chain = chainWith(reporting());
  const { seen, onStatus } = stages();
  const out = await chain.submit(signed(), onStatus);
  assert.equal(out.fee, 111n);
  assert.ok(seen.includes("confirmed") && !seen.includes("confirming"));
});

test("a repurchase or a seizure reports whether its shares wait in the contract", async () => {
  const chain = new Chain(dep);
  chain.invoke = async () => ({ value: undefined, hash: "abc", seconds: 1, fee: 1n });
  const pending = { fund: dep.contracts.fundShares, to: G, shares: 10_000_000_000n };
  let answer = pending;
  chain.read = async (contract, fn) => {
    if (fn !== "pending_release") throw new Error(`unexpected read ${fn}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  assert.equal((await chain.seize({ address: G }, 5)).deferred, true, "a lender whose approval was revoked: the shares wait");
  answer = null;
  assert.equal((await chain.seize({ address: G }, 5)).deferred, false);
  assert.equal((await chain.repurchase({ address: G }, 6)).deferred, false);
  answer = new TypeError("Failed to fetch");
  assert.equal((await chain.repurchase({ address: G }, 6)).deferred, null, "unknown when the read fails; the write itself succeeded");
});

test("an unconfirmed write reads as such, never as a failure or a success", () => {
  const { text, name } = describeError(new TransactionError("TxUnconfirmed", "second.example did not confirm it in time.", "abc"));
  assert.equal(name, "TxUnconfirmed");
  assert.match(text, /^The transaction was sent and one RPC endpoint reports it confirmed, but a second endpoint did not confirm it\. Check it on the explorer/);
  assert.match(text, /second\.example did not confirm it in time\.$/);
});
