//! Fixed-point arithmetic. Every operation is checked and returns a typed
//! error: the workspace lints deny unchecked arithmetic in contract code.
//!
//! Two newtypes keep quantities apart: [`Bps`] for rates and haircuts, and
//! [`Price`] for a fixed-point price with its own number of decimals. Amounts
//! of tokens stay plain `i128`, as in SEP-41.

use crate::error::Error;

/// Basis points in one unit.
pub const BPS: i128 = 10_000;
/// Seconds in a year of 365 days: interest uses the actual/365 convention.
pub const YEAR_SECS: i128 = 31_536_000;

const OVERFLOW: Error = Error::ArithmeticOverflow;

/// A rate or a haircut in basis points, strictly below one unit.
#[derive(Clone, Copy, Debug, Eq, PartialEq, PartialOrd, Ord)]
pub struct Bps(u32);

impl Bps {
    /// Accepts values from 0 to 9,999.
    pub fn haircut(value: u32) -> Result<Self, Error> {
        if i128::from(value) >= BPS {
            return Err(Error::InvalidHaircut);
        }
        Ok(Self(value))
    }

    pub fn get(self) -> u32 {
        self.0
    }

    /// Sum of two haircuts, still strictly below one unit.
    pub fn plus(self, other: Self) -> Result<Self, Error> {
        let sum = self.0.checked_add(other.0).ok_or(OVERFLOW)?;
        Self::haircut(sum)
    }

    /// Share of a value kept after the haircut, in basis points.
    fn kept(self) -> Result<i128, Error> {
        BPS.checked_sub(i128::from(self.0)).ok_or(OVERFLOW)
    }
}

/// A strictly positive fixed-point price: `mantissa / 10^decimals`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Price {
    mantissa: i128,
    decimals: u32,
}

impl Price {
    pub fn new(mantissa: i128, decimals: u32) -> Result<Self, Error> {
        if mantissa <= 0 {
            return Err(Error::InvalidPrice);
        }
        Ok(Self { mantissa, decimals })
    }

    pub fn mantissa(self) -> i128 {
        self.mantissa
    }

    pub fn decimals(self) -> u32 {
        self.decimals
    }

    /// Cross price: `self` and `quote` are both expressed in the same base
    /// (for instance USD); the result is `self` expressed in units of
    /// `quote`'s asset (for instance EUR), with `self`'s decimals:
    /// `self.mantissa * 10^d / quote.mantissa`, rounded down, with `d` the
    /// quote's decimals, without forming that product (review finding
    /// VAL-3, 20 October 2026: at 18 and 18 decimals it exceeded i128 above
    /// 170 per share). With `self.mantissa = q * quote.mantissa + r`, the
    /// result is `q * 10^d + floor(r * 10^d / quote.mantissa)`: the first
    /// term is at most the result, and the second goes through a wide
    /// product where `r * 10^d` does not fit (second round of the finding:
    /// an 18-decimal rate above 170 overflowed it for some NAVs). The result
    /// is the direct formula's wherever that one fits in i128; the only
    /// overflow left is a result that does not fit.
    pub fn divided_by(self, quote: Price) -> Result<Price, Error> {
        let unit = pow10(quote.decimals)?;
        let (whole, rest) = (
            self.mantissa.checked_div(quote.mantissa).ok_or(OVERFLOW)?,
            self.mantissa.checked_rem(quote.mantissa).ok_or(OVERFLOW)?,
        );
        let mantissa = whole
            .checked_mul(unit)
            .ok_or(OVERFLOW)?
            .checked_add(mul_div_floor_wide(rest, unit, quote.mantissa)?)
            .ok_or(OVERFLOW)?;
        Price::new(mantissa, self.decimals)
    }
}

pub fn pow10(exponent: u32) -> Result<i128, Error> {
    10i128.checked_pow(exponent).ok_or(OVERFLOW)
}

/// `a * b / c`, rounded down. Callers pass non-negative values.
pub fn mul_div_floor(a: i128, b: i128, c: i128) -> Result<i128, Error> {
    a.checked_mul(b)
        .ok_or(OVERFLOW)?
        .checked_div(c)
        .ok_or(OVERFLOW)
}

