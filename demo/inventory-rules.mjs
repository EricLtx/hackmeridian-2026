// The admission and pricing rules the inventory checks an instance against,
// as contracts/night-window/src/lib.rs and math.rs apply them since rc5.
// Pure functions: no network, no key (demo/test/inventory.test.mjs).

import { LEDGER_SECS, LIMITS } from "./detectors.mjs";

/** Admission rules of rc5, as contracts/night-window/src/lib.rs checks them. */
export const RC5 = {
  stablecoinDecimals: 7, // STABLECOIN_DECIMALS
  minFeedDecimals: 6, // MIN_FEED_DECIMALS: NAV, FX and fallback feeds
  maxFeedDecimals: 18, // MAX_FEED_DECIMALS (review finding VAL-3)
  yearSecs: 31_536_000n, // math::YEAR_SECS
};

/**
 * The inventory's findings on a feed's decimals. Since rc5 a NAV, FX or
 * fallback feed must publish with 6 to 18 decimals: checked at admission,
 * at a replacement, and when a fallback or a re-anchor is proposed or
 * applied (OutsideEnvelope); a fund admitted before keeps running until
 * then. `decimals` is null when the feed does not answer.
 */
export function feedDecimalsIssues(feed, decimals) {
  if (decimals === null || decimals === undefined) return [`rc5: the ${feed} does not answer decimals(); it must publish with ${RC5.minFeedDecimals} to ${RC5.maxFeedDecimals} decimals`];
  if (decimals < RC5.minFeedDecimals) return [`rc5: the ${feed} publishes with ${decimals} decimals, under ${RC5.minFeedDecimals}: its bounds round inward to whole units of the feed, and a replacement, a fallback or a re-anchor that reads it is refused`];
  if (decimals > RC5.maxFeedDecimals) return [`rc5: the ${feed} publishes with ${decimals} decimals, above ${RC5.maxFeedDecimals}: a replacement, a fallback or a re-anchor that reads it is refused`];
  return [];
}

/** A live NAV this close to the corridor's top, in days of growth at the fund's yield cap, is a finding. */
export const NEAR_TOP_DAYS = 3;

const BPS = 10_000n;
const ceilDiv = (a, b) => (a + b - 1n) / b;

/**
 * Smallest haircut, in basis points, that covers a fund's NAV corridor (the
 * rc5 cross-invariant, `corridor_haircut_bps` in lib.rs): a true NAV at the
 * corridor's bottom and a wrong reading at its top lie two floors plus one
 * NAV age bound of growth apart, the growth rounded up.
 */
export const corridorHaircutBps = (cfg) =>
  2n * BigInt(cfg.corridor_floor_bps) + ceilDiv(BigInt(cfg.max_yield_bps) * BigInt(cfg.nav_max_age_secs), RC5.yearSecs);

/** How long a proposal stays applicable past its delay (PROPOSAL_GRACE_SECS in lib.rs): seven days. */
export const PROPOSAL_GRACE_SECS = 604_800n;

/**
 * Smallest haircut, in basis points, that covers a two-key re-anchor of a
 * fund's price reference under the time delay `timelockDelaySecs` (the
 * rc5 round-2 extension of S30, `reanchor_haircut_bps` in lib.rs): one
 * wrong reading at the apply may lift the reference by the model path
 * over the delay, the proposal's grace and two NAV age bounds, so the
 * haircut must cover two floors plus that growth, rounded up. The
 * contract refuses propose_reanchor and apply_reanchor with
 * OutsideEnvelope below it; set_fund_limits widens the haircut through
 * the delay. tMMF (10 bps, 5 %, 26 h): 33 bps at a 300 s delay, 36 at 48 h.
 */
export const reanchorHaircutBps = (cfg, timelockDelaySecs) =>
  2n * BigInt(cfg.corridor_floor_bps) + ceilDiv(BigInt(cfg.max_yield_bps) * (BigInt(timelockDelaySecs) + PROPOSAL_GRACE_SECS + 2n * BigInt(cfg.nav_max_age_secs)), RC5.yearSecs);

/** The inventory's finding on a fund whose haircut is below what a re-anchor needs under the current delay. */
export function reanchorIssues(cfg, timelockDelaySecs) {
  const needed = reanchorHaircutBps(cfg, timelockDelaySecs);
  if (BigInt(cfg.haircut_bps) >= needed) return [];
  return [`rc5: haircut ${(Number(cfg.haircut_bps) / 100).toFixed(2)} % below the ${(Number(needed) / 100).toFixed(2)} % a two-key re-anchor needs under the ${Number(timelockDelaySecs)} s delay (two floors plus the yield over the delay, the 7-day grace and two NAV age bounds): propose_reanchor and apply_reanchor are refused with OutsideEnvelope until set_fund_limits widens the haircut through the delay`];
}

/**
 * The NAV corridor as math::corridor computes it since rc5: from
 * `ceil(reference x (1 - floor))` to
 * `floor(reference x (1 + floor + max_yield x elapsed / year))`, `elapsed`
 * running from the reference's time to the NAV's over at most the fund's
 * NAV age bound. Returns `{ low, high }`, in the NAV's units.
 */
