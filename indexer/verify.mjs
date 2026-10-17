// Re-reads every journal file, recomputes the hash chain and reports the
// first break. The line count and the last hash are the integrity proof to
// publish or compare with another copy of the journal.
//
//   npm run verify
//   npm run verify -- --state <dir>

import { verifyChain } from "./lib/chain.mjs";
import { DEFAULT_STATE_DIR, journalFiles, readCursor, readJournal } from "./lib/journal.mjs";
import path from "node:path";

const args = process.argv.slice(2);
const i = args.indexOf("--state");
const STATE_DIR = i >= 0 ? args[i + 1] : DEFAULT_STATE_DIR;

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
if (result.ok && !problems.length) {
  console.log(`Chain:   intact`);
  console.log(`Last hash: ${result.lastHash}`);
  if (cursor && cursor.lastHash && cursor.lastHash !== result.lastHash) console.log(`NOTE     cursor.json records ${cursor.lastHash}; it is a cache, the journal is the authority`);
  process.exit(0);
}
if (!result.ok) {
  console.log(`Chain:   BROKEN at seq ${result.break.seq} (line index ${result.break.index}): ${result.break.reason}`);
  console.log(`Intact up to seq ${result.break.seq - 1}, hash ${result.lastHash}`);
}
process.exit(2);
