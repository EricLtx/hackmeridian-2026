// Two processes on one monitor state file (review finding TOOL-3 and its
// residual, 20 October 2026): a watch merging and saving in a tight loop
// while `npm run upgrade` announces, then acknowledges, through the real
// functions of monitor-state.mjs (test/stub/monitor-writer.mjs). Every
// writer takes the file's lock around its read-merge-write and replaces the
// file in one rename, so nothing written between a read and a write is
// lost, and no reader sees a torn file.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { saveMonitor } from "../monitor-state.mjs";

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OW = "CBDS6BZ2JOU6AGIR6FSFK6MNIS25DVYYD2ZHHHEWIPXH4ZDCVWWX7XGL";
const RC4 = "f5f13ae69499efdd23ae350d45f4bfe4bb25026bfcb6b44b264a2d3d2effbcea";
const RC5 = "a4062abac12f6d0c158d8228b84be759be55a0537b2dff1784376807e3b6b62a";

const runWriter = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, ["test/stub/monitor-writer.mjs", ...args], { cwd: DEMO, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  child.on("exit", (code) => resolve({ code, err }));
});

/** A watch of `passes` passes against `announcements` announcements (and `acknowledgements` of RC5): what the file and the watch hold at the end. */
async function race({ passes, announcements, acknowledgements = 0 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-race-"));
  const file = path.join(dir, "monitor.json");
  const result = path.join(dir, "watch.json");
  saveMonitor(file, { contract: OW, announced: [], wasmHash: RC4 });
  const jobs = [runWriter(["watch", file, OW, String(passes), result]), runWriter(["announce", file, "hash", String(announcements)])];
  if (acknowledgements) jobs.push(runWriter(["acknowledge", file, RC5, String(acknowledgements)]));
  const exits = await Promise.all(jobs);
  const disk = JSON.parse(fs.readFileSync(file, "utf8"));
  const watch = JSON.parse(fs.readFileSync(result, "utf8"));
  const expected = Array.from({ length: announcements }, (_, i) => `hash${String(i).padStart(4, "0")}`);
  const lostOnDisk = expected.filter((h) => !(disk.announced ?? []).includes(h));
  const leftovers = fs.readdirSync(dir).filter((name) => name !== "monitor.json" && name !== "watch.json");
  fs.rmSync(dir, { recursive: true, force: true });
  return { disk, watch, exits, lostOnDisk, leftovers };
}

test("no announcement made while a watch saves is lost, from the file or from the watch, and no writer sees a torn file", async () => {
  const r = await race({ passes: 200, announcements: 60 });
  assert.deepEqual(r.exits.map((e) => e.code), [0, 0]);
  assert.deepEqual(r.lostOnDisk, [], `${r.lostOnDisk.length} of 60 announcements missing from the file`);
  assert.equal(r.watch.announced.length, 60, "the watch's memory holds every announcement");
  assert.deepEqual(r.watch.errors, [], "the watch read and wrote without an error");
  assert.equal(r.exits[1].err.trim(), "", "the announcer wrote without an error");
  assert.equal(r.disk.cursor, 199, "the watch's own last pass is on disk");
  assert.deepEqual(r.leftovers, [], "no lock or temporary file left behind");
});

test("an acknowledged code baseline survives a watch saving at the same time", async () => {
  for (let round = 0; round < 2; round += 1) {
    const r = await race({ passes: 150, announcements: 15, acknowledgements: 1 });
    assert.deepEqual([r.disk.wasmHash, r.watch.wasmHash], [RC5, RC5], `round ${round + 1}: the old baseline came back on disk or in the watch`);
    assert.deepEqual(r.lostOnDisk, []);
  }
});
