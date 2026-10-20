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
function recorder({ executable = null, pending = null, now = 1_000, held = null, life = null, readings = null } = {}) {
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
    // What each endpoint says the instance runs: both the same, unless `readings` says otherwise.
    executableHashes: async () => {
      calls.push(["executables"]);
      return readings ?? [{ url: "https://one.stub.invalid", hex: held ?? executable }, { url: "https://two.stub.invalid", hex: held ?? executable }];
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
  // Apply: after the upgrade, the slices that reach 91 days, counted once from the target: three of 20.4 days from 29.9, never a fourth.
  const applied = recorder({ pending: { wasm_hash: Buffer.from(sha(SHIPPED), "hex"), eta: 1_000n }, held: sha(SHIPPED), life: 29.9 });
  const lines = [];
  applied.log = (line) => lines.push(line);
  await upgrade.apply(state, { wasm: SHIPPED, expect: sha(SHIPPED), env: CLEAN, io: applied });
  assert.deepEqual(applied.calls.filter(([kind]) => kind === "extend"), [["extend", sha(SHIPPED), 29.9, 50.3], ["extend", sha(SHIPPED), 50.3, 70.6], ["extend", sha(SHIPPED), 70.6, 91]]);
  const extendedAfter = applied.calls.findIndex(([kind]) => kind === "extend");
  assert.ok(extendedAfter > applied.calls.findIndex(([kind, , fn]) => kind === "invoke" && fn === "upgrade"), "extended once installed");
  assert.ok(lines.at(-1).startsWith(`code ${sha(SHIPPED).slice(0, 12)}… has 91.0 days to live (at least 90`), lines.at(-1));
});

test("the slices are counted once from the target, 91 days, and never overshoot to 120: an upgrade run rents about 84 days, 706 XLM at 8.40 XLM a day", () => {
  const rent = (slices, from) => (slices.at(-1) - from) * 8.4;
  // The default run: the upload's 7 days to 30 before the proposal, then from 30.00 (read a ledger or more later) to 91.
  assert.deepEqual(upgrade.codeSlices(7, 30), [30]);
  const afterUpgrade = upgrade.codeSlices(29.9998, 91);
  assert.equal(afterUpgrade.length, 3);
  assert.equal(afterUpgrade.at(-1), 91);
  assert.ok(afterUpgrade.every((d, i) => d - (i ? afterUpgrade[i - 1] : 29.9998) <= 30 + 1e-9), "each slice at most 30 days, under the 400 XLM cap");
  const total = rent([30], 7) + rent(afterUpgrade, 29.9998);
  assert.ok(total > 700 && total < 710, `${total.toFixed(1)} XLM, not the 950 of 7 -> 30 -> 60 -> 90 -> 120`);
  // --apply from 29.99 days: three slices to 91, 61 days of rent; from 89.99, one short slice, not a 30-day one.
  assert.deepEqual(upgrade.codeSlices(29.99, 91).map((d) => Number(d.toFixed(2))), [50.33, 70.66, 91]);
  assert.deepEqual(upgrade.codeSlices(89.99, 91), [91]);
  // At or past the target: nothing to buy. The old loop bought a slice at 89.99.
  assert.deepEqual(upgrade.codeSlices(91, 91), []);
  assert.deepEqual(upgrade.codeSlices(100, 91), []);
  assert.deepEqual(upgrade.codeSlices(null, 91), []);
  assert.equal(upgrade.CODE_TTL_MARGIN_DAYS, 1);
});