/// `2^64`: a 128-bit value splits into two limbs of this base.
const LIMB: u128 = 1 << 64;
/// `2^127`: the top bit of a 128-bit value.
const TOP: u128 = 1 << 127;

/// `a * b / c`, rounded down, for `a` and `b` non-negative and `c`
/// positive, through a 256-bit product where the direct one does not fit
/// (review finding VAL-3, second round, 20 October 2026): the only overflow
/// left is a quotient that does not fit in i128. A negative input or a zero
/// `c` is an overflow too, never a trap, on either path: the direct
/// division would otherwise truncate a negative quotient towards zero.
pub fn mul_div_floor_wide(a: i128, b: i128, c: i128) -> Result<i128, Error> {
    if a < 0 || b < 0 || c <= 0 {
        return Err(OVERFLOW);
    }
    if let Some(product) = a.checked_mul(b) {
        return product.checked_div(c).ok_or(OVERFLOW);
    }
    let unsigned = |value: i128| u128::try_from(value).map_err(|_| OVERFLOW);
    let (a, b, c) = (unsigned(a)?, unsigned(b)?, unsigned(c)?);
    let (high, low) = wide_product(a, b)?;
    // The quotient fits in 128 bits exactly when the high half is below
    // the divisor.
    if high >= c {
        return Err(OVERFLOW);
    }
    i128::try_from(wide_quotient(high, low, c)?).map_err(|_| OVERFLOW)
}

/// The two 64-bit limbs of a 128-bit value, `(high, low)`.
fn limbs(value: u128) -> Result<(u128, u128), Error> {
    Ok((
        value.checked_div(LIMB).ok_or(OVERFLOW)?,
        value.checked_rem(LIMB).ok_or(OVERFLOW)?,
    ))
}

/// `a * b` as two 128-bit halves, `(high, low)`, from the four products of
/// the operands' limbs: with `a = a1 * 2^64 + a0` and `b = b1 * 2^64 + b0`,
/// the product is `a1 b1 * 2^128 + (a1 b0 + a0 b1) * 2^64 + a0 b0`, each
/// term carried into the half above it.
fn wide_product(a: u128, b: u128) -> Result<(u128, u128), Error> {
    let ((a1, a0), (b1, b0)) = (limbs(a)?, limbs(b)?);
    let (ll1, ll0) = limbs(a0.checked_mul(b0).ok_or(OVERFLOW)?)?;
    let (lh1, lh0) = limbs(a0.checked_mul(b1).ok_or(OVERFLOW)?)?;
    let (hl1, hl0) = limbs(a1.checked_mul(b0).ok_or(OVERFLOW)?)?;
    let hh = a1.checked_mul(b1).ok_or(OVERFLOW)?;
    // The middle limb, under 3 x 2^64, and its carry.
    let (mid1, mid0) = limbs(
        ll1.checked_add(lh0)
            .and_then(|middle| middle.checked_add(hl0))
            .ok_or(OVERFLOW)?,
    )?;
    let low = mid0
        .checked_mul(LIMB)
        .and_then(|shifted| shifted.checked_add(ll0))
        .ok_or(OVERFLOW)?;
    let high = hh
        .checked_add(lh1)
        .and_then(|high| high.checked_add(hl1))
        .and_then(|high| high.checked_add(mid1))
        .ok_or(OVERFLOW)?;
    Ok((high, low))
}

/// `(high, low) / c`, rounded down, for `high < c`, so that the quotient
/// fits in 128 bits: restoring division, one bit of the low half at a time.
/// The remainder stays below `c`, so doubling it never overflows.
fn wide_quotient(high: u128, low: u128, c: u128) -> Result<u128, Error> {
    let (mut remainder, mut low, mut quotient) = (high, low, 0u128);
    for _ in 0..128 {
        let (carry, rest) = if low >= TOP {
            (1, low.checked_sub(TOP).ok_or(OVERFLOW)?)
        } else {
            (0, low)
        };
        low = rest.checked_mul(2).ok_or(OVERFLOW)?;
        remainder = remainder
            .checked_mul(2)
            .and_then(|doubled| doubled.checked_add(carry))
            .ok_or(OVERFLOW)?;
        quotient = quotient.checked_mul(2).ok_or(OVERFLOW)?;
        if remainder >= c {
            remainder = remainder.checked_sub(c).ok_or(OVERFLOW)?;
            quotient = quotient.checked_add(1).ok_or(OVERFLOW)?;
        }
    }
    Ok(quotient)
}

