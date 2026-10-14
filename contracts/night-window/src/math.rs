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
    /// `quote`'s asset (for instance EUR), with `self`'s decimals.
    pub fn divided_by(self, quote: Price) -> Result<Price, Error> {
        let mantissa = mul_div_floor(self.mantissa, pow10(quote.decimals)?, quote.mantissa)?;
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
    let value = mul_div_floor(shares, price.mantissa, pow10(price.decimals)?)?;
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
/// `reference * (1 + floor + max_yield * elapsed / year)`. A faulty or
/// compromised feed can therefore only move the reference at `max_yield`
/// per year, however many times it publishes.
pub fn corridor(
    reference: i128,
    reference_time: u64,
    observed_time: u64,
    floor_bps: u32,
    max_yield_bps: u32,
) -> Result<(i128, i128), Error> {
    let floor = i128::from(floor_bps);
    let low = mul_div_floor(reference, BPS.checked_sub(floor).ok_or(OVERFLOW)?, BPS)?;
    let elapsed = i128::from(observed_time.saturating_sub(reference_time));
    let year_bps = BPS.checked_mul(YEAR_SECS).ok_or(OVERFLOW)?;
    let growth = i128::from(max_yield_bps)
        .checked_mul(elapsed)
        .ok_or(OVERFLOW)?;
    let numerator = year_bps
        .checked_add(floor.checked_mul(YEAR_SECS).ok_or(OVERFLOW)?)
        .ok_or(OVERFLOW)?
        .checked_add(growth)
        .ok_or(OVERFLOW)?;
    let high = mul_div_ceil(reference, numerator, year_bps)?;
    Ok((low, high))
}
