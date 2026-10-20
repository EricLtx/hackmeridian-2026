// A write shows as confirmed only once a second RPC endpoint sees it: the
// endpoint in use could report SUCCESS for a transaction it never forwarded.
// Silence from the other endpoints is not a contradiction: the write then
// ends as applied according to the endpoint in use alone, never confirmed,
// and the page is free again. A contradiction (a failure, or a transaction
// unknown past its window) stands only once the endpoint in use, asked
// again, still reports the success. No network: the endpoints are
// stand-ins, the transaction is built locally.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Account, Keypair, Networks, Operation, SorobanDataBuilder, TransactionBuilder, nativeToScVal } from "@stellar/stellar-sdk";
import { Chain, keypairSigner, unverifiedText } from "../src/chain.js";
import { TransactionError, describeError } from "../src/errors.js";
import { setLang } from "../src/i18n.js";

const dep = JSON.parse(readFileSync(new URL("../public/deployment.testnet.json", import.meta.url), "utf8"));
const G = "GAOLESTCJHYYSTQ5G3IM46B4KT33RM22JEQXVIF5KHZF5DTTOB3MYZNN";
const fake = (host, server) => ({ url: `https://${host}`, host, server, lastMs: null, failures: 0 });
const nowSecs = () => Math.floor(Date.now() / 1000);
const down = async () => {
  throw new TypeError("Failed to fetch");
};

/** A transaction valid until `maxTime`, as the wallet would return it signed. */
const signed = (maxTime = nowSecs() + 180) =>
  new TransactionBuilder(new Account(G, "1"), { fee: "100", networkPassphrase: Networks.TESTNET, timebounds: { minTime: 0, maxTime } })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .build();

// getTransaction answers as the SDK returns them: every one carries the endpoint's latest close time.
const success = (fee, closeTime = nowSecs()) => ({ status: "SUCCESS", ledger: 10, latestLedgerCloseTime: String(closeTime), resultXdr: { feeCharged: fee } });
const failure = (closeTime = nowSecs()) => ({ status: "FAILED", ledger: 10, latestLedgerCloseTime: String(closeTime), resultXdr: {} });
const notFound = (closeTime) => ({ status: "NOT_FOUND", latestLedger: 10, latestLedgerCloseTime: String(closeTime) });

/** The endpoint in use accepts the transaction and reports it applied (or what `answer` returns, asked again). */
const reporting = (host = "first.example", answer = () => success(111n)) => fake(host, { sendTransaction: async () => ({ status: "PENDING" }), getTransaction: async () => answer() });

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

/** `promise`, or a rejection once `ms` have passed: the code before the silence rule waited out the whole window. */
function within(promise, ms) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
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
  assert.equal(out.unverified, undefined);
});

test("silence from the other endpoint ends the wait after silentMs, as applied by one endpoint only, whichever endpoint is in use", async () => {
  for (const active of [0, 1]) {
    // active 1: the page failed over to the second endpoint, and the first one is down.
    const endpoints = active === 0 ? [reporting(), fake("second.example", { getTransaction: down })] : [fake("first.example", { getTransaction: down, sendTransaction: down }), reporting("second.example")];
    const chain = chainWith(...endpoints);
    chain.active = active;
    chain.silentMs = 200;
    const { seen, onStatus } = stages();
    const started = Date.now();
    const out = await within(chain.submit(signed(nowSecs() + 180), onStatus), 3000);
    assert.ok(Date.now() - started < 3000, `active ${active}: settled after ${Date.now() - started} ms, not at the end of the window`);
    assert.deepEqual(out.unverified, active === 0 ? { host: "first.example", others: "second.example" } : { host: "second.example", others: "first.example" });
    assert.equal(out.fee, 111n, "the facts are those of the endpoint that reports it applied");
    assert.ok(seen.includes("unverified") && !seen.includes("confirmed"), `active ${active}: ${seen.join(",")}`);
  }
});

test("silence past the window is silence too, not a contradiction", async () => {
  const chain = chainWith(reporting(), fake("second.example", { getTransaction: down }));
  const { seen, onStatus } = stages();
  const out = await within(chain.submit(signed(nowSecs() - 120), onStatus), 3000);
  assert.deepEqual(out.unverified, { host: "first.example", others: "second.example" });
  assert.ok(!seen.includes("confirmed"));
});

test("an endpoint that answers while it catches up is still waited for, past silentMs", async () => {
  let looks = 0;
  const second = fake("second.example", {
    getTransaction: async () => {
      looks += 1;
      return looks < 6 ? notFound(nowSecs()) : success(444n);
    },
  });
  const chain = chainWith(reporting(), second);
  chain.silentMs = 1;
  const out = await chain.submit(signed());
  assert.equal(out.fee, 444n);
  assert.equal(out.unverified, undefined, "an answer, even NOT_FOUND, is not silence");
});

