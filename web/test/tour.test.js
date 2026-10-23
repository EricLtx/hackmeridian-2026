// The guided tour's content and the pure helpers of its live scenes: the
// rules of the presentation brief (one job per scene, at most thirty words
// of body text, speaker notes for every scene), the cost the contract would
// charge, and the reading of untrusted data (the indexer's export, prices).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { HOUR, interest } from "../src/terms.js";
import { COST_PRESETS, ROLES, SCENES, bestRate, costOf, freshness, isOpen, openHours, replayRepo, visibleWords } from "../src/tour-scenes.js";

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

test("the tour's images are bundled WebP files, credited in NOTICE", () => {
  for (const name of ["earth", "stars"]) {
    const head = readFileSync(new URL(`../public/tour/${name}.webp`, import.meta.url)).subarray(0, 12);
    assert.equal(head.subarray(0, 4).toString("latin1"), "RIFF");
    assert.equal(head.subarray(8, 12).toString("latin1"), "WEBP");
  }
  const notice = readFileSync(new URL("../../NOTICE", import.meta.url), "utf8");
  assert.match(notice, /NASA 3D/);
});

test("the tour page keeps the interface's content security policy, without friendbot", () => {
  const html = readFileSync(new URL("../tour.html", import.meta.url), "utf8");
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? "";
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /img-src 'self' data:;/);
  assert.doesNotMatch(csp, /friendbot/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/, "no inline script");
});
