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

/**
 * The chain and the monitor's file as a recorder: every call, in order.
 * `life` is the days the code entry has to live (null: not uploaded, or
 * archived); an upload leaves 7, as on testnet, and an extension what it asked.
 */
function recorder({ executable = null, pending = null, now = 1_000, held = null, life = null } = {}) {
  const calls = [];
  const reads = { pending_upgrade: pending, schema_version: 2 };
  let days = life;
  return {
    calls,
    upload: async () => {
      calls.push(["upload"]);
      days = 7;
    },
    codeLife: async () => days,
    extendCode: async (hex, fromDays, toDays) => {
      calls.push(["extend", hex, Number(fromDays.toFixed(1)), Number(toDays.toFixed(1))]);
      days = toDays;
      return { days: toDays, fee: 2_570_000_000n, seconds: 1, hash: "cd".repeat(32) };
    },
    restoreCode: async (hex) => {
      calls.push(["restore", hex]);
      days = 7;
      return { fee: 600_000_000n, seconds: 1, hash: "ef".repeat(32) };
    },
    invoke: async (role, fn, args = []) => {
      calls.push(["invoke", role, fn, ...args.map((a) => (a.type === "scvBytes" ? Buffer.from(scValToNative(a)).toString("hex") : a.type))]);
      if (fn === "propose_upgrade") reads.pending_upgrade = { wasm_hash: Buffer.from(scValToNative(args[0])), eta: BigInt(now + 300) };
      return { seconds: 1, hash: "ab".repeat(32) };
    },
    read: async (fn) => {
      calls.push(["read", fn]);
      return typeof reads[fn] === "function" ? reads[fn]() : reads[fn];
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
  assert.deepEqual(io.calls.filter(([kind]) => kind !== "extend"), [["executable"], ["upload"], ["announce", sha(SHIPPED)], ["invoke", "governor", "propose_upgrade", sha(SHIPPED)], ["read", "pending_upgrade"]]);
  // Already running that code: nothing to propose.
  const same = recorder({ executable: sha(SHIPPED) });
  assert.equal(await upgrade.propose(state, { wasm: SHIPPED, expect: sha(SHIPPED), env: CLEAN, io: same }), null);
  assert.deepEqual(same.calls, [["executable"]]);
});

// drill 8's stand-in for hostile code: the hash of another contract's WASM.
const FOREIGN_CODE = wasmWith(65_536, { salt: 8 });

test("apply installs only the built and expected code: a pending upgrade to other code is refused before anything is signed (TOOL-2)", async () => {
  const io = recorder({ pending: { wasm_hash: Buffer.from(sha(FOREIGN_CODE), "hex"), eta: 1_000n } });
  await assert.rejects(
    upgrade.apply(state, { wasm: SHIPPED, expect: sha(SHIPPED), env: CLEAN, io }),
    new RegExp(`the pending upgrade is ${sha(FOREIGN_CODE)}, not the built and expected night_window.wasm ${sha(SHIPPED)}: nothing signed`),
  );
  assert.deepEqual(io.calls, [["read", "pending_upgrade"]]);
  // Swapped during the delay: refused again right before the governor would sign.
  const answers = [{ wasm_hash: Buffer.from(sha(SHIPPED), "hex"), eta: 1_000n }, { wasm_hash: Buffer.from(sha(FOREIGN_CODE), "hex"), eta: 1_000n }];
  const swapped = recorder();
  swapped.read = async (fn) => {
    swapped.calls.push(["read", fn]);
    return answers.shift();
  };
  await assert.rejects(upgrade.apply(state, { wasm: SHIPPED, expect: sha(SHIPPED), env: CLEAN, io: swapped }), /nothing signed/);
  assert.equal(swapped.calls.some(([kind]) => kind === "invoke"), false);
  // Once the expected code is the one pending, it is installed, and the monitor's baseline follows.
  const ours = recorder({ pending: { wasm_hash: Buffer.from(sha(SHIPPED), "hex"), eta: 1_000n }, held: sha(SHIPPED), life: 95 });
  await upgrade.apply(state, { wasm: SHIPPED, expect: sha(SHIPPED), env: CLEAN, io: ours });
  assert.deepEqual(ours.calls.filter(([kind]) => kind === "invoke"), [["invoke", "governor", "upgrade", sha(SHIPPED)]]);
  assert.ok(ours.calls.some(([kind, hex]) => kind === "acknowledge" && hex === sha(SHIPPED)));
});

test("the new code gets one 30-day slice right after the upload, and slices to 90 days after the upgrade (TOOL-4)", async () => {
  // Propose: upload (the network's 7 days), then one slice, before the announcement and the proposal.
  const io = recorder({ executable: "f5".repeat(32) });
  await upgrade.propose(state, { wasm: SHIPPED, expect: sha(SHIPPED), env: CLEAN, io });
  assert.deepEqual(io.calls.slice(0, 4), [["executable"], ["upload"], ["extend", sha(SHIPPED), 7, 30], ["announce", sha(SHIPPED)]]);
  // Code uploaded earlier and still alive: no second upload, and no slice it does not need.
  const again = recorder({ executable: "f5".repeat(32), life: 45 });
  await upgrade.propose(state, { wasm: SHIPPED, expect: sha(SHIPPED), env: CLEAN, io: again });
  assert.equal(again.calls.some(([kind]) => kind === "upload" || kind === "extend"), false);
  // Apply: after the upgrade, 30-day slices until 90 days or more, never past 120.
  const applied = recorder({ pending: { wasm_hash: Buffer.from(sha(SHIPPED), "hex"), eta: 1_000n }, held: sha(SHIPPED), life: 29.9 });
  const lines = [];
  applied.log = (line) => lines.push(line);
  await upgrade.apply(state, { wasm: SHIPPED, expect: sha(SHIPPED), env: CLEAN, io: applied });
  assert.deepEqual(applied.calls.filter(([kind]) => kind === "extend"), [["extend", sha(SHIPPED), 29.9, 59.9], ["extend", sha(SHIPPED), 59.9, 89.9], ["extend", sha(SHIPPED), 89.9, 119.9]]);
  const extendedAfter = applied.calls.findIndex(([kind]) => kind === "extend");
  assert.ok(extendedAfter > applied.calls.findIndex(([kind, , fn]) => kind === "invoke" && fn === "upgrade"), "extended once installed");
  assert.ok(lines.at(-1).startsWith(`code ${sha(SHIPPED).slice(0, 12)}… has 119.9 days to live (at least 90`), lines.at(-1));
});

test("--restore-code restores exactly the instance's own archived code, then extends it; a live code is only extended (TOOL-4)", async () => {
  const archived = recorder({ executable: sha(SHIPPED), life: null });
  assert.ok((await upgrade.restoreCode(state, { io: archived })) >= 90);
  assert.deepEqual(archived.calls, [["executable"], ["restore", sha(SHIPPED)], ["extend", sha(SHIPPED), 7, 37], ["extend", sha(SHIPPED), 37, 67], ["extend", sha(SHIPPED), 67, 97]]);
  const live = recorder({ executable: sha(SHIPPED), life: 100 });
  assert.equal(await upgrade.restoreCode(state, { io: live }), 100);
  assert.deepEqual(live.calls, [["executable"]]);
});
