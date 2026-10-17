// Demo parameters shared by setup.mjs and run.mjs. Testnet values only.

import { ONE } from "./lib.mjs";

/** NAV of the demo US T-bill fund share at setup, in USD with 14 decimals. */
export const NAV_USD_AT_SETUP = 108_500_000_000_000n;

/** Annual growth the operator applies to the demo NAV; under the 5 % model cap. */
export const DEMO_YIELD_BPS = 400n;

/** The NAV the operator publishes at `now`: the setup NAV grown at the demo yield. */
export function navAt(publishedAt, now) {
  const elapsed = BigInt(Math.max(0, now - publishedAt));
  return NAV_USD_AT_SETUP + (NAV_USD_AT_SETUP * DEMO_YIELD_BPS * elapsed) / (10_000n * 365n * 86_400n);
}

/** Risk settings of the demo fund, passed to `set_fund` at admission. */
export const FUND_SETTINGS = {
  haircutBps: 200,
  fxHaircutBps: 200,
  fxBandBps: 200,
  fxMaxAgeSecs: 3 * 24 * 3600,
  navMaxAgeSecs: 26 * 3600,
  corridorFloorBps: 10,
  maxYieldBps: 500,
  maxPrincipalPerRepo: 100_000n * ONE,
  maxOutstanding: 500_000n * ONE,
};

/** EUR/USD used for the local FX feed when Reflector has no price, 14 decimals. */
export const FALLBACK_EUR_USD = 112_000_000_000_000n;

/**
 * Time delay on upgrades and on changes to an admitted fund, set before the
 * first admission. Five minutes lets a demo show propose, wait, apply; a
 * real deployment keeps the contract's 48-hour default or more.
 */
export const DEMO_TIMELOCK_SECS = 300;

/** Offers created at setup: the offer the issuer designates (funded by an independent provider) and a market offer. */
export const OFFERS = {
  sponsor: { amount: 300_000n * ONE, rateBps: 250 },
  market: { amount: 150_000n * ONE, rateBps: 350 },
};
