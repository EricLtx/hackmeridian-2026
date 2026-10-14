// Loan arithmetic, mirrored from the contract so previews match what it
// charges to the unit. Source: contracts/night-window/src/math.rs and
// `interest_due` in lib.rs.

export const HOUR = 3600;
export const YEAR_SECS = 31_536_000n;
export const BPS = 10_000n;
/** Shortest term the contract accepts, in seconds. */
export const MIN_TERM_SECS = HOUR;
/** Friday evening to Monday morning, the gap the product exists for. */
export const WEEKEND_SECS = 64 * HOUR;

/** Hours charged after `seconds`: every started hour, at least one. */
export function chargedHours(seconds) {
  return Math.ceil(Math.max(Number(seconds), 1) / HOUR);
}

/** Interest in token units: ceil(principal * rate * charged seconds / (10,000 * year)). */
export function interest(principal, rateBps, seconds) {
  const elapsed = BigInt(chargedHours(seconds) * HOUR);
  const numerator = BigInt(principal) * BigInt(rateBps) * elapsed;
  const denominator = BPS * YEAR_SECS;
  const quotient = numerator / denominator;
  return numerator % denominator === 0n ? quotient : quotient + 1n;
}

/**
 * When the interest of a repo opened at `openedAt` next steps up, seen at
 * `now` (both Unix seconds): the end of the hour being charged. The first
 * hour is charged from the start.
 */
export function nextInterestStep(openedAt, now) {
  const elapsed = Math.max(Number(now) - Number(openedAt), 0);
  return Number(openedAt) + chargedHours(elapsed) * HOUR;
}

/** Offers in the order a borrower should see them: the issuer's own first, then cheapest. */
export function sortOffers(offers) {
  return [...offers].sort((a, b) => {
    if (a.sponsor !== b.sponsor) return a.sponsor ? -1 : 1;
    if (a.rate_bps !== b.rate_bps) return a.rate_bps - b.rate_bps;
    return Number(a.id) - Number(b.id);
  });
}

/** The first offer, in display order, that accepts `fund` and holds `amount`. */
export function pickOffer(offers, fund, amount) {
  return sortOffers(offers).find((o) => o.funds.includes(fund) && o.available >= BigInt(amount) && o.available > 0n) ?? null;
}

/** Longest term allowed by an offer and by the contract, in seconds. */
export function maxTermFor(offer, contractMaxTerm) {
  return Math.min(Number(offer?.max_term ?? 0), Number(contractMaxTerm ?? 0));
}

/**
 * Whether a lender may take the shares of a repo at `now` (ledger seconds).
 * The contract allows `seize` on an open repo from its maturity on
 * (`timestamp < maturity` is refused with NotMatured). Returns
 * `{ allowed, reason, wait }`, `reason` being "closed", "early" or "matured".
 */
export function seizeState(repo, now) {
  if (repo.status !== "Open") return { allowed: false, reason: "closed", wait: 0 };
  const wait = Number(repo.maturity) - Number(now);
  return wait > 0 ? { allowed: false, reason: "early", wait } : { allowed: true, reason: "matured", wait: 0 };
}

/**
 * Checks a withdrawal amount against what the offer holds. Returns the
 * amount in units, or a sentence explaining what is wrong.
 */
export function withdrawalAmount(units, available) {
  if (units === null || units === undefined) return { error: "Enter an amount." };
  if (units <= 0n) return { error: "The amount must be greater than zero." };
  if (units > BigInt(available)) return { error: "The offer does not hold that much." };
  return { amount: units };
}

/**
 * Suggested principal: 90 % of what the shares secure, never above the
 * quote itself nor any of the extra `limits` (offer liquidity, caps).
 */
export function defaultPrincipal(maxPrincipal, ...limits) {
  let value = (BigInt(maxPrincipal) * 90n) / 100n;
  for (const limit of limits) {
    if (limit !== null && limit !== undefined && BigInt(limit) < value) value = BigInt(limit);
  }
  return value > 0n ? value : 0n;
}
