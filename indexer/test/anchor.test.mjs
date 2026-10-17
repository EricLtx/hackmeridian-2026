import assert from "node:assert/strict";
import { test } from "node:test";

import { Account, Keypair, Networks, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

import {
  anchorDataKey,
  anchorInEnvelope,
  anchorOperation,
  anchorRecord,
  anchorTransaction,
  checkAnchorAgainstJournal,
  dataEntryValue,
  dataLedgerKey,
  hashBytes,
} from "../lib/anchor.mjs";
import { chainLine, hashLine } from "../lib/chain.mjs";

const CONTRACT = "CBDS6BZ2JOU6AGIR6FSFK6MNIS25DVYYD2ZHHHEWIPXH4ZDCVWWX7XGL";
const ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const event = (ledger, index, name, topics, data) => ({
  ledger,
  closedAt: `2026-10-15T21:4${index}:00Z`,
  txHash: `${index}`.repeat(64),
  id: `${String(ledger).padStart(10, "0")}0000000000-${String(index).padStart(10, "0")}`,
  contract: CONTRACT,
  topics: [name, ...topics],
  data,
});

function journal() {
  const l1 = chainLine(null, event(100, 0, "offer_created", ["1", "GLENDER"], { amount: "3000000000000", rate_bps: 250 }));
  const l2 = chainLine(l1, event(101, 1, "repo_opened", ["1", "GBORROWER"], { principal: "9000000000", shares: "10000000000" }));
  const l3 = chainLine(l2, event(102, 2, "repo_repurchased", ["1"], { interest: "1998", principal: "9000000000" }));
  return [l1, l2, l3];
}

const anchorOf = (lines, n) => anchorRecord({ at: "2026-10-17T15:00:00Z", ledger: 5_000_000, txHash: "ab".repeat(32), account: ACCOUNT, dataKey: anchorDataKey(CONTRACT), hash: lines[n - 1].hash, lines: n });

test("the data key is the prefix plus the first 8 characters of the contract id, within the 64-byte limit", () => {
  const key = anchorDataKey(CONTRACT);
  assert.equal(key, "openwindow.indexer.CBDS6BZ2");
  assert.ok(Buffer.byteLength(key) <= 64);
  assert.throws(() => anchorDataKey("GNOTACONTRACT"), /not a contract id/);
});

test("the manageData operation carries the key and the 32 raw bytes of the hash", () => {
  const [, , l3] = journal();
  const op = anchorOperation(CONTRACT, l3.hash);
  const parsed = Operation.fromXDRObject(op);
  assert.equal(parsed.type, "manageData");
  assert.equal(parsed.name, "openwindow.indexer.CBDS6BZ2");
  const value = Buffer.from(parsed.value);
  assert.equal(value.length, 32);
  assert.equal(value.toString("hex"), l3.hash);
  assert.throws(() => hashBytes("abc"), /32-byte hex hash/);
  assert.throws(() => hashBytes(l3.hash.toUpperCase()), /32-byte hex hash/);
});

test("the anchor transaction is one manageData at the base fee with a validity window and the line count in the memo", () => {
  const [, , l3] = journal();
  const tx = anchorTransaction(new Account(ACCOUNT, "41"), CONTRACT, l3.hash, 3);
  assert.equal(tx.operations.length, 1);
  assert.equal(tx.operations[0].type, "manageData");
  assert.equal(tx.operations[0].name, "openwindow.indexer.CBDS6BZ2");
  assert.equal(Buffer.from(tx.operations[0].value).toString("hex"), l3.hash);
  assert.equal(tx.fee, "100");
  assert.equal(tx.sequence, "42");
  assert.equal(tx.memo.type, "text");
  assert.equal(Buffer.from(tx.memo.value).toString("utf8"), "ow-indexer lines=3");
  assert.ok(Number(tx.timeBounds.maxTime) > Date.now() / 1000);
  assert.equal(tx.networkPassphrase, Networks.TESTNET);
});

test("the anchor is read back from a signed envelope, and an envelope without it yields null", () => {
  const [, , l3] = journal();
  const key = Keypair.random();
  const tx = anchorTransaction(new Account(key.publicKey(), "7"), CONTRACT, l3.hash, 3);
  tx.sign(key);
  const envelope = tx.toXDR();
  const found = anchorInEnvelope(envelope, anchorDataKey(CONTRACT));
  assert.deepEqual(found, { account: key.publicKey(), dataKey: anchorDataKey(CONTRACT), hash: l3.hash });
  assert.equal(anchorInEnvelope(envelope, "openwindow.indexer.OTHER"), null);
  // Round trip through the SDK's parser: the same bytes come back.
  const parsed = TransactionBuilder.fromXDR(envelope, Networks.TESTNET);
  assert.equal(Buffer.from(parsed.operations[0].value).toString("hex"), l3.hash);
});

test("check (a): the anchored hash is recomputed from the journal line it names", () => {
  const lines = journal();
  assert.equal(checkAnchorAgainstJournal(anchorOf(lines, 3), lines).ok, true);
  assert.equal(checkAnchorAgainstJournal(anchorOf(lines, 2), lines).ok, true);
  // The journal grew since: an older anchor still holds.
  const grown = [...lines, chainLine(lines[2], event(103, 3, "pause_changed", [], { paused: true }))];
  assert.equal(checkAnchorAgainstJournal(anchorOf(lines, 3), grown).ok, true);
});

test("check (a) fails when the line was altered, when the journal is shorter, or when the anchor names another hash", () => {
  const lines = journal();
  const anchor = anchorOf(lines, 3);

  const altered = journal();
  altered[2].data.interest = "1";
  let result = checkAnchorAgainstJournal(anchor, altered);
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not hash to its own hash field/);

  altered[2].hash = hashLine(altered[2]); // the forger recomputes the line's hash: the anchor still disagrees
  result = checkAnchorAgainstJournal(anchor, altered);
  assert.equal(result.ok, false);
  assert.match(result.reason, /anchor says/);

  result = checkAnchorAgainstJournal(anchor, lines.slice(0, 2));
  assert.equal(result.ok, false);
  assert.match(result.reason, /journal has 2 line\(s\)/);

  result = checkAnchorAgainstJournal({ ...anchor, lines: 0 }, lines);
  assert.equal(result.ok, false);
  result = checkAnchorAgainstJournal({ ...anchor, hash: "00".repeat(32) }, lines);
  assert.equal(result.ok, false);
  assert.match(result.reason, /anchor says 0000000000000000/);
});

