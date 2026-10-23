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

/**
 * The one rule on an instance name (`OPEN_WINDOW_STATE`): letters, digits,
 * `_` and `-` only. The name goes into file names under demo/.state/ (the
 * state file, the monitor file, a disposable deployment file): nothing
 * else may reach outside that folder or carry a separator. Returns the
 * name; throws before any file is read or written. lib.mjs applies it to
 * the variable at import, so every script (setup, the demo, the monitor,
 * the upgrade) refuses a bad name before it does anything.
 */
export function checkStateName(stateName) {
  if (typeof stateName !== "string" || !/^[A-Za-z0-9_-]+$/.test(stateName)) {
    throw new Error(`OPEN_WINDOW_STATE must be made of letters, digits, _ and - only, not ${JSON.stringify(stateName)}`);
  }
  return stateName;
}

/**
 * The name of the state file of the instance `stateName` (`OPEN_WINDOW_STATE`,
 * `testnet` by default), in demo/.state/: `monitor.json` for the demo
 * instance, `monitor-<name>.json` for a disposable one, so that a rehearsal
 * or an offline run never writes into the demo instance's file. Every writer
 * (the watch, `npm run upgrade`) names it this way, under `checkStateName`.
 */
export function monitorFileName(stateName) {
  return checkStateName(stateName) === "testnet" ? "monitor.json" : `monitor-${stateName}.json`;
}

/**
 * Whether `--rehearse` may run on the instance it points at. The drills
 * publish a NAV jump, claw back shares, pause, propose upgrades and change
 * fund settings: on the demo instance, which the web interface serves, every
 * visitor would see them, and a running `--watch --act` would answer them on
 * the same accounts. So a rehearsal runs on a disposable instance
 * (`OPEN_WINDOW_STATE=<name>`), and on the demo instance only when `--live`
 * asks for it. The demo instance is known by its name (`testnet`) or by its
 * contract id, the one `web/public/deployment.testnet.json` publishes: a
 * disposable state file that points at the demo contract is refused too.
 */
export function rehearsalAllowed({ stateName, contractId, publishedId, live }) {
  const demo = checkStateName(stateName) === "testnet" || (Boolean(publishedId) && contractId === publishedId);
  return !demo || live === true;
}

/** The file's content, or null when it is missing or unreadable. */
export function readMonitorFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** How long a writer waits for the file's lock before giving up, and the age past which a lock left by a dead process is cleared. */
export const LOCK_WAIT_MS = 15_000;
export const LOCK_STALE_MS = 10_000;

/** Sleeps `ms` without yielding: the writers are synchronous, and the lock is held for about a millisecond. */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Attempts, a millisecond apart, to remove a file Windows refuses to remove while another process has it open. */
const UNLINK_ATTEMPTS = 50;

/** Removes `file`, retrying briefly when another process holds it open; false when it could not be removed. */
function unlinkPatiently(file) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.unlinkSync(file);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return true;
      if (attempt >= UNLINK_ATTEMPTS) return false;
      pause(1);
    }
  }
}

/**
 * Runs `fn` while holding the lock of `file`, a `<file>.lock` created
 * exclusively (O_EXCL), so that two writers never interleave a read, a
 * merge and a write: without it, what one process wrote between the other's
 * read and write was lost for good (the TOOL-3 residual, 20 October 2026).
 * A lock older than `LOCK_STALE_MS` was left by a process that died: it is
 * claimed by one waiter alone, through a rename to a name of its own, then
 * removed, so a fresh lock taken meanwhile is never removed by mistake. A
 * writer that cannot take the lock within `LOCK_WAIT_MS` throws rather
 * than write over the file.
 */
