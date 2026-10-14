//! Valuation of fund shares from SEP-40 oracles.
//!
//! The NAV feed is checked twice, like a safety-relevant sensor: for
//! freshness (decision S1) and against a model of its expected path, the NAV
//! corridor (decision S2). When the NAV is not reported in the loan currency,
//! a second feed converts it (cross price) and an FX haircut covers the risk
//! that the exchange rate is frozen over a weekend while markets are closed.

use soroban_sdk::{contractclient, Address, Env};

use crate::error::Error;
use crate::math::{corridor, Bps, Price};
use crate::types::{Asset, FundConfig, FundState, PriceData, PriceSource};

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
    let now = env.ledger().timestamp();
    let age = now.checked_sub(data.timestamp).ok_or(Error::InvalidPrice)?;
    if age > max_age {
        return Err(Error::StalePrice);
    }
    Ok(Reading {
        price: Price::new(data.price, decimals)?,
        timestamp: data.timestamp,
    })
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

/// Values a fund's shares in its loan currency.
pub fn value(env: &Env, config: &FundConfig, state: &FundState) -> Result<Valuation, Error> {
    let nav = read_fresh(
        env,
        &config.oracle,
        &config.oracle_asset,
        state.nav_decimals,
        config.nav_max_age_secs,
    )?;
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
            Ok(Valuation {
                nav,
                price: nav.price.divided_by(rate.price)?,
                haircut: haircut.plus(Bps::haircut(fx.haircut_bps)?)?,
            })
        }
    }
}
