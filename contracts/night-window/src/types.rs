// Types exported in the contract interface. The interface freezes at the tag
// the external audit reviews, `audit-v4-rc5`; from then on it is append-only:
// new types, new enum variants at the end and new functions, never a reshaped
// or removed one. A stored type keeps its key (see `DataKey`); a change of
// layout bumps `SCHEMA_VERSION` and gets a step in `migrate`.

use soroban_sdk::{contracttype, Address, BytesN, Symbol, Vec};

/// SEP-40 asset identifier.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Asset {
    /// By contract address.
    Stellar(Address),
    /// By ticker symbol.
    Other(Symbol),
}

/// SEP-40 price point.
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
    /// Persistent: shares owed by a closed repo, by repo identifier, while
    /// the share token refuses the delivery or, for seized shares, while the
    /// recipient is not approved for the fund.
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
    /// Persistent: re-anchoring of a fund's references waiting for its
    /// delay.
    PendingReanchor(Address),
    /// Instance: governor handover proposed by `set_admin` from version 4 on,
    /// with its eta. Replaces `PendingAdmin`, which stays readable for a
    /// handover proposed before an upgrade.
    PendingAdminChange,
    /// Instance: the only address the guardian may hand its role over to,
    /// registered by the governor and the guardian together.
    GuardianBackup,
    /// Instance: the only lender of a single-lender instance. Set once,
    /// before anything is at stake.
    SoleLender,
    /// Persistent: a lender's attestation for a fund, by fund and lender.
    /// Removed when the approval is revoked.
    LenderAttestation(Address, Address),
    /// Persistent: a lost steward key's replacement by the steward's
    /// backup, waiting for the longest delay.
    PendingStewardRecovery(Address),
    /// Persistent: the successor a fund's steward named for itself, the only
    /// address a steward recovery may install.
    StewardBackup(Address),
    /// Instance: counts governor and guardian changes, so that a proposal
    /// signed by keys since replaced can be recognised.
    GovernanceGeneration,
    /// Instance: the trustee, whose consent upgrades need.
    Trustee,
    /// Persistent: replacement of a steward's backup, waiting for its delay.
    PendingStewardBackup(Address),
    /// Persistent: a stablecoin registration or currency change proposed
    /// after the first admission, waiting for its delay (rc4).
    PendingStablecoin(Address),
    /// Instance: the sentinel, an automated key the guardian names, which
    /// may only pause and cancel (rc4).
    Sentinel,
    /// Instance: version of the stored data layout. Absent means 1, the
    /// layout of every instance deployed before rc4.
    SchemaVersion,
}

/// Bounds on every fund configuration.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RiskEnvelope {
    pub min_haircut_bps: u32,
    pub min_fx_haircut_bps: u32,
    pub max_corridor_floor_bps: u32,
    pub max_yield_bps: u32,
    pub max_nav_age_secs: u64,
    pub max_fx_age_secs: u64,
    pub max_fx_band_bps: u32,
}

/// FX leg of a cross price.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FxLeg {
    pub oracle: Address,
    /// As quoted by the FX oracle.
    pub asset: Asset,
    /// Extra, for the FX gap.
    pub haircut_bps: u32,
    pub max_age_secs: u64,
    pub band_bps: u32,
}

/// Where the loan-currency price comes from.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PriceSource {
    /// NAV in the loan currency.
    Direct,
    /// Converted through an FX leg.
    Cross(FxLeg),
}

/// A fund's valuation settings.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundConfig {
    /// SEP-40 NAV oracle.
    pub oracle: Address,
    /// The shares in that oracle.
    pub oracle_asset: Asset,
    pub haircut_bps: u32,
    /// The issuer's key.
    pub steward: Address,
    /// Loan currency.
    pub currency: Symbol,
    pub source: PriceSource,
    pub nav_max_age_secs: u64,
    pub corridor_floor_bps: u32,
    /// Corridor growth, yearly.
    pub max_yield_bps: u32,
    pub max_principal_per_repo: i128,
    pub max_outstanding: i128,
}

/// Runtime state of a fund.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FundState {
    pub currency: Symbol,
    pub share_decimals: u32,
    pub nav_decimals: u32,
    /// 0 without FX leg.
    pub fx_decimals: u32,
    /// Corridor reference.
    pub reference_nav: i128,
    pub reference_time: u64,
    /// 0 without FX leg.
    pub reference_fx: i128,
    pub outstanding: i128,
    /// Set by the steward.
    pub frozen: bool,
}