/// `a * b / c`, rounded up. Callers pass non-negative values.
pub fn mul_div_ceil(a: i128, b: i128, c: i128) -> Result<i128, Error> {
    let product = a.checked_mul(b).ok_or(OVERFLOW)?;
    let quotient = product.checked_div(c).ok_or(OVERFLOW)?;
    let remainder = product.checked_rem(c).ok_or(OVERFLOW)?;
    if remainder > 0 {
        quotient.checked_add(1).ok_or(OVERFLOW)
    } else {
        Ok(quotient)
    }
}

/// Seconds of growth the model grants a NAV observed at `observed_time`: the
/// time since the reference, counted over at most `max_window_secs` (the
/// fund's NAV age bound). An old reference grants no more growth than a
/// fresh one: the corridor's span stays bounded, however long nobody moved
/// the reference.
fn growth_window(reference_time: u64, observed_time: u64, max_window_secs: u64) -> i128 {
    i128::from(
        observed_time
            .saturating_sub(reference_time)
            .min(max_window_secs),
    )
}

/// Highest value the reference may take after `elapsed` seconds: the
/// reference grown at `max_yield_bps` per year over at most
/// `max_window_secs`, rounded down. However often a faulty feed publishes,
/// the reference cannot outrun this path, and one update moves it by at
/// most one window of growth.
pub fn model_path(
    reference: i128,
    reference_time: u64,
    observed_time: u64,
    max_yield_bps: u32,
    max_window_secs: u64,
) -> Result<i128, Error> {
    let elapsed = growth_window(reference_time, observed_time, max_window_secs);
    let year_bps = BPS.checked_mul(YEAR_SECS).ok_or(OVERFLOW)?;
    let growth = i128::from(max_yield_bps)
        .checked_mul(elapsed)
        .ok_or(OVERFLOW)?;
    mul_div_floor(
        reference,
        year_bps.checked_add(growth).ok_or(OVERFLOW)?,
        year_bps,
    )
}

/// Whether `value` lies within `band_bps` of `reference`, both ways. The
/// bounds round inward (review finding arith-4, 20 October 2026): the
/// tolerance never exceeds the band, whatever the precision of the feed,
/// and the reference itself always passes.
pub fn within_band(value: i128, reference: i128, band_bps: u32) -> Result<bool, Error> {
    let band = i128::from(band_bps);
    let low = mul_div_ceil(reference, BPS.checked_sub(band).ok_or(OVERFLOW)?, BPS)?;
    let high = mul_div_floor(reference, BPS.checked_add(band).ok_or(OVERFLOW)?, BPS)?;
    Ok(value >= low && value <= high)
}

/// Rounds a duration up to whole hours: interest accrues per started hour, so
/// the amount a borrower signs for does not change between simulation and
/// execution of the same transaction.
pub fn ceil_to_hour(seconds: u64) -> Result<u64, Error> {
    const HOUR: u64 = 3_600;
    let hours = seconds.div_ceil(HOUR);
    hours.checked_mul(HOUR).ok_or(OVERFLOW)
}

/// Converts an amount between two decimal precisions, rounding down.
pub fn rescale_floor(amount: i128, from: u32, to: u32) -> Result<i128, Error> {
    if to >= from {
        let shift = to.checked_sub(from).ok_or(OVERFLOW)?;
        amount.checked_mul(pow10(shift)?).ok_or(OVERFLOW)
    } else {
        let shift = from.checked_sub(to).ok_or(OVERFLOW)?;
        amount.checked_div(pow10(shift)?).ok_or(OVERFLOW)
    }
}

