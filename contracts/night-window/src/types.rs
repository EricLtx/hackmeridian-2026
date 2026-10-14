//! Types exported in the contract interface. The interface freezes at the
//! first public testnet deployment; from then on, add, never reshape.

use soroban_sdk::{contracttype, Address, Symbol, Vec};

/// Asset identifier as defined by SEP-40.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Asset {
    /// A Stellar asset, identified by its contract address.
    Stellar(Address),
    /// Any other asset, identified by a ticker symbol (`USD`, `EUR`).
    Other(Symbol),
}

/// A price point as defined by SEP-40. `price` carries the oracle's
/// `decimals()` fractional digits; `timestamp` is a Unix timestamp.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

/// Storage keys. Global settings live in instance storage; funds, offers,
/// repos and approvals are persistent entries keyed individually, so no
/// operation reads more than a fixed number of entries (invariant I6).
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Instance: the governor (multisig account), historical name kept.
    Admin,
    /// Instance: ceiling for a repo term, in seconds.
    MaxTerm,
    NextOfferId,
    NextRepoId,
    /// Persistent: configuration of an accepted fund, by share token address.
    Fund(Address),
    Offer(u64),
    Repo(u64),
    /// Instance: the guardian, who may pause new entries.
    Guardian,
    /// Instance: whether new offers and repos are suspended.
    Paused,
    /// Instance: the protocol risk envelope.
    Envelope,
    /// Persistent: an accepted stablecoin, by token address.
    Stablecoin(Address),
    /// Persistent: a lender approved by the steward of a fund.
    Lender(Address, Address),
    /// Persistent: runtime state of a fund.
    FundState(Address),
    /// Instance: sum of open principals in a currency.
    CurrencyOutstanding(Symbol),
    /// Instance: cap on open principals in a currency. Unset means zero.
    CurrencyCap(Symbol),
    /// Instance: governor proposed by `set_admin`, awaiting acceptance.
    PendingAdmin,
}

/// Limits that no fund configuration may exceed, set by the governor.
/// Stewards tune their fund inside it, the way a calibration stays inside the
/// limits a manufacturer burns into the firmware.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RiskEnvelope {
    pub min_haircut_bps: u32,
    pub min_fx_haircut_bps: u32,
    pub max_corridor_floor_bps: u32,
    pub max_yield_bps: u32,
    pub max_nav_age_secs: u64,
    pub max_fx_age_secs: u64,
    /// Widest band an FX rate may move from its reference.
    pub max_fx_band_bps: u32,
}

/// Second leg of a cross price: the fund's NAV oracle reports in one base
/// (for instance USD) and the loan is in another currency (for instance EUR).
/// The FX oracle must report `asset` in the same base as the NAV oracle.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FxLeg {
    pub oracle: Address,
    /// The loan currency as quoted by the FX oracle, e.g. `Other(EUR)`.
    pub asset: Asset,
    /// Extra haircut covering a weekend gap of the exchange rate.
    pub haircut_bps: u32,
    pub max_age_secs: u64,
    /// Band around the reference rate, both ways. The reference is set at
    /// admission, which needs both the governor and the steward.
    pub band_bps: u32,
}

/// Where a fund's price in the loan currency comes from.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PriceSource {
    /// The NAV oracle reports in the loan currency.
    Direct,
    /// The NAV oracle reports in another base; this leg converts it.
    Cross(FxLeg),
}

/// How the contract values and accepts a fund's shares as collateral.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundConfig {
    /// SEP-40 oracle publishing the fund's NAV.
    pub oracle: Address,
    /// Identifier of the shares in that oracle.
    pub oracle_asset: Asset,
    /// Haircut on the share value, in basis points.
    pub haircut_bps: u32,
    /// The issuer's key: approves lenders and tunes the fund in the envelope.
    pub steward: Address,
    /// Currency of the stablecoins this fund can be borrowed against.
    pub currency: Symbol,
    /// Direct, or crossed through an FX feed when the NAV oracle does not
    /// report in `currency`.
    pub source: PriceSource,
    /// Oldest acceptable NAV, in seconds.
    pub nav_max_age_secs: u64,
    /// Lower margin of the NAV corridor, in basis points.
    pub corridor_floor_bps: u32,
    /// Highest annual growth the corridor allows, in basis points.
    pub max_yield_bps: u32,
    /// Cap on the principal of one repo, in stablecoin units.
    pub max_principal_per_repo: i128,
    /// Cap on the sum of open principals on this fund.
    pub max_outstanding: i128,
}

/// Runtime state of a fund, kept apart from its configuration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundState {
    /// Loan currency, copied from the configuration so that totals can be
    /// released even after the fund or its stablecoin leaves the registry.
    pub currency: Symbol,
    /// Decimals of the share token, read at admission.
    pub share_decimals: u32,
    /// Decimals of the NAV oracle, read at admission.
    pub nav_decimals: u32,
    /// Decimals of the FX oracle, 0 without FX leg.
    pub fx_decimals: u32,
    /// Reference NAV of the corridor and its timestamp.
    pub reference_nav: i128,
    pub reference_time: u64,
    /// Reference FX rate, 0 without FX leg.
    pub reference_fx: i128,
    /// Sum of open principals on this fund.
    pub outstanding: i128,
    /// Set by the steward to suspend new repos on this fund.
    pub frozen: bool,
}

/// An accepted stablecoin.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StablecoinConfig {
    pub currency: Symbol,
    /// Read from the token when registered.
    pub decimals: u32,
}

/// A lender's standing offer. Borrowers take it in one transaction; the
/// principal repaid flows back into it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Offer {
    pub lender: Address,
    pub stablecoin: Address,
    /// Amount available to borrow now.
    pub available: i128,
    /// Annual rate, in basis points.
    pub rate_bps: u32,
    /// Longest term the lender accepts, in seconds.
    pub max_term: u64,
    /// Fund shares the lender accepts as collateral.
    pub funds: Vec<Address>,
    /// Marked by a fund's steward: the issuer's own offer.
    pub sponsor: bool,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepoStatus {
    Open,
    Repurchased,
    Defaulted,
}

/// A repo position: shares locked against a stablecoin loan. Its terms are
/// frozen at opening (invariant I9).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Repo {
    pub offer_id: u64,
    pub borrower: Address,
    pub lender: Address,
    pub fund: Address,
    pub shares: i128,
    pub stablecoin: Address,
    pub principal: i128,
    pub rate_bps: u32,
    /// Ledger timestamp at opening.
    pub opened_at: u64,
    /// Ledger timestamp from which the lender may seize the shares.
    pub maturity: u64,
    pub status: RepoStatus,
}

/// What a fund's shares can secure right now. Read-only, for interfaces.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Quote {
    /// Share price in the loan currency, with `price_decimals` digits.
    pub price: i128,
    pub price_decimals: u32,
    /// Fund haircut plus FX haircut when the price is crossed.
    pub haircut_bps: u32,
    pub max_principal: i128,
    pub nav_timestamp: u64,
}
