// Exports of the journal, rebuilt from the events alone.
//
//   npm run export -- --csv              .state/events.csv   every line, flat
//   npm run export -- --view registre    .state/registre.csv one row per repo
//   npm run export -- --view sftr        .state/sftr.csv     SFTR-shaped rows
//   npm run export -- --json             .state/export.json  for the web page
//   npm run export -- --json --web       also copies it to ../web/public/history.json
//   npm run export -- --state <dir>      another state folder
//
// Several outputs may be combined in one call. The export refuses to run on a
// journal whose hash chain is broken: a view of corrupt data would be worse
// than none.

import fs from "node:fs";
import path from "node:path";
import { verifyChain } from "./lib/chain.mjs";
import { eventName } from "./lib/decode.mjs";
import { DEFAULT_STATE_DIR, INDEXER_DIR, readCursor, readJournal } from "./lib/journal.mjs";
import { EVENTS_COLUMNS, REGISTRY_COLUMNS, SFTR_COLUMNS, eventsTable, registry, sftr, toCsv } from "./lib/views.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const STATE_DIR = option("--state") ?? DEFAULT_STATE_DIR;
const WEB_FILE = path.resolve(INDEXER_DIR, "..", "web", "public", "history.json");
const RECENT_EVENTS = 200;
const EXPLORER = "https://stellar.expert/explorer/testnet";

const views = args.flatMap((a, i) => (a === "--view" ? [args[i + 1]] : []));
const wantCsv = args.includes("--csv");
const wantJson = args.includes("--json");
const toWeb = args.includes("--web");
if (!wantCsv && !wantJson && !views.length) {
  console.error("Nothing to export: pass --csv, --json and/or --view registre|sftr.");
  process.exit(1);
}
for (const v of views) {
  if (!["registre", "registry", "sftr"].includes(v)) {
    console.error(`Unknown view ${v}; use registre or sftr.`);
    process.exit(1);
  }
}

const { lines, problems } = readJournal(STATE_DIR);
if (problems.length) {
  console.error(`Journal has unreadable lines (${problems[0].file}:${problems[0].line}); run npm run verify.`);
  process.exit(2);
}
const check = verifyChain(lines);
if (!check.ok) {
  console.error(`Journal hash chain broken at seq ${check.break.seq}: ${check.break.reason}; nothing exported.`);
  process.exit(2);
}
fs.mkdirSync(STATE_DIR, { recursive: true });
const write = (name, text) => {
  const file = path.join(STATE_DIR, name);
  fs.writeFileSync(file, text);
  return file;
};
const rel = (file) => path.relative(process.cwd(), file) || file;

if (wantCsv) {
  const file = write("events.csv", toCsv(EVENTS_COLUMNS, eventsTable(lines)));
  console.log(`${rel(file)}: ${lines.length} event(s)`);
}
if (views.some((v) => v === "registre" || v === "registry")) {
  const rows = registry(lines);
  const file = write("registre.csv", toCsv(REGISTRY_COLUMNS, rows));
  const count = (s) => rows.filter((r) => r.status === s).length;
  console.log(`${rel(file)}: ${rows.length} repo(s): ${count("open")} open, ${count("repurchased")} repurchased, ${count("seized")} seized, ${count("release_pending")} release pending`);
}
if (views.includes("sftr")) {
  const rows = sftr(lines);
  const file = write("sftr.csv", toCsv(SFTR_COLUMNS, rows));
  console.log(`${rel(file)}: ${rows.length} row(s); LEI, master agreement and counterparty identity are not on chain (see README)`);
}
if (wantJson) {
  const cursor = readCursor(STATE_DIR);
  const recent = lines
    .slice(-RECENT_EVENTS)
    .reverse()
    .map((l) => ({ seq: l.seq, ledger: l.ledger, closedAt: l.closedAt, txHash: l.txHash, event: eventName(l), topics: l.topics.slice(1), data: l.data, hash: l.hash }));
  const payload = {
    generatedAt: new Date().toISOString(),
    network: "testnet",
    explorer: EXPLORER,
    contract: lines.length ? lines[lines.length - 1].contract : cursor?.contract ?? null,
    journal: {
      lines: lines.length,
      lastHash: check.lastHash,
      firstLedger: lines[0]?.ledger ?? null,
      lastLedger: lines[lines.length - 1]?.ledger ?? null,
      firstClosedAt: lines[0]?.closedAt ?? null,
      lastClosedAt: lines[lines.length - 1]?.closedAt ?? null,
      gaps: cursor?.gaps ?? [],
    },
    registry: registry(lines),
    events: recent,
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  const file = write("export.json", text);
  console.log(`${rel(file)}: ${payload.registry.length} repo(s), ${recent.length} recent event(s)`);
  if (toWeb) {
    fs.mkdirSync(path.dirname(WEB_FILE), { recursive: true });
    fs.writeFileSync(WEB_FILE, text);
    console.log(`${rel(WEB_FILE)}: copied for the web page`);
  }
}
