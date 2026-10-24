// The guided tour's content and the pure helpers of its live scenes: the
// rules of the presentation brief (one job per scene, at most thirty words
// of body text, speaker notes for every scene), the cost the contract would
// charge, and the reading of untrusted data (the indexer's export, prices).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { HOUR, interest } from "../src/terms.js";
import { COMPARE, COST_PRESETS, PLANETS, ROLES, SCENES, bestRate, costOf, freshness, isOpen, openHours, replayRepo, visibleWords } from "../src/tour-scenes.js";

const KINDS = ["title", "hook", "context", "problem", "insight", "roles", "journey", "cost", "live", "safety", "questions", "roadmap", "cta"];

test("thirteen scenes, hook to call to action, each with one job and a renderer", () => {
  assert.deepEqual(
    SCENES.map((s) => s.kind),
    KINDS,
  );
  assert.equal(new Set(SCENES.map((s) => s.id)).size, SCENES.length, "scene ids are unique");
  for (const s of SCENES) {
    assert.ok(s.kicker && s.title, `${s.id} has a kicker and a headline`);
  }
});

test("no scene shows more than thirty words of body text", () => {
  for (const s of SCENES) assert.ok(visibleWords(s) <= 30, `${s.id}: ${visibleWords(s)} words`);
});

test("every scene has complete speaker notes", () => {
  for (const s of SCENES) {
    for (const field of ["key", "say", "stress", "question", "answer", "next"]) {
      assert.ok(typeof s.notes?.[field] === "string" && s.notes[field].length > 3, `${s.id} notes.${field}`);
    }
  }
});

