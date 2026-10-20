// Governed upgrade of the Open Window demo instance on testnet (decision S7,
// S15, S29): upload the built WASM, announce it to the monitor, propose it
// with the governor and the trustee, wait for the time delay, upgrade, then
// run `migrate` when the stored layout is behind the code, and check the
// executable hash the ledger holds. A running monitor watch merges the
// announcement and the new code baseline itself: no restart is needed.
//
//   npm run upgrade -- --expect=<sha256>             propose, wait for the delay, upgrade, migrate
//   npm run upgrade -- --propose --expect=<sha256>   propose and announce only
//   npm run upgrade -- --apply --expect=<sha256>     upgrade and migrate a proposal whose delay has elapsed
//   npm run upgrade -- --restore-code                restore the instance's own code if archived, then extend it
//                                                    (two endpoints must agree on that code, or --expect=<sha256> names it)
//
// `--expect` is the sha256 of night_window.wasm as `stellar contract build`
// produces it at the release tag, in a clean shell. The built WASM must be
// exactly that build, linked with the shipped 64 KiB stack, before anything
// is uploaded, proposed or installed; and the script refuses to run while
// NIGHT_WINDOW_STACK_SIZE or CARGO_TARGET_DIR is set (review finding
// STATE-2, 20 October 2026). `--restore-code` reads no build and needs none.
//
// The code entry is kept alive (review finding TOOL-4): the upload leaves it
// at the network's minimum time to live (7 days on testnet), so it is
// extended by one 30-day slice right after the upload, and after the
// upgrade in slices of at most 30 days, counted once from the 90 days the
// monitor keeps plus a day of margin, so that the run buys 91 days of life
// and not a slice more: about 84 days of rent in all, 706 XLM at 8.40 XLM a
// day (20 October 2026), paid by the keeper (the operator without one). Once
// archived, every invocation would need a restore of the code, which the
// footprint rule of the tooling refuses: `--restore-code` restores exactly
// that entry, under its own cap.
//
// Exits never wait for the migration: the contract keeps repurchase, seizure
// and release open between `upgrade` and `migrate` (decision S6). New offers
// and repos answer SchemaOutdated meanwhile, and the monitor raises a
// critical alert until `migrate` has run.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODE_RESTORE_MAX_FEE,
  CODE_SLICE_MAX_FEE,
  Operation,
  STATE_DIR,
  STATE_NAME,
  UPLOAD_MAX_FEE,
  WASM_DIR,
  activeEndpoint,
  checkUpgradeWasm,
  codeKey,
  endpointClient,
  explorer,
  extendCode,
  invoke,
  ledgerEntries,
  ledgerTime,
  loadState,
  read,
  restoreEntries,
  secondEndpoint,
  send,
  sleep,
  storageKey,
  sv,
} from "./lib.mjs";
import { CODE_MAX_DAYS, CODE_STEP_DAYS, LEDGER_SECS, LIMITS } from "./detectors.mjs";
import { acknowledgeUpgrade, announceUpgrade, monitorFileName } from "./monitor-state.mjs";

// The file the monitor's watch of this instance reads (monitor.mjs names it the same way).
const MONITOR_FILE = path.join(STATE_DIR, monitorFileName(STATE_NAME));

/** The WASM hash the ledger holds as the executable of `contractId`, read through `reader` (the failover client by default). */
async function executableHash(contractId, reader = ledgerEntries) {
  const head = await reader([storageKey(contractId)]);
  const raw = head.entries[0]?.value?.contractData?.val?.instance?.executable?.wasmHash;
  if (!raw) return null;
  return typeof raw.toXDR === "function" ? raw.toXDR("hex") : Buffer.from(raw).toString("hex");
}

/**
 * The executable of `contractId` as each endpoint reports it, the active one
 * first, then the second one when configured: `[{ url, hex }]`, `hex` null
 * when that endpoint could not say (an unreadable instance, a failed read).
 * Each is asked directly, never through the failover client, so no endpoint
 * vouches for itself.
 */
async function executableHashes(contractId) {
  const indexes = [activeEndpoint(), secondEndpoint()].filter((i) => i !== null);
  return Promise.all(indexes.map(async (index) => {
    const client = endpointClient(index);
    try {
      return { url: client.url, hex: await executableHash(contractId, client.ledgerEntries) };
    } catch (error) {
      return { url: client.url, hex: null, error: String(error?.message ?? error).split("\n")[0].slice(0, 80) };
    }
  }));
}

/** The schema version the built code expects, read from the source constant, so the script needs no rebuild of the contract crate. */
function expectedSchema() {
  const source = fs.readFileSync(path.join(WASM_DIR, "..", "..", "..", "contracts", "night-window", "src", "lib.rs"), "utf8");
  const m = source.match(/pub const SCHEMA_VERSION: u32 = (\d+);/);
  return m ? Number(m[1]) : 1;
}