export function corridor(reference, referenceTime, observedTime, floorBps, maxYieldBps, windowSecs) {
  const ref = BigInt(reference);
  const floor = BigInt(floorBps);
  const elapsed = BigInt(Math.max(0, Math.min(Number(observedTime) - Number(referenceTime), Number(windowSecs))));
  const yearBps = BPS * RC5.yearSecs;
  return {
    low: ceilDiv(ref * (BPS - floor), BPS),
    high: (ref * (yearBps + floor * RC5.yearSecs + BigInt(maxYieldBps) * elapsed)) / yearBps,
  };
}

/**
 * Where a fund's live NAV stands in its rc5 corridor, around the stored
 * reference (review finding TOOL-8, 20 October 2026). An honest NAV that
 * outgrows the top is refused by quote, open_repo and refresh_reference
 * alike, and only a two-key re-anchor restores the fund. Returns:
 * - `low`, `high`: the corridor at the NAV's timestamp;
 * - `inside`: whether the NAV lies in it;
 * - `headroomBps`: the room from the NAV to the top, in basis points of the
 *   reference, to two decimals (negative above the top);
 * - `daysAtMaxYield`: the days a NAV growing at the fund's yield cap takes
 *   to reach the top if nothing moves the reference. The top grows with
 *   the NAV until the reference is one NAV age bound old, then stays.
 * - `referenceAgeSecs` at `now`, and whether it is past the bound.
 */
export function corridorHeadroom({ referenceNav, referenceTime, navPrice, navTime, floorBps, maxYieldBps, navMaxAgeSecs, now }) {
  const { low, high } = corridor(referenceNav, referenceTime, navTime, floorBps, maxYieldBps, navMaxAgeSecs);
  const nav = BigInt(navPrice);
  const inside = nav >= low && nav <= high;
  const headroomBps = Number(((high - nav) * 1_000_000n) / BigInt(referenceNav)) / 100;
  const growingDays = Math.max(0, Number(referenceTime) + Number(navMaxAgeSecs) - Number(navTime)) / 86_400;
  const daysAtMaxYield = !inside ? 0 : Number(maxYieldBps) > 0 ? growingDays + (headroomBps * 365) / Number(maxYieldBps) : Infinity;
  const referenceAgeSecs = Number(now ?? navTime) - Number(referenceTime);
  return { low, high, inside, headroomBps, daysAtMaxYield, referenceAgeSecs, referenceStale: referenceAgeSecs > Number(navMaxAgeSecs) };
}

/** The inventory's findings on a fund's corridor: a NAV outside it, or within `NEAR_TOP_DAYS` of its top at the yield cap. */
export function corridorIssues(h) {
  if (!h.inside) {
    return [`rc5: the live NAV is outside its corridor [${h.low}, ${h.high}] around the stored reference (${h.headroomBps.toFixed(2)} bps from the top): quote, open_repo and refresh_reference are refused until a two-key re-anchor`];
  }
  if (h.daysAtMaxYield < NEAR_TOP_DAYS) {
    return [`rc5: the live NAV is ${h.headroomBps.toFixed(2)} bps under its corridor's top, about ${h.daysAtMaxYield.toFixed(1)} days at the yield cap: refresh_reference now (anyone may), or the fund fails closed until a two-key re-anchor`];
  }
  return [];
}

/** Whether two feed assets are the same: `["Stellar", address]` or `["Other", symbol]`, as the contract's types decode. */
const sameAsset = (a, b) => Array.isArray(a) && Array.isArray(b) && String(a[0]) === String(b[0]) && String(a[1]) === String(b[1]);

/**
 * The inventory's finding on a fund whose active fallback reads the very
 * feed and asset of its primary (oracle-5, review finding VAL-4): one source
 * twice, and a silent feed silences both. Since rc5 a replacement that
 * promotes the fallback drops it, and a fallback proposal naming the
 * primary is refused; a fund left so before still needs the change.
 */
export function fallbackIssues(cfg, fallback) {
  if (!fallback || String(fallback.oracle) !== String(cfg.oracle) || !sameAsset(fallback.asset, cfg.oracle_asset)) return [];
  return ["rc5: the fallback feed is the fund's own NAV feed: no second source, a silent feed silences both; remove_fallback, then propose another feed"];
}

/** Days a code entry has to live: `liveUntil` ledger seen at ledger `latest`. */
export const daysToLive = (liveUntil, latest) => ((Number(liveUntil) - Number(latest)) * LEDGER_SECS) / 86_400;

/** The inventory's finding on the contract code's time to live: under the 90 days the monitor keeps (LIMITS.codeTtlDays), or archived. */
export function codeTtlIssues(days, minDays = LIMITS.codeTtlDays) {
  if (days === null || days <= 0) return [`the contract code is archived or missing: npm run upgrade -- --restore-code`];
  if (days < minDays) return [`the contract code has ${days.toFixed(1)} days to live, under the ${minDays} the monitor keeps: the keeper extends it (npm run monitor -- --watch --act)`];
  return [];
}
