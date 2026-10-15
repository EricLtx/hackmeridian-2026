//! Events: one per state transition (decision S13), identifiers and
//! addresses as topics, for audit, indexing and issuer reconciliation.

use soroban_sdk::{contractevent, Address, BytesN, Symbol};

use crate::types::RiskEnvelope;

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
pub struct AdminProposed {
    #[topic]
    pub current: Address,
    pub proposed: Address,
}

#[contractevent]
pub struct AdminProposalCancelled {
    pub proposed: Address,
    pub by: Address,
}

#[contractevent]
pub struct ReanchorProposed {
    #[topic]
    pub fund: Address,
    pub nav: i128,
    pub nav_time: u64,
    pub fx: i128,
    pub eta: u64,
}

#[contractevent]
pub struct ReanchorCancelled {
    #[topic]
    pub fund: Address,
    pub by: Address,
}

#[contractevent]
pub struct Reanchored {
    #[topic]
    pub fund: Address,
    pub nav: i128,
    pub nav_time: u64,
    pub fx: i128,
}

#[contractevent]
pub struct MaxTermChanged {
    pub max_term: u64,
}

#[contractevent]
pub struct GuardianChanged {
    pub guardian: Address,
}

#[contractevent]
pub struct EnvelopeChanged {
    pub envelope: RiskEnvelope,
}

#[contractevent]
pub struct PauseChanged {
    pub paused: bool,
    pub by: Address,
}

#[contractevent]
pub struct StablecoinSet {
    #[topic]
    pub stablecoin: Address,
    pub currency: Symbol,
}

#[contractevent]
pub struct StablecoinRemoved {
    #[topic]
    pub stablecoin: Address,
}

#[contractevent]
pub struct CurrencyCapSet {
    #[topic]
    pub currency: Symbol,
    pub cap: i128,
}

#[contractevent]
pub struct FundLimitsSet {
    #[topic]
    pub fund: Address,
    pub haircut_bps: u32,
    pub max_principal_per_repo: i128,
    pub max_outstanding: i128,
}

#[contractevent]
pub struct LenderApproval {
    #[topic]
    pub fund: Address,
    #[topic]
    pub lender: Address,
    pub approved: bool,
}

#[contractevent]
pub struct FundFrozen {
    #[topic]
    pub fund: Address,
    pub frozen: bool,
}

#[contractevent]
pub struct ReferenceUpdated {
    #[topic]
    pub fund: Address,
    pub nav: i128,
    pub timestamp: u64,
}

#[contractevent]
pub struct SponsorSet {
    #[topic]
    pub offer_id: u64,
    pub sponsor: bool,
}

#[contractevent]
pub struct OfferCreated {
    #[topic]
    pub offer_id: u64,
    #[topic]
    pub lender: Address,
    pub stablecoin: Address,
    pub amount: i128,
    pub rate_bps: u32,
    pub max_term: u64,
}

#[contractevent]
pub struct OfferWithdrawn {
    #[topic]
    pub offer_id: u64,
    pub amount: i128,
}

#[contractevent]
pub struct RepoOpened {
    #[topic]
    pub repo_id: u64,
    #[topic]
    pub borrower: Address,
    pub offer_id: u64,
    pub lender: Address,
    pub fund: Address,
    pub shares: i128,
    pub principal: i128,
    pub rate_bps: u32,
    pub maturity: u64,
}

#[contractevent]
pub struct RepoRepurchased {
    #[topic]
    pub repo_id: u64,
    pub principal: i128,
    pub interest: i128,
}

#[contractevent]
pub struct RepoSeized {
    #[topic]
    pub repo_id: u64,
    pub to: Address,
    pub shares: i128,
}

// -- Time delay (decision S7) -------------------------------------------------

#[contractevent]
pub struct TimelockDelayChanged {
    pub delay: u64,
}

#[contractevent]
pub struct UpgradeProposed {
    pub wasm_hash: BytesN<32>,
    pub eta: u64,
}

#[contractevent]
pub struct UpgradeCancelled {
    pub wasm_hash: BytesN<32>,
    pub by: Address,
}

/// Published just before the code switches, by the code being replaced.
#[contractevent]
pub struct Upgraded {
    pub wasm_hash: BytesN<32>,
}

