import assert from "node:assert/strict";
import { test } from "node:test";

import { GENESIS, canonical, chainLine, hashLine, verifyChain } from "../lib/chain.mjs";

const CONTRACT = "CBDS6BZ2JOU6AGIR6FSFK6MNIS25DVYYD2ZHHHEWIPXH4ZDCVWWX7XGL";
const event = (ledger, index, name, topics, data) => ({
  ledger,
  closedAt: `2026-10-15T21:4${index}:00Z`,
  txHash: `${index}`.repeat(64),
  id: `${String(ledger).padStart(10, "0")}0000000000-${String(index).padStart(10, "0")}`,
  contract: CONTRACT,
  topics: [name, ...topics],
  data,
});

function sample() {
  const e1 = event(100, 0, "offer_created", ["1", "GLENDER"], { amount: "3000000000000", max_term: "604800", rate_bps: 250, stablecoin: "CEURO" });
  const e2 = event(101, 1, "repo_opened", ["1", "GBORROWER"], { fund: "CFUND", lender: "GLENDER", maturity: "1792104297", offer_id: "1", principal: "9000000000", rate_bps: 250, shares: "10000000000" });
  const e3 = event(102, 2, "repo_repurchased", ["1"], { interest: "1998", principal: "9000000000" });
  const l1 = chainLine(null, e1);
  const l2 = chainLine(l1, e2);
  const l3 = chainLine(l2, e3);
  return [l1, l2, l3];
}

test("canonical JSON sorts keys at every depth and ignores key order", () => {
  assert.equal(canonical({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[1,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonical({ x: 1, y: "2" }), canonical({ y: "2", x: 1 }));
});

test("the first line hashes from the genesis prevHash and each line chains to the previous one", () => {
  const [l1, l2, l3] = sample();
  assert.equal(l1.seq, 1);
  assert.equal(l1.prevHash, GENESIS);
  assert.equal(l2.prevHash, l1.hash);
  assert.equal(l3.prevHash, l2.hash);
  assert.match(l3.hash, /^[0-9a-f]{64}$/);
  assert.equal(hashLine(l3), l3.hash);
  const result = verifyChain([l1, l2, l3]);
  assert.deepEqual(result, { ok: true, lines: 3, lastHash: l3.hash, break: null });
});

test("the hash is stable: same content, same hash, whatever the key order on disk", () => {
  const [l1] = sample();
  const shuffled = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(l1).reverse())));
  assert.equal(hashLine(shuffled), l1.hash);
});

test("an altered field breaks the chain at that line", () => {
  const lines = sample();
  lines[1].data.principal = "9000000001"; // one unit more borrowed
  const result = verifyChain(lines);
  assert.equal(result.ok, false);
  assert.equal(result.break.seq, 2);
  assert.match(result.break.reason, /hash does not match/);
  assert.equal(result.lastHash, lines[0].hash);
});

test("a removed line breaks the chain where the gap is", () => {
  const lines = sample();
  const result = verifyChain([lines[0], lines[2]]);
  assert.equal(result.ok, false);
  assert.equal(result.break.seq, 3);
  assert.match(result.break.reason, /seq 3, expected 2/);
});

test("a line rewritten with a fresh hash still breaks the next line", () => {
  const lines = sample();
  lines[1].data.principal = "1";
  lines[1].hash = hashLine(lines[1]); // the forger recomputes this line's hash
  const result = verifyChain(lines);
  assert.equal(result.ok, false);
  assert.equal(result.break.seq, 3);
  assert.match(result.break.reason, /prevHash/);
});

test("an inserted line out of ledger order is refused", () => {
  const [l1, l2] = sample();
  const late = chainLine(l2, { ...event(100, 5, "pause_changed", [], { paused: true, by: "GX" }) });
  const result = verifyChain([l1, l2, late]);
  assert.equal(result.ok, false);
  assert.match(result.break.reason, /order/);
});

test("an empty journal verifies to the genesis hash", () => {
  assert.deepEqual(verifyChain([]), { ok: true, lines: 0, lastHash: GENESIS, break: null });
});
