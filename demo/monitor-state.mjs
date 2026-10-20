// The monitor's state file (demo/.state/monitor.json) and its writers.
//
// A running watch keeps the file's content in memory and saves it after
// every pass. Other processes write to the same file: `npm run upgrade`
// announces the code it proposes and moves the code baseline after a
// verified upgrade, and `npm run monitor -- --announce-...=` records a
// planned change. A watch that read the file once and saved its own copy
// would answer an announced change as an attack and erase what the others
// wrote (review finding TOOL-3, 20 October 2026). So the watch merges the
// file at the start of every pass and before every decision, and every save
// writes that merge: the announcement lists are united, and a code baseline
// another process moved is taken up.
//
// No network, no key: tested offline (demo/test/monitor-state.test.mjs).

import fs from "node:fs";
import path from "node:path";

/** The lists of planned changes the monitor reports instead of answering: other processes add to them, the watch never removes from them. */
export const ANNOUNCEMENTS = ["announced", "announcedStablecoins", "announcedAdmins", "announcedGuardians"];

/** The file's content, or null when it is missing or unreadable. */
export function readMonitorFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The monitoring state of the deployed contract `contract`. A new
 * deployment starts afresh and keeps only the announced code hashes.
 * `_fileWasmHash` remembers the code baseline the file held, so that a later
 * change there is recognized as another process's.
 */
export function loadMonitor(file, contract) {
  const m = readMonitorFile(file) ?? {};
  const same = m.contract === contract;
  const loaded = same ? m : { contract, announced: m.announced ?? [] };
  loaded._fileWasmHash = same ? (m.wasmHash ?? null) : null;
  return loaded;
}

/**
 * Merges into `m`, in place, what other processes wrote to the file
 * (`disk`, its parsed content): the union of each announcement list, and the
 * file's code baseline when it changed since this process last read or
 * wrote it. A file of another deployment is ignored. Returns `m`.
 */
export function mergeMonitor(m, disk) {
  if (!disk || typeof disk !== "object") return m;
  if (disk.contract !== undefined && disk.contract !== m.contract) return m;
  for (const field of ANNOUNCEMENTS) {
    if (!Array.isArray(disk[field])) continue;
    m[field] = [...new Set([...(m[field] ?? []), ...disk[field]])];
  }
  const fileHash = disk.wasmHash ?? null;
  if (fileHash !== null && fileHash !== (m._fileWasmHash ?? null)) m.wasmHash = fileHash;
  m._fileWasmHash = fileHash;
  return m;
}

/** Re-reads the file and merges it into `m`: at the start of every pass and before every decision. */
export function refreshMonitor(file, m) {
  return mergeMonitor(m, readMonitorFile(file));
}

/**
 * Writes `m` after merging the file once more, so that what another process
 * wrote since the last read is kept. Fields starting with "_" are this
 * process's memory, never saved.
 */
export function saveMonitor(file, m) {
  refreshMonitor(file, m);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(m, (key, value) => (key.startsWith("_") ? undefined : value), 2));
  m._fileWasmHash = m.wasmHash ?? null;
}

/** Adds a code hash to the announced upgrades on disk: `npm run upgrade` does it before it proposes. */
export function announceUpgrade(file, hash) {
  const m = readMonitorFile(file) ?? {};
  m.announced = [...new Set([...(m.announced ?? []), hash.toLowerCase()])];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(m, null, 2));
}

/**
 * Moves the code baseline on disk to the executable the ledger holds after a
 * verified upgrade; a running watch takes it up at its next pass. Without a
 * file there is no baseline yet: the first pass takes the executable it reads.
 */
export function acknowledgeUpgrade(file, hash) {
  const m = readMonitorFile(file);
  if (!m) return false;
  m.wasmHash = hash.toLowerCase();
  fs.writeFileSync(file, JSON.stringify(m, null, 2));
  return true;
}
