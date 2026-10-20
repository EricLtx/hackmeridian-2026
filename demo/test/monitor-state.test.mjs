// The monitor's state file shared between a running watch and the other
// writers (review finding TOOL-3, 20 October 2026): `npm run upgrade`
// announces and acknowledges, `npm run monitor -- --announce-...=` records a
// planned change, and the watch merges all of it before deciding and when
// it saves. The real functions, on a file in a temporary directory.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { LIMITS, decideActions, detect, recordAnnouncement } from "../detectors.mjs";
import { acknowledgeUpgrade, announceUpgrade, loadMonitor, mergeMonitor, readMonitorFile, refreshMonitor, saveMonitor } from "../monitor-state.mjs";

const OW = "CBDS6BZ2JOU6AGIR6FSFK6MNIS25DVYYD2ZHHHEWIPXH4ZDCVWWX7XGL";
const RC4 = "f5f13ae69499efdd23ae350d45f4bfe4bb25026bfcb6b44b264a2d3d2effbcea";
const RC5 = "a4062abac12f6d0c158d8228b84be759be55a0537b2dff1784376807e3b6b62a";

const fileIn = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ow-monitor-")), "monitor.json");

/** A snapshot with nothing in it but `over`. */
const snap = (over = {}) => ({
  now: 1_800_000_000, latest: 10, from: 1, funds: [], caps: {}, paused: false, repos: [], openRepos: [], releases: [], ttl: [], wasmHash: null,
  events: [], keeperRole: "keeper", keeperXlm: 10_000, rpcHeights: null, journal: null, schemaVersion: 2, sentinel: null, pending: {}, ...over,
});

test("an upgrade and a handover announced while a watch runs are seen by its next decision, and survive its save", () => {
  const file = fileIn();
  saveMonitor(file, { contract: OW, announced: [] });
  // The watch starts: its state is read once.
  const watch = loadMonitor(file, OW);
  // `npm run upgrade` announces the code before it proposes it.
  announceUpgrade(file, RC5.toUpperCase());
  // `npm run monitor -- --announce-admin=G...`, in a process of its own.
  const planned = loadMonitor(file, OW);
  recordAnnouncement(planned, ["--announce-admin=GBNEWGOVERNORXX"]);
  saveMonitor(file, planned);
  // The watch's next pass: it merges the file before reading and before deciding.
  refreshMonitor(file, watch);
  const s = snap({
    events: [
      { name: "upgrade_proposed", ledger: 5, txHash: "t1", data: { wasm_hash: Buffer.from(RC5, "hex"), eta: 1_800_000_300n } },
      { name: "admin_proposed", ledger: 6, txHash: "t2", data: { proposed: "GBNEWGOVERNORXX" } },
    ],
    pending: { upgrade: { hash: RC5, eta: 1_800_000_300 }, admin: { admin: "GBNEWGOVERNORXX", eta: 1_800_000_300 } },
  });
  const alerts = detect(s, watch, { limits: LIMITS });
  assert.deepEqual(alerts.filter((a) => a.level === "critical"), []);
  const { actions } = decideActions(alerts, s, refreshMonitor(file, watch), { actor: "sentinel", keys: { guardian: true, trustee: true } });
  assert.deepEqual(actions, []);
  saveMonitor(file, watch);
  const onDisk = readMonitorFile(file);
  assert.deepEqual([onDisk.announced, onDisk.announcedAdmins], [[RC5], ["GBNEWGOVERNORXX"]]);
});

test("the code baseline `npm run upgrade` moves survives a running watch's save: a restarted watch reports no code change", () => {
  const file = fileIn();
  saveMonitor(file, { contract: OW, announced: [], wasmHash: RC4 });
  const watch = loadMonitor(file, OW);
  assert.equal(acknowledgeUpgrade(file, RC5), true);
  // The watch's next save keeps the moved baseline instead of writing its own back.
  saveMonitor(file, watch);
  assert.equal(watch.wasmHash, RC5);
  const restarted = loadMonitor(file, OW);
  const critical = detect(snap({ wasmHash: RC5 }), restarted, { limits: LIMITS }).filter((a) => a.level === "critical");
  assert.deepEqual(critical, []);
  // The watch's own baseline is never replaced by its own earlier write.
  watch.wasmHash = RC5;
  saveMonitor(file, watch);
  mergeMonitor(watch, readMonitorFile(file));
  assert.equal(watch.wasmHash, RC5);
});

test("a file of another deployment is never merged; a new deployment keeps only the announced codes; no file, no baseline", () => {
  const file = fileIn();
  fs.writeFileSync(file, JSON.stringify({ contract: "COTHER", announced: [RC4], announcedAdmins: ["GOLD"], wasmHash: RC4 }));
  const fresh = loadMonitor(file, OW);
  assert.deepEqual([fresh.contract, fresh.announced, fresh.announcedAdmins, fresh.wasmHash], [OW, [RC4], undefined, undefined]);
  mergeMonitor(fresh, readMonitorFile(file));
  assert.deepEqual([fresh.announcedAdmins, fresh.wasmHash], [undefined, undefined]);
  // Fields of this process's memory are never written.
  fresh._trail = { events: new Map() };
  saveMonitor(file, fresh);
  assert.equal("_trail" in readMonitorFile(file), false);
  assert.equal("_fileWasmHash" in readMonitorFile(file), false);
  const missing = path.join(path.dirname(file), "none.json");
  assert.equal(acknowledgeUpgrade(missing, RC5), false);
  assert.equal(fs.existsSync(missing), false);
});