/// An accepted stablecoin.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StablecoinConfig {
    pub currency: Symbol,
    pub decimals: u32,
}

/// A lender's standing offer.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Offer {
    pub lender: Address,
    pub stablecoin: Address,
    pub available: i128,
    /// Annual.
    pub rate_bps: u32,
    pub max_term: u64,
    /// Accepted collateral.
    pub funds: Vec<Address>,
    /// Issuer-designated.
    pub sponsor: bool,
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepoStatus {
    Open,
    Repurchased,
    Defaulted,
}

/// Shares locked against a loan; terms frozen.
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
    pub opened_at: u64,
    /// Seizable from then.
    pub maturity: u64,
    pub status: RepoStatus,
}

/// What shares can secure now.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Quote {
    /// `price_decimals` digits.
    pub price: i128,
    pub price_decimals: u32,
    /// Fund plus FX.
    pub haircut_bps: u32,
    pub max_principal: i128,
    pub nav_timestamp: u64,
}

/// A proposed upgrade.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUpgrade {
    pub wasm_hash: BytesN<32>,
    pub eta: u64,
}

/// A proposed fund replacement.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingFundChange {
    pub config: FundConfig,
    /// First FX leg's reference, else 0.
    pub fx_anchor: i128,
    pub eta: u64,
}

/// A proposed re-anchor: readings at the proposal.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingReanchor {
    pub nav_oracle: Address,
    pub nav_asset: Asset,
    /// `nav_decimals` digits.
    pub nav: i128,
    pub nav_time: u64,
    pub nav_decimals: u32,
    pub fx: AnchorFx,
    pub eta: u64,
}

/// FX side of a re-anchor.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AnchorFx {
    Direct,
    Cross(AnchorRate),
}

impl AnchorFx {
    /// The rate, for a cross price.
    pub fn rate(&self) -> Option<&AnchorRate> {
        match self {
            AnchorFx::Direct => None,
            AnchorFx::Cross(rate) => Some(rate),
        }
    }
}

/// An FX reading with its feed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AnchorRate {
    pub oracle: Address,
    pub asset: Asset,
    /// `decimals` digits.
    pub rate: i128,
    pub decimals: u32,
}

/// Shares owed: refused by the token, or seized for an unapproved recipient.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingRelease {
    pub fund: Address,
    /// Borrower or seizure recipient.
    pub to: Address,
    pub shares: i128,
}

/// A second NAV source.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FallbackFeed {
    /// Same base as the NAV oracle.
    pub oracle: Address,
    pub asset: Asset,
    pub max_age_secs: u64,
    /// Gap from the primary.
    pub max_divergence_bps: u32,
}

/// A proposed guardian.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingGuardianChange {
    pub guardian: Address,
    pub eta: u64,
}

/// A proposed ceiling increase.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingMaxTermChange {
    pub max_term: u64,
    pub eta: u64,
}

/// A proposed envelope loosening.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingEnvelopeChange {
    pub envelope: RiskEnvelope,
    pub eta: u64,
}

/// A proposed loosening of fund limits.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingFundLimitsChange {
    pub haircut_bps: u32,
    pub max_principal_per_repo: i128,
    pub max_outstanding: i128,
    pub eta: u64,
}

/// A proposed cap increase.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingCurrencyCapChange {
    pub cap: i128,
    pub eta: u64,
}

/// A proposed fallback feed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingFallback {
    pub feed: FallbackFeed,
    pub eta: u64,
}

/// A proposed governor handover.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAdminChange {
    pub admin: Address,
    /// Acceptable from then.
    pub eta: u64,
}

// Reshaped after the first v4 draft (field `steward` added). Version 4 was
// never released: instances are redeployed, never upgraded in place from a
// draft, so no stored value has the old shape.

/// Hash of a declaration both signed.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LenderAttestation {
    pub declaration: BytesN<32>,
    /// Co-signer; must still hold.
    pub steward: Address,
    pub at: u64,
}

// Reshaped after the first v4 draft (fields `previous` and `generation`
// added); same reason as `LenderAttestation`: no stored value has the old
// shape.

/// A proposed steward recovery.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingStewardRecovery {
    pub steward: Address,
    /// Steward at the proposal.
    pub previous: Address,
    pub generation: u64,
    pub eta: u64,
}

/// A proposed backup replacement.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingStewardBackup {
    pub backup: Address,
    pub steward: Address,
    pub eta: u64,
}

/// A stablecoin registration waiting for its delay.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingStablecoinChange {
    pub currency: Symbol,
    pub eta: u64,
}
