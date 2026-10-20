// Two endpoints configured: the second reading the monitor takes before it
// acts goes to the other endpoint only, never through the failover client.

import assert from "node:assert/strict";
import { test } from "node:test";

process.env.STELLAR_RPC_URLS = "https://one.stub.invalid,https://two.stub.invalid";
process.env.OPEN_WINDOW_STATE = "offline-test";

const { Address, SorobanDataBuilder, nativeToScVal, rpc, xdr } = await import("@stellar/stellar-sdk");
const lib = await import("../lib.mjs");

const OW = "CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W";

function simulation(retval) {
  const data = new SorobanDataBuilder().build();
  return rpc.parseRawSimulation({ id: "1", latestLedger: 10, minResourceFee: "0", transactionData: data.toXDR("base64"), results: [{ auth: [], xdr: retval.toXDR("base64") }], events: [] });
}

test("the second reading goes to the other endpoint only, from the null account", async () => {
  const [one, two] = lib.rpcServers;
  const asked = [];
  one.simulateTransaction = async () => {
    asked.push("one");
    return simulation(nativeToScVal(false));
  };
  two.simulateTransaction = async (tx) => {
    asked.push(["two", tx.source]);
    return simulation(nativeToScVal(true));
  };
  two.getLatestLedger = async () => ({ sequence: 42, closeTime: "1800000000" });
  assert.equal(lib.activeRpcUrl(), "https://one.stub.invalid");
  const index = lib.secondEndpoint();
  assert.equal(index, 1);
  const client = lib.endpointClient(index);
  assert.equal(client.url, "https://two.stub.invalid");
  assert.equal(await client.read(OW, "is_paused"), true);
  assert.equal(await lib.read({ keys: {} }, OW, "is_paused"), false);
  assert.deepEqual(asked, [["two", lib.NULL_ACCOUNT], "one"]);
  assert.equal((await client.latestLedger()).sequence, 42);
});

test("the second endpoint's ledger entries are read there, 200 keys at a time", async () => {
  const [one, two] = lib.rpcServers;
  one.getLedgerEntries = async () => {
    throw new Error("the first endpoint must not be asked");
  };
  const sizes = [];
  two.getLedgerEntries = async (...keys) => {
    sizes.push(keys.length);
    return { latestLedger: 7, entries: [] };
  };
  const keys = Array.from({ length: 201 }, (_, i) =>
    xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(OW).toScAddress(), key: nativeToScVal(i, { type: "u64" }), durability: xdr.ContractDataDurability.persistent })),
  );
  const read = await lib.endpointClient(1).ledgerEntries(keys);
  assert.deepEqual(sizes, [200, 1]);
  assert.equal(read.entries.every((e) => e === null), true);
});
