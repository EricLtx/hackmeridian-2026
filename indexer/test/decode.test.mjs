import assert from "node:assert/strict";
import { test } from "node:test";

import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";

import { chainLine, verifyChain } from "../lib/chain.mjs";
import { decodeEvent, eventName } from "../lib/decode.mjs";
import { eventsTable, registry } from "../lib/views.mjs";

const CONTRACT = "CBDS6BZ2JOU6AGIR6FSFK6MNIS25DVYYD2ZHHHEWIPXH4ZDCVWWX7XGL";
const FUND = "CAEXP2UGZVWDXIVOMSZSE5MDSTD5LRBU55FPTERGFSPHTMKONBNJ5XHB";
const LENDER = "GCUGRDNQC6H57MYVVZJZKAV7VCCWWOTXEAYUOCI6EU7XVQSELO65642R";
const BORROWER = "GAOLESTCJHYYSTQ5G3IM46B4KT33RM22JEQXVIF5KHZF5DTTOB3MYZNN";

const field = (key, val) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
const i128 = (v) => nativeToScVal(BigInt(v), { type: "i128" });
const u64 = (v) => nativeToScVal(BigInt(v), { type: "u64" });

/** A `getEvents` entry as the RPC returns it, for an event of the contract. */
const raw = (ledger, n, topic, value) => ({
  ledger,
  ledgerClosedAt: "2026-10-27T10:00:00Z",
  txHash: `${n}`.padStart(64, "a"),
  id: `${String(ledger).padStart(10, "0")}0000000000-${String(n).padStart(10, "0")}`,
  contractId: CONTRACT,
  topic,
  value,
});

// rc5 adds `repo_valued` (contracts/night-window/src/events.rs), published by
// open_repo right after `repo_opened`. The indexer has no rule per event: it
// journals the name, the topics and every field as they come.
test("rc5's repo_valued event is journaled field by field, and leaves the registry as it was", () => {
  const opened = decodeEvent(
    raw(
      5_300_000,
      1,
      [xdr.ScVal.scvSymbol("repo_opened"), u64(12), new Address(BORROWER).toScVal()],
      xdr.ScVal.scvMap([
        field("fund", new Address(FUND).toScVal()),
        field("lender", new Address(LENDER).toScVal()),
        field("maturity", u64(1_800_086_400)),
        field("offer_id", u64(2)),
        field("principal", i128(9_000_000_000)),
        field("rate_bps", nativeToScVal(300, { type: "u32" })),
        field("shares", i128(10_000_000_000)),
      ]),
    ),
  );
  const valued = decodeEvent(
    raw(
      5_300_000,
      2,
      [xdr.ScVal.scvSymbol("repo_valued"), u64(12), new Address(FUND).toScVal()],
      xdr.ScVal.scvMap([
        field("fx", i128("111880000000000")),
        field("fx_applied", i128("111980000000000")),
        field("fx_time", u64(1_799_999_000)),
        field("haircut_bps", nativeToScVal(400, { type: "u32" })),
        field("nav", i128("108500000000000")),
        field("nav_time", u64(1_799_998_000)),
        field("price", i128("96892302196820")),
      ]),
    ),
  );
  assert.equal(eventName(valued), "repo_valued");
  assert.deepEqual(valued.topics, ["repo_valued", "12", FUND]);
  assert.deepEqual(valued.data, {
    fx: "111880000000000",
    fx_applied: "111980000000000",
    fx_time: "1799999000",
    haircut_bps: 400,
    nav: "108500000000000",
    nav_time: "1799998000",
    price: "96892302196820",
  });

  const first = chainLine(null, opened);
  const lines = [first, chainLine(first, valued)];
  assert.equal(verifyChain(lines).ok, true);
  // The repo registry is rebuilt from the lifecycle events: the valuation adds nothing to its row.
  assert.deepEqual(registry(lines), registry([first]));
  const table = eventsTable(lines);
  assert.equal(table[1].event, "repo_valued");
  assert.equal(table[1].topics, JSON.stringify(["12", FUND]));
  assert.equal(JSON.parse(table[1].data).price, "96892302196820");
});

// rc5 adds `fallback` to repo_valued (review finding VAL-5): true when the
// fund's backup feed supplied the NAV, the primary being stale or silent.
test("repo_valued's fallback field is journaled as a boolean, both ways", () => {
  const valued = (fallback) =>
    decodeEvent(
      raw(
        5_300_100,
        3,
        [xdr.ScVal.scvSymbol("repo_valued"), u64(13), new Address(FUND).toScVal()],
        xdr.ScVal.scvMap([
          field("fallback", xdr.ScVal.scvBool(fallback)),
          field("fx", i128(0)),
          field("fx_applied", i128(0)),
          field("fx_time", u64(0)),
          field("haircut_bps", nativeToScVal(150, { type: "u32" })),
          field("nav", i128("100200000000000")),
          field("nav_time", u64(1_800_000_000)),
          field("price", i128("100200000000000")),
        ]),
      ),
    );
  assert.equal(valued(true).data.fallback, true);
  assert.equal(valued(false).data.fallback, false);
  assert.equal(JSON.parse(eventsTable([chainLine(null, valued(true))])[0].data).fallback, true);
});
