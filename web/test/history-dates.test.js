// The registry table of the History page shows its dates in a short form,
// the full time as the title and the ISO value for machines; anything the
// export puts in a date cell is escaped or dropped, never run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { when, whenShort } from "../src/journal.js";

test("a short date keeps the minute, the ISO value and the full time as its title", () => {
  const cell = whenShort("2026-10-21T23:01:43Z", "en");
  assert.match(cell, /^<time datetime="2026-10-21T23:01:43Z" title="2026-10-21 23:01:43 UTC">/);
  assert.match(cell, /23:01/, "the minute, on a 24-hour clock whatever the language");
  assert.match(cell, /Oct/, "the month in letters");
  assert.match(cell, / UTC<\/time>$/);
  assert.equal(whenShort("2026-10-21T23:01:43Z", "fr-FR").includes("23:01"), true);
  assert.equal(when("2026-10-21T23:01:43Z"), "2026-10-21 23:01:43 UTC", "the tiles keep the full form");
});

test("a short date is a dash when the cell is empty or not a time", () => {
  assert.equal(whenShort("", "en"), "—");
  assert.equal(whenShort(null, "en"), "—");
  assert.equal(whenShort(undefined, "en"), "—");
  assert.equal(whenShort("not a date", "en"), "—");
  assert.equal(whenShort({}, "en"), "—");
});

test("a hostile date cell never reaches the markup unescaped", () => {
  for (const hostile of ['2026-10-21T23:01:43Z"><img src=x onerror=1>', "<script>alert(1)</script>", "2026-10-21T23:01:43Z' onmouseover='x"]) {
    const cell = whenShort(hostile, "en");
    assert.doesNotMatch(cell, /<(?!\/?time\b)/, `no tag but <time>: ${cell}`);
    assert.doesNotMatch(cell, /[^&]"[^ >]*onerror|onmouseover='/, `no attribute injected: ${cell}`);
  }
  // A time with a tag inside that still parses is shown escaped, not run.
  assert.doesNotMatch(whenShort("2026-10-21T23:01:43Z", "<script>"), /<script/);
});
