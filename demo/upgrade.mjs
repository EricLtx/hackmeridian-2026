// Governed upgrade of the Open Window demo instance on testnet (decision S7,
// S15, S29): upload the built WASM, propose it with the governor and the
// trustee, announce it to the monitor, wait for the time delay, upgrade, then
// run `migrate` when the stored layout is behind the code, and check the
// executable hash the ledger holds.
//
//   npm run upgrade                  propose, wait for the delay, upgrade, migrate
//   npm run upgrade -- --propose     propose and announce only
//   npm run upgrade -- --apply       upgrade and migrate a proposal whose delay has elapsed
//
// Exits never wait for the migration: the contract keeps repurchase, seizure
// and release open between `upgrade` and `migrate` (decision S6). New offers
// and repos answer SchemaOutdated meanwhile, and the monitor raises a
// critical alert until `migrate` has run.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  Operation,
  STATE_DIR,
  WASM_DIR,
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

const args = process.argv.slice(2);
const PROPOSE_ONLY = args.includes("--propose");
const APPLY_ONLY = args.includes("--apply");
const MONITOR_FILE = path.join(STATE_DIR, "monitor.json");

const state = loadState();
const ow = state.contracts?.openWindow;
if (!ow) {
  console.error("No deployment found: run `npm run setup` first.");
  process.exit(1);
}

/** The monitor reports an announced upgrade as a warning, an unannounced one as an attack. */
function announce(hash) {
  let monitor = {};
  try {
    monitor = JSON.parse(fs.readFileSync(MONITOR_FILE, "utf8"));
  } catch {
    // No monitor state yet: it starts with this announcement.
  }
  monitor.announced = [...new Set([...(monitor.announced ?? []), hash.toLowerCase()])];
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(MONITOR_FILE, JSON.stringify(monitor, null, 2));
}

/** The WASM hash the ledger holds as the instance's executable. */
async function executableHash() {
  const head = await ledgerEntries([storageKey(ow)]);
  const raw = head.entries[0]?.value?.contractData?.val?.instance?.executable?.wasmHash;
  if (!raw) return null;
  return typeof raw.toXDR === "function" ? raw.toXDR("hex") : Buffer.from(raw).toString("hex");
}

async function propose() {
  const wasm = fs.readFileSync(path.join(WASM_DIR, "night_window.wasm"));
  const hash = crypto.createHash("sha256").update(wasm).digest();
  const hex = hash.toString("hex");
  console.log(`built WASM ${wasm.length} bytes, hash ${hex}`);
  if ((await executableHash()) === hex) {
    console.log("the instance already runs this code; nothing to propose");
    return null;
  }
  // The upload needs a funded account, not a role: the operator pays it.
  await send(state, "operator", Operation.uploadContractWasm({ wasm }), "upload night_window.wasm");
  // The proposal takes the governor and, when named, the trustee: both keys
  // are in the demo state, so the authorization entries are signed here.
  const r = await invoke(state, "governor", ow, "propose_upgrade", [sv.bytes(hash)]);
  announce(hex);
  const pending = await read(state, ow, "pending_upgrade");
  const eta = Number(pending.eta);
  console.log(`proposed in ${r.seconds.toFixed(1)} s, announced to the monitor; applies at ${new Date(eta * 1000).toISOString()}  ${explorer(r.hash)}`);
  return { hex, hash, eta };
}

async function apply(hash) {
  const pending = await read(state, ow, "pending_upgrade");
  if (!pending) throw new Error("no pending upgrade: run with --propose first");
  const wasmHash = hash ?? Buffer.from(pending.wasm_hash);
  const eta = Number(pending.eta);
  for (;;) {
    const now = await ledgerTime();
    if (now >= eta) break;
    console.log(`  waiting ${eta - now} s for the delay`);
    await sleep(Math.min(30_000, (eta - now) * 1000 + 1000));
  }
  const up = await invoke(state, "governor", ow, "upgrade", [sv.bytes(wasmHash)]);
  console.log(`upgraded in ${up.seconds.toFixed(1)} s  ${explorer(up.hash)}`);
  const held = await executableHash();
  console.log(`ledger executable ${held}`);
  if (held !== Buffer.from(wasmHash).toString("hex")) throw new Error("the ledger holds another executable: stop and investigate");
  // Pre-rc4 code has no schema_version: read it through the new code, after the upgrade.
  const version = Number(await read(state, ow, "schema_version"));
  const expected = await expectedSchema();
  if (version < expected) {
    const m = await invoke(state, "governor", ow, "migrate", []);
    console.log(`migrated schema ${version} -> ${await read(state, ow, "schema_version")} in ${m.seconds.toFixed(1)} s  ${explorer(m.hash)}`);
  } else {
    console.log(`schema ${version}: nothing to migrate`);
  }
}

/** The schema version the built code expects, read from the source constant, so the script needs no rebuild of the contract crate. */
async function expectedSchema() {
  const source = fs.readFileSync(path.join(WASM_DIR, "..", "..", "..", "contracts", "night-window", "src", "lib.rs"), "utf8");
  const m = source.match(/pub const SCHEMA_VERSION: u32 = (\d+);/);
  return m ? Number(m[1]) : 1;
}

async function main() {
  if (APPLY_ONLY) return apply(null);
  const proposed = await propose();
  if (!proposed || PROPOSE_ONLY) return;
  await apply(proposed.hash);
}

main().catch((error) => {
  console.error(`\nUpgrade stopped: ${error.message}`);
  process.exitCode = 1;
});