/// Value of `shares` at `price`, in the share token's units:
/// `shares * mantissa / 10^decimals`, rounded down, without forming that
/// product (review finding arith-5, 20 October 2026). With `d` the price's
/// decimals, `shares = q * 10^d + r` and `mantissa = p * 10^d + s`, the
/// value is `q * mantissa + r * p + floor(r * s / 10^d)`: each term is at
/// most the value, and `r * s` stays below `10^(2d)`. The result is the
/// direct formula's wherever that one fits in i128, and for a price with up
/// to 19 decimals the only overflow left is a value that does not fit.
pub fn share_value(shares: i128, price: Price) -> Result<i128, Error> {
    let unit = pow10(price.decimals)?;
    let (whole, rest) = (
        shares.checked_div(unit).ok_or(OVERFLOW)?,
        shares.checked_rem(unit).ok_or(OVERFLOW)?,
    );
    let (units, fraction) = (
        price.mantissa.checked_div(unit).ok_or(OVERFLOW)?,
        price.mantissa.checked_rem(unit).ok_or(OVERFLOW)?,
    );
    whole
        .checked_mul(price.mantissa)
        .ok_or(OVERFLOW)?
        .checked_add(rest.checked_mul(units).ok_or(OVERFLOW)?)
        .ok_or(OVERFLOW)?
        .checked_add(mul_div_floor(rest, fraction, unit)?)
        .ok_or(OVERFLOW)
}

/// Largest principal `shares` can secure (decision S4): value at `price`,
/// converted from the share token's decimals to the stablecoin's, minus the
/// haircut. Every step rounds down, in favour of the lender.
pub fn max_principal(
    shares: i128,
    share_decimals: u32,
    price: Price,
    stablecoin_decimals: u32,
    haircut: Bps,
) -> Result<i128, Error> {
    let value = share_value(shares, price)?;
    let value = rescale_floor(value, share_decimals, stablecoin_decimals)?;
    mul_div_floor(value, haircut.kept()?, BPS)
}

/// Interest on `principal` at `rate_bps` per year over `elapsed` seconds,
/// actual/365, rounded up in favour of the lender (decision S3).
pub fn interest(principal: i128, rate_bps: u32, elapsed: u64) -> Result<i128, Error> {
    let rate_time = i128::from(rate_bps)
        .checked_mul(i128::from(elapsed))
        .ok_or(OVERFLOW)?;
    let denominator = BPS.checked_mul(YEAR_SECS).ok_or(OVERFLOW)?;
    mul_div_ceil(principal, rate_time, denominator)
}

/// Bounds of the NAV corridor (decision S2, model-based plausibility check).
///
/// A capitalising money market fund share follows a predictable path: its
/// value grows slowly and almost never falls. Given a reference NAV observed
/// at `reference_time`, a NAV observed at `observed_time` is plausible when it
/// lies between `reference * (1 - floor)` and
/// `reference * (1 + floor + max_yield * elapsed / year)`, where `elapsed`
/// counts at most `max_window_secs`, the fund's NAV age bound (review
/// findings arith-2 and oracle-1, 20 October 2026). The span from a true NAV
/// at the bottom to a reading at the top is then at most two floors plus
/// one window of growth, which the fund's haircut must cover (enforced at
/// admission); an honest NAV that outgrew it fails closed until the
/// reference moves. The floor is a tolerance of the check only: the
/// reference itself follows [`model_path`], never the oracle, so a faulty
/// feed cannot ratchet it. Both bounds round inward, as in [`within_band`],
/// and still bracket the reference.
pub fn corridor(
    reference: i128,
    reference_time: u64,
    observed_time: u64,
    floor_bps: u32,
    max_yield_bps: u32,
    max_window_secs: u64,
) -> Result<(i128, i128), Error> {
    let floor = i128::from(floor_bps);
    let low = mul_div_ceil(reference, BPS.checked_sub(floor).ok_or(OVERFLOW)?, BPS)?;
    let elapsed = growth_window(reference_time, observed_time, max_window_secs);
    let year_bps = BPS.checked_mul(YEAR_SECS).ok_or(OVERFLOW)?;
    let growth = i128::from(max_yield_bps)
        .checked_mul(elapsed)
        .ok_or(OVERFLOW)?;
    let numerator = year_bps
        .checked_add(floor.checked_mul(YEAR_SECS).ok_or(OVERFLOW)?)
        .ok_or(OVERFLOW)?
        .checked_add(growth)
        .ok_or(OVERFLOW)?;
    let high = mul_div_floor(reference, numerator, year_bps)?;
    Ok((low, high))
}
