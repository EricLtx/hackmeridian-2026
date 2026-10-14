#![no_std]
//! NAV oracle (crate `nav-oracle`): a SEP-40 price feed fed by an operator.
//!
//! Tokenized money market fund shares have no public on-chain price feed. This
//! contract lets an operator (the admin) publish the net asset value of a
//! share, and exposes it through the SEP-40 consumer interface, so a consumer
//! contract can read it exactly as it would read any SEP-40 oracle. It can
//! also carry a fallback FX rate (for example base USD, asset
//! `Other("EUR")`).
//!
//! Intended for testnet demonstrations. Two deliberate departures from a
//! production feed:
//!
//! - timestamps are not forced onto multiples of [`NavOracle::resolution`],
//!   and are not compared to the ledger time, so the operator can publish a
//!   stale or out-of-band price on purpose and show a consumer refusing it.
//!   Consumers must check `timestamp` against the ledger time themselves, as
//!   SEP-40 asks;
//! - a single key publishes: there is no aggregation of several sources.
//!
//! Invariants:
//!
//! - per asset, published timestamps never decrease. Publishing again at the
//!   same timestamp replaces that record. A timestamp in the future therefore
//!   blocks earlier ones for that asset;
//! - at most [`MAX_ASSETS`] assets and, per asset, the [`MAX_HISTORY`] most
//!   recent records are stored: storage does not grow without bound;
//! - `base`, `decimals` and `resolution` are fixed at deployment (SEP-40).

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contractmeta, contracttype,
    panic_with_error, Address, BytesN, ContractExecutable, Env, Symbol, Vec,
};

contractmeta!(key = "binver", val = "0.1.0");
contractmeta!(
    key = "desc",
    val = "Operator-fed SEP-40 price feed for tokenized fund share NAV"
);

// Ledgers close about every 5 seconds: 17,280 ledgers a day.
const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const BUMP_TO: u32 = 120 * DAY_IN_LEDGERS;

/// Most assets the feed quotes.
pub const MAX_ASSETS: u32 = 16;

/// Most records kept per asset; older ones are dropped on publish.
pub const MAX_HISTORY: u32 = 32;

/// Most fractional digits a price may carry: `i128` holds about 1.7e38.
pub const MAX_DECIMALS: u32 = 38;

// ---------------------------------------------------------------------------
// SEP-40 types
// ---------------------------------------------------------------------------

/// Asset identifier as defined by SEP-40.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Asset {
    /// A Stellar asset, identified by its contract address.
    Stellar(Address),
    /// Any other asset, identified by a ticker symbol.
    Other(Symbol),
}

/// A price point as defined by SEP-40. `price` carries `decimals()` fractional
/// digits; `timestamp` is the Unix time the operator attached to the price.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// Storage keys. Configuration and the asset list live in instance storage;
/// each asset's history is one persistent entry, bounded to `MAX_HISTORY`.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Instance: administrator (publisher) address.
    Admin,
    /// Instance: asset every price is quoted in.
    Base,
    /// Instance: fractional digits of every price.
    Decimals,
    /// Instance: nominal update period, in seconds.
    Resolution,
    /// Instance: quoted assets, in order of first publication.
    Assets,
    /// Instance: most recent timestamp published, all assets together.
    LastTimestamp,
    /// Persistent: price records of an asset, newest first.
    History(Asset),
}

// ---------------------------------------------------------------------------
// Errors and events
// ---------------------------------------------------------------------------

/// Error codes are public ABI: add new ones, never renumber.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// Prices must be strictly positive.
    InvalidPrice = 1,
    /// Timestamps must be strictly positive.
    InvalidTimestamp = 2,
    /// The timestamp is older than the asset's last published one.
    NonMonotonicTimestamp = 3,
    /// The feed already quotes `MAX_ASSETS` assets.
    TooManyAssets = 4,
    /// Instance storage lost its configuration. Unreachable with a constructor
    /// deployment; kept as a typed failure rather than an opaque trap.
    NotInitialized = 5,
    /// Deployment parameters out of range: `decimals` above `MAX_DECIMALS` or
    /// a zero `resolution`.
    InvalidConfig = 6,
}

#[contractevent]
pub struct PricePublished {
    #[topic]
    pub asset: Asset,
    pub price: i128,
    pub timestamp: u64,
}

#[contractevent]
pub struct AdminChanged {
    #[topic]
    pub previous: Address,
    pub admin: Address,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct NavOracle;

#[contractimpl]
impl NavOracle {
    /// Deploys the feed. `base`, `decimals` and `resolution` never change
    /// afterwards, as SEP-40 requires.
    pub fn __constructor(env: Env, admin: Address, base: Asset, decimals: u32, resolution: u32) {
        if decimals > MAX_DECIMALS || resolution == 0 {
            panic_with_error!(&env, Error::InvalidConfig);
        }
        let instance = env.storage().instance();
        instance.set(&DataKey::Admin, &admin);
        instance.set(&DataKey::Base, &base);
        instance.set(&DataKey::Decimals, &decimals);
        instance.set(&DataKey::Resolution, &resolution);
        instance.set(&DataKey::Assets, &Vec::<Asset>::new(&env));
        instance.set(&DataKey::LastTimestamp, &0u64);
        bump_instance(&env);
    }

    // -- SEP-40 read interface ----------------------------------------------

