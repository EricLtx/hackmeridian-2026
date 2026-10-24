import assert from "node:assert/strict";
import { test } from "node:test";

import { AREAS, changedPaths, classify, outputs } from "./changes.mjs";

const only = (...on) => Object.fromEntries(AREAS.map((a) => [a, on.includes(a)]));
const all = only(...AREAS);

test("a documentation-only change runs no build", () => {
  assert.deepEqual(classify(["docs/roadmap.md"]), only("docs"));
  assert.deepEqual(classify(["README.md", "docs/faq.md"]), only("docs"));
});

test("a Markdown file inside an area adds docs to that area", () => {
  assert.deepEqual(classify(["web/README.md"]), only("web", "docs"));
  assert.deepEqual(classify(["demo/README.md"]), only("tooling", "docs"));
});

test("the interface and the tooling run on their own", () => {
  assert.deepEqual(classify(["web/src/main.js"]), only("web"));
  assert.deepEqual(classify(["demo/lib.mjs"]), only("tooling"));
  assert.deepEqual(classify(["indexer/lib/export.mjs"]), only("tooling"));
});

test("a Rust change also runs the web and the tooling, which use the built WASM", () => {
  assert.deepEqual(classify(["contracts/night-window/src/events.rs"]), only("rust", "web", "tooling"));
  assert.deepEqual(classify(["Cargo.lock"]), only("rust", "web", "tooling"));
  assert.deepEqual(classify(["deny.toml"]), only("rust", "web", "tooling"));
  assert.deepEqual(classify(["rust-toolchain.toml"]), only("rust", "web", "tooling"));
});

test("a workflow change, a path no area claims, or an empty list runs everything", () => {
  assert.deepEqual(classify([".github/workflows/pages.yml"]), all);
  assert.deepEqual(classify(["web/src/main.js", ".github/dependabot.yml"]), all);
  assert.deepEqual(classify([".gitattributes"]), all);
  assert.deepEqual(classify(["LICENSE"]), all);
  assert.deepEqual(classify([".claude/settings.json"]), all);
  assert.deepEqual(classify([]), all);
  assert.deepEqual(classify(null), all);
  assert.deepEqual(classify(["web/src/main.js", ""]), all);
});

test("a path with spaces stays one path, and both sides of a rename are read", () => {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, args]);
    return "web/src/a b.js\0docs/old.md\0docs/new.md\0";
  };
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  assert.deepEqual(changedPaths(base, head, run), ["web/src/a b.js", "docs/old.md", "docs/new.md"]);
  assert.deepEqual(calls[0], ["git", ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`]]);
});

test("an unreadable diff, a bad or all-zero commit id, or an empty diff is unknown", () => {
  const head = "b".repeat(40);
  assert.equal(changedPaths("0".repeat(40), head, () => "x\0"), null);
  assert.equal(changedPaths("", head, () => "x\0"), null);
  assert.equal(changedPaths("abc; rm -rf /", head, () => "x\0"), null);
  assert.equal(changedPaths("a".repeat(40), head, () => { throw new Error("fatal"); }), null);
  assert.equal(changedPaths("a".repeat(40), head, () => ""), null);
});

test("the outputs: six keys, the areas of the diff on a pull request, everything otherwise", () => {
  const sha = (c) => c.repeat(40);
  const docs = outputs({ eventName: "pull_request", baseSha: sha("a"), headSha: sha("b"), paths: () => ["docs/roadmap.md"] });
  assert.deepEqual(docs, ["rust=false", "web=false", "tooling=false", "docs=true", "ci=false", "critical=[]"]);
  const csp = outputs({ eventName: "push", baseSha: sha("a"), headSha: sha("b"), paths: () => ["web/index.html"] });
  assert.deepEqual(csp, ["rust=false", "web=true", "tooling=false", "docs=false", "ci=false", 'critical=["csp"]']);
  const dispatch = outputs({ eventName: "workflow_dispatch", baseSha: "", headSha: "", paths: () => { throw new Error("never read"); } });
  assert.equal(dispatch.length, 6);
  assert.deepEqual(dispatch.slice(0, 5), AREAS.map((a) => `${a}=true`));
  assert.ok(JSON.parse(dispatch[5].slice("critical=".length)).length >= 6, "every critical area when the paths are unknown");
  const unknown = outputs({ eventName: "pull_request", baseSha: sha("a"), headSha: sha("b"), paths: () => null });
  assert.deepEqual(unknown.slice(0, 5), AREAS.map((a) => `${a}=true`));
});
