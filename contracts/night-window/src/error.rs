//! Error codes. They are public ABI: add new variants at the end, never
//! renumber or remove one.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Kept for ABI stability: returned by entry points of version 1 that
    /// waited for the specification. No longer returned.
    NotImplemented = 1,
    /// The fund is not in the registry of accepted funds.
    FundNotAccepted = 2,
    /// Haircut must be below 10,000 basis points and within the envelope.
    InvalidHaircut = 3,
    /// Amounts must be strictly positive.
    InvalidAmount = 4,
    /// Term must be within the minimum term and the applicable ceiling.
    InvalidTerm = 5,
    /// The oracle has no price for the asset.
    NoPrice = 6,
    /// Instance storage lost its configuration. Unreachable with a constructor
    /// deployment; kept as a typed failure rather than an opaque trap.
    NotInitialized = 7,
    /// New offers and new repos are suspended.
    Paused = 8,
    /// The stablecoin is not in the registry of accepted stablecoins.
    StablecoinNotAccepted = 9,
    /// Currencies of the fund, its oracles and the stablecoin do not match.
    CurrencyMismatch = 10,
    /// The price is older than the freshness window.
    StalePrice = 11,
    /// The fund's NAV is outside the corridor predicted from its reference.
    PriceOutOfBand = 12,
    /// The principal requested exceeds what the shares can secure.
    LoanTooLarge = 13,
    OfferNotFound = 14,
    /// The offer does not hold enough stablecoins.
    InsufficientOffer = 15,
    RepoNotFound = 16,
    /// The repo was already repurchased or seized.
    RepoNotOpen = 17,
    /// The repo has not reached maturity yet.
    NotMatured = 18,
    /// A per-repo, per-fund or per-currency cap would be exceeded.
    CapExceeded = 19,
    /// An offer lists no fund, a duplicate, or more than the maximum.
    TooManyFunds = 20,
    /// The lender or recipient is not approved by the fund's steward.
    LenderNotApproved = 21,
    /// The contract did not receive exactly the amount transferred.
    TransferMismatch = 22,
    /// The offer does not accept this fund as collateral.
    FundNotInOffer = 23,
    /// Rates are expressed in basis points and capped at 10,000.
    InvalidRate = 24,
    /// A computation overflowed or divided by zero.
    ArithmeticOverflow = 25,
    /// A parameter lies outside the protocol risk envelope.
    OutsideEnvelope = 26,
    /// The fund's steward suspended new repos on this fund.
    FundFrozen = 27,
    /// A price is not strictly positive or lies in the future.
    InvalidPrice = 28,
    /// Reserved: the fund is already listed in the offer.
    DuplicateFund = 29,
    /// The caller does not hold the role this function requires.
    Unauthorized = 30,
    /// Once a fund has been admitted, the time delay may only grow: a
    /// compromised governor cannot shorten the window others have to react.
    DelayCannotDecrease = 31,
    /// No pending proposal matches: nothing proposed, already applied or
    /// cancelled, or an upgrade to another WASM hash than the one proposed.
    NotProposed = 32,
    /// The proposal exists but its time delay has not elapsed yet.
    TimelockPending = 33,
    /// Reserved: a draft of version 3 returned it from `release`, which now
    /// reports a refused delivery as `false` so that the record's TTL
    /// extension is kept. No longer returned.
    ReleaseBlocked = 34,
    /// The fund's NAV feed and its fallback feed disagree by more than the
    /// tolerance set for the fallback.
    PriceDivergence = 35,
    /// No shares are waiting to be released for this repo.
    NothingToRelease = 36,
    /// The fund has no fallback NAV feed.
    NoFallback = 37,
    /// The proposal was not applied within its grace period after the eta;
    /// it is treated as gone and must be proposed again.
    ProposalExpired = 38,
    /// A bounded list kept in instance storage is full: funds with a
    /// fallback feed, or currencies with a pending cap increase.
    LimitReached = 39,
    /// A fund's steward, its issuer, never lends on its fund: it cannot be
    /// approved or attested as a lender there, nor create an offer listing
    /// it, and an approved lender cannot become the fund's steward.
    StewardCannotLend = 40,
    /// The instance runs in sole-lender mode and the caller is not that
    /// lender.
    NotSoleLender = 41,
    /// The lender has no attestation for this fund, signed by itself and the
    /// fund's steward, so the steward cannot approve it.
    AttestationMissing = 42,
    /// A guardian may hand its role over only to the backup it registered
    /// with the governor.
    NotGuardianBackup = 43,
    /// The sole lender can be chosen once, before the first admission and the
    /// first offer, and never changes.
    SoleLenderFixed = 44,
}
