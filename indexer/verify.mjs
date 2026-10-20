// Re-reads every journal file, recomputes the hash chain and reports the
// first break. The line count and the last hash are the integrity proof to
// publish or compare with another copy of the journal.
//
//   npm run verify
//   npm run verify -- --state <dir>
//   npm run verify -- --anchors          also checks every anchor of .state/anchors.jsonl:
//                                        (a) its hash is the hash of the journal line it names,
//                                        (b) the ledger still carries it (data entry, or the transaction)
//   npm run verify -- --against <url>    also compares the journal with what an RPC endpoint
//                                        serves, both ways, over the ledgers it still keeps:
//                                        events it serves that the journal lacks, lines it
//                                        does not know, lines whose content differs (rpc-6).
//                                        Use an endpoint other than the indexer's own.
//
// Exit code 0 when everything holds, 2 otherwise.

import path from "node:path";

import { checkAnchorAgainstJournal, readAnchorTransaction, readAnchors, readDataEntry } from "./lib/anchor.mjs";
import { verifyChain } from "./lib/chain.mjs";
import { compareTrail, nameOf } from "./lib/crosscheck.mjs";
import { decodeEvent } from "./lib/decode.mjs";
import { DEFAULT_STATE_DIR, journalFiles, readCursor, readJournal } from "./lib/journal.mjs";
import { Rpc } from "./lib/rpc.mjs";

const args = process.argv.slice(2);
const i = args.indexOf("--state");
const STATE_DIR = i >= 0 ? args[i + 1] : DEFAULT_STATE_DIR;
const WITH_ANCHORS = args.includes("--anchors");
const a = args.indexOf("--against");
const AGAINST = a >= 0 ? args[a + 1] : undefined;

const files = journalFiles(STATE_DIR);
const { lines, problems } = readJournal(STATE_DIR);
const result = verifyChain(lines);
const cursor = readCursor(STATE_DIR);

console.log(`Journal: ${STATE_DIR}`);
console.log(`Files:   ${files.length ? files.map((f) => path.basename(f)).join(", ") : "none"}`);
for (const p of problems) console.log(`UNREADABLE ${p.file}:${p.line} (${p.reason})`);
console.log(`Lines:   ${result.lines}`);
if (lines.length) {
  const first = lines[0];
  const last = lines[lines.length - 1];
  console.log(`Range:   ledger ${first.ledger} (${first.closedAt}) to ledger ${last.ledger} (${last.closedAt})`);
  console.log(`Contract: ${last.contract}`);
}
if (cursor?.gaps?.length) {
  for (const g of cursor.gaps) console.log(`GAP      ledgers ${g.fromLedger}-${g.toLedger} were outside the RPC window when indexing resumed (${g.noticedAt})`);
}
let chainOk = result.ok && !problems.length;
if (chainOk) {
  console.log(`Chain:   intact`);
  console.log(`Last hash: ${result.lastHash}`);
  if (cursor && cursor.lastHash && cursor.lastHash !== result.lastHash) console.log(`NOTE     cursor.json records ${cursor.lastHash}; it is a cache, the journal is the authority`);
}
if (!result.ok) {
  console.log(`Chain:   BROKEN at seq ${result.break.seq} (line index ${result.break.index}): ${result.break.reason}`);
  console.log(`Intact up to seq ${result.break.seq - 1}, hash ${result.lastHash}`);
}

/**
 * Checks every anchor against the journal (recomputed hash of the line it
 * names) and against the ledger: the account's data entry when it still holds
 * this hash, else the anchoring transaction itself when a later anchor has
 * overwritten the entry. Returns true when every anchor holds.
 */
