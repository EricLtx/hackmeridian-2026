// The inventory's rc5 rules on hand-made numbers, and on fund 1's as read
// from testnet on 20 October 2026 (review finding TOOL-8): no network.

import assert from "node:assert/strict";
import { test } from "node:test";

import { NEAR_TOP_DAYS, codeTtlIssues, corridor, corridorHaircutBps, corridorHeadroom, corridorIssues, daysToLive } from "../inventory-rules.mjs";

const DAY = 86_400;
/** Fund 1 (tMMF): 10 bps floor, 5 % yield cap, 26 h NAV age bound; its reference and its NAV on 20 October 2026. */
const TMMF = { corridor_floor_bps: 10, max_yield_bps: 500, nav_max_age_secs: 26 * 3600 };
const FUND1 = { referenceNav: 108_529_815_480_720n, referenceTime: 1_792_317_272, navPrice: 108_547_853_399_289n, navTime: 1_792_448_341, floorBps: 10, maxYieldBps: 500, navMaxAgeSecs: 26 * 3600 };

test("the corridor is math::corridor's, its growth capped at the NAV age bound", () => {
  const { low, high } = corridor(FUND1.referenceNav, FUND1.referenceTime, FUND1.navTime, 10, 500, 26 * 3600);
  assert.deepEqual([low, high], [108_421_285_665_240n, 108_654_451_319_046n]);
  // A reference older than the bound grants no more growth.
  assert.equal(corridor(FUND1.referenceNav, FUND1.referenceTime, FUND1.navTime + 30 * DAY, 10, 500, 26 * 3600).high, high);
  // Both bounds bracket the reference.
  const at = corridor(1_000_000n, 0, 0, 10, 500, 3600);
  assert.deepEqual([at.low, at.high], [999_000n, 1_001_000n]);
  // The haircut the corridor needs: 22 bps for tMMF, 13 for the euro funds (5 bps, 4 %, 64 h).
  assert.equal(corridorHaircutBps(TMMF), 22n);
  assert.equal(corridorHaircutBps({ corridor_floor_bps: 5, max_yield_bps: 400, nav_max_age_secs: 64 * 3600 }), 13n);
});

test("fund 1 on 20 October: inside, 9.82 bps under the top, about 7 days at the 5 % cap, its reference past the bound (TOOL-8)", () => {
  const h = corridorHeadroom({ ...FUND1, now: FUND1.navTime + 2 * 3600 });
  assert.equal(h.inside, true);
  assert.equal(h.headroomBps, 9.82);
  assert.equal(h.daysAtMaxYield.toFixed(2), "7.17");
  assert.equal(h.referenceStale, true);
  assert.equal(Math.round(h.referenceAgeSecs / 3600), 38);
  assert.deepEqual(corridorIssues(h), []);
});

test("a NAV outside the corridor, or within three days of its top, is a finding; a fresh reference counts its window first (TOOL-8)", () => {
  const above = corridorHeadroom({ ...FUND1, navPrice: 108_700_000_000_000n });
  assert.equal(above.inside, false);
  assert.ok(above.headroomBps < 0);
  assert.match(corridorIssues(above)[0], /^rc5: the live NAV is outside its corridor \[108421285665240, 108654451319046\] around the stored reference \(-4\.19 bps from the top\)/);
  // Two bps from the top at a 5 % cap: under a day and a half.
  const near = corridorHeadroom({ ...FUND1, navPrice: 108_632_000_000_000n });
  assert.ok(near.inside && near.daysAtMaxYield < NEAR_TOP_DAYS);
  assert.match(corridorIssues(near)[0], /^rc5: the live NAV is 2\.06 bps under its corridor's top, about 1\.5 days at the yield cap: refresh_reference now/);
  // A reference one hour old: the top still grows for 25 hours before it stays.
  const fresh = corridorHeadroom({ ...FUND1, referenceTime: FUND1.navTime - 3600, navPrice: FUND1.referenceNav });
  assert.equal(fresh.referenceStale, false);
  assert.ok(Math.abs(fresh.daysAtMaxYield - (25 / 24 + (fresh.headroomBps * 365) / 500)) < 1e-9);
  // A flat NAV with no yield allowed never reaches its top.
  assert.equal(corridorHeadroom({ ...FUND1, maxYieldBps: 0, navPrice: FUND1.referenceNav }).daysAtMaxYield, Infinity);
});

test("the code's time to live is checked against the 90 days the monitor keeps (TOOL-8)", () => {
  assert.equal(daysToLive(1_000 + 17_280 * 35, 1_000), 35);
  assert.match(codeTtlIssues(34.9)[0], /^the contract code has 34\.9 days to live, under the 90 the monitor keeps/);
  assert.deepEqual(codeTtlIssues(90), []);
  assert.match(codeTtlIssues(null)[0], /archived or missing: npm run upgrade -- --restore-code$/);
});
