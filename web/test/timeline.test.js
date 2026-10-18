import assert from "node:assert/strict";
import { test } from "node:test";

import { eventsOfRepo, timelineOf } from "../src/timeline.js";

const T0 = 1_792_000_000;
const repo = (status, extra = {}) => ({ id: 7, status, opened_at: T0, maturity: T0 + 64 * 3600, principal: "1000000000", rate_bps: 300, shares: "10000000000", ...extra });
const ev = (event, at, data = {}) => ({ event, topics: ["7"], closedAt: new Date(at * 1000).toISOString(), txHash: `${event}-tx`, data });

test("an open repo before its term: opened, interest running, term next", () => {
  const steps = timelineOf(repo("Open"), { now: T0 + 90 * 60, opening: { txHash: "abc" } });
  assert.deepEqual(steps.map((s) => [s.key, s.state]), [["opened", "done"], ["interest", "now"], ["maturity", "next"]]);
  assert.equal(steps[0].tx, "abc");
  assert.match(steps[1].detail, /^2 started hours/);
  assert.equal(steps[2].at, T0 + 64 * 3600);
});

test("an open repo past its term is late", () => {
  const steps = timelineOf(repo("Open"), { now: T0 + 70 * 3600 });
  assert.equal(steps.at(-1).state, "late");
  assert.match(steps.at(-1).detail, /lender may take the shares/);
});

test("a repurchased repo takes its closing time and transaction from the events", () => {
  const events = [ev("repo_opened", T0), ev("repo_repurchased", T0 + 3 * 3600 + 10, { interest: "1" }), ev("offer_created", T0, {})];
  const steps = timelineOf(repo("Repurchased"), { now: T0 + 100 * 3600, events });
  assert.deepEqual(steps.map((s) => s.key), ["opened", "interest", "maturity", "closed"]);
  assert.equal(steps[0].tx, "repo_opened-tx");
  assert.match(steps[1].detail, /^4 started hours$/);
  assert.equal(steps[2].state, "off");
  assert.equal(steps[3].at, T0 + 3 * 3600 + 10);
  assert.equal(steps[3].tx, "repo_repurchased-tx");
});

test("a seized repo with shares held back, then delivered", () => {
  const held = timelineOf(repo("Defaulted"), { now: T0 + 100 * 3600, events: [ev("repo_seized", T0 + 65 * 3600), ev("release_deferred", T0 + 65 * 3600)], pendingRelease: { shares: "10000000000", to: "G..." } });
  assert.equal(held.at(-2).label, "Shares taken by the lender");
  assert.equal(held.at(-1).key, "release");
  assert.equal(held.at(-1).state, "late");
  const delivered = timelineOf(repo("Defaulted"), { now: T0 + 100 * 3600, events: [ev("repo_seized", T0 + 65 * 3600), ev("release_deferred", T0 + 65 * 3600), ev("shares_released", T0 + 66 * 3600)] });
  assert.equal(delivered.at(-1).state, "done");
  assert.equal(delivered.at(-1).tx, "shares_released-tx");
  assert.match(delivered.at(-1).detail, /held back .* delivered/);
});

test("events are matched to a repo by topic or by data", () => {
  const events = [ev("repo_opened", T0), { event: "repo_opened", topics: [], closedAt: "", txHash: "x", data: { repo_id: "8" } }, { event: "repo_opened", topics: ["9"], data: {} }];
  assert.equal(eventsOfRepo(events, 7).length, 1);
  assert.equal(eventsOfRepo(events, "8").length, 1);
  assert.equal(eventsOfRepo(events, 9).length, 1);
  assert.equal(eventsOfRepo(undefined, 7).length, 0);
});
