//! Valuation of fund shares from SEP-40 oracles.
//!
//! The NAV feed is checked twice, like a safety-relevant sensor: for
//! freshness (decision S1) and against a model of its expected path, the NAV
//! corridor (decision S2). When the NAV is not reported in the loan currency,
//! a second feed converts it (cross price) and an FX haircut covers the risk
//! that the exchange rate is frozen over a weekend while markets are closed.

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

/// What the shares of a fund are worth now, and the haircut to apply.
#[derive(Clone, Copy, Debug)]
pub struct Valuation {
    /// NAV as reported by the NAV oracle, in its own base.
    pub nav: Reading,
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

/// Reads a fallback feed, expressed with the primary feed's decimals. A
/// fallback that traps is treated as silent: a broken backup must not take
/// the primary feed down with it.
pub fn read_fallback(
    env: &Env,
    feed: &FallbackFeed,
    decimals: u32,
    nav_decimals: u32,
) -> Result<Reading, Error> {
    let data = match OracleClient::new(env, &feed.oracle).try_lastprice(&feed.asset) {
        Ok(Ok(Some(data))) => data,
        _ => return Err(Error::NoPrice),
    };
    check_fresh(env, &data, decimals, nav_decimals, feed.max_age_secs)
}

/// The fund's NAV, from the primary feed or its fallback, like a redundant
/// sensor pair: the primary is used whenever it is fresh, and a fresh
/// fallback must then agree with it within `max_divergence_bps`, otherwise
/// neither is trusted. When the primary is stale or silent, a fresh fallback
/// stands in; when both are, the primary's error is returned, as without a
/// fallback. A primary that publishes an invalid price is not replaced: that
/// is a faulty feed to investigate, not an outage.
pub fn read_nav(
    env: &Env,
    config: &FundConfig,
    state: &FundState,
    fallback: Option<&(FallbackFeed, u32)>,
) -> Result<Reading, Error> {
    let primary = read_fresh(
        env,
        &config.oracle,
        &config.oracle_asset,
        state.nav_decimals,
        config.nav_max_age_secs,
    );
    let Some((feed, decimals)) = fallback else {
        return primary;
    };
    let backup = read_fallback(env, feed, *decimals, state.nav_decimals);
    match primary {
        Ok(nav) => {
            if let Ok(backup) = backup {
                if !within_band(
                    backup.price.mantissa(),
                    nav.price.mantissa(),
                    feed.max_divergence_bps,
                )? {
                    return Err(Error::PriceDivergence);
                }
            }
            Ok(nav)
        }
        Err(error @ (Error::StalePrice | Error::NoPrice)) => backup.map_err(|_| error),
        Err(error) => Err(error),
    }
}

/// Checks that `nav` lies in the corridor predicted from the fund's reference.
pub fn check_corridor(config: &FundConfig, state: &FundState, nav: &Reading) -> Result<(), Error> {
    let (low, high) = corridor(
        state.reference_nav,
        state.reference_time,
        nav.timestamp,
        config.corridor_floor_bps,
        config.max_yield_bps,
    )?;
    let value = nav.price.mantissa();
    if value < low || value > high {
        return Err(Error::PriceOutOfBand);
    }
    Ok(())
}

/// Next reference after a NAV passed the corridor: it never falls, and it
/// rises at most along the model path. Returns `None` when the reading is not
/// newer than the reference.
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
            price: nav.price,
            haircut,
        }),
        PriceSource::Cross(fx) => {
            let rate = read_fresh(
                env,
                &fx.oracle,
                &fx.asset,
                state.fx_decimals,
                fx.max_age_secs,
            )?;
            if !within_band(rate.price.mantissa(), state.reference_fx, fx.band_bps)? {
                return Err(Error::PriceOutOfBand);
            }
            Ok(Valuation {
                nav,
                price: nav.price.divided_by(rate.price)?,
                haircut: haircut.plus(Bps::haircut(fx.haircut_bps)?)?,
            })
        }
    }
}
