//! Valuation of fund shares from SEP-40 oracles.
//!
//! The NAV feed is checked twice, like a safety-relevant sensor: for
//! freshness (decision S1) and against a model of its expected path, the NAV
//! corridor (decision S2). When the NAV is not reported in the loan currency,
//! a second feed converts it (cross price) and an FX haircut covers the risk
//! that the exchange rate is frozen over a weekend while markets are closed.
//! The rate must lie in a band around the fund's FX reference, and the NAV is
//! divided by the higher of the rate and that reference: the lender's side
//! of the band (decision S22).

use soroban_sdk::{contractclient, Address, Env};

use crate::error::Error;
use crate::math::{corridor, model_path, rescale_floor, within_band, Bps, Price};
use crate::types::{Asset, FallbackFeed, FundConfig, FundState, PriceData, PriceSource};

/// The subset of the SEP-40 interface this contract consumes.
#[contractclient(name = "OracleClient")]
pub trait Sep40Oracle {
    /// Base asset every price is reported in.
    fn base(env: Env) -> Asset;
    /// Number of fractional digits in every price.
    fn decimals(env: Env) -> u32;
    /// Last known price of `asset`, or `None` when the oracle does not track it.
    fn lastprice(env: Env, asset: Asset) -> Option<PriceData>;
}

/// A reading of one feed: the price and when it was observed.
#[derive(Clone, Copy, Debug)]
pub struct Reading {
    pub price: Price,
    pub timestamp: u64,
}

/// The FX leg of a cross valuation: the rate read and the rate applied.
#[derive(Clone, Copy, Debug)]
pub struct FxValuation {
    /// The FX feed's reading, with the fund's FX decimals.
    pub rate: Reading,
    /// The divisor of the NAV: the rate read, or the fund's FX reference when
    /// the rate is below it. Same decimals as the rate.
    pub applied: Price,
}

/// What the shares of a fund are worth now, and the haircut to apply.
#[derive(Clone, Copy, Debug)]
pub struct Valuation {
    /// NAV as reported by the NAV oracle, in its own base.
    pub nav: Reading,
    /// The FX leg, for a cross price; `None` for a fund priced directly.
    pub fx: Option<FxValuation>,
    /// Share price in the loan currency.
    pub price: Price,
    /// Fund haircut, plus the FX haircut for a cross price.
    pub haircut: Bps,
}

/// Reads the last price of `asset` and checks it is positive, not in the
/// future and not older than `max_age` seconds.
pub fn read_fresh(
    env: &Env,
    oracle: &Address,
    asset: &Asset,
    decimals: u32,
    max_age: u64,
) -> Result<Reading, Error> {
    let data = OracleClient::new(env, oracle)
        .lastprice(asset)
        .ok_or(Error::NoPrice)?;
    check_fresh(env, &data, decimals, decimals, max_age)
}

/// Checks a price point for freshness and sign, and expresses it with
/// `to_decimals` digits, rounding down.
fn check_fresh(
    env: &Env,
    data: &PriceData,
    from_decimals: u32,
    to_decimals: u32,
    max_age: u64,
) -> Result<Reading, Error> {
    let now = env.ledger().timestamp();
    let age = now.checked_sub(data.timestamp).ok_or(Error::InvalidPrice)?;
    if age > max_age {
        return Err(Error::StalePrice);
    }
    if data.price <= 0 {
        return Err(Error::InvalidPrice);
    }
    Ok(Reading {
        price: Price::new(
            rescale_floor(data.price, from_decimals, to_decimals)?,
            to_decimals,
        )?,
        timestamp: data.timestamp,
    })
}

/// Like [`read_fresh`], but a feed whose call traps counts as silent
/// (`NoPrice`) instead of reverting the caller.
fn read_fresh_or_silent(
    env: &Env,
    oracle: &Address,
    asset: &Asset,
    from_decimals: u32,
    to_decimals: u32,
    max_age: u64,
) -> Result<Reading, Error> {
    let data = match OracleClient::new(env, oracle).try_lastprice(asset) {
        Ok(Ok(Some(data))) => data,
        _ => return Err(Error::NoPrice),
    };
    check_fresh(env, &data, from_decimals, to_decimals, max_age)
}

/// Oldest acceptable fallback price: its own limit, never beyond the fund's
/// limit for the primary feed.
pub fn fallback_max_age(config: &FundConfig, feed: &FallbackFeed) -> u64 {
    feed.max_age_secs.min(config.nav_max_age_secs)
}

/// Reads a fallback feed, expressed with the primary feed's decimals. A
/// fallback that traps is treated as silent: a broken backup must not take
/// the primary feed down with it.
pub fn read_fallback(
    env: &Env,
    config: &FundConfig,
    feed: &FallbackFeed,
    decimals: u32,
    nav_decimals: u32,
) -> Result<Reading, Error> {
    read_fresh_or_silent(
        env,
        &feed.oracle,
        &feed.asset,
        decimals,
        nav_decimals,
        fallback_max_age(config, feed),
    )
}

