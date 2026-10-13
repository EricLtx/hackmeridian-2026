#![no_std]
//! Night Window: an on-chain repo contract on Stellar.
//!
//! Holders of tokenized money market fund shares borrow stablecoins against
//! their shares, at any hour, for a fixed term and a fixed rate. Lenders fund
//! standing offers; the fund issuer does not have to finance the liquidity.
//!
//! Scope of this scaffold, produced while the specification is being
//! finalised:
//!
//! - administration and upgrade path (admin-gated WASM replacement);
//! - registry of accepted funds with a haircut and a SEP-40 price source;
//! - SEP-40 price lookup through a typed oracle client;
//! - storage layout with one ledger entry per fund, per offer and per repo,
//!   so that no operation loops over positions;
//! - the lifecycle entry points (offer, open, repurchase, default, withdraw)
//!   declared with their intended signatures and the types they move.
//!
//! The lifecycle entry points return [`Error::NotImplemented`] until the
//! specification settles the open points: haircut per fund, seven-day
//! maximum term, pro-rata interest on early repurchase, price staleness
//! window, and what the lender may do with seized shares. The security
//! baseline and invariants are in `docs/securite.md`.

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contractmeta,
    contracttype, panic_with_error, Address, BytesN, ContractExecutable, Env, Symbol, Vec,
};

contractmeta!(key = "binver", val = "0.1.0");
contractmeta!(
    key = "desc",
    val = "Night Window: repo of tokenized money market fund shares"
);

// Ledgers close about every 5 seconds: 17,280 ledgers a day.
const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const BUMP_TO: u32 = 120 * DAY_IN_LEDGERS;

/// Basis points in one unit: haircuts and rates are expressed out of 10,000.
pub const BPS_DENOMINATOR: u32 = 10_000;

/// Default ceiling for a repo term: seven days, in seconds. Short terms keep
/// the first version free of margin calls.
pub const DEFAULT_MAX_TERM_SECS: u64 = 7 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// SEP-40 oracle consumer interface (price of the fund shares)
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
/// digits; `timestamp` is a Unix timestamp aligned on the oracle resolution.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

/// The subset of the SEP-40 oracle interface this contract consumes.
#[contractclient(name = "OracleClient")]
pub trait Sep40Oracle {
    /// Number of fractional digits in every price returned by the oracle.
    fn decimals(env: Env) -> u32;
    /// Last known price of `asset`, or `None` when the oracle does not track it.
    fn lastprice(env: Env, asset: Asset) -> Option<PriceData>;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/// Storage keys. Global configuration lives in instance storage; funds, offers
/// and repos are persistent entries keyed individually, so no operation has
/// to read more than a fixed number of entries.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Instance: administrator address.
    Admin,
    /// Instance: ceiling for a repo term, in seconds.
    MaxTerm,
    /// Instance: identifier of the next offer.
    NextOfferId,
    /// Instance: identifier of the next repo.
    NextRepoId,
    /// Persistent: configuration of an accepted fund, keyed by its token address.
    Fund(Address),
    /// Persistent: a lender's standing offer.
    Offer(u64),
    /// Persistent: a repo position.
    Repo(u64),
}

/// How the contract values and accepts a fund's shares as collateral.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundConfig {
    /// SEP-40 oracle that prices the shares.
    pub oracle: Address,
    /// Identifier of the shares in that oracle.
    pub oracle_asset: Asset,
    /// Discount applied to the share value when sizing a loan, in basis points.
    /// A loan is capped at `value * (10_000 - haircut_bps) / 10_000`.
    pub haircut_bps: u32,
}

/// A lender's standing offer. Borrowers take it in one transaction.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Offer {
    pub lender: Address,
    /// Stablecoin lent (SEP-41 token address).
    pub stablecoin: Address,
    /// Amount still available to borrow.
    pub available: i128,
    /// Annual repo rate, in basis points.
    pub rate_bps: u32,
    /// Longest term the lender accepts, in seconds.
    pub max_term: u64,
    /// Fund shares the lender accepts as collateral.
    pub funds: Vec<Address>,
}

