// demo/lib.mjs against a stubbed RPC: the client's methods are replaced in
// process, so nothing reaches the network and no key leaves the test.

import assert from "node:assert/strict";
import { test } from "node:test";

process.env.STELLAR_RPC_URLS = "https://rpc.stub.invalid";
process.env.OPEN_WINDOW_STATE = "offline-test";

const { Address, Keypair, SorobanDataBuilder, nativeToScVal, rpc, scValToNative, xdr } = await import("@stellar/stellar-sdk");
const lib = await import("../lib.mjs");
const { server } = lib;

const OW = "CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W";

/** A parsed simulation as the SDK returns it, built from its raw JSON-RPC shape. */
function simulation({ retval = xdr.ScVal.scvVoid(), auth = [], data = new SorobanDataBuilder().build() } = {}) {
  return rpc.parseRawSimulation({
    id: "1",
    latestLedger: 1000,
    minResourceFee: data.resourceFee.toString(),
    transactionData: data.toXDR("base64"),
    results: [{ auth: auth.map((a) => a.toXDR("base64")), xdr: retval.toXDR("base64") }],
    events: [],
  });
}

const dataKey = (contract, index) =>
  xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(contract).toScAddress(), key: nativeToScVal(index, { type: "u64" }), durability: xdr.ContractDataDurability.persistent }));

test("read simulates from the null account: no role key, no account lookup", async () => {
  const sources = [];
  server.getAccount = async () => {
    throw new Error("a read must not look an account up");
  };
  server.simulateTransaction = async (tx) => {
    sources.push(tx.source);
    return simulation({ retval: nativeToScVal(42, { type: "u32" }) });
  };
  const state = { keys: {}, contracts: {} };
  assert.equal(await lib.read(state, OW, "version"), 42);
  assert.deepEqual(sources, [lib.NULL_ACCOUNT]);
  assert.equal(await lib.probe(state, null, OW, "version"), null);
  // A named role is still the source when a caller asks for it.
  const operator = Keypair.random();
  await lib.read({ keys: { operator: operator.secret() } }, OW, "version", [], "operator");
  assert.equal(sources.at(-1), operator.publicKey());
});

test("ledgerEntries asks for 200 keys at most per call and keeps the order", async () => {
  const keys = Array.from({ length: 450 }, (_, i) => dataKey(OW, i));
  const sizes = [];
  server.getLedgerEntries = async (...asked) => {
    // The RPC refuses more than 200 keys (-32602, "key count (201) exceeds maximum supported (200)").
    if (asked.length > 200) throw new Error(`key count (${asked.length}) exceeds maximum supported (200)`);
    sizes.push(asked.length);
    // Every third key is missing; the others live until 5,000 + their index.
    const entries = asked
      .map((key) => ({ key, index: Number(scValToNative(key.contractData.key)) }))
      .filter(({ index }) => index % 3 !== 0)
      .map(({ key, index }) => ({ key, liveUntilLedgerSeq: 5_000 + index, val: null }));
    return { latestLedger: 1_000 + sizes.length, entries };
  };
  const read = await lib.ledgerEntries(keys);
  assert.deepEqual(sizes, [200, 200, 50]);
  assert.equal(read.latest, 1_003);
  assert.equal(read.entries.length, 450);
  assert.equal(read.entries[0], null);
  assert.equal(read.entries[1].liveUntil, 5_001);
  assert.equal(read.entries[449].liveUntil, 5_449);
  assert.equal(read.entries.filter((e) => e === null).length, 150);
});
