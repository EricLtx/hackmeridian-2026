import assert from "node:assert/strict";
import { test } from "node:test";

import { CRITICAL, MARKER, criticalAreas, render } from "./critical.mjs";

test("each critical path maps to its area, in a fixed order", () => {
  assert.deepEqual(criticalAreas(["contracts/night-window/src/lib.rs"]), ["contract"]);
  assert.deepEqual(criticalAreas(["Cargo.lock"]), ["contract"]);
  assert.deepEqual(criticalAreas(["web/src/chain.js"]), ["signing-web"]);
  assert.deepEqual(criticalAreas(["web/package-lock.json"]), ["signing-web"]);
  assert.deepEqual(criticalAreas(["web/public/deployment.testnet.json"]), ["signing-web"]);
  assert.deepEqual(criticalAreas(["web/index.html"]), ["csp"]);
  assert.deepEqual(criticalAreas(["web/history.html"]), ["csp"]);
  assert.deepEqual(criticalAreas(["demo/monitor.mjs"]), ["operator-signing"]);
  assert.deepEqual(criticalAreas(["demo/setup.mjs", "demo/lib.mjs"]), ["operator-signing"]);
  assert.deepEqual(criticalAreas([".github/workflows/ci.yml"]), ["ci"]);
  assert.deepEqual(criticalAreas([".gitignore"]), ["repo-guard"]);
  assert.deepEqual(criticalAreas(["docs/security.md", ".claude/settings.json"]), ["repo-guard"]);
  assert.deepEqual(criticalAreas(["demo/lib.mjs", "contracts/x/src/lib.rs", "web/index.html"]), ["contract", "csp", "operator-signing"]);
});

test("paths outside the critical set give no area; unknown paths give every area", () => {
  assert.deepEqual(criticalAreas(["web/src/terms.js", "docs/roadmap.md", "demo/test/lib.test.mjs", "demo/README.md", "indexer/lib/export.mjs"]), []);
  assert.deepEqual(criticalAreas([]), []);
  assert.deepEqual(criticalAreas(null), CRITICAL.map((c) => c.area));
  assert.deepEqual(criticalAreas([42, null]), []);
});

test("the checklist starts with the marker and lists each area once, with its items", () => {
  const md = render(["csp", "ci"]);
  assert.ok(md.startsWith(`${MARKER}\n`));
  assert.equal(md.match(/^### /gm).length, 2);
  assert.equal((md.match(/\(`csp`\)/g) ?? []).length, 1);
  assert.match(md, /connect-src/);
  assert.match(md, /pull_request_target/);
  assert.doesNotMatch(md, /\(`contract`\)/);
  assert.equal(render([]).match(/^### /gm), null, "no section without an area");
});

test("every area has a title and at least three checklist items", () => {
  assert.equal(new Set(CRITICAL.map((c) => c.area)).size, CRITICAL.length);
  for (const c of CRITICAL) {
    assert.ok(c.title.length > 5, c.area);
    assert.ok(c.checklist.length >= 3, c.area);
  }
});