/**
 * What the flows do on the chain and on disk, for the instance of `state`;
 * the offline tests replace it (demo/test/upgrade.test.mjs).
 */
export function chainIo(state) {
  const ow = state.contracts.openWindow;
  // Rent is paid by the keeper, an account with no role; older states fall back to the operator.
  const payer = state.keys?.keeper ? "keeper" : "operator";
  return {
    // The upload needs a funded account, not a role: the operator pays it.
    upload: (wasm) => send(state, "operator", Operation.uploadContractWasm({ wasm }), "upload night_window.wasm", { maxResourceFee: UPLOAD_MAX_FEE }),
    /** Days the code entry `hex` has to live, or null when it is archived or missing. */
    codeLife: async (hex) => {
      const read1 = await ledgerEntries([codeKey(hex)]);
      const entry = read1.entries[0];
      const days = entry ? ((entry.liveUntil - read1.latest) * LEDGER_SECS) / 86_400 : null;
      return days === null || days <= 0 ? null : days;
    },
    // One slice at most, a shorter one when the rent has risen (TOOL-6).
    extendCode: (hex, fromDays, toDays) => extendCode(state, payer, codeKey(hex), { fromDays, toDays, maxResourceFee: CODE_SLICE_MAX_FEE }),
    restoreCode: (hex) => restoreEntries(state, payer, [codeKey(hex)], { maxResourceFee: CODE_RESTORE_MAX_FEE }),
    invoke: (role, fn, args = [], options = {}) => invoke(state, role, ow, fn, args, options),
    read: (fn, args = []) => read(state, ow, fn, args),
    ledgerTime,
    sleep,
    executableHash: () => executableHash(ow),
    executableHashes: () => executableHashes(ow),
    // The monitor reports an announced upgrade as a warning, an unannounced
    // one as an attack it cancels; a running watch merges the file (TOOL-3).
    announce: (hex) => announceUpgrade(MONITOR_FILE, hex),
    // The monitor's code baseline moves to the executable the ledger holds.
    acknowledge: (hex) => acknowledgeUpgrade(MONITOR_FILE, hex),
    expectedSchema,
    log: (line) => console.log(line),
  };
}

/**
 * Uploads the built WASM, announces it and proposes it. `wasm` is the bytes
 * of night_window.wasm, `expect` the operator's `--expect`. Returns
 * `{ hex, hash, eta }`, or null when the instance already runs this code.
 */
export async function propose(state, { wasm, expect, env = process.env, io = chainIo(state) }) {
  const built = checkUpgradeWasm(wasm, expect, env);
  io.log(`built WASM ${built.size} bytes, hash ${built.hex}, stack ${built.stack} bytes: the expected build`);
  if ((await io.executableHash()) === built.hex) {
    io.log("the instance already runs this code; nothing to propose");
    return null;
  }
  const uploaded = await io.codeLife(built.hex);
  if (uploaded === null) await io.upload(wasm);
  else io.log(`the code is already uploaded, ${uploaded.toFixed(1)} days to live: upload skipped`);
  // An upload leaves the entry at the network's minimum time to live (7
  // days on testnet): one 30-day slice at once, before anything depends on
  // it (TOOL-4); the rest after the upgrade.
  const life = await io.codeLife(built.hex);
  if (life === null || life < CODE_STEP_DAYS) {
    const r = await io.extendCode(built.hex, life ?? 0, CODE_STEP_DAYS);
    io.log(`new code extended to about ${r.days.toFixed(0)} days${r.fee == null ? "" : `, fee ${(Number(r.fee) / 1e7).toFixed(2)} XLM`}`);
  }
  // Announced before it is proposed: a running watch must never read the
  // proposal before the announcement and cancel it (TOOL-3).
  io.announce(built.hex);
  // The proposal takes the governor and, when named, the trustee: both keys
  // are in the demo state, so the authorization entries are signed here.
  // The trustee is declared: a key signs only what its call expects (rpc-1).
  const r = await io.invoke("governor", "propose_upgrade", [sv.bytes(built.hash)], { cosigners: ["trustee"] });
  const pending = await io.read("pending_upgrade");
  const eta = Number(pending.eta);
  io.log(`announced to the monitor, then proposed in ${r.seconds.toFixed(1)} s; applies at ${new Date(eta * 1000).toISOString()}  ${explorer(r.hash)}`);
  return { hex: built.hex, hash: built.hash, eta };
}