#[contractevent]
pub struct GuardianChangeProposed {
    pub guardian: Address,
    pub eta: u64,
}

#[contractevent]
pub struct GuardianChangeCancelled {
    pub guardian: Address,
    pub by: Address,
}

#[contractevent]
pub struct MaxTermChangeProposed {
    pub max_term: u64,
    pub eta: u64,
}

#[contractevent]
pub struct MaxTermChangeCancelled {
    pub max_term: u64,
    pub by: Address,
}

#[contractevent]
pub struct EnvelopeChangeProposed {
    pub envelope: RiskEnvelope,
    pub eta: u64,
}

#[contractevent]
pub struct EnvelopeChangeCancelled {
    pub envelope: RiskEnvelope,
    pub by: Address,
}

/// The governor imposes a guardian without the current one, after the
/// longest delay.
#[contractevent]
pub struct GuardianChangeForced {
    pub guardian: Address,
    pub eta: u64,
}

#[contractevent]
pub struct ForcedGuardianChangeCancelled {
    pub guardian: Address,
    pub by: Address,
}

#[contractevent]
pub struct FundLimitsChangeProposed {
    #[topic]
    pub fund: Address,
    pub haircut_bps: u32,
    pub max_principal_per_repo: i128,
    pub max_outstanding: i128,
    pub eta: u64,
}

#[contractevent]
pub struct FundLimitsChangeCancelled {
    #[topic]
    pub fund: Address,
    pub by: Address,
}

#[contractevent]
pub struct CurrencyCapChangeProposed {
    #[topic]
    pub currency: Symbol,
    pub cap: i128,
    pub eta: u64,
}

#[contractevent]
pub struct CurrencyCapChangeCancelled {
    #[topic]
    pub currency: Symbol,
    pub by: Address,
}

#[contractevent]
pub struct FundChangeProposed {
    #[topic]
    pub fund: Address,
    pub eta: u64,
}

#[contractevent]
pub struct FundChangeCancelled {
    #[topic]
    pub fund: Address,
    pub by: Address,
}

// -- Fallback NAV feed ----------------------------------------------------------

#[contractevent]
pub struct FallbackProposed {
    #[topic]
    pub fund: Address,
    pub oracle: Address,
    pub eta: u64,
}

#[contractevent]
pub struct FallbackSet {
    #[topic]
    pub fund: Address,
    pub oracle: Address,
}

#[contractevent]
pub struct FallbackCancelled {
    #[topic]
    pub fund: Address,
    pub by: Address,
}

#[contractevent]
pub struct FallbackRemoved {
    #[topic]
    pub fund: Address,
    pub by: Address,
}

// -- Deferred share release (decision S9) ---------------------------------------

#[contractevent]
pub struct ReleaseDeferred {
    #[topic]
    pub repo_id: u64,
    pub to: Address,
    pub shares: i128,
}

#[contractevent]
pub struct ReleaseRedirected {
    #[topic]
    pub repo_id: u64,
    pub to: Address,
}

#[contractevent]
pub struct SharesReleased {
    #[topic]
    pub repo_id: u64,
    pub to: Address,
    pub shares: i128,
}

// -- Version 4: independent lenders and custody gaps ----------------------------

/// Published with `AdminProposed`, which keeps its version 2 shape: when the
/// proposed governor may accept.
#[contractevent]
pub struct AdminChangeProposed {
    pub admin: Address,
    pub eta: u64,
}

#[contractevent]
pub struct SoleLenderSet {
    pub lender: Address,
}

#[contractevent]
pub struct LenderAttested {
    #[topic]
    pub fund: Address,
    #[topic]
    pub lender: Address,
    pub declaration: BytesN<32>,
}

#[contractevent]
pub struct GuardianBackupSet {
    pub backup: Address,
}

#[contractevent]
pub struct StewardBackupSet {
    #[topic]
    pub fund: Address,
    pub backup: Address,
}

#[contractevent]
pub struct StewardRecoveryProposed {
    #[topic]
    pub fund: Address,
    pub steward: Address,
    pub eta: u64,
}

#[contractevent]
pub struct StewardRecoveryCancelled {
    #[topic]
    pub fund: Address,
    pub by: Address,
}

#[contractevent]
pub struct StewardRecovered {
    #[topic]
    pub fund: Address,
    pub previous: Address,
    pub steward: Address,
}
