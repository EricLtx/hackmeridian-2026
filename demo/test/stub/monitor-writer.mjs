// One writer of a monitor state file, for demo/test/monitor-race.test.mjs:
// a watch merging and saving in a tight loop, an `npm run upgrade` announcing
// code hashes, or one acknowledging a baseline, each in a process of its
// own, through the real functions of monitor-state.mjs. No network, no key.
//   node test/stub/monitor-writer.mjs watch <file> <contract> <passes> <result.json> [paceMs]
//   node test/stub/monitor-writer.mjs announce <file> <prefix> <count> [-] [paceMs]
//   node test/stub/monitor-writer.mjs acknowledge <file> <hash> <count> [-] [paceMs]
//   node test/stub/monitor-writer.mjs hold <file> - <seconds> <result.json>   (holds the lock, writes nothing)
// `paceMs` rests that long between two operations (a hot loop without it).
import fs from "node:fs";
import { acknowledgeUpgrade, announceUpgrade, loadMonitor, refreshMonitor, saveMonitor, withMonitorLock } from "../../monitor-state.mjs";

const [role, file, a, b, out, paceArg] = process.argv.slice(2);
const pace = Number(paceArg ?? 0);
/** A busy wait: keeps both processes interleaving at file-system speed. */
const spin = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // nothing: the point is the interleaving
  }
};
/** The rest between two operations: a pace when one is set, else a few milliseconds of spin. */
const rest = (spinMs) => {
  if (pace > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pace);
  else spin(Math.random() * spinMs);
};
const errors = [];
const attempt = (fn) => {
  try {
    fn();
  } catch (error) {
    errors.push(error.code ?? error.message);
  }
};

if (role === "watch") {
  const m = loadMonitor(file, a);
  for (let pass = 0; pass < Number(b); pass += 1) {
    attempt(() => refreshMonitor(file, m)); // the start of a pass
    m.cursor = pass; // what the pass owns
    m.alertsSeen = { [`k${pass}`]: true };
    rest(2);
    attempt(() => refreshMonitor(file, m)); // before the decision
    attempt(() => saveMonitor(file, m));
  }
  fs.writeFileSync(out, JSON.stringify({ announced: m.announced ?? [], wasmHash: m.wasmHash ?? null, errors }));
} else if (role === "announce") {
  for (let i = 0; i < Number(b); i += 1) {
    attempt(() => announceUpgrade(file, `${a}${String(i).padStart(4, "0")}`));
    rest(3);
  }
  if (errors.length) console.error(JSON.stringify(errors.slice(0, 5)));
} else if (role === "acknowledge") {
  for (let i = 0; i < Number(b); i += 1) {
    attempt(() => acknowledgeUpgrade(file, a));
    rest(3);
  }
  if (errors.length) console.error(JSON.stringify(errors.slice(0, 5)));
} else if (role === "hold") {
  // A stalled writer: takes the lock and keeps it, alive, for `b` seconds.
  const until = Date.now() + Number(b) * 1000;
  withMonitorLock(file, () => {
    const t0 = Date.now();
    while (Date.now() < until) {
      // holding
    }
    fs.writeFileSync(out, JSON.stringify({ heldMs: Date.now() - t0, errors }));
  });
}