/// State of a repo position.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepoStatus {
    Open,
    Repurchased,
    Defaulted,
}

/// A repo position: shares locked against a stablecoin loan.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Repo {
    pub offer_id: u64,
    pub borrower: Address,
    pub lender: Address,
    /// Fund shares used as collateral (SEP-41 token address).
    pub fund: Address,
    pub shares: i128,
    pub stablecoin: Address,
    pub principal: i128,
    pub rate_bps: u32,
    /// Ledger timestamp at opening.
    pub opened_at: u64,
    /// Ledger timestamp after which the lender may seize the shares.
    pub maturity: u64,
    pub status: RepoStatus,
}

// ---------------------------------------------------------------------------
// Errors and events
// ---------------------------------------------------------------------------

/// Error codes are public ABI: add new ones, never renumber.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    /// The entry point is declared but waits for the specification.
    NotImplemented = 1,
    /// The fund is not in the registry of accepted funds.
    FundNotAccepted = 2,
    /// Haircut must be below 10,000 basis points.
    InvalidHaircut = 3,
    /// Amounts must be strictly positive.
    InvalidAmount = 4,
    /// Term must be strictly positive and within the contract ceiling.
    InvalidTerm = 5,
    /// The oracle has no price for the fund's shares.
    NoPrice = 6,
    /// Instance storage lost its configuration. Unreachable with a constructor
    /// deployment; kept as a typed failure rather than an opaque trap.
    NotInitialized = 7,
}

#[contractevent]
pub struct FundSet {
    #[topic]
    pub fund: Address,
    pub oracle: Address,
    pub haircut_bps: u32,
}

#[contractevent]
pub struct FundRemoved {
    #[topic]
    pub fund: Address,
}

#[contractevent]
pub struct AdminChanged {
    #[topic]
    pub previous: Address,
    pub admin: Address,
}

