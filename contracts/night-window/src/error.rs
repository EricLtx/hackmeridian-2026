//! Error codes. They are public ABI: add new variants at the end, never
//! renumber or remove one.

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Reserved (version 1).
    NotImplemented = 1,
    /// Fund not in the registry.
    FundNotAccepted = 2,
    /// Haircut out of range.
    InvalidHaircut = 3,
    /// Amount not positive.
    InvalidAmount = 4,
    /// Term out of range.
    InvalidTerm = 5,
    /// No price for the asset.
    NoPrice = 6,
    /// Configuration missing.
    NotInitialized = 7,
    /// New entries suspended.
    Paused = 8,
    /// Stablecoin not in the registry.
    StablecoinNotAccepted = 9,
    /// Currencies differ.
    CurrencyMismatch = 10,
    /// Price too old.
    StalePrice = 11,
    /// NAV outside its corridor.
    PriceOutOfBand = 12,
    /// Principal exceeds the collateral.
    LoanTooLarge = 13,
    OfferNotFound = 14,
    /// Offer holds too little.
    InsufficientOffer = 15,
    RepoNotFound = 16,
    /// Repo already closed.
    RepoNotOpen = 17,
    /// Maturity not reached.
    NotMatured = 18,
    /// A cap would be exceeded.
    CapExceeded = 19,
    /// Fund list empty, duplicated or too long.
    TooManyFunds = 20,
    /// Lender or recipient not approved.
    LenderNotApproved = 21,
    /// Amount received differs.
    TransferMismatch = 22,
    /// Offer refuses this fund.
    FundNotInOffer = 23,
    /// Rate above 10,000 bps.
    InvalidRate = 24,
    /// Overflow or division by zero.
    ArithmeticOverflow = 25,
    /// Outside the envelope.
    OutsideEnvelope = 26,
    /// Fund frozen by its steward.
    FundFrozen = 27,
    /// Price not positive or future.
    InvalidPrice = 28,
    /// Reserved.
    DuplicateFund = 29,
    /// Caller lacks the role.
    Unauthorized = 30,
    /// Delay may only grow.
    DelayCannotDecrease = 31,
    /// No matching proposal.
    NotProposed = 32,
    /// Delay not elapsed.
    TimelockPending = 33,
    /// Reserved (version 3 draft).
    ReleaseBlocked = 34,
    /// NAV feeds disagree.
    PriceDivergence = 35,
    /// No shares awaiting release.
    NothingToRelease = 36,
    /// No fallback feed.
    NoFallback = 37,
    /// Grace period passed.
    ProposalExpired = 38,
    /// Bounded list full.
    LimitReached = 39,
    /// A steward never lends on its fund.
    StewardCannotLend = 40,
    /// Not the sole lender.
    NotSoleLender = 41,
    /// No attestation with this steward.
    AttestationMissing = 42,
    /// Not the registered backup.
    NotGuardianBackup = 43,
    /// Sole lender already fixed.
    SoleLenderFixed = 44,
    /// No or other steward backup.
    NoStewardBackup = 45,
    /// Trustee already named.
    TrusteeFixed = 46,
    /// Trustee holds another role.
    TrusteeNotIndependent = 47,
    /// FX band wider than the FX haircut.
    FxBandExceedsHaircut = 48,
}
