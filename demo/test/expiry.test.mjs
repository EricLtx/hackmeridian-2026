// send() with two endpoints configured (review finding TOOL-1, 20 October
// 2026): the expiry of a co-signer's signature comes from the lower of both
// endpoints' heads, and endpoints that disagree refuse the signature; a
// transaction the active endpoint does not know is called expired only when
// the second endpoint does not know it either.

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

process.env.STELLAR_RPC_URLS = "https://one.stub.invalid,https://two.stub.invalid";
process.env.OPEN_WINDOW_STATE = "offline-test";

const { Account, Address, Keypair, Networks, Operation, SorobanDataBuilder, TransactionBuilder, rpc, xdr } = await import("@stellar/stellar-sdk");
const lib = await import("../lib.mjs");
const [one, two] = lib.rpcServers;

const OW = "CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W";
const FOREIGN = "CC7LI6WZLFGUXHZ6LSUSOC2KGBIH65ZRKQOKXEFT6DUOJWESHHHNMH5D";
const roles = Object.fromEntries(["governor", "steward"].map((r) => [r, Keypair.random()]));
const state = { keys: Object.fromEntries(Object.entries(roles).map(([r, k]) => [r, k.secret()])), contracts: { openWindow: OW } };

function callOf(contract, fn, args) {
  const tx = new TransactionBuilder(new Account(roles.governor.publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args }))
    .setTimeout(0)
    .build();
  return tx.operations[0].func.invokeContract;
}

/** The steward's unsigned address-credential entry over `call`, as a simulation records it. */
const stewardEntry = (call) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: new Address(roles.steward.publicKey()).toScAddress(), nonce: xdr.Int64.fromString("7"), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid() })),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call), subInvocations: [] }),
  });

const args = [lib.sv.address(FOREIGN)];
let auth;
let simulations;
let sent;
beforeEach(() => {
  auth = [];
  simulations = 0;
  sent = [];
  one.getAccount = async (publicKey) => new Account(publicKey, "100");
  one.simulateTransaction = async () => {
    simulations += 1;
    const data = new SorobanDataBuilder().setReadWrite([lib.storageKey(OW)]).setResourceFee(1_000_000n).build();
    return rpc.parseRawSimulation({ id: String(simulations), latestLedger: 1_000, minResourceFee: "1000000", transactionData: data.toXDR("base64"), results: [{ auth: auth.map((a) => a.toXDR("base64")), xdr: xdr.ScVal.scvVoid().toXDR("base64") }], events: [] });
  };
  one.sendTransaction = async (tx) => {
    sent.push(tx);
    return { status: "PENDING" };
  };
  one.getTransaction = async () => ({ status: "SUCCESS", returnValue: xdr.ScVal.scvVoid() });
  one.getLatestLedger = async () => ({ sequence: 1_004, closeTime: "1800000000" });
  two.getLatestLedger = async () => ({ sequence: 1_000, closeTime: "1800000000" });
  two.getTransaction = async () => ({ status: "NOT_FOUND" });
});

test("a co-signer's signature expires 100 ledgers past the lower of the two endpoints' heads", async () => {
  auth = [stewardEntry(callOf(OW, "co_signed_test", args))];
  await lib.invoke(state, "governor", OW, "co_signed_test", args, { cosigners: ["steward"] });
  assert.equal(sent.length, 1);
  const [entry] = sent[0].operations[0].auth;
  assert.equal(Number(entry.credentials.address.signatureExpirationLedger), 1_100);
});

test("endpoints further apart than rpcLedgerGap, or a silent second endpoint, refuse the signature", async () => {
  auth = [stewardEntry(callOf(OW, "co_signed_test", args))];
  // The active endpoint announces a head far ahead: the signature would live as long.
  one.getLatestLedger = async () => ({ sequence: 4_000_000_000, closeTime: "1800000000" });
  await assert.rejects(
    lib.invoke(state, "governor", OW, "co_signed_test", args, { cosigners: ["steward"] }),
    /is at ledger 4000000000 and https:\/\/two\.stub\.invalid at 1000, more than 10 apart: the expiry of the signatures cannot be trusted; nothing signed \(rpc-1\)$/,
  );
  one.getLatestLedger = async () => ({ sequence: 1_004, closeTime: "1800000000" });
  two.getLatestLedger = async () => {
    throw new Error("bad request");
  };
  await assert.rejects(lib.invoke(state, "governor", OW, "co_signed_test", args, { cosigners: ["steward"] }), /https:\/\/two\.stub\.invalid did not give its latest ledger \(bad request\).*nothing signed \(rpc-1\)/);
  assert.equal(simulations, 2, "one simulation per attempt: no signed entry went out");
  assert.equal(sent.length, 0);
});

test("a transaction the active endpoint does not know, but the second one does, is never called expired", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_800_000_000_000 });
  one.getTransaction = async () => ({ status: "NOT_FOUND" });
  two.getTransaction = async () => ({ status: "SUCCESS" });
  let verdict;
  lib.invoke(state, "governor", OW, "unpause_test", []).then(() => { verdict = "landed"; }, (error) => { verdict = error.message; });
  for (let second = 0; second < 300 && verdict === undefined; second += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1_000);
  }
  assert.doesNotMatch(verdict ?? "", /nothing changed on chain/);
  assert.match(verdict ?? "", /https:\/\/one\.stub\.invalid does not know transaction [0-9a-f]{64}, https:\/\/two\.stub\.invalid says SUCCESS: the endpoints disagree; check it in the explorer before rerunning the step/);
  // Both silent: then it expired, once this machine's clock is past the window.
  two.getTransaction = async () => ({ status: "NOT_FOUND" });
  verdict = undefined;
  lib.invoke(state, "governor", OW, "unpause_test", []).then(() => { verdict = "landed"; }, (error) => { verdict = error.message; });
  for (let second = 0; second < 300 && verdict === undefined; second += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1_000);
  }
  assert.match(verdict ?? "", /expired before landing; nothing changed on chain, rerun the step$/);
});
