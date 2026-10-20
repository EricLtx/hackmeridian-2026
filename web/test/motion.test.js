// Value flashes: a displayed figure is read in the language in use, and its
// move decides the colour (up green, down red, other changes neutral).

import { test } from "node:test";
import assert from "node:assert/strict";
import { changeOf, readNumber } from "../src/motion.js";

test("a displayed figure is read with the separators of its language", () => {
  assert.equal(readNumber("1,250.50 tEUR", "."), 1250.5);
  assert.equal(readNumber("1\u00a0250,50 tEUR", ","), 1250.5);
  assert.equal(readNumber("12.345.678,90", ","), 12345678.9);
  assert.equal(readNumber("2,50 %", ","), 2.5);
  assert.equal(readNumber("-3.5", "."), -3.5);
  assert.equal(readNumber("OPEN", "."), null);
  assert.equal(readNumber("", "."), null);
  assert.equal(readNumber("tMMF 1.0855 USD 3m42s", "."), 1.0855);
});

test("a move is up, down, same, or changed when the text is not a number", () => {
  assert.equal(changeOf("1,000.00", "1,000.01", "."), "up");
  assert.equal(changeOf("900,20", "899,90", ","), "down");
  assert.equal(changeOf("1.0855", "1.0855", "."), "same");
  assert.equal(changeOf("1.08550", "1.0855", "."), "same");
  assert.equal(changeOf("OPEN", "PAUSED", "."), "changed");
  assert.equal(changeOf("—", "1.00", "."), "changed");
});