test("a failure the second endpoint reports is a contradiction once the endpoint in use, asked again, still reports the success", async () => {
  let asked = 0;
  const first = reporting("first.example", () => {
    asked += 1;
    return success(111n);
  });
  const chain = chainWith(first, fake("second.example", { getTransaction: async () => failure() }));
  const { seen, onStatus } = stages();
  await assert.rejects(chain.submit(signed(), onStatus), (error) => error.name === "TxUnconfirmed" && /second\.example reports it failed/.test(error.message));
  assert.ok(asked >= 2, `the endpoint in use is asked again before the contradiction is told (asked ${asked} times)`);
  assert.ok(!seen.includes("confirmed") && !seen.includes("unverified"));
});

test("a failure both endpoints report, the endpoint in use asked again, is the transaction's failure", async () => {
  let asked = 0;
  const first = reporting("first.example", () => {
    asked += 1;
    return asked === 1 ? success(111n) : failure();
  });
  const chain = chainWith(first, fake("second.example", { getTransaction: async () => failure() }));
  await assert.rejects(chain.submit(signed()), (error) => error.name === "TxFailed");
});

test("a transaction the second endpoint does not know is a contradiction once the endpoint in use has also closed a ledger past the window", async () => {
  // The window has passed by every clock: the second endpoint would know a transaction that landed.
  const maxTime = nowSecs() - 60;
  const chain = chainWith(reporting(), fake("second.example", { getTransaction: async () => notFound(nowSecs()) }));
  const { seen, onStatus } = stages();
  await assert.rejects(chain.submit(signed(maxTime), onStatus), (error) => error.name === "TxUnconfirmed" && /second\.example does not know it/.test(error.message) && /^[0-9a-f]{64}$/.test(error.hash));
  assert.ok(!seen.includes("confirmed"));
});

test("the second endpoint alone cannot end a write: a close time past the window that the endpoint in use has not reached is waited out", async () => {
  // Gateway.fm, say, claims ledgers past the window three minutes early; the endpoint in use reads the real time.
  const maxTime = nowSecs() + 180;
  let looks = 0;
  const second = fake("second.example", {
    getTransaction: async () => {
      looks += 1;
      return looks < 4 ? notFound(maxTime + 6) : success(555n);
    },
  });
  const chain = chainWith(reporting(), second);
  const out = await within(chain.submit(signed(maxTime)), 3000);
  assert.equal(out.fee, 555n, "the write is confirmed once the second endpoint sees it");
  assert.equal(looks, 4);
});

test("an endpoint that answers but never sees the transaction is not confirmed past the window", async () => {
  // It lags (its own close time is old) and the window plus its grace is over: TxUnconfirmed, as before.
  const maxTime = nowSecs() - 40;
  const chain = chainWith(reporting(), fake("second.example", { getTransaction: async () => notFound(maxTime - 100) }));
  await assert.rejects(chain.submit(signed(maxTime)), (error) => error.name === "TxUnconfirmed" && /did not confirm it in time/.test(error.message));
});

test("with a single endpoint, its answer is the confirmation", async () => {
  const chain = chainWith(reporting());
  const { seen, onStatus } = stages();
  const out = await chain.submit(signed(), onStatus);
  assert.equal(out.fee, 111n);
  assert.ok(seen.includes("confirmed") && !seen.includes("confirming"));
});

test("a contract call applied by one endpoint only keeps its value and says so (invoke, the path of both views)", async () => {
  const kp = Keypair.random();
  const retval = nativeToScVal(7n, { type: "u64" });
  const first = fake("first.example", {
    getAccount: async () => new Account(kp.publicKey(), "1"),
    simulateTransaction: async () => ({
      latestLedger: 1,
      minResourceFee: "1000000",
      transactionData: new SorobanDataBuilder().setResourceFee(1_000_000n).build().toXdr("base64"),
      results: [{ auth: [], xdr: retval.toXDR("base64") }],
    }),
    sendTransaction: async () => ({ status: "PENDING" }),
    getTransaction: async () => ({ ...success(123n), returnValue: retval }),
  });
  const chain = chainWith(first, fake("second.example", { getTransaction: down }));
  chain.silentMs = 50;
  const out = await within(chain.openRepo(keypairSigner(kp), { offerId: 1, shares: 1n, principal: 1n, term: 3600 }), 3000);
  assert.equal(out.repoId, 7);
  assert.equal(out.fee, 123n);
  assert.deepEqual(out.unverified, { host: "first.example", others: "second.example" });
});

test("a write applied by one endpoint only reads as such in the three languages", () => {
  assert.equal(unverifiedText("a.example"), "Applied according to a.example; no second endpoint could confirm it.");
  try {
    setLang("fr");
    assert.equal(unverifiedText("a.example"), "Appliquée selon a.example ; aucun second point d'accès n'a pu la confirmer.");
    setLang("es");
    assert.equal(unverifiedText("a.example"), "Aplicada según a.example; ningún segundo punto de acceso pudo confirmarla.");
  } finally {
    setLang("en");
  }
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