    /// Asset every price is quoted in.
    pub fn base(env: Env) -> Asset {
        read_instance(&env, &DataKey::Base)
    }

    /// Assets quoted by the feed, in order of first publication.
    pub fn assets(env: Env) -> Vec<Asset> {
        read_instance(&env, &DataKey::Assets)
    }

    /// Fractional digits of every price.
    pub fn decimals(env: Env) -> u32 {
        read_instance(&env, &DataKey::Decimals)
    }

    /// Nominal update period, in seconds. Published timestamps are not
    /// required to be multiples of it.
    pub fn resolution(env: Env) -> u32 {
        read_instance(&env, &DataKey::Resolution)
    }

    /// Price of `asset` recorded at exactly `timestamp`, if still retained.
    pub fn price(env: Env, asset: Asset, timestamp: u64) -> Option<PriceData> {
        read_history(&env, &asset)
            .iter()
            .find(|record| record.timestamp == timestamp)
    }

    /// Up to `records` most recent prices of `asset`, newest first. `None`
    /// when the asset has never been published.
    pub fn prices(env: Env, asset: Asset, records: u32) -> Option<Vec<PriceData>> {
        let key = DataKey::History(asset);
        let history: Vec<PriceData> = env.storage().persistent().get(&key)?;
        let count = records.min(history.len());
        Some(history.slice(..count))
    }

    /// Most recent price of `asset`, or `None` when it has never been published.
    pub fn lastprice(env: Env, asset: Asset) -> Option<PriceData> {
        read_history(&env, &asset).first()
    }

    /// Most recent timestamp published, all assets together; 0 before the
    /// first publication.
    pub fn last_timestamp(env: Env) -> u64 {
        read_instance(&env, &DataKey::LastTimestamp)
    }

    // -- Administration -----------------------------------------------------

    pub fn admin(env: Env) -> Address {
        read_instance(&env, &DataKey::Admin)
    }

    /// Hands publication rights to `new_admin`. Requires the current admin.
    pub fn set_admin(env: Env, new_admin: Address) {
        let previous = require_admin(&env);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        bump_instance(&env);
        AdminChanged {
            previous,
            admin: new_admin,
        }
        .publish(&env);
    }

    /// Replaces the contract code while keeping its address and storage, as
    /// SEP-40 expects of a feed. The WASM must already be uploaded. Requires
    /// the admin.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        require_admin(&env);
        env.deployer()
            .update_current_contract(ContractExecutable::Wasm(new_wasm_hash));
    }

    // -- Publication ----------------------------------------------------------

    /// Publishes `price` for `asset` at `timestamp`. A new asset is added to
    /// `assets`. Publishing again at the asset's last timestamp replaces that
    /// record. Requires the admin.
    pub fn publish(env: Env, asset: Asset, price: i128, timestamp: u64) -> Result<(), Error> {
        require_admin(&env);
        if price <= 0 {
            return Err(Error::InvalidPrice);
        }
        if timestamp == 0 {
            return Err(Error::InvalidTimestamp);
        }
        let mut history = read_history(&env, &asset);
        match history.first() {
            None => register_asset(&env, &asset)?,
            Some(last) if timestamp < last.timestamp => return Err(Error::NonMonotonicTimestamp),
            Some(last) if timestamp == last.timestamp => {
                history.pop_front();
            }
            Some(_) => {}
        }
        history.push_front(PriceData { price, timestamp });
        while history.len() > MAX_HISTORY {
            history.pop_back();
        }
        write_history(&env, &asset, &history);
        record_last_timestamp(&env, timestamp);
        bump_instance(&env);
        PricePublished {
            asset,
            price,
            timestamp,
        }
        .publish(&env);
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Reads a value the constructor sets. A typed error beats an opaque trap if
/// that assumption ever breaks (e.g. a faulty migration).
fn read_instance<V>(env: &Env, key: &DataKey) -> V
where
    V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>,
{
    env.storage()
        .instance()
        .get(key)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

/// Loads the admin from storage and requires its authorization. Returns it.
fn require_admin(env: &Env) -> Address {
    let admin: Address = read_instance(env, &DataKey::Admin);
    admin.require_auth();
    admin
}

/// Records of `asset`, newest first; empty when never published.
fn read_history(env: &Env, asset: &Asset) -> Vec<PriceData> {
    env.storage()
        .persistent()
        .get(&DataKey::History(asset.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

fn write_history(env: &Env, asset: &Asset, history: &Vec<PriceData>) {
    let key = DataKey::History(asset.clone());
    env.storage().persistent().set(&key, history);
    env.storage()
        .persistent()
        .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
}

/// Appends a first-time asset to the quoted list, within `MAX_ASSETS`.
fn register_asset(env: &Env, asset: &Asset) -> Result<(), Error> {
    let mut assets: Vec<Asset> = read_instance(env, &DataKey::Assets);
    if assets.contains(asset) {
        return Ok(());
    }
    if assets.len() >= MAX_ASSETS {
        return Err(Error::TooManyAssets);
    }
    assets.push_back(asset.clone());
    env.storage().instance().set(&DataKey::Assets, &assets);
    Ok(())
}

fn record_last_timestamp(env: &Env, timestamp: u64) {
    let last: u64 = read_instance(env, &DataKey::LastTimestamp);
    if timestamp > last {
        env.storage()
            .instance()
            .set(&DataKey::LastTimestamp, &timestamp);
    }
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

mod test;
