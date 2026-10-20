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
//
// `--expect` is the sha256 of night_window.wasm as `stellar contract build`
// produces it at the release tag, in a clean shell. The built WASM must be
// exactly that build, linked with the shipped 64 KiB stack, before anything
// is uploaded, proposed or installed; and the script refuses to run while
// NIGHT_WINDOW_STACK_SIZE or CARGO_TARGET_DIR is set (review finding
// STATE-2, 20 October 2026).
//
// Exits never wait for the migration: the contract keeps repurchase, seizure
// and release open between `upgrade` and `migrate` (decision S6). New offers
// and repos answer SchemaOutdated meanwhile, and the monitor raises a
// critical alert until `migrate` has run.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Operation,
  STATE_DIR,
  UPLOAD_MAX_FEE,
  WASM_DIR,
  checkUpgradeWasm,
  explorer,
  invoke,
  ledgerEntries,
  ledgerTime,
  loadState,
  read,
  send,
  sleep,
  storageKey,
  sv,
} from "./lib.mjs";
import { acknowledgeUpgrade, announceUpgrade } from "./monitor-state.mjs";

const MONITOR_FILE = path.join(STATE_DIR, "monitor.json");

/** The WASM hash the ledger holds as the executable of `contractId`. */
async function executableHash(contractId) {
  const head = await ledgerEntries([storageKey(contractId)]);
  const raw = head.entries[0]?.value?.contractData?.val?.instance?.executable?.wasmHash;
  if (!raw) return null;
  return typeof raw.toXDR === "function" ? raw.toXDR("hex") : Buffer.from(raw).toString("hex");
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
  return {
    // The upload needs a funded account, not a role: the operator pays it.
    upload: (wasm) => send(state, "operator", Operation.uploadContractWasm({ wasm }), "upload night_window.wasm", { maxResourceFee: UPLOAD_MAX_FEE }),
    invoke: (role, fn, args = [], options = {}) => invoke(state, role, ow, fn, args, options),
    read: (fn, args = []) => read(state, ow, fn, args),
    ledgerTime,
    sleep,
    executableHash: () => executableHash(ow),
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
  await io.upload(wasm);
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
 * behind. `wasm` and `expect` as for `propose`; `hash` is the code just
 * proposed, when `propose` ran first.
 */
export async function apply(state, { wasm, expect, hash = null, env = process.env, io = chainIo(state) }) {
  checkUpgradeWasm(wasm, expect, env);
  const pending = await io.read("pending_upgrade");
  if (!pending) throw new Error("no pending upgrade: run with --propose first");
  const wasmHash = hash ?? Buffer.from(pending.wasm_hash);
  const eta = Number(pending.eta);
  for (;;) {
    const now = await io.ledgerTime();
    if (now >= eta) break;
    io.log(`  waiting ${eta - now} s for the delay`);
    await io.sleep(Math.min(30_000, (eta - now) * 1000 + 1000));
  }
  const up = await io.invoke("governor", "upgrade", [sv.bytes(wasmHash)]);
  io.log(`upgraded in ${up.seconds.toFixed(1)} s  ${explorer(up.hash)}`);
  const held = await io.executableHash();
  io.log(`ledger executable ${held}`);
  if (held !== Buffer.from(wasmHash).toString("hex")) throw new Error("the ledger holds another executable: stop and investigate");
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
}

async function main(args) {
  const state = loadState();
  if (!state.contracts?.openWindow) {
    console.error("No deployment found: run `npm run setup` first.");
    process.exit(1);
  }
  const expect = args.find((a) => a.startsWith("--expect="))?.slice("--expect=".length);
  const wasm = fs.readFileSync(path.join(WASM_DIR, "night_window.wasm"));
  if (args.includes("--apply")) return apply(state, { wasm, expect });
  const proposed = await propose(state, { wasm, expect });
  if (!proposed || args.includes("--propose")) return;
  await apply(state, { wasm, expect, hash: proposed.hash });
}

// Run as a script; imported by the tests, it only exports the flows.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`\nUpgrade stopped: ${error.message}`);
    process.exitCode = 1;
  });
}