test("the record keeps the documented fields in order and nothing else", () => {
  const record = anchorRecord({ hash: "aa".repeat(32), extra: "dropped", lines: 3, at: "t", ledger: 1, txHash: "h", account: ACCOUNT, dataKey: "k" });
  assert.deepEqual(Object.keys(record), ["at", "ledger", "txHash", "account", "dataKey", "hash", "lines"]);
  assert.equal(record.extra, undefined);
});

test("the data entry read back from the ledger yields the raw bytes, whatever the XDR accessor shape", () => {
  const [, , l3] = journal();
  const key = Keypair.random();
  const entry = xdr.LedgerEntryData.data(
    new xdr.DataEntry({
      accountId: key.xdrAccountId(),
      dataName: anchorDataKey(CONTRACT),
      dataValue: hashBytes(l3.hash),
      ext: xdr.DataEntryExt.fromXDR(Buffer.alloc(4)),
    }),
  );
  const parsed = xdr.LedgerEntryData.fromXDR(entry.toXDR("base64"), "base64");
  assert.equal(dataEntryValue(parsed).toString("hex"), l3.hash);
  // Method-shaped accessors (older js-xdr) read the same way.
  const methodShaped = { switch: () => ({ name: "data" }), data: () => ({ dataValue: () => hashBytes(l3.hash) }) };
  assert.equal(dataEntryValue(methodShaped).toString("hex"), l3.hash);
  assert.equal(dataEntryValue(null), null);
  assert.equal(dataEntryValue(xdr.LedgerEntryData.fromXDR(entry.toXDR("base64"), "base64").toXDR("base64")), null);
  // The ledger key names the account and the data name.
  const ledgerKey = dataLedgerKey(key.publicKey(), anchorDataKey(CONTRACT));
  const roundTrip = xdr.LedgerKey.fromXDR(ledgerKey.toXDR("base64"), "base64");
  assert.equal(roundTrip.type, "data");
  assert.equal(String(roundTrip.data.dataName), anchorDataKey(CONTRACT));
});
