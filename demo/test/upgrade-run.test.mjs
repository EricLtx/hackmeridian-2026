// `npm run upgrade` run as a script, offline, against the chain model of
// test/stub/upgrade-chain.mjs: what it submits, in which order, at what
// rent. Each scenario spawns `node --import ./test/stub/upgrade-chain.mjs
// upgrade.mjs ...` on a disposable state of throwaway random keys and reads
// what the stub saw. It needs the built night_window.wasm in target/ (the
// script reads it); without one the scenarios are skipped, as in CI.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const { Keypair } = await import("@stellar/stellar-sdk");

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WASM = path.join(DEMO, "..", "target", "wasm32v1-none", "release", "night_window.wasm");
const STATE_DIR = path.join(DEMO, ".state");
const STATE_NAME = "offline-stub";
const STATE_FILE = path.join(STATE_DIR, `${STATE_NAME}.json`);
// The monitor file of that disposable instance, never the testnet instance's monitor.json.
const MONITOR_FILE = path.join(STATE_DIR, `monitor-${STATE_NAME}.json`);
const OW = "CBDS6BZ2JOU6AGIR6FSFK6MNIS25DVYYD2ZHHHEWIPXH4ZDCVWWX7XGL";
const RC4 = "f5f13ae69499efdd23ae350d45f4bfe4bb25026bfcb6b44b264a2d3d2effbcea";
const FOREIGN = "fd5cdbd3d02a9c6cc78d672cb81830b45532c43480cd6994d32a28e2cc0429c3"; // another contract's code, drill 8's stand-in
const BUILT = fs.existsSync(WASM) ? createHash("sha256").update(fs.readFileSync(WASM)).digest("hex") : null;
const skip = BUILT ? false : "no target/wasm32v1-none/release/night_window.wasm: `stellar contract build` first";

const roles = Object.fromEntries(["governor", "trustee", "keeper", "operator"].map((r) => [r, Keypair.random()]));
const dirs = [];
after(() => {
  fs.rmSync(STATE_FILE, { force: true });
  fs.rmSync(MONITOR_FILE, { force: true });
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs upgrade.mjs with `args` against the chain `scenario`; returns `{ status, out, log, monitor }`. */
function run(args, scenario, env = {}) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ keys: Object.fromEntries(Object.entries(roles).map(([r, k]) => [r, k.secret()])), contracts: { openWindow: OW } }, null, 2));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-upgrade-"));
  dirs.push(dir);
  const file = path.join(dir, "scenario.json");
  const logFile = path.join(dir, "log.jsonl");
  fs.writeFileSync(logFile, "");
  fs.writeFileSync(file, JSON.stringify({ ow: OW, trustee: roles.trustee.publicKey(), monitorFile: MONITOR_FILE, ...scenario }));
  fs.writeFileSync(MONITOR_FILE, JSON.stringify({ contract: OW, announced: [], wasmHash: scenario.executable ?? RC4 }, null, 2));
  const base = { ...process.env };
  delete base.NIGHT_WINDOW_STACK_SIZE;
  delete base.CARGO_TARGET_DIR;
  const r = spawnSync(process.execPath, ["--import", "./test/stub/upgrade-chain.mjs", "upgrade.mjs", ...args], {
    cwd: DEMO,
    env: { ...base, STELLAR_RPC_URLS: "https://one.stub.invalid,https://two.stub.invalid", OPEN_WINDOW_STATE: STATE_NAME, UPGRADE_STUB: file, UPGRADE_STUB_LOG: logFile, ...env },
    encoding: "utf8",
    timeout: 120_000,
  });
  const log = fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, log, monitor: JSON.parse(fs.readFileSync(MONITOR_FILE, "utf8")) };
}
const submitted = (log) => log.filter((e) => e.at === "submitted");
const rent = (subs) => subs.filter((s) => s.kind === "extendFootprintTtl").reduce((a, s) => a + s.fee, 0);

