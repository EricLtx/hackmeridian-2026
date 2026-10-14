//! Events: one per state transition (decision S13), identifiers and
//! addresses as topics, for audit, indexing and issuer reconciliation.

use soroban_sdk::{contractevent, Address, Symbol};

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
