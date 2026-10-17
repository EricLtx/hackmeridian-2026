// The journal on disk: `events-YYYY-MM.jsonl` files (one line per event,
// month of the ledger close time, UTC) and `cursor.json`. Lines are only ever
// appended; the journal itself, not the cursor, is the authority on where to
// resume.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const INDEXER_DIR = path.resolve(here, "..");
export const DEFAULT_STATE_DIR = path.join(INDEXER_DIR, ".state");
export const DEMO_STATE_FILE = path.resolve(INDEXER_DIR, "..", "demo", ".state", "testnet.json");

const FILE_PATTERN = /^events-(\d{4})-(\d{2})\.jsonl$/;

/** Journal files in chronological order (the name sorts by month). */
export function journalFiles(stateDir) {
  if (!fs.existsSync(stateDir)) return [];
  return fs
    .readdirSync(stateDir)
    .filter((f) => FILE_PATTERN.test(f))
    .sort()
    .map((f) => path.join(stateDir, f));
}

/** Every line of every journal file, in file order. A malformed line is reported with its position. */
export function readJournal(stateDir) {
  const lines = [];
  const problems = [];
  for (const file of journalFiles(stateDir)) {
    const text = fs.readFileSync(file, "utf8");
    const rows = text.split("\n");
    rows.forEach((row, i) => {
      if (row.trim() === "") return;
      try {
        lines.push(JSON.parse(row));
      } catch {
        problems.push({ file: path.basename(file), line: i + 1, reason: "not valid JSON" });
      }
    });
  }
  return { lines, problems };
}

/** The file a line belongs to, from its ledger close time. */
export function fileFor(stateDir, line) {
  const month = String(line.closedAt ?? "").slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`line ${line.seq} has no usable close time: ${line.closedAt}`);
  return path.join(stateDir, `events-${month}.jsonl`);
}

/** Appends lines, grouped by file, each as one JSON row. Never rewrites. */
export function appendLines(stateDir, lines) {
  fs.mkdirSync(stateDir, { recursive: true });
  const byFile = new Map();
  for (const line of lines) {
    const file = fileFor(stateDir, line);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(`${JSON.stringify(line)}\n`);
  }
  for (const [file, rows] of byFile) fs.appendFileSync(file, rows.join(""), { flag: "a" });
}

export const cursorFile = (stateDir) => path.join(stateDir, "cursor.json");

export function readCursor(stateDir) {
  try {
    return JSON.parse(fs.readFileSync(cursorFile(stateDir), "utf8"));
  } catch {
    return null;
  }
}

export function writeCursor(stateDir, cursor) {
  fs.mkdirSync(stateDir, { recursive: true });
  const tmp = `${cursorFile(stateDir)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cursor, null, 2)}\n`);
  fs.renameSync(tmp, cursorFile(stateDir));
}

/** The Open Window contract id of the demo deployment, from the demo's git-ignored state. */
export function demoContract() {
  try {
    const state = JSON.parse(fs.readFileSync(DEMO_STATE_FILE, "utf8"));
    return state?.contracts?.openWindow ?? null;
  } catch {
    return null;
  }
}
