import assert from "node:assert/strict";
import { test } from "node:test";

import { closingLine, eventsOfRepo, heldNote, stillHeldLine, timelineOf } from "../src/timeline.js";

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

test("held shares wait for the share token, or for a seizure also for the lender's approval (rc5)", () => {
  const pendingRelease = { shares: "10000000000", to: "G..." };
  const seized = timelineOf(repo("Defaulted"), { now: T0 + 100 * 3600, events: [ev("repo_seized", T0 + 65 * 3600), ev("release_deferred", T0 + 65 * 3600)], pendingRelease });
  assert.equal(
    seized.at(-1).detail,
    "the delivery waits for the share token or for the lender's approval for the fund; the shares are recorded for the lender and can be released once both allow it",
  );
  // A repurchase's shares go back to the borrower, whom no approval gates: only the token can hold them.
  const repaid = timelineOf(repo("Repurchased"), { now: T0 + 10 * 3600, events: [ev("repo_repurchased", T0 + 3600), ev("release_deferred", T0 + 3600)], pendingRelease });
  assert.match(repaid.at(-1).detail, /^the share token refused the transfer/);
  const delivered = (status) =>
    timelineOf(repo(status), { now: T0 + 100 * 3600, events: [ev("repo_seized", T0 + 65 * 3600), ev("release_deferred", T0 + 65 * 3600), ev("shares_released", T0 + 66 * 3600)] }).at(-1).detail;
  assert.equal(delivered("Defaulted"), "held back at closing until the share token and the lender's approval allowed it, then delivered");
  assert.equal(delivered("Repurchased"), "held back by the share token at closing, delivered after the issuer allowed it");
});

test("the lines about held shares say what they wait for, and where the shares of a closing went", () => {
  assert.equal(heldNote("Defaulted", "1,000.00 tMMF"), "1,000.00 tMMF held: waiting for the share token or the lender's approval");
  assert.equal(heldNote("Repurchased", "1,000.00 tMMF"), "1,000.00 tMMF held: the issuer blocks the transfer");
  const shares = "1,000.00 tMMF";
  assert.equal(closingLine("seize", { id: 5, shares, deferred: false }), "Repo #5 closed: 1,000.00 tMMF sent to your wallet.");
  assert.equal(closingLine("seize", { id: 5, shares, deferred: true }), "Repo #5 closed: 1,000.00 tMMF are recorded for you and wait for the share token or for your approval as lender.");
  assert.equal(closingLine("seize", { id: 5, shares, deferred: null }), "Repo #5 closed.");
  assert.equal(closingLine("repurchase", { id: 6, shares, deferred: false }), "Repo #6 repurchased: 1,000.00 tMMF back in your wallet.");
  assert.match(closingLine("repurchase", { id: 6, shares, deferred: true }), /^Repo #6 repurchased: 1,000\.00 tMMF are recorded for you, since the share token refused the transfer/);
  assert.equal(closingLine("repurchase", { id: 6, shares, deferred: null }), "Repo #6 repurchased.");
  assert.match(stillHeldLine("Defaulted", 5), /^Repo #5: the delivery still waits for the share token or for your approval as lender\./);
  assert.match(stillHeldLine("Repurchased", 6), /^Repo #6: the issuer still blocks the transfer\./);
});

test("events are matched to a repo by topic or by data", () => {
  const events = [ev("repo_opened", T0), { event: "repo_opened", topics: [], closedAt: "", txHash: "x", data: { repo_id: "8" } }, { event: "repo_opened", topics: ["9"], data: {} }];
  assert.equal(eventsOfRepo(events, 7).length, 1);
  assert.equal(eventsOfRepo(events, "8").length, 1);
  assert.equal(eventsOfRepo(events, 9).length, 1);
  assert.equal(eventsOfRepo(undefined, 7).length, 0);
});