/**
 * Waits for the delay of the pending upgrade, installs it, checks the
 * executable the ledger holds and runs `migrate` when the stored layout is
 * behind. `wasm` and `expect` as for `propose`.
 *
 * Only the code built here, which is the code expected, is installed (review
 * finding TOOL-2, 20 October 2026): the pending slot is single, and a
 * proposal of other code (drill 8's stand-in, a stolen governor key's) may
 * have replaced ours. The pending hash must equal both, before the wait and
 * again right before the governor signs; otherwise nothing is signed.
 */
export async function apply(state, { wasm, expect, env = process.env, io = chainIo(state) }) {
  const built = checkUpgradeWasm(wasm, expect, env);
  const pendingEta = async (say) => {
    const pending = await io.read("pending_upgrade");
    if (!pending) throw new Error("no pending upgrade: run with --propose first");
    const hex = Buffer.from(pending.wasm_hash).toString("hex");
    if (say) io.log(`pending upgrade ${hex}\nbuilt WASM      ${built.hex}\n--expect        ${String(expect).toLowerCase()}`);
    if (hex !== built.hex) throw new Error(`the pending upgrade is ${hex}, not the built and expected night_window.wasm ${built.hex}: nothing signed; the governor cancels it (cancel_upgrade), then propose again`);
    return Number(pending.eta);
  };
  const eta = await pendingEta(true);
  for (;;) {
    const now = await io.ledgerTime();
    if (now >= eta) break;
    io.log(`  waiting ${eta - now} s for the delay`);
    await io.sleep(Math.min(30_000, (eta - now) * 1000 + 1000));
  }
  await pendingEta(false);
  const up = await io.invoke("governor", "upgrade", [sv.bytes(built.hash)]);
  io.log(`upgraded in ${up.seconds.toFixed(1)} s  ${explorer(up.hash)}`);
  const held = await io.executableHash();
  io.log(`ledger executable ${held}`);
  if (held !== built.hex) throw new Error("the ledger holds another executable: stop and investigate");
  io.acknowledge(held);
  io.log("monitor baseline moved to the new executable; a running watch takes it up at its next pass");
  // Pre-rc4 code has no schema_version: read it through the new code, after the upgrade.
  const version = Number(await io.read("schema_version"));
  const expected = io.expectedSchema();
  if (version < expected) {
    const m = await io.invoke("governor", "migrate", [], { cosigners: ["trustee"] });
    io.log(`migrated schema ${version} -> ${await io.read("schema_version")} in ${m.seconds.toFixed(1)} s  ${explorer(m.hash)}`);
  } else {
    io.log(`schema ${version}: nothing to migrate`);
  }
  await keepCodeAlive(io, built.hex);
}

/**
 * Days of margin above `LIMITS.codeTtlDays` the run aims at: each slice is
 * read back a ledger or more later, so a run aimed at exactly 90 days would
 * read 89.99 and buy a whole slice more.
 */
export const CODE_TTL_MARGIN_DAYS = 1;

/**
 * The lives, in days, the slices that take a code entry from `life` days to
 * at least `target` aim at: the fewest slices of at most `step` days, equal
 * sized, counted once from the target. From 30 days to 91, three slices of
 * 20.33 days (61 days of rent); from 7 days, three of 28. A code already at
 * the target gets none. Pure, for the tests.
 */
export function codeSlices(life, target, step = CODE_STEP_DAYS) {
  if (!Number.isFinite(life)) return [];
  const need = target - life;
  if (!(need > 0)) return [];
  const count = Math.ceil(need / step);
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? target : life + (need * (i + 1)) / count));
}

/**
 * Extends the code entry `hex` until it has at least `LIMITS.codeTtlDays`
 * (90) to live, the policy the monitor keeps, then prints its time to live
 * and returns it in days (TOOL-4). The slices are counted once from the
 * target plus `CODE_TTL_MARGIN_DAYS`, so the run never buys a slice past
 * it: an upgrade costs the rent of about 84 days, not of 113. A slice the
 * rent made shorter (`extendCode` falls back under its cap) is followed by
 * one more round of counting, never an endless one.
 */
