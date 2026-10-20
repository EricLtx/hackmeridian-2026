// OPEN_WINDOW_STATE names files under demo/.state/ (the state file, the
// monitor file, a disposable deployment file): a name that is not made of
// letters, digits, _ and - is refused when lib.mjs loads, in every script,
// before any file is read or written. Each case runs in a process of its
// own, since the name is read at import.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Loads lib.mjs with `name` as OPEN_WINDOW_STATE, then calls loadState() and reports the state file it would use. */
function load(name) {
  const script = "const lib = await import('./lib.mjs'); const s = lib.loadState(); console.log(JSON.stringify({ file: lib.STATE_FILE, name: lib.STATE_NAME, keys: Object.keys(s.keys ?? {}).length }));";
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: DEMO,
    env: { ...process.env, OPEN_WINDOW_STATE: name, STELLAR_RPC_URLS: "https://rpc.stub.invalid" },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

test("a state name with a parent reference or a separator is refused when lib.mjs loads, before any file is read or written", () => {
  for (const [name, would] of [["../x", path.join(DEMO, "x.json")], ["a/b", path.join(DEMO, ".state", "a", "b.json")], ["..", path.join(DEMO, ".state", "..json")]]) {
    const r = load(name);
    assert.equal(r.status, 1, `${name}: ${r.out} ${r.err}`);
    assert.match(r.err, /OPEN_WINDOW_STATE must be made of letters, digits, _ and - only, not /);
    assert.equal(r.out, "", `${name}: nothing ran past the import`);
    assert.equal(fs.existsSync(would), false, `${name}: no file at ${would}`);
    assert.equal(fs.existsSync(path.dirname(would)) && path.dirname(would) !== DEMO && path.dirname(would) !== path.join(DEMO, ".state"), false, `${name}: no folder created`);
  }
});

test("an accepted name points every script at demo/.state/<name>.json, which an offline name leaves unread when missing", () => {
  const r = load("offline-name-check");
  assert.equal(r.status, 0, r.err);
  const got = JSON.parse(r.out);
  assert.deepEqual(got, { file: path.join(DEMO, ".state", "offline-name-check.json"), name: "offline-name-check", keys: 0 });
  assert.equal(fs.existsSync(got.file), false, "loadState reads, never creates");
});