test("a slice the rent made shorter is followed by one more round of counting, never an endless one", async () => {
  // The recorder's extension grants only half of what is asked, as a fallback under the fee cap would.
  const io = recorder({ executable: sha(SHIPPED), life: 60 });
  io.extendCode = async (hex, fromDays, toDays) => {
    io.calls.push(["extend", Number(fromDays.toFixed(1)), Number(toDays.toFixed(1))]);
    const granted = fromDays + (toDays - fromDays) / 2;
    io.codeLife = async () => granted;
    return { days: granted, fee: 1n, seconds: 1, hash: "cd".repeat(32) };
  };
  await assert.rejects(upgrade.keepCodeAlive(io, sha(SHIPPED)), /still has .* days to live after two rounds of extensions/);
  assert.deepEqual(io.calls.filter(([kind]) => kind === "extend"), [["extend", 60, 75.5], ["extend", 67.8, 91], ["extend", 79.4, 91]]);
});

test("--restore-code restores exactly the instance's own archived code, then extends it; a live code is only extended (TOOL-4)", async () => {
  const archived = recorder({ executable: sha(SHIPPED), life: null });
  assert.ok((await upgrade.restoreCode(state, { io: archived })) >= 90);
  assert.deepEqual(archived.calls, [["executables"], ["restore", sha(SHIPPED)], ["extend", sha(SHIPPED), 7, 35], ["extend", sha(SHIPPED), 35, 63], ["extend", sha(SHIPPED), 63, 91]]);
  const live = recorder({ executable: sha(SHIPPED), life: 100 });
  assert.equal(await upgrade.restoreCode(state, { io: live }), 100);
  assert.deepEqual(live.calls, [["executables"]]);
});

test("--restore-code pays only for a code two endpoints agree on, or one endpoint and --expect: a lying or silent endpoint restores nothing", async () => {
  const one = "https://one.stub.invalid";
  const two = "https://two.stub.invalid";
  const ours = sha(SHIPPED);
  const theirs = sha(FOREIGN_CODE);
  // The active endpoint names another code, archived: the keeper would have restored and rented it.
  const lying = recorder({ life: null, readings: [{ url: one, hex: theirs }, { url: two, hex: ours }] });
  await assert.rejects(upgrade.restoreCode(state, { io: lying }), new RegExp(`the endpoints disagree on the code the instance runs: ${one} says ${theirs}, ${two} says ${ours}; nothing restored`));
  assert.deepEqual(lying.calls, [["executables"]]);
  // A second endpoint that could not say: nothing restored either.
  const silent = recorder({ life: null, readings: [{ url: one, hex: ours }, { url: two, hex: null, error: "fetch failed" }] });
  await assert.rejects(upgrade.restoreCode(state, { io: silent }), new RegExp(`${two} could not say which code the instance runs \\(fetch failed\\): nothing restored`));
  assert.deepEqual(silent.calls, [["executables"]]);
  // --expect contradicted by both endpoints: the operator's word wins, nothing paid.
  const contradicted = recorder({ executable: theirs, life: null });
  await assert.rejects(upgrade.restoreCode(state, { expect: ours, io: contradicted }), new RegExp(`the instance runs ${theirs}, not the expected ${ours}: nothing restored`));
  await assert.rejects(upgrade.restoreCode(state, { expect: "abc", io: contradicted }), /--expect takes a sha256 in hex, 64 characters, not abc; nothing restored/);
  assert.deepEqual(contradicted.calls, [["executables"], ["executables"]]);
  // One endpoint configured: its word alone is refused; with --expect naming the same code, accepted.
  const single = recorder({ life: null, readings: [{ url: one, hex: ours }] });
  await assert.rejects(upgrade.restoreCode(state, { io: single }), new RegExp(`rests on ${one} alone: pass --expect=<sha256> .* or list a second endpoint in STELLAR_RPC_URLS; nothing restored`));
  assert.deepEqual(single.calls, [["executables"]]);
  assert.ok((await upgrade.restoreCode(state, { expect: ours.toUpperCase(), io: single })) >= 90);
  assert.deepEqual(single.calls[2], ["restore", ours]);
  // The pure rule, for the record.
  assert.equal(upgrade.codeToRestore([{ url: one, hex: ours }, { url: two, hex: ours }]), ours);
  assert.equal(upgrade.codeToRestore([{ url: one, hex: ours }], ours), ours);
});