test("the default run uploads, extends once to 30 days, announces before proposing, installs, then buys the slices to 91 days and no more: about 706 XLM of rent at 8.40 XLM a day", { skip }, () => {
  const r = run([`--expect=${BUILT}`], { executable: RC4, pending: null, codes: {}, jumpAfterPropose: 301 });
  assert.equal(r.status, 0, r.out);
  const subs = submitted(r.log);
  const kinds = subs.map((s) => s.fn ?? s.kind);
  assert.deepEqual(kinds.slice(0, 4), ["upload", "extendFootprintTtl", "propose_upgrade", "upgrade"], kinds.join(", "));
  assert.equal(subs[0].hash, BUILT);
  assert.equal(Math.round(subs[1].extendToDays), 30);
  assert.deepEqual(subs[2].auth, ["sorobanCredentialsSourceAccount", "sorobanCredentialsAddress"], "the governor through the transaction, the trustee's own entry");
  assert.deepEqual(r.log.filter((e) => e.at === "simulate propose_upgrade").map((e) => e.announcedBefore), [true, true], "announced before the proposal's simulations");
  assert.equal(subs[3].contract, "installed");
  const after = subs.slice(4);
  assert.equal(after.length, 3, `three slices of 20.3 days after the upgrade, not 30/60/90/120: ${after.map((s) => s.extendToDays.toFixed(2)).join(", ")}`);
  assert.ok(after.every((s) => s.kind === "extendFootprintTtl" && s.keys.length === 1 && s.keys[0] === `code:${BUILT}` && s.fee <= 400.2));
  assert.ok(Math.abs(after.at(-1).extendToDays - 91) < 0.01, `the last slice aims at 91 days: ${after.at(-1).extendToDays}`);
  const life = Number(/has ([\d.]+) days to live/.exec(r.out)?.[1]);
  assert.ok(life >= 90 && life <= 91, r.out);
  const paid = rent(subs);
  assert.ok(paid > 700 && paid < 710, `${paid.toFixed(1)} XLM of rent (84 days at 8.4), not the 950 of the slices that overshot to 120 days`);
  assert.ok(subs.filter((s) => s.kind === "extendFootprintTtl").every((s) => s.source === roles.keeper.publicKey()), "the keeper pays the rent");
  assert.deepEqual([r.monitor.announced, r.monitor.wasmHash], [[BUILT], BUILT]);
  assert.deepEqual(r.log.filter((e) => e.refused), [], "nothing left the process");
});

test("--apply from a 29.99-day life buys three slices to 91 days, about 512 XLM, and the pending upgrade to other code is refused before anything is signed", { skip }, () => {
  const r = run(["--apply", `--expect=${BUILT}`], { executable: RC4, pending: { hash: BUILT, etaOffset: -10 }, codes: { [BUILT]: 29.99 } });
  assert.equal(r.status, 0, r.out);
  const subs = submitted(r.log);
  assert.deepEqual([subs[0].fn, subs[0].args, subs[0].contract], ["upgrade", [BUILT], "installed"]);
  const slices = subs.slice(1);
  assert.equal(slices.length, 3, slices.map((s) => s.extendToDays.toFixed(2)).join(", "));
  assert.ok(Math.abs(slices.at(-1).extendToDays - 91) < 0.01);
  const paid = rent(subs);
  assert.ok(paid > 505 && paid < 520, `${paid.toFixed(1)} XLM: 61 days at 8.4`);
  assert.ok(Number(/has ([\d.]+) days to live/.exec(r.out)?.[1]) >= 90, r.out);
  // Drill 8's stand-in pending instead: refused, one read, nothing submitted.
  const foreign = run(["--apply", `--expect=${BUILT}`], { executable: RC4, pending: { hash: FOREIGN, etaOffset: -10 }, codes: { [FOREIGN]: 100 } });
  assert.equal(foreign.status, 1, foreign.out);
  assert.match(foreign.out, /the pending upgrade is fd5cdbd3.*not the built and expected night_window.wasm/);
  assert.deepEqual(submitted(foreign.log), []);
});

test("--restore-code pays for the code both endpoints say the instance runs; an endpoint that names another code is refused before anything is signed", { skip }, () => {
  // Honest endpoints, the code archived: a RestoreFootprint on exactly that entry, then the slices to 91 days.
  const r = run(["--restore-code"], { executable: BUILT, pending: null, codes: { [BUILT]: null } });
  assert.equal(r.status, 0, r.out);
  const subs = submitted(r.log);
  assert.deepEqual([subs[0].kind, subs[0].keys], ["restoreFootprint", [`code:${BUILT}`]]);
  assert.ok(subs[0].fee <= 100.2);
  assert.ok(subs.slice(1).every((s) => s.kind === "extendFootprintTtl" && s.keys[0] === `code:${BUILT}`));
  assert.ok(Number(/has ([\d.]+) days to live/.exec(r.out)?.[1]) >= 90, r.out);
  assert.ok(r.log.filter((e) => e.rpc === "getLedgerEntries").some((e) => e.at.startsWith("https://two.")), "the second endpoint was asked for the executable");
  // The active endpoint reports another executable, archived: nothing is restored, nothing paid.
  const lie = run(["--restore-code"], { executable: BUILT, lieExecutable: FOREIGN, pending: null, codes: { [FOREIGN]: null, [BUILT]: 50 } });
  assert.equal(lie.status, 1, lie.out);
  assert.match(lie.out, /the endpoints disagree on the code the instance runs: https:\/\/one\.stub\.invalid says fd5cdbd3.*https:\/\/two\.stub\.invalid says .*nothing restored/);
  assert.deepEqual(submitted(lie.log), [], "the keeper paid for nothing");
  // Both endpoints lying alike cannot be told apart, but --expect can: the operator names the code.
  const named = run(["--restore-code", `--expect=${BUILT}`], { executable: BUILT, lieExecutable: FOREIGN, lieAt: "https://", pending: null, codes: { [FOREIGN]: null, [BUILT]: 50 } });
  assert.equal(named.status, 1, named.out);
  assert.match(named.out, /the instance runs fd5cdbd3.*not the expected .*nothing restored/);
  assert.deepEqual(submitted(named.log), []);
});
