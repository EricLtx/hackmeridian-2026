// Appends the contract's events to the journal, in chain order, with the
// hash chain. One pass by default; `--watch` repeats every 30 s.
//
//   npm run index                       one pass
//   npm run index -- --watch            every 30 s
//   npm run index -- --contract C...    another contract (default: demo/.state/testnet.json)
//   npm run index -- --state <dir>      another state folder (default: indexer/.state)
//
// The journal is the authority: the pass resumes after the last journaled
// event, and an event already journaled is never written twice. When the RPC
// no longer holds the ledgers right after the last journaled one, the pass
// starts at the oldest ledger the RPC keeps and records the gap in the
// cursor, so a missing stretch is declared rather than silently skipped.

import { chainLine, verifyChain } from "./lib/chain.mjs";
import { decodeEvent } from "./lib/decode.mjs";
import { DEFAULT_STATE_DIR, appendLines, demoContract, readCursor, readJournal, writeCursor } from "./lib/journal.mjs";
import { Rpc } from "./lib/rpc.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const WATCH = args.includes("--watch");
const STATE_DIR = option("--state") ?? DEFAULT_STATE_DIR;
const CONTRACT = option("--contract") ?? demoContract();
const INTERVAL_MS = 30_000;

if (!CONTRACT || !/^C[A-Z2-7]{55}$/.test(CONTRACT)) {
  console.error("No contract id: pass --contract C... or run the demo's setup so that demo/.state/testnet.json exists.");
  process.exit(1);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const log = (text) => console.log(`[${stamp()} UTC] ${text}`);
const rpc = new Rpc(undefined, { log: (t) => console.error(`  (${t})`) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pass() {
  const { lines, problems } = readJournal(STATE_DIR);
  if (problems.length) throw new Error(`journal has ${problems.length} unreadable line(s): ${problems[0].file}:${problems[0].line}; fix the file before indexing`);
  const check = verifyChain(lines);
  if (!check.ok) throw new Error(`journal hash chain broken at seq ${check.break.seq}: ${check.break.reason}; run \`npm run verify\``);
  const last = lines.length ? lines[lines.length - 1] : null;
  if (last && last.contract !== CONTRACT) throw new Error(`journal in ${STATE_DIR} belongs to ${last.contract}; use --state <another folder> for ${CONTRACT}`);
  const known = new Set(lines.map((l) => l.id));
  const cursor = readCursor(STATE_DIR) ?? { contract: CONTRACT, gaps: [] };

  // Where to resume: right after the last journaled event; on the first run,
  // at the oldest ledger the RPC still keeps.
  let from;
  if (last) from = { cursor: last.id };
  else {
    const health = await rpc.health();
    from = { startLedger: Math.max(1, Number(health.oldestLedger) || 1) };
  }

  let fetched;
  try {
    fetched = await rpc.events(CONTRACT, from);
  } catch (error) {
    if (!last) throw error;
    // The RPC may refuse a cursor older than its window: fall back to ledgers.
    fetched = await rpc.events(CONTRACT, { startLedger: last.ledger + 1 });
  }
  const { events, latestLedger, oldestLedger, startLedger } = fetched;

  // A gap: the RPC's oldest ledger is past the ledger following the last journaled event.
  // Either the fetch had to start later than requested, or the RPC's own
  // oldest ledger is past the resume point (a cursor it accepted anyway).
  const resumeLedger = last ? last.ledger + 1 : from.startLedger;
  const effectiveStart = Math.max(startLedger ?? resumeLedger, oldestLedger ?? resumeLedger);
  if (last && effectiveStart > resumeLedger) {
    const gap = { fromLedger: resumeLedger, toLedger: effectiveStart - 1, noticedAt: new Date().toISOString() };
    cursor.gaps = [...(cursor.gaps ?? []), gap];
    console.error(`  WARNING: ledgers ${gap.fromLedger}-${gap.toLedger} are no longer served by the RPC; events in that stretch are not journaled (gap recorded in cursor.json)`);
  }

  const fresh = [];
  let prev = last;
  for (const raw of events) {
    if (known.has(raw.id)) continue;
    const event = decodeEvent(raw);
    if (event.contract && event.contract !== CONTRACT) continue;
    event.contract = CONTRACT;
    if (prev && (event.ledger < prev.ledger || (event.ledger === prev.ledger && event.id <= prev.id))) {
      throw new Error(`RPC returned event ${event.id} (ledger ${event.ledger}) out of order after ${prev.id} (ledger ${prev.ledger}); nothing written`);
    }
    const line = chainLine(prev, event);
    fresh.push(line);
    known.add(line.id);
    prev = line;
  }
  if (fresh.length) appendLines(STATE_DIR, fresh);

  const tail = prev;
  writeCursor(STATE_DIR, {
    contract: CONTRACT,
    rpc: rpc.url,
    ledger: tail?.ledger ?? null,
    eventId: tail?.id ?? null,
    seq: tail?.seq ?? 0,
    lastHash: tail?.hash ?? check.lastHash,
    latestLedgerSeen: latestLedger,
    oldestLedgerServed: oldestLedger,
    gaps: cursor.gaps ?? [],
    updatedAt: new Date().toISOString(),
  });
  log(`${CONTRACT.slice(0, 8)}… ledger ${latestLedger ?? "?"} (RPC keeps from ${oldestLedger ?? effectiveStart}): ${events.length} event(s) fetched, ${fresh.length} new, ${lines.length + fresh.length} journaled, last hash ${(tail?.hash ?? check.lastHash).slice(0, 16)}…`);
  return fresh.length;
}

async function main() {
  for (;;) {
    try {
      await pass();
    } catch (error) {
      if (!WATCH) throw error;
      console.error(`[${stamp()} UTC] pass failed, retrying in ${INTERVAL_MS / 1000} s: ${error.message}`);
    }
    if (!WATCH) return;
    await sleep(INTERVAL_MS);
  }
}

main().catch((error) => {
  console.error(`Indexer stopped: ${error.message}`);
  process.exit(1);
});
