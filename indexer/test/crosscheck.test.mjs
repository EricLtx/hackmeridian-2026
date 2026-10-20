// The journal against an independent endpoint, both ways and by content
// (rpc-6): what the chain and the anchor cannot say.

import assert from "node:assert/strict";
import { test } from "node:test";

import { chainLine } from "../lib/chain.mjs";
import { compareTrail } from "../lib/crosscheck.mjs";
import { plain } from "../lib/decode.mjs";

const CONTRACT = "CBDS6BZ2JOU6AGIR6FSFK6MNIS25DVYYD2ZHHHEWIPXH4ZDCVWWX7XGL";

/** An event in the journal's form, as decodeEvent gives it. */
const event = (ledger, n, name, data = { amount: "100" }) => ({
  ledger,
  closedAt: "2026-10-27T10:00:00Z",
  txHash: `${n}`.padStart(64, "a"),
  id: `${String(ledger).padStart(10, "0")}0000000000-${String(n).padStart(10, "0")}`,
  contract: CONTRACT,
  topics: [name, "12"],
  data,
});

/** Journal lines chained from events, as the indexer writes them. */
function journal(events) {
  const lines = [];
  for (const e of events) lines.push(chainLine(lines.at(-1) ?? null, e));
  return lines;
}

const served = [event(100, 1, "repo_opened"), event(105, 2, "repo_valued"), event(110, 3, "repo_repurchased")];

test("a journal that matches the endpoint line for line raises nothing", () => {
  const result = compareTrail(journal(served), served, { from: 100, to: 110 });
  assert.deepEqual(result, { checked: 3, missing: [], unknown: [], altered: [] });
});

test("an event the endpoint serves and the journal lacks is missing", () => {
  const result = compareTrail(journal([served[0], served[2]]), served, { from: 100, to: 110 });
  assert.deepEqual(result.missing.map((e) => e.id), [served[1].id]);
  assert.deepEqual([result.unknown, result.altered], [[], []]);
});

test("a journal line the endpoint does not know is unknown: an event a hostile RPC made up", () => {
  const injected = event(107, 9, "pause_changed", { paused: true });
  const lines = journal([served[0], served[1], injected, served[2]]);
  const result = compareTrail(lines, served, { from: 100, to: 110 });
  assert.deepEqual(result.unknown.map((l) => [l.seq, l.id]), [[3, injected.id]]);
  assert.deepEqual(result.missing, []);
});

test("a line whose topics, data, ledger or transaction differ is altered, field by field", () => {
  const forged = journal([served[0], { ...served[1], data: { amount: "999" } }, { ...served[2], topics: ["repo_seized", "12"], txHash: "b".repeat(64) }]);
  const result = compareTrail(forged, served, { from: 100, to: 110 });
  assert.deepEqual(result.altered.map((d) => [d.seq, d.name, d.fields]), [[2, "repo_valued", ["data"]], [3, "repo_seized", ["txHash", "topics"]]]);
  // Key order and the journal's chain fields do not count, only the content.
  const reordered = journal([{ ...served[0], data: { amount: "100" } }]);
  assert.deepEqual(compareTrail(reordered, [served[0]], { from: 100, to: 100 }).altered, []);
});

test("only the ledgers both sides cover are compared", () => {
  // The endpoint keeps from ledger 105; the journal ends at ledger 105.
  const result = compareTrail(journal(served.slice(0, 2)), served.slice(1), { from: 105, to: 105 });
  assert.deepEqual(result, { checked: 1, missing: [], unknown: [], altered: [] });
});

test("plain is shared by the indexer and the monitor: bytes, big integers and maps come out as the journal writes them", () => {
  const value = new Map([["amount", 5n], ["hash", Buffer.from([1, 2])]]);
  assert.deepEqual(plain([value, 7n, null]), [{ amount: "5", hash: "0102" }, "7", null]);
});