#[contractevent]
pub struct MaxTermChanged {
    pub max_term: u64,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct NightWindow;

#[contractimpl]
impl NightWindow {
    /// Deploys the contract with its administrator. Runs once, at deploy time.
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::MaxTerm, &DEFAULT_MAX_TERM_SECS);
        env.storage().instance().set(&DataKey::NextOfferId, &1u64);
        env.storage().instance().set(&DataKey::NextRepoId, &1u64);
    }

    // -- Administration -----------------------------------------------------

    /// Version of the contract interface. Bump on every incompatible change.
    pub fn version() -> u32 {
        1
    }

    pub fn admin(env: Env) -> Address {
        read_admin(&env)
    }

    /// Hands administration to `new_admin`. Requires the current admin.
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

    /// Replaces the contract code. The WASM must already be uploaded; storage
    /// and address are kept. Requires the admin.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        require_admin(&env);
        env.deployer()
            .update_current_contract(ContractExecutable::Wasm(new_wasm_hash));
    }

    /// Ceiling for a repo term, in seconds.
    pub fn max_term(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::MaxTerm)
            .unwrap_or(DEFAULT_MAX_TERM_SECS)
    }

    /// Sets the ceiling for a repo term, in seconds. Requires the admin.
    pub fn set_max_term(env: Env, max_term: u64) -> Result<(), Error> {
        require_admin(&env);
        if max_term == 0 {
            return Err(Error::InvalidTerm);
        }
        env.storage().instance().set(&DataKey::MaxTerm, &max_term);
        bump_instance(&env);
        MaxTermChanged { max_term }.publish(&env);
        Ok(())
    }

    // -- Registry of accepted funds -----------------------------------------

    /// Adds a fund to the registry or updates its configuration. `fund` is the
    /// SEP-41 address of the share token. Requires the admin.
    pub fn set_fund(env: Env, fund: Address, config: FundConfig) -> Result<(), Error> {
        require_admin(&env);
        if config.haircut_bps >= BPS_DENOMINATOR {
            return Err(Error::InvalidHaircut);
        }
        let key = DataKey::Fund(fund.clone());
        env.storage().persistent().set(&key, &config);
        env.storage()
            .persistent()
            .extend_ttl(&key, BUMP_THRESHOLD, BUMP_TO);
        bump_instance(&env);
        FundSet {
            fund,
            oracle: config.oracle,
            haircut_bps: config.haircut_bps,
        }
        .publish(&env);
        Ok(())
    }

    /// Removes a fund from the registry. Open repos on that fund are not
    /// affected: their terms are frozen at opening. Requires the admin.
    pub fn remove_fund(env: Env, fund: Address) -> Result<(), Error> {
        require_admin(&env);
        let key = DataKey::Fund(fund.clone());
        if !env.storage().persistent().has(&key) {
            return Err(Error::FundNotAccepted);
        }
        env.storage().persistent().remove(&key);
        bump_instance(&env);
        FundRemoved { fund }.publish(&env);
        Ok(())
    }

    /// Configuration of an accepted fund, or `None`.
    pub fn get_fund(env: Env, fund: Address) -> Option<FundConfig> {
        env.storage().persistent().get(&DataKey::Fund(fund))
    }

    /// Last price of a fund's shares, as reported by its SEP-40 oracle.
    /// Staleness is not checked here: the window belongs to the specification.
    pub fn fund_price(env: Env, fund: Address) -> Result<PriceData, Error> {
        let config = read_fund(&env, &fund)?;
        OracleClient::new(&env, &config.oracle)
            .lastprice(&config.oracle_asset)
            .ok_or(Error::NoPrice)
    }

    // -- Lifecycle, pending specification -----------------------------------

    /// Lender deposits `amount` of `stablecoin` with their terms. Returns the
    /// offer identifier.
    pub fn create_offer(
        _env: Env,
        _lender: Address,
        _stablecoin: Address,
        _amount: i128,
        _rate_bps: u32,
        _max_term: u64,
        _funds: Vec<Address>,
    ) -> Result<u64, Error> {
        Err(Error::NotImplemented)
    }

    /// Lender takes back `amount` of the stablecoins not lent from their offer.
    pub fn withdraw_offer(_env: Env, _offer_id: u64, _amount: i128) -> Result<(), Error> {
        Err(Error::NotImplemented)
    }

    /// Borrower locks `shares` of `fund` against `offer_id` and receives
    /// `principal` stablecoins in the same transaction, for `term` seconds.
    /// Returns the repo identifier.
    pub fn open_repo(
        _env: Env,
        _borrower: Address,
        _offer_id: u64,
        _fund: Address,
        _shares: i128,
        _principal: i128,
        _term: u64,
    ) -> Result<u64, Error> {
        Err(Error::NotImplemented)
    }

    /// Borrower repays principal and interest and gets the shares back.
    pub fn repurchase(_env: Env, _repo_id: u64) -> Result<(), Error> {
        Err(Error::NotImplemented)
    }

    /// After maturity, the lender seizes the shares of an unpaid repo.
    pub fn seize(_env: Env, _repo_id: u64) -> Result<(), Error> {
        Err(Error::NotImplemented)
    }

    pub fn get_offer(env: Env, offer_id: u64) -> Option<Offer> {
        env.storage().persistent().get(&DataKey::Offer(offer_id))
    }

    pub fn get_repo(env: Env, repo_id: u64) -> Option<Repo> {
        env.storage().persistent().get(&DataKey::Repo(repo_id))
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn read_admin(env: &Env) -> Address {
    // Set by the constructor, so always present. A typed error beats an
    // opaque trap if that assumption ever breaks (e.g. a faulty migration).
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

/// Loads the admin from storage and requires its authorization. Returns it.
fn require_admin(env: &Env) -> Address {
    let admin = read_admin(env);
    admin.require_auth();
    admin
}

fn read_fund(env: &Env, fund: &Address) -> Result<FundConfig, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Fund(fund.clone()))
        .ok_or(Error::FundNotAccepted)
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
}

mod test;
