// Interface languages: the choice of language, placeholders and plurals,
// numbers, durations and inputs in French and Spanish, and the reading of
// marked texts by the completeness check.

import { test } from "node:test";
import assert from "node:assert/strict";
import { initialLang, pickLang, setLang, t, tn } from "../src/i18n.js";
import { formatAge, formatAmount, formatDuration, formatRate, formatTerm, formatUnits, toUnits, unitsToInput } from "../src/format.js";
import { quantity, rate, term } from "../src/command.js";
import { htmlKeys, jsKeys } from "../scripts/i18n-check.mjs";

const ONE = 10_000_000n;
const inLang = (code, fn) => {
  setLang(code);
  try {
    fn();
  } finally {
    setLang("en");
  }
};

test("language choice: the URL, then the device, then the browser, else English", () => {
  assert.equal(initialLang({ search: "?lang=es", stored: "fr", preferred: ["en-US"] }), "es");
  assert.equal(initialLang({ search: "?lang=de", stored: "fr" }), "fr");
  assert.equal(initialLang({ stored: null, preferred: ["de-DE", "fr-CA"] }), "fr");
  assert.equal(initialLang({ preferred: ["de-DE"] }), "en");
  assert.equal(pickLang(["ES-mx"]), "es");
  assert.equal(setLang("xx"), "en");
});

test("t fills placeholders after the lookup and falls back to English", () => {
  inLang("fr", () => {
    assert.equal(t("just now"), "à l'instant");
    assert.equal(t("{duration} ago", { duration: "5 min" }), "il y a 5 min");
    assert.equal(t("Not in any dictionary {x}.", { x: 1 }), "Not in any dictionary 1.");
  });
  assert.equal(t("{duration} ago", { duration: "5 min" }), "5 min ago");
  assert.equal(t("{a} and {b}", { a: 1 }), "1 and {b}");
});

test("plurals follow each language: French counts zero as singular", () => {
  assert.equal(tn("{n} hour", "{n} hours", 0), "0 hours");
  inLang("fr", () => {
    assert.equal(tn("{n} hour", "{n} hours", 0), "0 heure");
    assert.equal(tn("{n} hour", "{n} hours", 2), "2 heures");
  });
  inLang("es", () => {
    assert.equal(tn("{n} hour", "{n} hours", 1), "1 hora");
    assert.equal(tn("{n} hour", "{n} hours", 0), "0 horas");
  });
});

test("amounts, rates, durations and terms in French and Spanish", () => {
  inLang("fr", () => {
    assert.equal(formatAmount(12_505_000_000n), "1 250,50");
    assert.equal(formatAmount(15_294_978n), "1,53");
    assert.equal(formatRate(250), "2,50 %");
    assert.equal(formatUnits(108_500_238_083_460n, 14, { digits: 4 }), "1,0850");
    assert.equal(formatDuration(2 * 86400 + 4 * 3600), "2 j 4 h");
    assert.equal(formatTerm(604800), "168 heures (7 jours)");
    assert.equal(formatAge(100, 700), "il y a 10 min");
    assert.equal(unitsToInput(12_505_000_000n, 7), "1250,5");
  });
  inLang("es", () => {
    assert.equal(formatAmount(12_505_000_000n), "1250,50");
    assert.equal(formatAmount(123_456_789_012_345n), "12.345.678,90");
    assert.equal(formatTerm(3600), "1 hora");
    assert.equal(formatTerm(604800), "168 horas (7 días)");
    assert.equal(formatAge(100, 700), "hace 10 min");
  });
  assert.equal(unitsToInput(12_505_000_000n, 7), "1250.5");
});

test("inputs: each language's separators; ambiguous forms are refused, never misread", () => {
  assert.equal(toUnits("1,250.5", 7), 12_505_000_000n);
  assert.equal(toUnits("1 250.5", 7), 12_505_000_000n);
  assert.equal(toUnits("1,25", 7), null);
  for (const code of ["fr", "es"]) {
    inLang(code, () => {
      assert.equal(toUnits("1250,5", 7), 12_505_000_000n, code);
      assert.equal(toUnits("1 250,5", 7), 12_505_000_000n, code);
      assert.equal(toUnits("1 250,5", 7), 12_505_000_000n, code);
      assert.equal(toUnits("1.250,5", 7), 12_505_000_000n, code);
      assert.equal(toUnits("1250.5", 7), 12_505_000_000n, code);
      assert.equal(toUnits("1.000", 7), 1000n * ONE, code);
      assert.equal(toUnits("1,000.5", 7), null, code);
      assert.equal(toUnits(",5", 7), 5_000_000n, code);
      assert.equal(toUnits(",", 7), null, code);
      assert.equal(quantity("1,5K", 7), 1500n * ONE, code);
      assert.equal(rate("3,25"), 325, code);
      assert.equal(rate("325PB"), 325, code);
      assert.equal(term("2J"), 48 * 3600, code);
      assert.equal(term("1S"), 168 * 3600, code);
    });
  }
});

test("the completeness check reads the texts marked in code and in pages", () => {
  const js = 'x = t("Repo #{id} does not exist.", { id }); y = tk("label"); z = tn("{n} offer", "{n} offers", n); split("a"); a.t("no");';
  assert.deepEqual(
    jsKeys(js).map((k) => k.key),
    ["Repo #{id} does not exist.", "label", "{n} offer", "{n} offers"],
  );
  const html =
    '<p data-i18n>Hello &amp; welcome\n  here</p><button data-i18n-attr="title" title="Refresh now">R</button>' +
    "<p data-i18n-html>See <code>x/</code></p><p data-i18n>Bad <b>x</b></p>";
  const found = htmlKeys(html);
  assert.deepEqual(
    found.filter((f) => f.key).map((f) => f.key),
    ["Hello & welcome here", "Refresh now", "See <code>x/</code>"],
  );
  assert.equal(found.filter((f) => f.problem).length, 1);
});

test("tc picks the entry of its context, then the plain entry, then English", async () => {
  const { tc } = await import("../src/i18n.js");
  assert.equal(tc("wallet", "none"), "none");
  inLang("fr", () => {
    assert.equal(tc("wallet", "none"), "aucun");
    assert.equal(tc("unknown context", "none"), "aucune");
    assert.equal(tc("unknown context", "Not in any dictionary"), "Not in any dictionary");
  });
  inLang("es", () => assert.equal(tc("wallet", "none"), "ninguna"));
  const js = 'x = tc("wallet", "none");';
  assert.deepEqual(
    jsKeys(js).map((k) => k.key),
    ["wallet\u0004none"],
  );
});