test("the doors of the last scene stay on this site", () => {
  const cta = SCENES.find((s) => s.kind === "cta");
  for (const [, href] of cta.doors) assert.match(href, /^\.\/[a-z]+\.html(\?view=terminal|#board)?$/);
});

test("each role states what it can do and what it can never do", () => {
  assert.equal(ROLES.length, 7);
  for (const r of ROLES) assert.ok(r.name && r.can && r.never, r.id);
});

test("the three parties a visitor may be get an 'is it for you?' moment, with the answer when it is not a fit", () => {
  for (const id of ["holder", "lender", "steward"]) {
    const r = ROLES.find((x) => x.id === id);
    assert.ok(r.fit, `${id} has a fit block`);
    assert.ok(r.fit.questions.length >= 2 && r.fit.questions.length <= 3, `${id}: two or three questions`);
    for (const q of r.fit.questions) assert.match(q, /\?$/, `${id}: a question`);
    assert.match(r.fit.no, /not for you|not the tool|do not lend/, `${id}: says when it is not a fit`);
  }
  for (const id of ["governor", "guardian", "sentinel", "trustee"]) assert.equal(ROLES.find((x) => x.id === id).fit, undefined);
});

/** Every text a visitor reads on the scenes (not the speaker notes). */
function visibleTexts() {
  const out = [];
  for (const s of SCENES) {
    out.push(s.kicker, s.title, s.body ?? "", ...(s.points ?? []));
    for (const pair of [...(s.steps ?? []), ...(s.tabs ?? []), ...(s.faq ?? []), ...(s.phases ?? [])]) out.push(...pair);
    for (const [label] of s.doors ?? []) out.push(label);
  }
  for (const r of ROLES) out.push(r.name, r.can, r.never, ...(r.fit?.questions ?? []), r.fit?.no ?? "");
  out.push(COMPARE.before.title, ...COMPARE.before.items, COMPARE.after.title, ...COMPARE.after.items);
  return out.filter(Boolean);
}

test("counselling tone: no marketing superlative and no business figure on the scenes", () => {
  const forbidden = /\b(first|guaranteed|guarantee[sd]?|instant(?:ly)?|audited|safest|oldest|fastest|cheapest|unique|revolutionary|seamless)\b/i;
  for (const text of visibleTexts()) {
    assert.doesNotMatch(text, forbidden, text);
    // No yield, rate, amount or count typed into the scenes: figures come from the chain, or from the cost scene's formula.
    assert.doesNotMatch(text, /\d+(?:[.,]\d+)?\s*(?:%|€|\$|EUR|USD|bps|tests?|drills?)\b/i, text);
  }
});

test("the approach is stated before anything is read live: repo not pool, fixed terms, exits open, what is not claimed", () => {
  const index = (kind) => SCENES.findIndex((s) => s.kind === kind);
  const textOf = (kind) => visibleTexts().join(" ") && [SCENES[index(kind)]].flatMap((s) => [s.title, s.body ?? "", ...(s.tabs ?? []).flat(), ...(s.faq ?? []).flat()]).join(" ");
  assert.ok(index("insight") < index("journey") && index("roles") < index("cost") && index("cost") < index("live"));
  assert.match(textOf("insight"), /repo, not a pool/i);
  assert.match(textOf("insight"), /fixed term, fixed rate/i);
  assert.match(textOf("insight"), /no liquidation, no margin call/i);
  assert.match(textOf("safety"), /no pause and no upgrade blocks an exit/i);
  assert.match(textOf("safety"), /guardian or the trustee can veto/i);
  assert.match(textOf("questions"), /testnet/i);
  assert.match(textOf("questions"), /nothing promises liquidity/i);
  assert.match(textOf("questions"), /third party/i);
  assert.match(ROLES.find((r) => r.id === "steward").never, /never lends/i);
});

test("the planets name bundled textures, on scenes after the first, and move only when motion is allowed", () => {
  const withPlanet = SCENES.filter((s) => s.planet);
  assert.ok(withPlanet.length >= 1 && withPlanet.length <= PLANETS.length);
  assert.equal(SCENES[0].planet, undefined, "the first scene carries no lazy planet");
  for (const s of withPlanet) assert.ok(PLANETS.includes(s.planet), `${s.id}: ${s.planet}`);
  const tour = readFileSync(new URL("../src/tour.js", import.meta.url), "utf8");
  assert.match(tour, /tour-planet-strip"><img [^>]*loading="lazy"[^>]*decoding="async"|tour-planet-strip">\$\{img\}/);
  assert.match(tour, /width="2048" height="1024" loading="lazy" decoding="async"/);
  const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const allowed = css.indexOf("@media (prefers-reduced-motion: no-preference)");
  assert.ok(allowed > 0);
  const end = css.indexOf("\n}\n", allowed);
  for (const name of ["ow-planet-spin", "ow-sky-drift"]) {
    const uses = [...css.matchAll(new RegExp(`animation:[^;]*\\b${name}\\b`, "g"))].map((m) => m.index);
    assert.equal(uses.length, 1, `${name} is used once`);
    assert.ok(uses[0] > allowed && uses[0] < end, `${name} runs only when motion is allowed`);
  }
  const reduce = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduce, /\.tour-planet-strip\s*\{[^}]*animation: none/);
});

test("the week view: 40 open hours in business hours, all 168 with Open Window", () => {
  assert.equal(openHours("hours"), 40);
  assert.equal(openHours("window"), 168);
  assert.equal(isOpen("hours", 4, 16), true, "Friday 16:00");
  assert.equal(isOpen("hours", 4, 18), false, "Friday 18:00");
  assert.equal(isOpen("hours", 5, 10), false, "Saturday");
});

test("the cost is the contract's interest for the hours chosen", () => {
  const principal = 10_000n * 10n ** 7n;
  for (const [, hours] of COST_PRESETS) {
    const { interest: due, total } = costOf(principal, 300, hours);
    assert.equal(due, interest(principal, 300, hours * HOUR));
    assert.equal(total, principal + due);
  }
  // 10,000 × 3 % × 64 / 8,760 hours = 2.1917808…, rounded up to the unit (7 decimals).
  assert.equal(costOf(principal, 300, 64).interest, 21_917_809n, "10,000 at 3 % over a 64-hour weekend");
  assert.equal(costOf(principal, 300, 0).interest, costOf(principal, 300, 1).interest, "at least one hour is charged");
});

test("the best rate is the lowest among offers with funds left", () => {
  assert.equal(bestRate([{ available: "0", rate_bps: 100 }, { available: 5n, rate_bps: 275 }, { available: "9", rate_bps: 250 }]), 250);
  assert.equal(bestRate([{ available: 0n, rate_bps: 100 }]), null);
  assert.equal(bestRate(null), null);
  // Asked for a term and a stablecoin, only the offers that could serve the loan count.
  const offers = [
    { available: "9", rate_bps: 200, max_term: String(48 * HOUR), stablecoin: "CA" },
    { available: "9", rate_bps: 250, max_term: String(168 * HOUR), stablecoin: "CB" },
    { available: "9", rate_bps: 300, max_term: String(168 * HOUR), stablecoin: "CA" },
  ];
  assert.equal(bestRate(offers, { hours: 24, stablecoin: "CA" }), 200);
  assert.equal(bestRate(offers, { hours: 64, stablecoin: "CA" }), 300, "the 48-hour offer cannot serve 64 hours");
  assert.equal(bestRate(offers, { hours: 64 }), 250);
  assert.equal(bestRate(offers, { hours: 200, stablecoin: "CA" }), null);
  assert.equal(bestRate([{ available: "9", rate_bps: 100 }], { hours: 1 }), null, "an offer without a longest term is not trusted");
});

const repo = (over = {}) => ({
  repo_id: "3",
  status: "repurchased",
  principal: "83370000000",
  interest: "237929",
  rate_bps: "250",
  currency: "EUR",
  opened_at: "2026-10-17T13:10:02Z",
  closed_at: "2026-10-17T15:11:02Z",
  ...over,
});

test("the replayed repo is the largest repurchased one whose fields read as expected", () => {
  const picked = replayRepo([repo(), repo({ repo_id: "7", principal: "90000000000" }), repo({ repo_id: "9", status: "open", principal: "99000000000" })]);
  assert.equal(picked.id, "7");
  assert.equal(picked.principal, 90_000_000_000n);
  assert.equal(picked.hours, 3, "2 h 01 min charged as three started hours");
});

test("a malformed export entry is skipped, never shown", () => {
  const bad = [
    repo({ principal: "1e9" }),
    repo({ interest: "-5" }),
    repo({ rate_bps: "<b>" }),
    repo({ currency: '<img src=x onerror="alert(1)">' }),
    repo({ opened_at: "yesterday" }),
    repo({ repo_id: "1; DROP" }),
    repo({ opened_at: "2026-10-17T15:11:02Z", closed_at: "2026-10-17T13:10:02Z" }),
    null,
  ];
  assert.equal(replayRepo(bad), null);
  assert.equal(replayRepo("not a list"), null);
  assert.equal(replayRepo(undefined), null);
});

test("a price's freshness follows the age the contract accepts", () => {
  assert.deepEqual(freshness(1000, 3600, 4000), { age: 3000, fresh: true });
  assert.deepEqual(freshness(1000, 3600, 5000), { age: 4000, fresh: false });
  assert.equal(freshness("x", 3600, 5000), null);
  assert.equal(freshness(0, 3600, 5000), null);
});

test("the tour's images are bundled WebP files within their budget, credited in NOTICE", () => {
  let planets = 0;
  for (const name of ["earth", "stars", ...PLANETS]) {
    const file = readFileSync(new URL(`../public/tour/${name}.webp`, import.meta.url));
    assert.equal(file.subarray(0, 4).toString("latin1"), "RIFF");
    assert.equal(file.subarray(8, 12).toString("latin1"), "WEBP");
    if (PLANETS.includes(name)) {
      assert.ok(file.length <= 450 * 1024, `${name}: ${file.length} bytes`);
      planets += file.length;
    }
  }
  assert.ok(planets <= 1600 * 1024, `planet textures: ${planets} bytes`);
  const notice = readFileSync(new URL("../../NOTICE", import.meta.url), "utf8");
  assert.match(notice, /NASA 3D/);
  assert.match(notice, /Solar System Scope \(https:\/\/www\.solarsystemscope\.com\/textures\/\)/);
  assert.match(notice, /CC BY 4\.0 \(https:\/\/creativecommons\.org\/licenses\/by\/4\.0\/\)/);
  assert.match(notice, /reveal\.js 6\.0\.2/);
});

test("the tour page keeps the interface's content security policy, without friendbot", () => {
  const html = readFileSync(new URL("../tour.html", import.meta.url), "utf8");
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? "";
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /img-src 'self' data:;/);
  assert.doesNotMatch(csp, /friendbot/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, "no inline script");
});
