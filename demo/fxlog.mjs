// Logs the Reflector EUR/USD feed on testnet over time: price, feed timestamp
// and age at each pass, so a weekend of publication behaviour can be read
// afterwards (does the feed keep ticking on Saturday and Sunday, and how old
// does the rate get?). Read-only: nothing is submitted.
//
//   npm run fxlog                      a pass every 5 minutes, appends to .state/fxlog.jsonl
//   npm run fxlog -- --every=60        a pass every 60 seconds
//   npm run fxlog -- --once            one pass, then exit

import { appendFileSync } from "node:fs";
import { REFLECTOR_FX_TESTNET, asset, ledgerTime, loadState, read } from "./lib.mjs";

const args = process.argv.slice(2);
const ONCE = args.includes("--once");
const every = Number((args.find((a) => a.startsWith("--every=")) ?? "--every=300").slice(8));
const OUT = new URL("./.state/fxlog.jsonl", import.meta.url);

const state = loadState();

async function pass() {
  const at = new Date().toISOString();
  try {
    const [rate, ledger] = await Promise.all([
      read(state, REFLECTOR_FX_TESTNET, "lastprice", [asset.other("EUR")]),
      ledgerTime(),
    ]);
    const ts = Number(rate.timestamp);
    const row = {
      at,
      ledgerTime: ledger,
      price: Number(BigInt(rate.price)) / 1e14,
      feedTimestamp: ts,
      ageSecs: ledger - ts,
    };
    appendFileSync(OUT, JSON.stringify(row) + "\n");
    console.log(`[${at}] EUR/USD ${row.price.toFixed(6)}  feed ${new Date(ts * 1000).toISOString()}  age ${(row.ageSecs / 60).toFixed(1)} min`);
  } catch (e) {
    const row = { at, error: String(e?.message ?? e).slice(0, 200) };
    appendFileSync(OUT, JSON.stringify(row) + "\n");
    console.log(`[${at}] read failed: ${row.error}`);
  }
}

await pass();
if (!ONCE) {
  setInterval(pass, every * 1000);
}
