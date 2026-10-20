// `npm run upgrade` offline: the WASM it may install (review finding STATE-2,
// 20 October 2026) and the order of its steps, with the chain and the
// monitor's file replaced by a recorder. No network, no key.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

process.env.STELLAR_RPC_URLS = "https://rpc.stub.invalid";
process.env.OPEN_WINDOW_STATE = "offline-test";

const { scValToNative } = await import("@stellar/stellar-sdk");
const lib = await import("../lib.mjs");
const upgrade = await import("../upgrade.mjs");

const OW = "CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W";
const state = { keys: {}, contracts: { openWindow: OW } };
const CLEAN = {};

/** A signed LEB128 number. */
function sleb(n) {
  const out = [];
  for (let v = BigInt(n); ; ) {
    const byte = Number(v & 0x7fn);
    v >>= 7n;
    const done = (v === 0n && (byte & 0x40) === 0) || (v === -1n && (byte & 0x40) !== 0);
    out.push(done ? byte : byte | 0x80);
    if (done) return out;
  }
}

/** A WASM module with a memory of `pages` and a first global `i32.const stack`; `salt` sets its hash apart. */
function wasmWith(stack, { pages = 2, salt = 0 } = {}) {
  const memory = [0x01, 0x00, pages];
  const global = [0x01, 0x7f, 0x01, 0x41, ...sleb(stack), 0x0b];
  const custom = [0x04, ...Buffer.from("salt"), salt];
  return Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x05, memory.length, ...memory, 0x06, global.length, ...global, 0x00, custom.length, ...custom]);
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

const SHIPPED = wasmWith(65_536);
const CANARY = wasmWith(8_192);

/** The chain and the monitor's file as a recorder: every call, in order. */
function recorder({ executable = null, pending = null, now = 1_000, held = null } = {}) {
  const calls = [];
  const reads = { pending_upgrade: pending, schema_version: 2 };
  return {
    calls,
    upload: async () => calls.push(["upload"]),
    invoke: async (role, fn, args = []) => {
      calls.push(["invoke", role, fn, ...args.map((a) => (a.type === "scvBytes" ? Buffer.from(scValToNative(a)).toString("hex") : a.type))]);
      if (fn === "propose_upgrade") reads.pending_upgrade = { wasm_hash: Buffer.from(scValToNative(args[0])), eta: BigInt(now + 300) };
      return { seconds: 1, hash: "ab".repeat(32) };
    },
    read: async (fn) => {
      calls.push(["read", fn]);
      return reads[fn];
    },
    ledgerTime: async () => now + 600,
    sleep: async () => {},
    executableHash: async () => {
      calls.push(["executable"]);
      return held ?? executable;
    },
    announce: (hex) => calls.push(["announce", hex]),
    acknowledge: (hex) => calls.push(["acknowledge", hex]),
    expectedSchema: () => 2,
    log: () => {},
  };
}

test("the stack global is read as the contract's layout test reads it", () => {
  assert.deepEqual(lib.wasmMemoryLayout(SHIPPED), { pages: 2, stack: 65_536 });
  assert.deepEqual(lib.wasmMemoryLayout(CANARY), { pages: 2, stack: 8_192 });
  assert.deepEqual(lib.wasmMemoryLayout(wasmWith(1_024, { pages: 1 })), { pages: 1, stack: 1_024 });
  assert.throws(() => lib.wasmMemoryLayout(Buffer.from("not wasm")), /not a WASM module/);
});

test("only the expected build, with the shipped stack, in a clean environment, may be upgraded to (STATE-2)", () => {
  const ok = lib.checkUpgradeWasm(SHIPPED, sha(SHIPPED).toUpperCase(), CLEAN);
  assert.deepEqual([ok.hex, ok.stack, ok.size], [sha(SHIPPED), 65_536, SHIPPED.length]);
  assert.throws(() => lib.checkUpgradeWasm(SHIPPED, undefined, CLEAN), /--expect=<sha256> is required/);
  assert.throws(() => lib.checkUpgradeWasm(SHIPPED, "abc", CLEAN), /--expect takes a sha256 in hex/);
  assert.throws(() => lib.checkUpgradeWasm(SHIPPED, sha(CANARY), CLEAN), new RegExp(`the built night_window.wasm is ${sha(SHIPPED)}, not the expected ${sha(CANARY)}`));
  // The canary's WASM left in target/: its hash is not the tag's, and its stack says why.
  assert.throws(() => lib.checkUpgradeWasm(CANARY, sha(SHIPPED), CLEAN), /linked with a 8192-byte stack, not the expected/);
  // An operator who passes the canary's own hash still meets the stack.
  assert.throws(() => lib.checkUpgradeWasm(CANARY, sha(CANARY), CLEAN), /starts its stack pointer at 8192, not the shipped 65536 bytes/);
  for (const name of lib.BUILD_VARIABLES) {
    assert.throws(() => lib.checkUpgradeWasm(SHIPPED, sha(SHIPPED), { [name]: "8192" }), new RegExp(`^Error: ${name} is set \\(8192\\)`));
  }
  assert.equal(lib.checkUpgradeWasm(SHIPPED, sha(SHIPPED), { NIGHT_WINDOW_STACK_SIZE: "", CARGO_TARGET_DIR: "" }).hex, sha(SHIPPED));
});

test("propose and apply refuse before any chain call, and propose uploads, announces, then proposes the expected build (STATE-2)", async () => {
  for (const [wasm, expect, env] of [[SHIPPED, undefined, CLEAN], [CANARY, sha(SHIPPED), CLEAN], [SHIPPED, sha(SHIPPED), { NIGHT_WINDOW_STACK_SIZE: "8192" }], [SHIPPED, sha(SHIPPED), { CARGO_TARGET_DIR: "target-canary" }]]) {
    const io = recorder({ pending: { wasm_hash: Buffer.from(sha(SHIPPED), "hex"), eta: 1n } });
    await assert.rejects(upgrade.propose(state, { wasm, expect, env, io }), /nothing uploaded or signed/);
    await assert.rejects(upgrade.apply(state, { wasm, expect, env, io }), /nothing uploaded or signed/);
    assert.deepEqual(io.calls, []);
  }
  const io = recorder({ executable: "f5".repeat(32) });
  const proposed = await upgrade.propose(state, { wasm: SHIPPED, expect: sha(SHIPPED), env: CLEAN, io });
  assert.equal(proposed.hex, sha(SHIPPED));
  assert.deepEqual(io.calls, [["executable"], ["upload"], ["announce", sha(SHIPPED)], ["invoke", "governor", "propose_upgrade", sha(SHIPPED)], ["read", "pending_upgrade"]]);
  // Already running that code: nothing to propose.
  const same = recorder({ executable: sha(SHIPPED) });
  assert.equal(await upgrade.propose(state, { wasm: SHIPPED, expect: sha(SHIPPED), env: CLEAN, io: same }), null);
  assert.deepEqual(same.calls, [["executable"]]);
});
