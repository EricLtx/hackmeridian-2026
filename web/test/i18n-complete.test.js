// Every text the interface marks for translation has a French and a Spanish
// entry that keeps its {placeholders} and its HTML tags; a new string
// without them fails here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { check } from "../scripts/i18n-check.mjs";

test("every marked text is translated in French and Spanish with the same placeholders and tags", async () => {
  const result = await check();
  assert.deepEqual(result.problems, [], "markup the check cannot read");
  assert.deepEqual(result.missing, [], "missing translations");
  assert.deepEqual(result.mismatched, [], "placeholders changed by a translation");
  assert.deepEqual(result.tags, [], "HTML tags changed by a translation");
  assert.deepEqual(result.conflicts, [], "a text translated differently in two files");
  assert.ok(result.keys > 300, `only ${result.keys} marked texts: the extraction is probably broken`);
});