/// The fund's NAV, from the primary feed or its fallback, like a redundant
/// sensor pair: the primary is used whenever it is fresh, and a fresh
/// fallback must then agree with it within `max_divergence_bps`, otherwise
/// neither is trusted. A fallback that publishes a fresh but unusable price
/// (not positive, in the future, out of range once rescaled) fails closed in
/// the same way; one that is stale or silent is ignored. When the primary is
/// stale or silent (with a fallback, a primary that traps counts as silent),
/// a fresh fallback stands in; when both are, the primary's error is
/// returned, as without a fallback. A primary that publishes an invalid
/// price is not replaced: that is a faulty feed to investigate, not an
/// outage.
pub fn read_nav(
    env: &Env,
    config: &FundConfig,
    state: &FundState,
    fallback: Option<&(FallbackFeed, u32)>,
) -> Result<Reading, Error> {
    let Some((feed, decimals)) = fallback else {
        return read_fresh(
            env,
            &config.oracle,
            &config.oracle_asset,
            state.nav_decimals,
            config.nav_max_age_secs,
        );
    };
    let primary = read_fresh_or_silent(
        env,
        &config.oracle,
        &config.oracle_asset,
        state.nav_decimals,
        state.nav_decimals,
        config.nav_max_age_secs,
    );
    let backup = read_fallback(env, config, feed, *decimals, state.nav_decimals);
    match primary {
        Ok(nav) => agree(nav, backup, feed),
        Err(error @ (Error::StalePrice | Error::NoPrice)) => backup.map_err(|_| error),
        Err(error) => Err(error),
    }
}

/// A fresh primary reading, checked against the fallback reading as
/// `read_nav` does: a fresh fallback must agree within its tolerance, a
/// fresh but unusable one fails closed, a stale or silent one is ignored.
fn agree(
    nav: Reading,
    backup: Result<Reading, Error>,
    feed: &FallbackFeed,
) -> Result<Reading, Error> {
    match backup {
        Ok(backup) => {
            if within_band(
                backup.price.mantissa(),
                nav.price.mantissa(),
                feed.max_divergence_bps,
            )? {
                Ok(nav)
            } else {
                Err(Error::PriceDivergence)
            }
        }
        Err(Error::StalePrice | Error::NoPrice) => Ok(nav),
        Err(_) => Err(Error::PriceDivergence),
    }
}

/// The primary NAV, which must be fresh, read with `nav_decimals` digits and
/// checked against the fund's fallback like any valuation. For a re-anchor:
/// a fallback may never be the anchor, and must not contradict it.
pub fn read_primary_checked(
    env: &Env,
    config: &FundConfig,
    nav_decimals: u32,
    fallback: Option<&(FallbackFeed, u32)>,
) -> Result<Reading, Error> {
    let nav = read_fresh(
        env,
        &config.oracle,
        &config.oracle_asset,
        nav_decimals,
        config.nav_max_age_secs,
    )?;
    let Some((feed, decimals)) = fallback else {
        return Ok(nav);
    };
    let backup = read_fallback(env, config, feed, *decimals, nav_decimals);
    agree(nav, backup, feed)
}

/// Checks that `nav` lies in the corridor predicted from the fund's reference,
/// its growth counted over at most the fund's NAV age bound.
pub fn check_corridor(config: &FundConfig, state: &FundState, nav: &Reading) -> Result<(), Error> {
    let (low, high) = corridor(
        state.reference_nav,
        state.reference_time,
        nav.timestamp,
        config.corridor_floor_bps,
        config.max_yield_bps,
        config.nav_max_age_secs,
    )?;
    let value = nav.price.mantissa();
    if value < low || value > high {
        return Err(Error::PriceOutOfBand);
    }
    Ok(())
}

/// Next reference after a NAV passed the corridor: it never falls, and it
/// rises at most along the model path, by at most one NAV age bound of
/// growth per update. Returns `None` when the reading is not newer than the
/// reference.
pub fn next_reference(
    config: &FundConfig,
    state: &FundState,
    nav: &Reading,
) -> Result<Option<i128>, Error> {
    if nav.timestamp <= state.reference_time {
        return Ok(None);
    }
    let ceiling = model_path(
        state.reference_nav,
        state.reference_time,
        nav.timestamp,
        config.max_yield_bps,
        config.nav_max_age_secs,
    )?;
    Ok(Some(
        nav.price.mantissa().min(ceiling).max(state.reference_nav),
    ))
}

/// Values a fund's shares in its loan currency. Whichever feed supplied the
/// NAV, it goes through the same corridor and FX checks.
pub fn value(
    env: &Env,
    config: &FundConfig,
    state: &FundState,
    fallback: Option<&(FallbackFeed, u32)>,
) -> Result<Valuation, Error> {
    let nav = read_nav(env, config, state, fallback)?;
    check_corridor(config, state, &nav)?;
    let haircut = Bps::haircut(config.haircut_bps)?;
    match &config.source {
        PriceSource::Direct => Ok(Valuation {
            nav,
            fx: None,
            price: nav.price,
            haircut,
        }),
        PriceSource::Cross(leg) => {
            let rate = read_fresh(
                env,
                &leg.oracle,
                &leg.asset,
                state.fx_decimals,
                leg.max_age_secs,
            )?;
            if !within_band(rate.price.mantissa(), state.reference_fx, leg.band_bps)? {
                return Err(Error::PriceOutOfBand);
            }
            // The band is centred on the reference, which only a two-key
            // re-anchor moves, while the market drifts inside it. A rate
            // below the reference raises the price: read as published, a
            // wrong rate at the low edge while the market sits near the top
            // would overvalue the shares by about two bands (review finding
            // arith-1, 20 October 2026). Divided by the higher of the rate
            // and the reference, they are overvalued by at most the market's
            // move above the reference, itself at most the band, which the
            // FX haircut covers (S22: band <= FX haircut).
            let fx = FxValuation {
                rate,
                applied: Price::new(
                    rate.price.mantissa().max(state.reference_fx),
                    state.fx_decimals,
                )?,
            };
            Ok(Valuation {
                nav,
                fx: Some(fx),
                price: nav.price.divided_by(fx.applied)?,
                haircut: haircut.plus(Bps::haircut(leg.haircut_bps)?)?,
            })
        }
    }
}