async function verifyAnchors() {
  const { anchors, problems: anchorProblems } = readAnchors(STATE_DIR);
  console.log("");
  console.log(`Anchors: ${anchors.length} in anchors.jsonl`);
  for (const p of anchorProblems) console.log(`UNREADABLE ${p.file}:${p.line} (${p.reason})`);
  if (!anchors.length) return anchorProblems.length === 0;

  const rpc = new Rpc(undefined, { log: (t) => console.error(`  (${t})`) });
  // One ledger read per (account, data key): the entry holds the latest anchor only.
  const entries = new Map();
  const entryOf = async (account, dataKey) => {
    const id = `${account}/${dataKey}`;
    if (!entries.has(id)) entries.set(id, readDataEntry(rpc, account, dataKey).catch((error) => ({ error })));
    return entries.get(id);
  };

  const rows = [];
  let allOk = anchorProblems.length === 0;
  for (let n = 0; n < anchors.length; n += 1) {
    const a = anchors[n];
    const journal = checkAnchorAgainstJournal(a, lines);
    const later = anchors.slice(n + 1).some((b) => b.account === a.account && b.dataKey === a.dataKey);
    let onChain;
    const entry = await entryOf(a.account, a.dataKey);
    if (entry.error) onChain = { ok: false, status: "UNREACHABLE", detail: entry.error.message.split("\n")[0].slice(0, 80) };
    else if (entry.value === a.hash) onChain = { ok: true, status: "entry", detail: `data entry holds the hash (last modified ledger ${entry.lastModified})` };
    else {
      // The entry holds another value: a later anchor if one was recorded. The transaction then has to carry this one.
      let tx = null;
      try {
        tx = await readAnchorTransaction(rpc, a.txHash, a.dataKey);
      } catch (error) {
        onChain = { ok: false, status: "UNREACHABLE", detail: error.message.split("\n")[0].slice(0, 80) };
      }
      if (!onChain) {
        if (tx?.failed) onChain = { ok: false, status: "TX FAILED", detail: `transaction ${a.txHash.slice(0, 12)}… failed on chain` };
        else if (tx?.hash === a.hash && later) onChain = { ok: true, status: "tx", detail: `superseded in the entry; transaction (${tx.source}) carries the hash${tx.ledger ? `, ledger ${tx.ledger}` : ""}` };
        else if (tx?.hash === a.hash) onChain = { ok: false, status: "OVERWRITTEN", detail: `transaction carries the hash but the entry now holds ${entry.value ? `${entry.value.slice(0, 16)}…` : "nothing"} and no later anchor is recorded` };
        else if (tx) onChain = { ok: false, status: "MISMATCH", detail: `transaction carries ${tx.hash ? `${tx.hash.slice(0, 16)}…` : "no value"}, not the recorded hash` };
        else if (entry.value === null) onChain = { ok: false, status: "MISSING", detail: "no data entry on the account and the transaction is not found" };
        else onChain = { ok: false, status: "MISMATCH", detail: `entry holds ${entry.value.slice(0, 16)}…, transaction not found` };
      }
    }
    allOk = allOk && journal.ok && onChain.ok;
    rows.push({
      n: String(n + 1),
      at: String(a.at ?? "").replace("T", " ").slice(0, 19),
      ledger: String(a.ledger ?? ""),
      lines: String(a.lines ?? ""),
      hash: `${String(a.hash ?? "").slice(0, 16)}…`,
      journal: journal.ok ? "ok" : `FAIL (${journal.reason})`,
      chain: `${onChain.ok ? "ok" : "FAIL"} ${onChain.status}`,
      detail: onChain.detail,
    });
  }

  const columns = [
    ["#", "n"],
    ["anchored at", "at"],
    ["ledger", "ledger"],
    ["line", "lines"],
    ["hash", "hash"],
    ["journal", "journal"],
    ["on chain", "chain"],
  ];
  const widths = columns.map(([title, key]) => Math.max(title.length, ...rows.map((r) => r[key].length)));
  const line = (cells) => cells.map((c, k) => c.padEnd(widths[k])).join("  ");
  console.log(line(columns.map(([title]) => title)));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) {
    console.log(line(columns.map(([, key]) => r[key])));
    console.log(`${" ".repeat(widths[0])}  ${r.detail}`);
  }
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  console.log(`Account: ${first.account}${anchors.some((a) => a.account !== first.account) ? " (and others)" : ""}, data key ${last.dataKey}`);
  console.log(`Latest anchor: line ${last.lines} of ${result.lines}, transaction ${last.txHash}`);
  console.log(`Anchors: ${allOk ? "every anchor holds, in the journal and on the ledger" : "AT LEAST ONE ANCHOR DOES NOT HOLD"}`);
  return allOk;
}

/**
 * Compares the journal with the events `url` serves, over the ledgers both
 * cover: from the endpoint's oldest kept ledger to the journal's last line,
 * or the endpoint's latest ledger if it is behind. Returns true when every
 * compared line matches and nothing served is missing.
 */
async function verifyAgainst(url) {
  console.log("");
  if (!/^https?:\/\//.test(url ?? "")) {
    console.log("Against: --against needs an RPC URL");
    return false;
  }
  const last = lines.at(-1);
  if (!last) {
    console.log(`Against: ${url}: the journal is empty, nothing to compare`);
    return true;
  }
  const own = cursor?.rpc;
  if (own === url) console.log(`NOTE     ${url} is the endpoint the indexer itself read: this compares the journal with its own source, not with an independent one`);
  const rpc = new Rpc([url], { log: (t) => console.error(`  (${t})`) });
  // Start at a ledger every RPC refuses; it answers with its oldest kept ledger, where the read begins.
  const fetched = await rpc.events(last.contract, { startLedger: 1 });
  const from = Number(fetched.startLedger ?? fetched.oldestLedger ?? 1);
  const to = Math.min(Number(last.ledger), Number(fetched.latestLedger ?? last.ledger));
  const events = fetched.events.map(decodeEvent).filter((e) => !e.contract || e.contract === last.contract);
  const result = compareTrail(lines, events, { from, to });
  console.log(`Against: ${url}, ledgers ${from} to ${to}: ${result.checked} journal line(s) compared, ${events.length} event(s) served`);
  for (const e of result.missing) console.log(`MISSING  event ${e.id} (${nameOf(e)}, ledger ${e.ledger}) is served but not journaled`);
  for (const l of result.unknown) console.log(`UNKNOWN  line ${l.seq} (event ${l.id}, ${nameOf(l)}, ledger ${l.ledger}) is not served by ${url}`);
  for (const d of result.altered) console.log(`ALTERED  line ${d.seq} (event ${d.id}, ${d.name}, ledger ${d.ledger}): ${d.fields.join(", ")} differ from ${url}`);
  const ok = !result.missing.length && !result.unknown.length && !result.altered.length;
  console.log(`Against: ${ok ? "the journal and the endpoint agree, line by line" : "THE JOURNAL AND THE ENDPOINT DISAGREE"}`);
  return ok;
}

// The exit code is set, not forced: `process.exit()` right after a network
// call trips a libuv assertion on Windows while the socket is still closing.
async function main() {
  let ok = chainOk;
  if (WITH_ANCHORS) ok = (await verifyAnchors()) && ok;
  if (a >= 0) ok = (await verifyAgainst(AGAINST)) && ok;
  process.exitCode = ok ? 0 : 2;
}

main().catch((error) => {
  console.error(`Verify failed: ${error.message}`);
  process.exitCode = 1;
});