export async function keepCodeAlive(io, hex) {
  let life = await io.codeLife(hex);
  if (life === null) throw new Error(`the code ${hex.slice(0, 12)}… is archived or missing: npm run upgrade -- --restore-code`);
  const target = Math.min(LIMITS.codeTtlDays + CODE_TTL_MARGIN_DAYS, CODE_MAX_DAYS);
  for (let round = 0; life < LIMITS.codeTtlDays; round += 1) {
    if (round === 2) throw new Error(`the code ${hex.slice(0, 12)}… still has ${life.toFixed(1)} days to live after two rounds of extensions; the rent moves faster than the slices: extend it by hand`);
    const plan = codeSlices(life, target);
    io.log(`  ${plan.length} slice${plan.length === 1 ? "" : "s"} to ${target} days: ${plan.map((d) => d.toFixed(1)).join(", ")}`);
    for (const toDays of plan) {
      const r = await io.extendCode(hex, life, toDays);
      const before = life;
      life = await io.codeLife(hex);
      if (life === null || life <= before) throw new Error(`the code ${hex.slice(0, 12)}… did not gain a day of life from its extension; extend it by hand`);
      io.log(`  code extended to ${life.toFixed(1)} days${r.fee == null ? "" : `, fee ${(Number(r.fee) / 1e7).toFixed(2)} XLM`}`);
    }
  }
  io.log(`code ${hex.slice(0, 12)}… has ${life.toFixed(1)} days to live (at least ${LIMITS.codeTtlDays}: the monitor's keeper extends it from there)`);
  return life;
}

/**
 * The code entry `--restore-code` pays for: the instance's executable as two
 * endpoints report it, in agreement, or as one endpoint reports it when
 * `--expect` names the same hash. One endpoint's word alone is never enough
 * (review finding TOOL-1, and the TOOL-4 residual of 20 October 2026): a
 * lying endpoint would have the keeper restore and rent a code entry of its
 * choosing. `readings` is what `executableHashes` returns; throws with
 * "nothing restored" otherwise.
 */
export function codeToRestore(readings, expect = undefined) {
  const expected = expect === undefined ? null : String(expect).toLowerCase();
  if (expected !== null && !/^[0-9a-f]{64}$/.test(expected)) throw new Error(`--expect takes a sha256 in hex, 64 characters, not ${expect}; nothing restored`);
  for (const r of readings) {
    if (!r.hex) throw new Error(`${r.url} could not say which code the instance runs${r.error ? ` (${r.error})` : ""}: nothing restored; retry, or check the endpoint`);
  }
  const hexes = [...new Set(readings.map((r) => r.hex))];
  if (hexes.length > 1) throw new Error(`the endpoints disagree on the code the instance runs: ${readings.map((r) => `${r.url} says ${r.hex}`).join(", ")}; nothing restored; check them before paying for a restore`);
  const [hex] = hexes;
  if (expected !== null && hex !== expected) throw new Error(`the instance runs ${hex}, not the expected ${expected}: nothing restored; check the deployment before paying for a restore`);
  if (readings.length < 2 && expected === null) throw new Error(`with one endpoint configured, the code the instance runs rests on ${readings[0].url} alone: pass --expect=<sha256> (the hash the instance must run) or list a second endpoint in STELLAR_RPC_URLS; nothing restored`);
  return hex;
}

/**
 * Restores the instance's own code entry when it is archived, a
 * RestoreFootprint on exactly that key under its own cap, then extends it to
 * the 90-day policy (TOOL-4). A live entry is only extended. The entry is
 * the one two endpoints agree the instance runs, or the one `--expect`
 * names when one endpoint confirms it (`codeToRestore`).
 */
export async function restoreCode(state, { expect = undefined, io = chainIo(state) } = {}) {
  const readings = await io.executableHashes();
  const hex = codeToRestore(readings, expect);
  io.log(`the instance runs ${hex}, as ${readings.map((r) => r.url).join(" and ")} report${readings.length === 1 ? "s" : ""}${expect === undefined ? "" : ", the expected code"}`);
  const life = await io.codeLife(hex);
  if (life === null) {
    const r = await io.restoreCode(hex);
    io.log(`code ${hex.slice(0, 12)}… restored${r.fee == null ? "" : `, fee ${(Number(r.fee) / 1e7).toFixed(2)} XLM`}  ${explorer(r.hash)}`);
  } else {
    io.log(`code ${hex.slice(0, 12)}… is live, ${life.toFixed(1)} days to live: nothing to restore`);
  }
  return keepCodeAlive(io, hex);
}

async function main(args) {
  const state = loadState();
  if (!state.contracts?.openWindow) {
    console.error("No deployment found: run `npm run setup` first.");
    process.exit(1);
  }
  const expect = args.find((a) => a.startsWith("--expect="))?.slice("--expect=".length);
  if (args.includes("--restore-code")) return restoreCode(state, { expect });
  const wasm = fs.readFileSync(path.join(WASM_DIR, "night_window.wasm"));
  if (args.includes("--apply")) return apply(state, { wasm, expect });
  const proposed = await propose(state, { wasm, expect });
  if (!proposed || args.includes("--propose")) return;
  await apply(state, { wasm, expect });
}

// Run as a script; imported by the tests, it only exports the flows.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`\nUpgrade stopped: ${error.message}`);
    process.exitCode = 1;
  });
}
