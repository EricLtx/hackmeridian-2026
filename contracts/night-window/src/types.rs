//! Types exported in the contract interface. The interface freezes at the
//! first public testnet deployment; from then on, add, never reshape.

use soroban_sdk::{contracttype, Address, BytesN, Symbol, Vec};

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
    /// Instance: time delay of upgrades and fund changes, in seconds.
    TimelockDelay,
    /// Instance: set once a fund has been admitted. From then on, the time
    /// delay may only grow.
    FundsAdmitted,
    /// Instance: the upgrade proposed by the governor, with its eta.
    PendingUpgrade,
    /// Persistent: replacement of an admitted fund's configuration, waiting
    /// for its time delay.
    PendingFundChange(Address),
    /// Persistent: shares owed by a closed repo that the share token refused
    /// to deliver, by repo identifier.
    PendingRelease(u64),
    /// Persistent: fallback NAV feed of a fund.
    Fallback(Address),
    /// Instance: decimals of a fund's fallback feed, present only while the
    /// fallback is active. Kept in instance storage so that a fund without
    /// fallback reads no extra ledger entry when it is valued.
    FallbackDecimals(Address),
    /// Persistent: fallback NAV feed proposed for a fund, with its eta.
    PendingFallback(Address),
    /// Instance: guardian proposed after the first admission, with its eta.
    PendingGuardian,
    /// Instance: increase of the term ceiling waiting for its delay.
    PendingMaxTerm,
    /// Instance: loosening of the risk envelope waiting for its delay.
    PendingEnvelope,
    /// Persistent: the steward of a fund's last installed configuration.
    /// Never removed, so that a removed fund cannot be re-admitted without
    /// its issuer.
    LastSteward(Address),
    /// Persistent: loosening of a fund's limits waiting for its delay.
    PendingFundLimits(Address),
    /// Instance: currency cap increases waiting for their delay, by currency.
    PendingCurrencyCaps,
    /// Instance: guardian imposed by the governor alone, after the longest
    /// delay.
    PendingForcedGuardian,
    /// Instance: number of funds with an active fallback feed.
    FallbackCount,
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

/// An upgrade proposed by the governor (decision S7). It can be applied by
/// the governor from `eta` on, or cancelled by the governor or the guardian
/// until then.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUpgrade {
    pub wasm_hash: BytesN<32>,
    /// Ledger timestamp from which `upgrade` accepts this hash.
    pub eta: u64,
}

/// A replacement of an admitted fund's configuration, signed by the governor
/// and the steward(s), waiting for its time delay (decision S7).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingFundChange {
    pub config: FundConfig,
    /// Ledger timestamp from which anyone may apply it.
    pub eta: u64,
}

/// Shares a closed repo owes but the share token refused to deliver: the
/// issuer froze the contract or the recipient, removed one of them from its
/// allowlist, or clawed shares back (decision S9). Anyone may retry the
/// delivery to `to`; nothing else moves these shares.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingRelease {
    pub fund: Address,
    /// The borrower after a repurchase, the seizure recipient after a default.
    pub to: Address,
    pub shares: i128,
}

/// A second NAV source for a fund, used when the primary feed is stale or
/// silent, and checked against it when both are fresh.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FallbackFeed {
    /// SEP-40 oracle reporting in the same base as the fund's NAV oracle.
    pub oracle: Address,
    /// Identifier of the shares in that oracle.
    pub asset: Asset,
    /// Oldest acceptable price, in seconds; within the envelope's NAV age.
    pub max_age_secs: u64,
    /// Largest gap allowed between the two feeds when both are fresh, in
    /// basis points of the primary NAV.
    pub max_divergence_bps: u32,
}

/// A guardian appointment waiting for its time delay. The current guardian
/// can cancel it, so a governor key alone cannot remove the veto in time.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingGuardianChange {
    pub guardian: Address,
    /// Ledger timestamp from which anyone may apply it.
    pub eta: u64,
}

/// An increase of the term ceiling waiting for its time delay.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingMaxTermChange {
    pub max_term: u64,
    /// Ledger timestamp from which anyone may apply it.
    pub eta: u64,
}

/// A risk envelope that loosens at least one bound, waiting for its time
/// delay.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingEnvelopeChange {
    pub envelope: RiskEnvelope,
    /// Ledger timestamp from which anyone may apply it.
    pub eta: u64,
}

/// A loosening of a fund's limits by its steward (lower haircut, higher
/// caps), waiting for its time delay.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingFundLimitsChange {
    pub haircut_bps: u32,
    pub max_principal_per_repo: i128,
    pub max_outstanding: i128,
    /// Ledger timestamp from which anyone may apply it.
    pub eta: u64,
}

/// An increase of a currency cap, waiting for its time delay.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingCurrencyCapChange {
    pub cap: i128,
    /// Ledger timestamp from which anyone may apply it.
    pub eta: u64,
}

/// A fallback feed proposed for a fund, waiting for its time delay.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingFallback {
    pub feed: FallbackFeed,
    /// Ledger timestamp from which anyone may apply it.
    pub eta: u64,
}