export function withMonitorLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const started = Date.now();
  let waits = 0;
  for (;;) {
    let fd = null;
    try {
      fd = fs.openSync(lock, "wx");
    } catch (error) {
      // EEXIST: held. EPERM, EBUSY, EACCES: Windows, a lock just released
      // that stays "delete pending" while another waiter still has it open
      // for a stat; it is gone a moment later.
      if (!["EEXIST", "EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      if (error.code === "EEXIST") {
        let age = 0;
        try {
          age = Date.now() - fs.statSync(lock).mtimeMs;
        } catch {
          continue; // released between the open and the stat: try again
        }
        if (age > LOCK_STALE_MS) {
          const claimed = `${lock}.stale-${process.pid}`;
          try {
            fs.renameSync(lock, claimed); // one waiter wins the rename; the others see no lock
            unlinkPatiently(claimed);
          } catch {
            // another waiter claimed it first, or it was released: try again
          }
          continue;
        }
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`${lock} is held by another process for more than ${LOCK_WAIT_MS / 1000} s: nothing written to ${file}`);
      // A randomized back-off, 5 to 50 ms and growing: waiters that wake
      // together would otherwise contend again together.
      pause(5 + Math.random() * Math.min(45, 5 * 2 ** waits));
      waits += 1;
      continue;
    }
    try {
      fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      return fn();
    } finally {
      fs.closeSync(fd);
      // Released at once: a lock left behind would hold every writer until LOCK_STALE_MS.
      releaseMonitorLock(lock);
    }
  }
}

/**
 * Removes this process's lock, and only its own: a holder stalled past
 * `LOCK_STALE_MS` has lost its lock to a waiter, and the lock at that path
 * may now be another process's, which must stay.
 */
function releaseMonitorLock(lock) {
  let content = "";
  try {
    content = fs.readFileSync(lock, "utf8");
  } catch {
    return; // already claimed as stale and removed
  }
  if (!content.startsWith(`${process.pid} `)) return;
  unlinkPatiently(lock);
}

/** Rename attempts, 2 ms apart, while a reader holds the file open (Windows refuses the rename meanwhile). */
const RENAME_ATTEMPTS = 50;

/**
 * Replaces the file's content in one step: written to a temporary file next
 * to it, then renamed over it, so a reader sees the old content or the new
 * one, never a torn file. On Windows the rename is refused while another
 * process holds the file open, which a read does for microseconds: it is
 * retried briefly, and then the file is written in place, which the lock
 * every writer holds keeps free of a second writer. `replacer` filters the
 * fields written. Called under `withMonitorLock` only.
 */
function writeMonitorFile(file, m, replacer = null) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = JSON.stringify(m, replacer, 2);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content);
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(temporary, file);
      return;
    } catch (error) {
      const held = ["EPERM", "EBUSY", "EACCES"].includes(error.code);
      if (held && attempt < RENAME_ATTEMPTS) {
        pause(2);
        continue;
      }
      try {
        fs.unlinkSync(temporary);
      } catch {
        // nothing to clean
      }
      if (!held) throw error;
      fs.writeFileSync(file, content);
      return;
    }
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
 * Writes `m` after merging the file once more, under the file's lock, so
 * that what another process wrote since the last read is kept. Fields
 * starting with "_" are this process's memory, never saved.
 */
export function saveMonitor(file, m) {
  withMonitorLock(file, () => {
    refreshMonitor(file, m);
    writeMonitorFile(file, m, (key, value) => (key.startsWith("_") ? undefined : value));
  });
  m._fileWasmHash = m.wasmHash ?? null;
}

/** Adds a code hash to the announced upgrades on disk, under the file's lock: `npm run upgrade` does it before it proposes. */
export function announceUpgrade(file, hash) {
  withMonitorLock(file, () => {
    const m = readMonitorFile(file) ?? {};
    m.announced = [...new Set([...(m.announced ?? []), hash.toLowerCase()])];
    writeMonitorFile(file, m);
  });
}

/**
 * Moves the code baseline on disk to the executable the ledger holds after a
 * verified upgrade, under the file's lock; a running watch takes it up at
 * its next pass. Without a file there is no baseline yet: the first pass
 * takes the executable it reads.
 */
export function acknowledgeUpgrade(file, hash) {
  return withMonitorLock(file, () => {
    const m = readMonitorFile(file);
    if (!m) return false;
    m.wasmHash = hash.toLowerCase();
    writeMonitorFile(file, m);
    return true;
  });
}
