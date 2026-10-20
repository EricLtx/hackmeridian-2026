// One writer of a monitor state file, for demo/test/monitor-race.test.mjs:
// a watch merging and saving in a tight loop, an `npm run upgrade` announcing
// code hashes, or one acknowledging a baseline, each in a process of its
// own, through the real functions of monitor-state.mjs. No network, no key.
//   node test/stub/monitor-writer.mjs watch <file> <contract> <passes> <result.json>
//   node test/stub/monitor-writer.mjs announce <file> <prefix> <count>
//   node test/stub/monitor-writer.mjs acknowledge <file> <hash> <count>
import fs from "node:fs";
import { acknowledgeUpgrade, announceUpgrade, loadMonitor, refreshMonitor, saveMonitor } from "../../monitor-state.mjs";

const [role, file, a, b, out] = process.argv.slice(2);
/** A busy wait: keeps both processes interleaving at file-system speed. */
const spin = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // nothing: the point is the interleaving
  }
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
    spin(Math.random() * 2);
    attempt(() => refreshMonitor(file, m)); // before the decision
    attempt(() => saveMonitor(file, m));
  }
  fs.writeFileSync(out, JSON.stringify({ announced: m.announced ?? [], wasmHash: m.wasmHash ?? null, errors }));
} else if (role === "announce") {
  for (let i = 0; i < Number(b); i += 1) {
    attempt(() => announceUpgrade(file, `${a}${String(i).padStart(4, "0")}`));
    spin(Math.random() * 3);
  }
  if (errors.length) console.error(JSON.stringify(errors.slice(0, 5)));
} else if (role === "acknowledge") {
  for (let i = 0; i < Number(b); i += 1) {
    attempt(() => acknowledgeUpgrade(file, a));
    spin(Math.random() * 3);
  }
  if (errors.length) console.error(JSON.stringify(errors.slice(0, 5)));
}
