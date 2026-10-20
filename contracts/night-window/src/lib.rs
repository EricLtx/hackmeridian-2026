#![no_std]
//! Open Window (crate `night-window`): a stablecoin liquidity facility for
//! tokenized fund shares on Stellar, built as an on-chain repo contract.
//!
//! A holder of tokenized money market fund shares locks them in the contract
//! and receives stablecoins in the same transaction, for a fixed term at a
//! fixed rate, from offers deposited in advance. The holder repays principal
//! and interest and gets the shares back; after maturity, the lender may
//! seize them instead.
//!
//! Roles (separation of privileges):
//! - governor: upgrade, fund admission, risk envelope, stablecoin registry,
//!   currency caps, guardian; a multisig account in production;
//! - guardian: pauses new entries and vetoes proposals, including a governor
//!   handover; hands its role over only to the backup it registered with
//!   the governor;
//! - steward, one per fund (the issuer's key): approves attested lenders,
//!   tunes its fund inside the envelope, freezes its fund, marks sponsor
//!   offers; never lends on its fund (MMF Regulation, Art. 35); a lost key
//!   is replaced, after 30 days and with the governor and the guardian,
//!   only by the backup the steward named;
//! - trustee (optional, named before anything is at stake, typically the
//!   fund's issuer or an independent trustee): co-signs every upgrade and
//!   forced guardian change and can veto them and a governor handover, so a
//!   lender holding the governor and guardian roles (mode D3) cannot change
//!   the code alone; it hands its role over only to a successor who signs.
//!   A lost trustee key means no upgrade ever: no upgrade without independent
//!   consent (decision S15);
//! - lenders: independent of the fund's steward; in a sole-lender instance,
//!   one lender fixed before anything is at stake;
//! - anyone: refreshes a fund's NAV reference inside the corridor, applies a
//!   change whose time delay has elapsed (a stablecoin registration takes the
//!   current governor), retries a deferred share release.
//!
//! The pause stops new offers and new repos; it never blocks a repurchase, a
//! withdrawal of an offer or a seizure. Upgrades, replacements of an admitted
//! fund and fallback NAV feeds wait for a time delay, during which the
//! guardian can cancel them (decision S7). Security baseline, invariants and
//! decisions: `docs/security.md`.

use soroban_sdk::{
    contract, contractimpl, contractmeta, panic_with_error, Address, BytesN, ContractExecutable,
    Env, Symbol, Vec,
};

mod error;
mod events;
mod math;
mod oracle;
mod storage;
mod token_io;
mod types;

pub use error::Error;
pub use oracle::{OracleClient, Sep40Oracle};
pub use types::{
    AnchorFx, AnchorRate, Asset, DataKey, FallbackFeed, FundConfig, FundState, FxLeg,
    LenderAttestation, Offer, PendingAdminChange, PendingCurrencyCapChange, PendingEnvelopeChange,
    PendingFallback, PendingFundChange, PendingFundLimitsChange, PendingGuardianChange,
    PendingMaxTermChange, PendingReanchor, PendingRelease, PendingStablecoinChange,
    PendingStewardBackup, PendingStewardRecovery, PendingUpgrade, PriceData, PriceSource, Quote,
    Repo, RepoStatus, RiskEnvelope, StablecoinConfig,
};

use events::*;
use math::Bps;

contractmeta!(key = "binver", val = "0.4.0");
contractmeta!(
    key = "desc",
    val = "Open Window: stablecoin liquidity facility for tokenized fund shares (repo)"
);

/// Basis points in one unit: haircuts and rates are expressed out of 10,000.
pub const BPS_DENOMINATOR: u32 = 10_000;
/// Default ceiling for a repo term: seven days, in seconds. Short terms keep
/// the first version free of margin calls.
pub const DEFAULT_MAX_TERM_SECS: u64 = 7 * 24 * 60 * 60;
/// Shortest repo, in seconds (decision S11).
pub const MIN_TERM_SECS: u64 = 60 * 60;
/// Most funds one offer may accept (decision S10).
pub const MAX_FUNDS_PER_OFFER: u32 = 8;
/// Highest ceiling the governor may set for a term: thirty days, well inside
/// the 120 days of TTL every repo entry receives at each write.
pub const MAX_TERM_CEILING_SECS: u64 = 30 * 24 * 60 * 60;
/// Time delay on upgrades and fund changes at deployment: 48 hours, enough
/// for monitoring to alert and the guardian to pause and cancel (S7).
pub const DEFAULT_TIMELOCK_SECS: u64 = 48 * 60 * 60;
/// Shortest delay the governor may set: one minute, for demonstrations.
pub const MIN_TIMELOCK_SECS: u64 = 60;
/// Longest delay: thirty days, the longest term a repo may have. A longer
/// delay would hold an urgent fix back for longer than any repo lasts.
pub const MAX_TIMELOCK_SECS: u64 = 30 * 24 * 60 * 60;
/// How long after its eta a proposal may still be applied: seven days. A
/// forgotten proposal must not be applied by anyone months later, against a
/// situation its signers never saw.
pub const PROPOSAL_GRACE_SECS: u64 = 7 * 24 * 60 * 60;

/// Version of the stored data layout this code expects. An instance deployed
/// before rc4 holds no version entry and is at 1; `migrate` brings it here
/// after an upgrade. Entries (new offers and repos) wait for the migration,
/// exits never do.
pub const SCHEMA_VERSION: u32 = 2;
/// Most funds with an active fallback feed: each one keeps its decimals in
/// instance storage, which every invocation loads.
pub const MAX_FALLBACKS: u32 = 16;
/// Most currencies with a pending cap increase at the same time; they share
/// one instance entry.
pub const MAX_PENDING_CURRENCY_CAPS: u32 = 8;
/// Fewest decimals a NAV or FX feed may publish with (review finding
/// arith-4, 20 October 2026). The corridor and the bands are computed in
/// units of the feed and rounded to whole units: with 2 decimals, a 0.5 %
/// floor around 1.00 rounded out to a whole percent before rc5 and rounds
/// in to nothing since. At 6 decimals one unit of a price near 1 is
/// 0.01 bps.
pub const MIN_FEED_DECIMALS: u32 = 6;
/// Decimals of every stablecoin: those of a Stellar classic asset through
/// its Stellar Asset Contract. Caps and outstanding totals add base units
/// across the stablecoins of a currency, so these must share one precision
/// (review findings arith-3 and token-3, 20 October 2026): a coin with 6
/// decimals would multiply every cap by ten. Normalising units is a later
/// version.
pub const STABLECOIN_DECIMALS: u32 = 7;

/// Envelope at deployment. The governor may tighten or widen it.
pub fn default_envelope() -> RiskEnvelope {
    RiskEnvelope {
        min_haircut_bps: 100,
        min_fx_haircut_bps: 150,
        max_corridor_floor_bps: 50,
        max_yield_bps: 1_000,
        max_nav_age_secs: 3 * 24 * 60 * 60,
        max_fx_age_secs: 3 * 24 * 60 * 60,
        max_fx_band_bps: 500,
    }
}

#[contract]
pub struct OpenWindow;

#[contractimpl]
impl OpenWindow {
    /// Deploys with `admin` as governor and first guardian.
    pub fn __constructor(env: Env, admin: Address) {
        storage::set_governor(&env, &admin);
        storage::set_guardian(&env, &admin);
        storage::set_max_term(&env, DEFAULT_MAX_TERM_SECS);
        storage::set_envelope(&env, &default_envelope());
        storage::set_timelock_delay(&env, DEFAULT_TIMELOCK_SECS);
        storage::set_schema_version(&env, SCHEMA_VERSION);
        env.storage().instance().set(&DataKey::NextOfferId, &1u64);
        env.storage().instance().set(&DataKey::NextRepoId, &1u64);
    }

    // -- Governor -----------------------------------------------------------

    // Interface (ABI): functions, exported types, events and error codes
    // freeze at the tag the external audit reviews; from then on they are
    // append-only (see `types.rs`, `error.rs`). Version 4 is unreleased: the
    // audit candidates (`audit-v4-rc*`) keep `version()` at 4.

    /// Interface version.
    pub fn version() -> u32 {
        4
    }

    /// Stored layout version; 1 before rc4.
    pub fn schema_version(env: Env) -> u32 {
        storage::schema_version(&env)
    }

    /// Brings the stored layout to this code's version after an upgrade.
    /// Governor, and the trustee when named.
    pub fn migrate(env: Env) -> Result<(), Error> {
        let governor = storage::require_governor(&env);
        require_trustee(&env, &governor);
        let from = storage::schema_version(&env);
        if from >= SCHEMA_VERSION {
            return Err(Error::NothingToMigrate);
        }
        // Version 1 to 2: no stored type changed; the version entry is the
        // whole migration. Each later version adds its own step here, run in
        // order, so that any instance can catch up from any earlier layout.
        storage::set_schema_version(&env, SCHEMA_VERSION);
        storage::bump_instance(&env);
        Migrated {
            from,
            to: SCHEMA_VERSION,
        }
        .publish(&env);
        Ok(())
    }

    /// The governor.
    pub fn admin(env: Env) -> Address {
        storage::governor(&env)
    }

    /// Proposes a handover, delayed after the first admission. Governor.
    pub fn set_admin(env: Env, new_admin: Address) {
        let current = storage::require_governor(&env);
        ensure_not_trustee_or_sentinel(&env, &new_admin)
            .unwrap_or_else(|error| panic_with_error!(&env, error));
        let eta = if storage::past_bootstrap(&env) {
            eta(&env).unwrap_or_else(|error| panic_with_error!(&env, error))
        } else {
            env.ledger().timestamp()
        };
        // One pending handover at a time: the version 3 key goes.
        storage::remove_instance(&env, &DataKey::PendingAdmin);
        storage::set_instance(
            &env,
            &DataKey::PendingAdminChange,
            &PendingAdminChange {
                admin: new_admin.clone(),
                eta,
            },
        );
        storage::bump_instance(&env);
        AdminProposed {
            current,
            proposed: new_admin.clone(),
        }
        .publish(&env);
        AdminChangeProposed {
            admin: new_admin,
            eta,
        }
        .publish(&env);
    }

    /// Completes a due handover. Proposed governor.
    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let pending = pending_admin_change(&env).ok_or(Error::Unauthorized)?;
        pending.admin.require_auth();
        ensure_due(&env, pending.eta)?;
        let previous = storage::governor(&env);
        storage::set_governor(&env, &pending.admin);
        storage::next_governance_generation(&env);
        remove_pending_admin(&env);
        drop_governor_proposals(&env, &pending.admin);
        storage::bump_instance(&env);
        AdminChanged {
            previous,
            admin: pending.admin,
        }
        .publish(&env);
        Ok(())
    }

    /// Withdraws the handover. Governor.
    pub fn cancel_admin(env: Env) -> Result<(), Error> {
        let governor = storage::require_governor(&env);
        drop_pending_admin(&env, &governor)
    }

    // A hostile guardian that vetoes every handover is answered by
    // `force_guardian_change` (with the trustee's consent, when one is
    // named): complete it before handing the governor over.

    /// Vetoes it; guardian, governor or trustee.
    pub fn veto_admin(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        if !is_governor_or_guardian(&env, &caller) && !is_trustee(&env, &caller) {
            return Err(Error::Unauthorized);
        }
        drop_pending_admin(&env, &caller)
    }

    /// The handover, if live.
    pub fn pending_admin(env: Env) -> Option<PendingAdminChange> {
        pending_admin_change(&env).filter(|p| is_live(&env, p.eta))
    }

    /// Delay of governed changes, seconds.
    pub fn timelock_delay(env: Env) -> u64 {
        storage::timelock_delay(&env, DEFAULT_TIMELOCK_SECS)
    }

    /// Sets the delay; it only grows after admission. Governor.
    pub fn set_timelock_delay(env: Env, delay: u64) -> Result<(), Error> {
        storage::require_governor(&env);
        if !(MIN_TIMELOCK_SECS..=MAX_TIMELOCK_SECS).contains(&delay) {
            return Err(Error::OutsideEnvelope);
        }
        if storage::past_bootstrap(&env)
            && delay < storage::timelock_delay(&env, DEFAULT_TIMELOCK_SECS)
        {
            return Err(Error::DelayCannotDecrease);
        }
        storage::set_timelock_delay(&env, delay);
        storage::bump_instance(&env);
        TimelockDelayChanged { delay }.publish(&env);
        Ok(())
    }

    /// Proposes code, applicable after the delay. Governor, trustee if named.
    pub fn propose_upgrade(env: Env, wasm_hash: BytesN<32>) -> Result<(), Error> {
        let governor = storage::require_governor(&env);
        require_trustee(&env, &governor);
        let eta = eta(&env)?;
        storage::set_pending_upgrade(
            &env,
            &PendingUpgrade {
                wasm_hash: wasm_hash.clone(),
                eta,
            },
        );
        storage::bump_instance(&env);
        UpgradeProposed { wasm_hash, eta }.publish(&env);
        Ok(())
    }

    /// The upgrade, if live.
    pub fn pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        storage::pending_upgrade(&env).filter(|p| is_live(&env, p.eta))
    }

    /// Withdraws it; governor, guardian or trustee.
    pub fn cancel_upgrade(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        if !may_cancel(&env, &caller) && !is_trustee(&env, &caller) {
            return Err(Error::Unauthorized);
        }
        let pending = storage::pending_upgrade(&env).ok_or(Error::NotProposed)?;
        storage::remove_pending_upgrade(&env);
        storage::bump_instance(&env);
        UpgradeCancelled {
            wasm_hash: pending.wasm_hash,
            by: caller,
        }
        .publish(&env);
        Ok(())
    }

    /// Installs the due WASM. Governor.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        storage::require_governor(&env);
        if let Err(error) = take_due_upgrade(&env, &new_wasm_hash) {
            panic_with_error!(&env, error);
        }
        storage::bump_instance(&env);
        Upgraded {
            wasm_hash: new_wasm_hash.clone(),
        }
        .publish(&env);
        env.deployer()
            .update_current_contract(ContractExecutable::Wasm(new_wasm_hash));
    }

    pub fn max_term(env: Env) -> u64 {
        storage::max_term(&env, DEFAULT_MAX_TERM_SECS)
    }

    /// Sets the term ceiling; increases wait after admission. Governor.
    pub fn set_max_term(env: Env, max_term: u64) -> Result<(), Error> {
        let governor = storage::require_governor(&env);
        if !(MIN_TERM_SECS..=MAX_TERM_CEILING_SECS).contains(&max_term) {
            return Err(Error::InvalidTerm);
        }
        if storage::past_bootstrap(&env) && max_term > Self::max_term(env.clone()) {
            let eta = eta(&env)?;
            storage::set_instance(
                &env,
                &DataKey::PendingMaxTerm,
                &PendingMaxTermChange { max_term, eta },
            );
            storage::bump_instance(&env);
            MaxTermChangeProposed { max_term, eta }.publish(&env);
            return Ok(());
        }
        drop_pending_max_term(&env, &governor);
        install_max_term(&env, max_term);
        Ok(())
    }

    /// Applies a due increase. Anyone.
    pub fn apply_max_term_change(env: Env) -> Result<(), Error> {
        let pending: PendingMaxTermChange =
            storage::instance_value(&env, &DataKey::PendingMaxTerm).ok_or(Error::NotProposed)?;
        ensure_due(&env, pending.eta)?;
        storage::remove_instance(&env, &DataKey::PendingMaxTerm);
        install_max_term(&env, pending.max_term);
        Ok(())
    }

    /// Withdraws it; governor or guardian.
    pub fn cancel_max_term_change(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        if !may_cancel(&env, &caller) {
            return Err(Error::Unauthorized);
        }
        if !drop_pending_max_term(&env, &caller) {
            return Err(Error::NotProposed);
        }
        storage::bump_instance(&env);
        Ok(())
    }

    /// The increase, if live.
    pub fn pending_max_term_change(env: Env) -> Option<PendingMaxTermChange> {
        storage::instance_value::<PendingMaxTermChange>(&env, &DataKey::PendingMaxTerm)
            .filter(|p| is_live(&env, p.eta))
    }

    pub fn guardian(env: Env) -> Address {
        storage::guardian(&env)
    }

    /// Appoints the guardian, delayed after admission. Governor.
    pub fn set_guardian(env: Env, guardian: Address) {
        storage::require_governor(&env);
        ensure_not_trustee_or_sentinel(&env, &guardian)
            .unwrap_or_else(|error| panic_with_error!(&env, error));
        if !storage::past_bootstrap(&env) {
            install_guardian(&env, guardian);
            return;
        }
        let eta = eta(&env).unwrap_or_else(|error| panic_with_error!(&env, error));
        storage::set_instance(
            &env,
            &DataKey::PendingGuardian,
            &PendingGuardianChange {
                guardian: guardian.clone(),
                eta,
            },
        );
        storage::bump_instance(&env);
        GuardianChangeProposed { guardian, eta }.publish(&env);
    }

    /// Applies a due appointment. Anyone.
    pub fn apply_guardian_change(env: Env) -> Result<(), Error> {
        let pending: PendingGuardianChange =
            storage::instance_value(&env, &DataKey::PendingGuardian).ok_or(Error::NotProposed)?;
        ensure_due(&env, pending.eta)?;
        // Checked again at the apply: before rc5 a proposed guardian could
        // still be named trustee or sentinel during the delay (review
        // finding auth-5, 20 October 2026).
        ensure_not_trustee_or_sentinel(&env, &pending.guardian)?;
        storage::remove_instance(&env, &DataKey::PendingGuardian);
        drop_pending_forced_guardian(&env, &env.current_contract_address());
        install_guardian(&env, pending.guardian);
        Ok(())
    }

    /// Withdraws it; governor or guardian.
    pub fn cancel_guardian_change(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        if !may_cancel(&env, &caller) {
            return Err(Error::Unauthorized);
        }
        if !drop_pending_guardian(&env, &caller) {
            return Err(Error::NotProposed);
        }
        storage::bump_instance(&env);
        Ok(())
    }

    /// The appointment, if live.
    pub fn pending_guardian_change(env: Env) -> Option<PendingGuardianChange> {
        storage::instance_value::<PendingGuardianChange>(&env, &DataKey::PendingGuardian)
            .filter(|p| is_live(&env, p.eta))
    }

    /// Hands the role to the backup, at once. Guardian.
    pub fn hand_over_guardian(env: Env, guardian: Address) {
        let current = storage::guardian(&env);
        current.require_auth();
        ensure_not_trustee_or_sentinel(&env, &guardian)
            .unwrap_or_else(|error| panic_with_error!(&env, error));
        let allowed = match storage::guardian_backup(&env) {
            Some(backup) => backup == guardian,
            None => current == storage::governor(&env),
        };
        if !allowed {
            panic_with_error!(&env, Error::NotGuardianBackup);
        }
        install_guardian(&env, guardian);
    }

    /// Registers the backup. Governor and guardian.
    pub fn set_guardian_backup(env: Env, backup: Address) {
        let governor = storage::require_governor(&env);
        ensure_not_trustee_or_sentinel(&env, &backup)
            .unwrap_or_else(|error| panic_with_error!(&env, error));
        let guardian = storage::guardian(&env);
        if guardian != governor {
            guardian.require_auth();
        }
        storage::set_guardian_backup(&env, &backup);
        storage::bump_instance(&env);
        GuardianBackupSet { backup }.publish(&env);
    }

    /// The backup, if any.
    pub fn guardian_backup(env: Env) -> Option<Address> {
        storage::guardian_backup(&env)
    }

    /// Imposes a guardian after the longest delay. Governor, trustee if named.
    pub fn force_guardian_change(env: Env, guardian: Address) {
        let governor = storage::require_governor(&env);
        ensure_not_trustee_or_sentinel(&env, &guardian)
            .unwrap_or_else(|error| panic_with_error!(&env, error));
        require_trustee(&env, &governor);
        let eta = env
            .ledger()
            .timestamp()
            .checked_add(MAX_TIMELOCK_SECS)
            .unwrap_or_else(|| panic_with_error!(&env, Error::ArithmeticOverflow));
        storage::set_instance(
            &env,
            &DataKey::PendingForcedGuardian,
            &PendingGuardianChange {
                guardian: guardian.clone(),
                eta,
            },
        );
        storage::bump_instance(&env);
        GuardianChangeForced { guardian, eta }.publish(&env);
    }

    /// Applies a due forced change. Anyone.
    pub fn apply_forced_guardian_change(env: Env) -> Result<(), Error> {
        let pending: PendingGuardianChange =
            storage::instance_value(&env, &DataKey::PendingForcedGuardian)
                .ok_or(Error::NotProposed)?;
        ensure_due(&env, pending.eta)?;
        storage::remove_instance(&env, &DataKey::PendingForcedGuardian);
        install_guardian(&env, pending.guardian);
        Ok(())
    }

    /// Withdraws it. Governor only.
    pub fn cancel_forced_guardian_change(env: Env) -> Result<(), Error> {
        let governor = storage::require_governor(&env);
        if !drop_pending_forced_guardian(&env, &governor) {
            return Err(Error::NotProposed);
        }
        storage::bump_instance(&env);
        Ok(())
    }

    /// The forced change, if live.
    pub fn pending_forced_guardian_change(env: Env) -> Option<PendingGuardianChange> {
        storage::instance_value::<PendingGuardianChange>(&env, &DataKey::PendingForcedGuardian)
            .filter(|p| is_live(&env, p.eta))
    }

    /// Withdraws it; governor or trustee.
    pub fn veto_forced_guardian_change(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        if caller != storage::governor(&env) && !is_trustee(&env, &caller) {
            return Err(Error::Unauthorized);
        }
        if !drop_pending_forced_guardian(&env, &caller) {
            return Err(Error::NotProposed);
        }
        storage::bump_instance(&env);
        Ok(())
    }

    // -- Trustee ----------------------------------------------------------------

    // A lost trustee key blocks every upgrade and forced guardian change for
    // good: that is the point, no upgrade without independent consent. The
    // trustee should be an account whose signers rotate (native multisig).

    /// Names the trustee once, before stakes. Governor and trustee.
    pub fn set_trustee(env: Env, trustee: Address) -> Result<(), Error> {
        storage::require_governor(&env);
        if storage::past_bootstrap(&env) || storage::trustee(&env).is_some() {
            return Err(Error::TrusteeFixed);
        }
        ensure_independent_trustee(&env, &trustee)?;
        trustee.require_auth();
        let by = env.current_contract_address();
        drop_pending_upgrade(&env, &by);
        drop_pending_forced_guardian(&env, &by);
        storage::set_trustee(&env, &trustee);
        storage::bump_instance(&env);
        TrusteeSet { trustee }.publish(&env);
        Ok(())
    }

    /// Passes the role, at once. Both trustees.
    pub fn hand_over_trustee(env: Env, trustee: Address) -> Result<(), Error> {
        let previous = storage::trustee(&env).ok_or(Error::Unauthorized)?;
        previous.require_auth();
        ensure_independent_trustee(&env, &trustee)?;
        trustee.require_auth();
        // Second review of rc2, M1: what the previous trustee co-signed must
        // not apply under the new one without its consent (a hand-over is
        // often the answer to a stolen key).
        let by = env.current_contract_address();
        drop_pending_upgrade(&env, &by);
        drop_pending_forced_guardian(&env, &by);
        storage::set_trustee(&env, &trustee);
        storage::bump_instance(&env);
        TrusteeChanged { previous, trustee }.publish(&env);
        Ok(())
    }

    /// The trustee, if named.
    pub fn trustee(env: Env) -> Option<Address> {
        storage::trustee(&env)
    }

    pub fn envelope(env: Env) -> RiskEnvelope {
        storage::envelope(&env)
    }

    /// Sets the envelope; loosenings wait after admission. Governor.
    pub fn set_envelope(env: Env, envelope: RiskEnvelope) -> Result<(), Error> {
        let governor = storage::require_governor(&env);
        check_envelope(&envelope)?;
        if storage::past_bootstrap(&env) && !tightens(&envelope, &storage::envelope(&env)) {
            let eta = eta(&env)?;
            storage::set_instance(
                &env,
                &DataKey::PendingEnvelope,
                &PendingEnvelopeChange {
                    envelope: envelope.clone(),
                    eta,
                },
            );
            storage::bump_instance(&env);
            EnvelopeChangeProposed { envelope, eta }.publish(&env);
            return Ok(());
        }
        drop_pending_envelope(&env, &governor);
        install_envelope(&env, envelope);
        Ok(())
    }

    /// Applies a due envelope. Anyone.
    pub fn apply_envelope_change(env: Env) -> Result<(), Error> {
        let pending: PendingEnvelopeChange =
            storage::instance_value(&env, &DataKey::PendingEnvelope).ok_or(Error::NotProposed)?;
        ensure_due(&env, pending.eta)?;
        check_envelope(&pending.envelope)?;
        storage::remove_instance(&env, &DataKey::PendingEnvelope);
        install_envelope(&env, pending.envelope);
        Ok(())
    }

    /// Withdraws it; governor or guardian.
    pub fn cancel_envelope_change(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        if !may_cancel(&env, &caller) {
            return Err(Error::Unauthorized);
        }
        if !drop_pending_envelope(&env, &caller) {
            return Err(Error::NotProposed);
        }
        storage::bump_instance(&env);
        Ok(())
    }

    /// The envelope, if live.
    pub fn pending_envelope_change(env: Env) -> Option<PendingEnvelopeChange> {
        storage::instance_value::<PendingEnvelopeChange>(&env, &DataKey::PendingEnvelope)
            .filter(|p| is_live(&env, p.eta))
    }

    /// Registers a 7-decimal stablecoin; after the first admission,
    /// proposes it for the delay. Governor.
    pub fn set_stablecoin(env: Env, stablecoin: Address, currency: Symbol) {
        storage::require_governor(&env);
        // The signature predates the delay and the decimals rule, so the
        // failures are raised the way `set_admin` raises. A coin the
        // registry would refuse is refused at once, not after the delay.
        let decimals = match check_stablecoin_decimals(&env, &stablecoin) {
            Ok(decimals) => decimals,
            Err(error) => panic_with_error!(&env, error),
        };
        if storage::past_bootstrap(&env) {
            // A new stablecoin, or a new currency for a registered one,
            // widens what lenders may be repaid in: it waits like any other
            // loosening (decision S7).
            let eta = match eta(&env) {
                Ok(eta) => eta,
                Err(error) => panic_with_error!(&env, error),
            };
            storage::set_pending_stablecoin(
                &env,
                &stablecoin,
                &PendingStablecoinChange {
                    currency: currency.clone(),
                    eta,
                },
            );
            storage::bump_instance(&env);
            StablecoinChangeProposed {
                stablecoin,
                currency,
                eta,
            }
            .publish(&env);
            return;
        }
        install_stablecoin(&env, stablecoin, currency, decimals);
    }

    /// Applies a proposed stablecoin once its delay has elapsed. Governor.
    pub fn apply_stablecoin_change(env: Env, stablecoin: Address) -> Result<(), Error> {
        // The current governor, not anyone (review finding auth-3, 20
        // October 2026): these proposals are kept per token, so a governor
        // handover cannot enumerate and drop them. One made by a replaced
        // governor then applies only if its successor takes it up.
        storage::require_governor(&env);
        let pending = storage::pending_stablecoin(&env, &stablecoin).ok_or(Error::NotProposed)?;
        ensure_due(&env, pending.eta)?;
        // Checked again: a proposal made before rc5 was not, and a token's
        // code may change during the delay.
        let decimals = check_stablecoin_decimals(&env, &stablecoin)?;
        storage::remove_pending_stablecoin(&env, &stablecoin);
        install_stablecoin(&env, stablecoin, pending.currency, decimals);
        Ok(())
    }

    /// Withdraws a proposed stablecoin. Governor, guardian or sentinel.
    pub fn cancel_stablecoin_change(
        env: Env,
        stablecoin: Address,
        caller: Address,
    ) -> Result<(), Error> {
        caller.require_auth();
        if !may_cancel(&env, &caller) {
            return Err(Error::Unauthorized);
        }
        if !storage::remove_pending_stablecoin(&env, &stablecoin) {
            return Err(Error::NotProposed);
        }
        storage::bump_instance(&env);
        StablecoinChangeCancelled {
            stablecoin,
            by: caller,
        }
        .publish(&env);
        Ok(())
    }

    /// The proposed registration of a stablecoin, unless it has expired.
    pub fn pending_stablecoin_change(
        env: Env,
        stablecoin: Address,
    ) -> Option<PendingStablecoinChange> {
        storage::pending_stablecoin(&env, &stablecoin).filter(|p| is_live(&env, p.eta))
    }

    /// Removes a stablecoin and drops its pending proposal; exits go on.
    /// Governor.
    pub fn remove_stablecoin(env: Env, stablecoin: Address) -> Result<(), Error> {
        storage::require_governor(&env);
        storage::remove_pending_stablecoin(&env, &stablecoin);
        storage::remove_stablecoin(&env, &stablecoin)?;
        StablecoinRemoved { stablecoin }.publish(&env);
        Ok(())
    }

    pub fn get_stablecoin(env: Env, stablecoin: Address) -> Option<StablecoinConfig> {
        storage::stablecoin(&env, &stablecoin).ok()
    }

    /// Caps a currency; increases wait after admission. Governor.
    pub fn set_currency_cap(env: Env, currency: Symbol, cap: i128) -> Result<(), Error> {
        let governor = storage::require_governor(&env);
        if cap < 0 {
            return Err(Error::InvalidAmount);
        }
        if storage::past_bootstrap(&env) && cap > storage::currency_cap(&env, &currency) {
            let mut pending = storage::pending_currency_caps(&env);
            // Expired proposals are gone: they must not hold a slot.
            // Bounded by MAX_PENDING_CURRENCY_CAPS.
            for (other, change) in pending.clone().iter() {
                if !is_live(&env, change.eta) {
                    pending.remove(other);
                }
            }
            if !pending.contains_key(currency.clone()) && pending.len() >= MAX_PENDING_CURRENCY_CAPS
            {
                return Err(Error::LimitReached);
            }
            let eta = eta(&env)?;
            pending.set(currency.clone(), PendingCurrencyCapChange { cap, eta });
            storage::set_pending_currency_caps(&env, &pending);
            storage::bump_instance(&env);
            CurrencyCapChangeProposed { currency, cap, eta }.publish(&env);
            return Ok(());
        }
        drop_pending_currency_cap(&env, &currency, &governor);
        install_currency_cap(&env, currency, cap);
        Ok(())
    }

    /// Applies a due increase. Anyone.
    pub fn apply_currency_cap_change(env: Env, currency: Symbol) -> Result<(), Error> {
        let mut pending = storage::pending_currency_caps(&env);
        let change = pending.get(currency.clone()).ok_or(Error::NotProposed)?;
        ensure_due(&env, change.eta)?;
        pending.remove(currency.clone());
        storage::set_pending_currency_caps(&env, &pending);
        install_currency_cap(&env, currency, change.cap);
        Ok(())
    }

    /// Withdraws it; governor or guardian.
    pub fn cancel_currency_cap_change(
        env: Env,
        currency: Symbol,
        caller: Address,
    ) -> Result<(), Error> {
        caller.require_auth();
        if !may_cancel(&env, &caller) {
            return Err(Error::Unauthorized);
        }
        if !drop_pending_currency_cap(&env, &currency, &caller) {
            return Err(Error::NotProposed);
        }
        storage::bump_instance(&env);
        Ok(())
    }

    /// The increase, if live.
    pub fn pending_currency_cap_change(
        env: Env,
        currency: Symbol,
    ) -> Option<PendingCurrencyCapChange> {
        storage::pending_currency_caps(&env)
            .get(currency)
            .filter(|p| is_live(&env, p.eta))
    }

    pub fn currency_cap(env: Env, currency: Symbol) -> i128 {
        storage::currency_cap(&env, &currency)
    }

    pub fn currency_outstanding(env: Env, currency: Symbol) -> i128 {
        storage::currency_outstanding(&env, &currency)
    }

    // The sole lender can never change: it must be an account whose signers
    // rotate (native multisig or smart account), never a bare key.

    /// Fixes the only lender once, before stakes. Governor.
    pub fn set_sole_lender(env: Env, lender: Address) -> Result<(), Error> {
        storage::require_governor(&env);
        if storage::past_bootstrap(&env) || storage::sole_lender(&env).is_some() {
            return Err(Error::SoleLenderFixed);
        }
        ensure_not_trustee_or_sentinel(&env, &lender)?;
        storage::set_sole_lender(&env, &lender);
        storage::bump_instance(&env);
        SoleLenderSet { lender }.publish(&env);
        Ok(())
    }

    /// The sole lender, if any.
    pub fn sole_lender(env: Env) -> Option<Address> {
        storage::sole_lender(&env)
    }

    /// Admits a fund at once, or queues a replacement. Governor and steward.
    pub fn set_fund(env: Env, fund: Address, config: FundConfig) -> Result<(), Error> {
        storage::require_governor(&env);
        config.steward.require_auth();
        if let Some(on_record) = storage::steward_on_record(&env, &fund) {
            if on_record != config.steward {
                on_record.require_auth();
            }
            // Either way the steward on record signed.
            steward_alive(&env, &fund, &on_record);
        }
        let previous = storage::fund_state(&env, &fund).ok();
        let admitted = storage::has_fund(&env, &fund);
        let state = prepare_fund(&env, &fund, &config, admitted, None)?;
        if let Some(previous) = previous {
            let fx_anchor = if previous.reference_fx == 0 {
                state.reference_fx
            } else {
                0
            };
            if !admitted && storage::pending_fund_change(&env, &fund).is_some() {
                // A removed fund's re-anchor was read from the re-admission
                // this proposal replaces.
                drop_pending_reanchor(&env, &fund, &storage::governor(&env));
            }
            let eta = eta(&env)?;
            storage::set_pending_fund_change(
                &env,
                &fund,
                &PendingFundChange {
                    config,
                    fx_anchor,
                    eta,
                },
            );
            mark_funds_admitted(&env);
            storage::bump_instance(&env);
            FundChangeProposed { fund, eta }.publish(&env);
            return Ok(());
        }
        install_fund(&env, fund, config, state);
        Ok(())
    }

    /// Applies a due replacement, rechecked. Anyone.
    pub fn apply_fund_change(env: Env, fund: Address) -> Result<(), Error> {
        let pending = storage::pending_fund_change(&env, &fund).ok_or(Error::NotProposed)?;
        ensure_due(&env, pending.eta)?;
        let anchor = (pending.fx_anchor > 0).then_some(pending.fx_anchor);
        let state = prepare_fund(&env, &fund, &pending.config, true, anchor)?;
        storage::remove_pending_fund_change(&env, &fund);
        install_fund(&env, fund, pending.config, state);
        Ok(())
    }

    /// Withdraws it; governor, guardian or steward.
    pub fn cancel_fund_change(env: Env, fund: Address, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        let steward = is_steward(&env, &fund, &caller);
        if !may_cancel(&env, &caller) && !steward {
            return Err(Error::Unauthorized);
        }
        if storage::pending_fund_change(&env, &fund).is_none() {
            return Err(Error::NotProposed);
        }
        if steward {
            steward_alive(&env, &fund, &caller);
        }
        storage::remove_pending_fund_change(&env, &fund);
        // A removed fund's re-anchor was read from the re-admission being
        // cancelled. An admitted fund's re-anchor was read from its current
        // feeds, which this cancellation does not touch, and stays.
        if !storage::has_fund(&env, &fund) {
            drop_pending_reanchor(&env, &fund, &caller);
        }
        storage::bump_instance(&env);
        FundChangeCancelled { fund, by: caller }.publish(&env);
        Ok(())
    }

    /// The replacement, if live.
    pub fn pending_fund_change(env: Env, fund: Address) -> Option<PendingFundChange> {
        storage::pending_fund_change(&env, &fund).filter(|p| is_live(&env, p.eta))
    }

    /// Removes a fund; open repos go on. Governor.
    pub fn remove_fund(env: Env, fund: Address) -> Result<(), Error> {
        let governor = storage::require_governor(&env);
        let config = storage::fund(&env, &fund)?;
        storage::set_last_steward(&env, &fund, &config.steward);
        storage::remove_fund(&env, &fund);
        drop_pending_reanchor(&env, &fund, &governor);
        drop_pending_fund_change(&env, &fund, &governor);
        drop_pending_fund_limits(&env, &fund, &governor);
        if storage::pending_fallback(&env, &fund).is_some() {
            storage::remove_pending_fallback(&env, &fund);
            FallbackCancelled {
                fund: fund.clone(),
                by: governor.clone(),
            }
            .publish(&env);
        }
        if storage::fallback(&env, &fund).is_some() {
            storage::remove_fallback(&env, &fund);
            FallbackRemoved {
                fund: fund.clone(),
                by: governor,
            }
            .publish(&env);
        }
        storage::bump_instance(&env);
        FundRemoved { fund }.publish(&env);
        Ok(())
    }

    // -- Steward recovery -----------------------------------------------------

    // Replacing a backup waits so that a stolen steward key cannot swap it
    // under a recovery: the governor sees the proposal and cancels it, and a
    // recovery proposed meanwhile drops it.

    /// Names the successor; replacing it waits. Steward and backup.
    pub fn set_steward_backup(env: Env, fund: Address, backup: Address) -> Result<(), Error> {
        let steward = storage::steward_on_record(&env, &fund).ok_or(Error::FundNotAccepted)?;
        steward.require_auth();
        // A mistyped address would leave the fund unrecoverable.
        backup.require_auth();
        if storage::lender_approved(&env, &fund, &backup) {
            return Err(Error::StewardCannotLend);
        }
        steward_alive(&env, &fund, &steward);
        match storage::steward_backup(&env, &fund) {
            Some(current) if current != backup => {
                let eta = eta(&env)?;
                storage::set_pending_steward_backup(
                    &env,
                    &fund,
                    &PendingStewardBackup {
                        backup: backup.clone(),
                        steward,
                        eta,
                    },
                );
                StewardBackupChangeProposed { fund, backup, eta }.publish(&env);
            }
            _ => {
                drop_pending_steward_backup(&env, &fund, &steward);
                install_steward_backup(&env, fund, backup);
            }
        }
        storage::bump_instance(&env);
        Ok(())
    }

    // A replacement never meets a recovery: proposing one is a steward
    // action, which cancels a recovery, and proposing a recovery drops it.
    // Nor does it outlive its steward: a rotation or a recovery drops it.

    /// Applies a due replacement. Anyone.
    pub fn apply_steward_backup_change(env: Env, fund: Address) -> Result<(), Error> {
        let pending = storage::pending_steward_backup(&env, &fund).ok_or(Error::NotProposed)?;
        // Second review of rc2, L2: the proposer must still be the steward on
        // record (a rotation or a recovery drops the proposal; this pins it).
        if storage::steward_on_record(&env, &fund) != Some(pending.steward) {
            return Err(Error::NotProposed);
        }
        ensure_due(&env, pending.eta)?;
        if storage::lender_approved(&env, &fund, &pending.backup) {
            return Err(Error::StewardCannotLend);
        }
        storage::remove_pending_steward_backup(&env, &fund);
        install_steward_backup(&env, fund, pending.backup);
        storage::bump_instance(&env);
        Ok(())
    }

    /// Withdraws it; steward or governor.
    pub fn cancel_steward_backup_change(
        env: Env,
        fund: Address,
        caller: Address,
    ) -> Result<(), Error> {
        caller.require_auth();
        let steward = is_steward(&env, &fund, &caller);
        if !steward && caller != storage::governor(&env) {
            return Err(Error::Unauthorized);
        }
        if !drop_pending_steward_backup(&env, &fund, &caller) {
            return Err(Error::NotProposed);
        }
        if steward {
            steward_alive(&env, &fund, &caller);
        }
        storage::bump_instance(&env);
        Ok(())
    }

    /// The backup, if any.
    pub fn steward_backup(env: Env, fund: Address) -> Option<Address> {
        storage::steward_backup(&env, &fund)
    }

    /// The replacement, if live.
    pub fn pending_steward_backup(env: Env, fund: Address) -> Option<PendingStewardBackup> {
        storage::pending_steward_backup(&env, &fund).filter(|p| is_live(&env, p.eta))
    }

    // Recovery answers a lost steward key. A stolen one is answered at once
    // by `remove_fund`: the fund then cannot return without its issuer.

    /// Proposes the backup for a lost steward key. Governor and guardian.
    pub fn propose_steward_recovery(
        env: Env,
        fund: Address,
        new_steward: Address,
    ) -> Result<(), Error> {
        let governor = storage::require_governor(&env);
        let guardian = storage::guardian(&env);
        // One key holding both roles must not replace an issuer on its own.
        if guardian == governor {
            return Err(Error::Unauthorized);
        }
        guardian.require_auth();
        let previous = storage::steward_on_record(&env, &fund).ok_or(Error::FundNotAccepted)?;
        if storage::steward_backup_extending(&env, &fund) != Some(new_steward.clone()) {
            return Err(Error::NoStewardBackup);
        }
        if storage::lender_approved(&env, &fund, &new_steward) {
            return Err(Error::StewardCannotLend);
        }
        let eta = env
            .ledger()
            .timestamp()
            .checked_add(MAX_TIMELOCK_SECS)
            .ok_or(Error::ArithmeticOverflow)?;
        drop_pending_steward_backup(&env, &fund, &governor);
        storage::set_pending_steward_recovery(
            &env,
            &fund,
            &PendingStewardRecovery {
                steward: new_steward.clone(),
                previous,
                generation: storage::governance_generation(&env),
                eta,
            },
        );
        storage::bump_instance(&env);
        StewardRecoveryProposed {
            fund,
            steward: new_steward,
            eta,
        }
        .publish(&env);
        Ok(())
    }

    /// Installs the backup once due (it signs); false drops a dead proposal.
    pub fn apply_steward_recovery(env: Env, fund: Address) -> Result<bool, Error> {
        let pending = storage::pending_steward_recovery(&env, &fund).ok_or(Error::NotProposed)?;
        if env.ledger().timestamp() < pending.eta {
            return Err(Error::TimelockPending);
        }
        // A dead proposal is removed rather than left to archive; returning
        // an error would roll the removal back.
        if !recovery_can_apply(&env, &fund, &pending) {
            storage::remove_pending_steward_recovery(&env, &fund);
            StewardRecoveryCancelled {
                fund,
                by: env.current_contract_address(),
            }
            .publish(&env);
            return Ok(false);
        }
        pending.steward.require_auth();
        let previous = pending.previous.clone();
        // An approval may have been granted during the thirty days.
        if storage::lender_approved(&env, &fund, &pending.steward) {
            return Err(Error::StewardCannotLend);
        }
        storage::remove_pending_steward_recovery(&env, &fund);
        let by = env.current_contract_address();
        drop_pending_fund_change(&env, &fund, &by);
        drop_pending_fund_limits(&env, &fund, &by);
        drop_pending_reanchor(&env, &fund, &by);
        drop_pending_fallback(&env, &fund, &by);
        if let Ok(mut config) = storage::fund(&env, &fund) {
            config.steward = pending.steward.clone();
            storage::set_fund(&env, &fund, &config);
        }
        storage::set_last_steward(&env, &fund, &pending.steward);
        storage::remove_steward_backup(&env, &fund);
        drop_pending_steward_backup(&env, &fund, &by);
        storage::bump_instance(&env);
        StewardRecovered {
            fund,
            previous,
            steward: pending.steward,
        }
        .publish(&env);
        Ok(true)
    }

    /// Withdraws it; steward on record or governor.
    pub fn cancel_steward_recovery(env: Env, fund: Address, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        if caller != storage::governor(&env) && !is_steward(&env, &fund, &caller) {
            return Err(Error::Unauthorized);
        }
        if storage::pending_steward_recovery(&env, &fund).is_none() {
            return Err(Error::NotProposed);
        }
        storage::remove_pending_steward_recovery(&env, &fund);
        storage::bump_instance(&env);
        StewardRecoveryCancelled { fund, by: caller }.publish(&env);
        Ok(())
    }

    /// The recovery, if it can still apply.
    pub fn pending_steward_recovery(env: Env, fund: Address) -> Option<PendingStewardRecovery> {
        storage::pending_steward_recovery(&env, &fund)
            .filter(|p| recovery_can_apply(&env, &fund, p))
    }

    // -- Re-anchoring ---------------------------------------------------------

    /// Proposes references near the signed values. Governor and steward.
    pub fn propose_reanchor(
        env: Env,
        fund: Address,
        expected_nav: i128,
        expected_fx: i128,
    ) -> Result<(), Error> {
        let governor = storage::require_governor(&env);
        let steward = storage::steward_on_record(&env, &fund).ok_or(Error::FundNotAccepted)?;
        if steward != governor {
            steward.require_auth();
        }
        steward_alive(&env, &fund, &steward);
        let config = pricing_config(&env, &fund)?;
        let (nav, fx) = read_anchor(&env, &fund, &config)?;
        let nav_value = nav.price.mantissa();
        let eta = eta(&env)?;
        // Values the apply will compute with must not overflow there: try
        // the same arithmetic on them now, with the growth the apply may
        // count at the latest, at the end of the grace period.
        math::within_band(nav_value, nav_value, config.corridor_floor_bps)?;
        math::corridor(
            nav_value,
            nav.timestamp,
            eta.saturating_add(PROPOSAL_GRACE_SECS),
            config.corridor_floor_bps,
            config.max_yield_bps,
            u64::MAX,
        )?;
        if !math::within_band(nav_value, expected_nav, config.corridor_floor_bps)? {
            return Err(Error::PriceOutOfBand);
        }
        let fx = match (&config.source, fx) {
            (PriceSource::Cross(leg), Some(rate)) => {
                let value = rate.price.mantissa();
                math::within_band(value, value, leg.band_bps)?;
                if !math::within_band(value, expected_fx, leg.band_bps)? {
                    return Err(Error::PriceOutOfBand);
                }
                AnchorFx::Cross(AnchorRate {
                    oracle: leg.oracle.clone(),
                    asset: leg.asset.clone(),
                    rate: value,
                    decimals: rate.price.decimals(),
                })
            }
            // A fund priced directly has no rate: any other expectation
            // means the signers looked at another configuration.
            _ if expected_fx != 0 => return Err(Error::PriceOutOfBand),
            _ => AnchorFx::Direct,
        };
        let pending = PendingReanchor {
            nav_oracle: config.oracle.clone(),
            nav_asset: config.oracle_asset.clone(),
            nav: nav_value,
            nav_time: nav.timestamp,
            nav_decimals: nav.price.decimals(),
            fx,
            eta,
        };
        storage::set_pending_reanchor(&env, &fund, &pending);
        storage::bump_instance(&env);
        ReanchorProposed {
            fund,
            nav: pending.nav,
            nav_time: pending.nav_time,
            fx: pending.fx.rate().map_or(0, |anchor| anchor.rate),
            eta,
        }
        .publish(&env);
        Ok(())
    }

    /// Installs due references if the feeds still agree. Anyone.
    pub fn apply_reanchor(env: Env, fund: Address) -> Result<(), Error> {
        let pending = storage::pending_reanchor(&env, &fund).ok_or(Error::NotProposed)?;
        ensure_due(&env, pending.eta)?;
        let config = pricing_config(&env, &fund)?;
        let same_feeds = config.oracle == pending.nav_oracle
            && config.oracle_asset == pending.nav_asset
            && match (&config.source, pending.fx.rate()) {
                (PriceSource::Direct, None) => true,
                (PriceSource::Cross(leg), Some(anchor)) => {
                    leg.oracle == anchor.oracle && leg.asset == anchor.asset
                }
                _ => false,
            };
        if !same_feeds {
            return Err(Error::NotProposed);
        }
        let (nav, fx) = read_anchor(&env, &fund, &config)?;
        // A SEP-40 feed keeps its decimals for life, so this only trips on a
        // broken feed; readings in other units than the proposal's cannot be
        // compared, which is the mismatch `CurrencyMismatch` reports.
        let fx_decimals = fx.map(|rate| rate.price.decimals());
        if nav.price.decimals() != pending.nav_decimals
            || fx_decimals != pending.fx.rate().map(|anchor| anchor.decimals)
        {
            return Err(Error::CurrencyMismatch);
        }
        // The NAV must have followed the model since the proposal, its
        // growth counted over the real elapsed time, which the proposal's
        // life bounds: the delay, its grace period and the NAV age of the
        // proposal's reading. Counted over at most the NAV age bound, as a
        // valuation counts it, an honest accruing NAV could never pass under
        // a delay of a week or more (review finding VAL-1, 20 October 2026).
        let (low, high) = math::corridor(
            pending.nav,
            pending.nav_time,
            nav.timestamp,
            config.corridor_floor_bps,
            config.max_yield_bps,
            u64::MAX,
        )?;
        let value = nav.price.mantissa();
        if value < low || value > high {
            return Err(Error::PriceOutOfBand);
        }
        if let (PriceSource::Cross(leg), Some(rate), Some(anchor)) =
            (&config.source, fx, pending.fx.rate())
        {
            if !math::within_band(rate.price.mantissa(), anchor.rate, leg.band_bps)? {
                return Err(Error::PriceOutOfBand);
            }
        }
        // The NAV reference is carried from the proposal's reading to this
        // one along the model, in one step: never below the NAV the two
        // signers proposed, never above the model path from it at the
        // maximum yield over the real elapsed time. A reference may never
        // advance faster than that path, which successive refreshes already
        // allow; the two signers fix the floor of the anchor and its FX
        // rate, and whoever applies picks neither.
        let ceiling = math::model_path(
            pending.nav,
            pending.nav_time,
            nav.timestamp,
            config.max_yield_bps,
            u64::MAX,
        )?;
        let mut state = storage::fund_state(&env, &fund)?;
        state.reference_nav = value.min(ceiling).max(pending.nav);
        state.reference_time = nav.timestamp.max(pending.nav_time);
        state.nav_decimals = pending.nav_decimals;
        state.reference_fx = pending.fx.rate().map_or(0, |anchor| anchor.rate);
        state.fx_decimals = pending.fx.rate().map_or(0, |anchor| anchor.decimals);
        storage::set_fund_state(&env, &fund, &state);
        storage::remove_pending_reanchor(&env, &fund);
        storage::bump_instance(&env);
        Reanchored {
            fund,
            nav: state.reference_nav,
            nav_time: state.reference_time,
            fx: state.reference_fx,
        }
        .publish(&env);
        Ok(())
    }

    /// Withdraws it; governor, guardian or steward.
    pub fn cancel_reanchor(env: Env, fund: Address, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        let steward = is_steward(&env, &fund, &caller);
        if !may_cancel(&env, &caller) && !steward {
            return Err(Error::Unauthorized);
        }
        if !drop_pending_reanchor(&env, &fund, &caller) {
            return Err(Error::NotProposed);
        }
        if steward {
            steward_alive(&env, &fund, &caller);
        }
        storage::bump_instance(&env);
        Ok(())
    }

    /// The re-anchor, if live.
    pub fn pending_reanchor(env: Env, fund: Address) -> Option<PendingReanchor> {
        storage::pending_reanchor(&env, &fund).filter(|p| is_live(&env, p.eta))
    }

    // -- Fallback NAV feed ----------------------------------------------------

    /// Proposes a fallback NAV feed. Governor and steward.
    pub fn propose_fallback(env: Env, fund: Address, feed: FallbackFeed) -> Result<(), Error> {
        storage::require_governor(&env);
        let config = storage::fund(&env, &fund)?;
        config.steward.require_auth();
        steward_alive(&env, &fund, &config.steward);
        if storage::fallback(&env, &fund).is_none()
            && storage::fallback_count(&env) >= MAX_FALLBACKS
        {
            return Err(Error::LimitReached);
        }
        check_fallback(&env, &fund, &config, &feed)?;
        let eta = eta(&env)?;
        let oracle = feed.oracle.clone();
        storage::set_pending_fallback(&env, &fund, &PendingFallback { feed, eta });
        storage::bump_instance(&env);
        FallbackProposed { fund, oracle, eta }.publish(&env);
        Ok(())
    }

    /// Activates a due fallback, rechecked. Anyone.
    pub fn apply_fallback(env: Env, fund: Address) -> Result<(), Error> {
        let pending = storage::pending_fallback(&env, &fund).ok_or(Error::NotProposed)?;
        ensure_due(&env, pending.eta)?;
        let config = storage::fund(&env, &fund)?;
        let decimals = check_fallback(&env, &fund, &config, &pending.feed)?;
        storage::remove_pending_fallback(&env, &fund);
        storage::set_fallback(&env, &fund, &pending.feed, decimals, MAX_FALLBACKS)?;
        storage::bump_instance(&env);
        FallbackSet {
            fund,
            oracle: pending.feed.oracle,
        }
        .publish(&env);
        Ok(())
    }

    /// Withdraws it; governor, guardian or steward.
    pub fn cancel_fallback(env: Env, fund: Address, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        let steward = is_steward(&env, &fund, &caller);
        if !may_cancel(&env, &caller) && !steward {
            return Err(Error::Unauthorized);
        }
        if storage::pending_fallback(&env, &fund).is_none() {
            return Err(Error::NotProposed);
        }
        if steward {
            steward_alive(&env, &fund, &caller);
        }
        storage::remove_pending_fallback(&env, &fund);
        storage::bump_instance(&env);
        FallbackCancelled { fund, by: caller }.publish(&env);
        Ok(())
    }

    /// Removes it at once; guardian, or governor with steward.
    pub fn remove_fallback(env: Env, fund: Address, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        if caller != storage::guardian(&env) {
            let governor = storage::governor(&env);
            let steward = storage::steward_on_record(&env, &fund).ok_or(Error::Unauthorized)?;
            if caller == governor {
                if steward != caller {
                    steward.require_auth();
                }
            } else if caller == steward {
                governor.require_auth();
            } else {
                return Err(Error::Unauthorized);
            }
            steward_alive(&env, &fund, &steward);
        }
        if storage::fallback(&env, &fund).is_none() {
            return Err(Error::NoFallback);
        }
        storage::remove_fallback(&env, &fund);
        storage::bump_instance(&env);
        FallbackRemoved { fund, by: caller }.publish(&env);
        Ok(())
    }

    pub fn get_fallback(env: Env, fund: Address) -> Option<FallbackFeed> {
        storage::fallback(&env, &fund).map(|(feed, _)| feed)
    }

    /// The fallback, if live.
    pub fn pending_fallback(env: Env, fund: Address) -> Option<PendingFallback> {
        storage::pending_fallback(&env, &fund).filter(|p| is_live(&env, p.eta))
    }

    pub fn get_fund(env: Env, fund: Address) -> Option<FundConfig> {
        storage::fund(&env, &fund).ok()
    }

    pub fn get_fund_state(env: Env, fund: Address) -> Option<FundState> {
        storage::fund_state(&env, &fund).ok()
    }

    // -- Guardian -----------------------------------------------------------

    pub fn is_paused(env: Env) -> bool {
        storage::is_paused(&env)
    }

    /// Stops new offers and repos, not exits; guardian, governor or sentinel.
    pub fn pause(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        if !may_cancel(&env, &caller) {
            return Err(Error::Unauthorized);
        }
        storage::set_paused(&env, true);
        storage::bump_instance(&env);
        PauseChanged {
            paused: true,
            by: caller,
        }
        .publish(&env);
        Ok(())
    }

    /// Names the automated key that may only pause and cancel. Guardian.
    pub fn set_sentinel(env: Env, sentinel: Address) -> Result<(), Error> {
        let guardian = storage::guardian(&env);
        guardian.require_auth();
        // The sentinel is a hot key on a monitoring host: it must hold no
        // role whose loss or theft would matter more than a pause, nor be
        // about to take one (review finding auth-5, 20 October 2026).
        if is_governor_or_guardian(&env, &sentinel)
            || is_trustee(&env, &sentinel)
            || storage::guardian_backup(&env).is_some_and(|backup| backup == sentinel)
            || storage::sole_lender(&env).is_some_and(|lender| lender == sentinel)
            || pending_admin_change(&env).is_some_and(|pending| pending.admin == sentinel)
            || is_pending_guardian(&env, &DataKey::PendingGuardian, &sentinel)
            || is_pending_guardian(&env, &DataKey::PendingForcedGuardian, &sentinel)
        {
            return Err(Error::SentinelNotIndependent);
        }
        storage::set_sentinel(&env, Some(&sentinel));
        storage::bump_instance(&env);
        SentinelChanged {
            sentinel: Some(sentinel),
            by: guardian,
        }
        .publish(&env);
        Ok(())
    }

    /// Removes the sentinel. Guardian or governor.
    pub fn clear_sentinel(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        if !is_governor_or_guardian(&env, &caller) {
            return Err(Error::Unauthorized);
        }
        storage::set_sentinel(&env, None);
        storage::bump_instance(&env);
        SentinelChanged {
            sentinel: None,
            by: caller,
        }
        .publish(&env);
        Ok(())
    }

    /// The sentinel, if one is named.
    pub fn sentinel(env: Env) -> Option<Address> {
        storage::sentinel(&env)
    }

    /// Lifts the pause. Governor.
    pub fn unpause(env: Env) {
        let governor = storage::require_governor(&env);
        storage::set_paused(&env, false);
        storage::bump_instance(&env);
        PauseChanged {
            paused: false,
            by: governor,
        }
        .publish(&env);
    }

    // -- Steward ------------------------------------------------------------

    /// Tunes haircut and caps; loosenings wait. Steward.
    pub fn set_fund_limits(
        env: Env,
        fund: Address,
        haircut_bps: u32,
        max_principal_per_repo: i128,
        max_outstanding: i128,
    ) -> Result<(), Error> {
        let current = storage::fund(&env, &fund)?;
        current.steward.require_auth();
        steward_alive(&env, &fund, &current.steward);
        let mut config = current.clone();
        config.haircut_bps = haircut_bps;
        config.max_principal_per_repo = max_principal_per_repo;
        config.max_outstanding = max_outstanding;
        check_fund_config(&env, &config)?;
        let tightens = haircut_bps >= current.haircut_bps
            && max_principal_per_repo <= current.max_principal_per_repo
            && max_outstanding <= current.max_outstanding;
        if !tightens {
            let eta = eta(&env)?;
            storage::set_pending_fund_limits(
                &env,
                &fund,
                &PendingFundLimitsChange {
                    haircut_bps,
                    max_principal_per_repo,
                    max_outstanding,
                    eta,
                },
            );
            FundLimitsChangeProposed {
                fund,
                haircut_bps,
                max_principal_per_repo,
                max_outstanding,
                eta,
            }
            .publish(&env);
            return Ok(());
        }
        drop_pending_fund_limits(&env, &fund, &current.steward);
        // A pending replacement would overwrite this tightening with the
        // limits it carries: it goes too, and can be proposed again.
        drop_pending_fund_change(&env, &fund, &current.steward);
        install_fund_limits(&env, fund, config);
        Ok(())
    }

    /// Applies a due loosening, rechecked. Anyone.
    pub fn apply_fund_limits_change(env: Env, fund: Address) -> Result<(), Error> {
        let pending = storage::pending_fund_limits(&env, &fund).ok_or(Error::NotProposed)?;
        ensure_due(&env, pending.eta)?;
        let mut config = storage::fund(&env, &fund)?;
        config.haircut_bps = pending.haircut_bps;
        config.max_principal_per_repo = pending.max_principal_per_repo;
        config.max_outstanding = pending.max_outstanding;
        check_fund_config(&env, &config)?;
        storage::remove_pending_fund_limits(&env, &fund);
        install_fund_limits(&env, fund, config);
        Ok(())
    }

    /// Withdraws it; governor, guardian or steward.
    pub fn cancel_fund_limits_change(
        env: Env,
        fund: Address,
        caller: Address,
    ) -> Result<(), Error> {
        caller.require_auth();
        let steward = is_steward(&env, &fund, &caller);
        if !may_cancel(&env, &caller) && !steward {
            return Err(Error::Unauthorized);
        }
        if !drop_pending_fund_limits(&env, &fund, &caller) {
            return Err(Error::NotProposed);
        }
        if steward {
            steward_alive(&env, &fund, &caller);
        }
        Ok(())
    }

    /// The loosening, if live.
    pub fn pending_fund_limits_change(env: Env, fund: Address) -> Option<PendingFundLimitsChange> {
        storage::pending_fund_limits(&env, &fund).filter(|p| is_live(&env, p.eta))
    }

    /// Approves or revokes an attested lender. Steward.
    pub fn approve_lender(
        env: Env,
        fund: Address,
        lender: Address,
        approved: bool,
    ) -> Result<(), Error> {
        let config = storage::fund(&env, &fund)?;
        config.steward.require_auth();
        steward_alive(&env, &fund, &config.steward);
        if approved {
            ensure_not_steward(&env, &fund, &config, &lender)?;
            ensure_attested(&env, &fund, &config, &lender)?;
        } else {
            // A revocation stops the lender's new offers and loans at once.
            // It does not stop the seizure of its open repos: their shares
            // then wait for a new approval (decision S8, `seize`).
            storage::remove_lender_attestation(&env, &fund, &lender);
        }
        storage::set_lender_approved(&env, &fund, &lender, approved.then_some(&config.steward));
        LenderApproval {
            fund,
            lender,
            approved,
        }
        .publish(&env);
        Ok(())
    }

    pub fn is_lender_approved(env: Env, fund: Address, lender: Address) -> bool {
        storage::fund(&env, &fund).is_ok_and(|config| {
            storage::lender_approver(&env, &fund, &lender) == Some(config.steward)
        })
    }

    /// Records a declaration hash. Lender and steward.
    pub fn attest_lender(
        env: Env,
        fund: Address,
        lender: Address,
        declaration: BytesN<32>,
    ) -> Result<(), Error> {
        let config = storage::fund(&env, &fund)?;
        config.steward.require_auth();
        lender.require_auth();
        ensure_not_steward(&env, &fund, &config, &lender)?;
        steward_alive(&env, &fund, &config.steward);
        storage::set_lender_attestation(
            &env,
            &fund,
            &lender,
            &LenderAttestation {
                declaration: declaration.clone(),
                steward: config.steward,
                at: env.ledger().timestamp(),
            },
        );
        LenderAttested {
            fund,
            lender,
            declaration,
        }
        .publish(&env);
        Ok(())
    }

    /// The attestation, if any.
    pub fn lender_attestation(
        env: Env,
        fund: Address,
        lender: Address,
    ) -> Option<LenderAttestation> {
        storage::lender_attestation(&env, &fund, &lender)
    }

    /// Suspends or resumes new repos. Steward.
    pub fn freeze_fund(env: Env, fund: Address, frozen: bool) -> Result<(), Error> {
        let config = storage::fund(&env, &fund)?;
        config.steward.require_auth();
        steward_alive(&env, &fund, &config.steward);
        let mut state = storage::fund_state(&env, &fund)?;
        state.frozen = frozen;
        storage::set_fund_state(&env, &fund, &state);
        FundFrozen { fund, frozen }.publish(&env);
        Ok(())
    }

    /// Lowers the NAV reference to the NAV. Steward.
    pub fn reset_reference(env: Env, fund: Address) -> Result<PriceData, Error> {
        let config = storage::fund(&env, &fund)?;
        config.steward.require_auth();
        steward_alive(&env, &fund, &config.steward);
        let mut state = storage::fund_state(&env, &fund)?;
        let fallback = storage::fallback_for_pricing(&env, &fund);
        let nav = oracle::read_nav(&env, &config, &state, fallback.as_ref())?;
        let lowered = nav.price.mantissa().min(state.reference_nav);
        let timestamp = nav.timestamp.max(state.reference_time);
        Ok(set_reference(&env, &fund, &mut state, lowered, timestamp))
    }

    /// Labels an issuer-designated offer. Steward.
    pub fn set_sponsor(env: Env, offer_id: u64, fund: Address, sponsor: bool) -> Result<(), Error> {
        let config = storage::fund(&env, &fund)?;
        config.steward.require_auth();
        steward_alive(&env, &fund, &config.steward);
        let mut offer = storage::offer(&env, offer_id)?;
        if !offer.funds.contains(&fund) {
            return Err(Error::FundNotInOffer);
        }
        offer.sponsor = sponsor;
        storage::set_offer(&env, offer_id, &offer);
        SponsorSet { offer_id, sponsor }.publish(&env);
        Ok(())
    }

    // -- Anyone -------------------------------------------------------------

    /// Moves the reference along the model. Anyone.
    pub fn refresh_reference(env: Env, fund: Address) -> Result<PriceData, Error> {
        let config = storage::fund(&env, &fund)?;
        let mut state = storage::fund_state(&env, &fund)?;
        let fallback = storage::fallback_for_pricing(&env, &fund);
        let nav = oracle::read_nav(&env, &config, &state, fallback.as_ref())?;
        oracle::check_corridor(&config, &state, &nav)?;
        if let Some(next) = oracle::next_reference(&config, &state, &nav)? {
            return Ok(set_reference(&env, &fund, &mut state, next, nav.timestamp));
        }
        Ok(PriceData {
            price: state.reference_nav,
            timestamp: state.reference_time,
        })
    }

    /// Last oracle NAV, unchecked.
    pub fn fund_price(env: Env, fund: Address) -> Result<PriceData, Error> {
        let config = storage::fund(&env, &fund)?;
        OracleClient::new(&env, &config.oracle)
            .lastprice(&config.oracle_asset)
            .ok_or(Error::NoPrice)
    }

    /// What `shares` can secure now, fully checked.
    pub fn quote(
        env: Env,
        fund: Address,
        shares: i128,
        stablecoin: Address,
    ) -> Result<Quote, Error> {
        let config = storage::fund(&env, &fund)?;
        let state = storage::fund_state(&env, &fund)?;
        let coin = storage::stablecoin(&env, &stablecoin)?;
        if coin.currency != config.currency {
            return Err(Error::CurrencyMismatch);
        }
        let fallback = storage::fallback_for_pricing(&env, &fund);
        let valuation = oracle::value(&env, &config, &state, fallback.as_ref())?;
        let max_principal = math::max_principal(
            shares,
            state.share_decimals,
            valuation.price,
            coin.decimals,
            valuation.haircut,
        )?;
        Ok(Quote {
            price: valuation.price.mantissa(),
            price_decimals: valuation.price.decimals(),
            haircut_bps: valuation.haircut.get(),
            max_principal,
            nav_timestamp: valuation.nav.timestamp,
        })
    }

    // -- Lifecycle ----------------------------------------------------------

    /// Deposits an offer; returns its id. Approved lender.
    pub fn create_offer(
        env: Env,
        lender: Address,
        stablecoin: Address,
        amount: i128,
        rate_bps: u32,
        max_term: u64,
        funds: Vec<Address>,
    ) -> Result<u64, Error> {
        lender.require_auth();
        storage::ensure_not_paused(&env)?;
        ensure_schema_current(&env)?;
        // Read from instance storage, which every invocation loads: the mode
        // adds no ledger entry to the footprint.
        if storage::sole_lender(&env).is_some_and(|sole| sole != lender) {
            return Err(Error::NotSoleLender);
        }
        let coin = storage::stablecoin(&env, &stablecoin)?;
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if rate_bps > BPS_DENOMINATOR {
            return Err(Error::InvalidRate);
        }
        if max_term < MIN_TERM_SECS || max_term > Self::max_term(env.clone()) {
            return Err(Error::InvalidTerm);
        }
        if funds.is_empty() || funds.len() > MAX_FUNDS_PER_OFFER {
            return Err(Error::TooManyFunds);
        }
        for (position, fund) in funds.iter().enumerate() {
            // Bounded by MAX_FUNDS_PER_OFFER: at most 28 comparisons.
            if funds
                .iter()
                .skip(position.saturating_add(1))
                .any(|other| other == fund)
            {
                return Err(Error::TooManyFunds);
            }
            let config = storage::fund(&env, &fund)?;
            if config.currency != coin.currency {
                return Err(Error::CurrencyMismatch);
            }
            // The approval rules already keep a steward out; this also
            // covers an approval granted before version 4.
            if config.steward == lender {
                return Err(Error::StewardCannotLend);
            }
            // An approval records the steward that granted it (second review
            // of rc2, M2): one granted under a steward since rotated or
            // recovered backs no new offer and no new loan. The approval
            // implies the attestation that steward co-signed, so no
            // attestation is read here.
            if storage::lender_approver(&env, &fund, &lender).as_ref() != Some(&config.steward) {
                return Err(Error::LenderNotApproved);
            }
        }

        token_io::pull(&env, &stablecoin, &lender, amount)?;
        let offer_id = storage::next_id(&env, DataKey::NextOfferId)?;
        storage::set_offer(
            &env,
            offer_id,
            &Offer {
                lender: lender.clone(),
                stablecoin: stablecoin.clone(),
                available: amount,
                rate_bps,
                max_term,
                funds,
                sponsor: false,
            },
        );
        storage::bump_instance(&env);
        OfferCreated {
            offer_id,
            lender,
            stablecoin,
            amount,
            rate_bps,
            max_term,
        }
        .publish(&env);
        Ok(offer_id)
    }

    /// Takes back unlent stablecoins, even paused. Lender.
    pub fn withdraw_offer(env: Env, offer_id: u64, amount: i128) -> Result<(), Error> {
        let mut offer = storage::offer(&env, offer_id)?;
        offer.lender.require_auth();
        storage::bump_instance(&env);
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if amount > offer.available {
            return Err(Error::InsufficientOffer);
        }
        offer.available = offer
            .available
            .checked_sub(amount)
            .ok_or(Error::ArithmeticOverflow)?;
        storage::set_offer(&env, offer_id, &offer);
        token_io::push(&env, &offer.stablecoin, &offer.lender, amount);
        OfferWithdrawn { offer_id, amount }.publish(&env);
        Ok(())
    }

    /// Locks shares, pays `principal` for `term`; returns the id. Borrower.
    pub fn open_repo(
        env: Env,
        borrower: Address,
        offer_id: u64,
        fund: Address,
        shares: i128,
        principal: i128,
        term: u64,
    ) -> Result<u64, Error> {
        borrower.require_auth();
        storage::ensure_not_paused(&env)?;
        ensure_schema_current(&env)?;

        let mut offer = storage::offer(&env, offer_id)?;
        if !offer.funds.contains(&fund) {
            return Err(Error::FundNotInOffer);
        }
        let config = storage::fund(&env, &fund)?;
        let mut state = storage::fund_state(&env, &fund)?;
        if state.frozen {
            return Err(Error::FundFrozen);
        }
        let coin = storage::stablecoin(&env, &offer.stablecoin)?;
        if coin.currency != config.currency {
            return Err(Error::CurrencyMismatch);
        }
        // An offer made by the steward under an approval granted before
        // version 4 never lends. Comparing with the configuration suffices:
        // for an admitted fund the `LastSteward` record, when present, is the
        // same address, and reading it would cost `open_repo` an entry.
        if offer.lender == config.steward {
            return Err(Error::StewardCannotLend);
        }
        // The steward may have revoked the lender since the offer was made,
        // or have been replaced: a loan needs the current steward's approval
        // (second review of rc2, M2). Once the repo is open, neither stops
        // its seizure (decision S8): the lender of record seizes without a
        // current approval, and shares seized after a revocation wait in the
        // contract until the lender is approved again or names an approved
        // holder (review findings auth-1, econ-2 and state-2, 20 October
        // 2026). The read extends the approval past this repo's end.
        if !storage::lender_approved_by_extending(&env, &fund, &offer.lender, &config.steward) {
            return Err(Error::LenderNotApproved);
        }
        if shares <= 0 || principal <= 0 {
            return Err(Error::InvalidAmount);
        }
        if term < MIN_TERM_SECS || term > offer.max_term || term > Self::max_term(env.clone()) {
            return Err(Error::InvalidTerm);
        }
        if principal > offer.available {
            return Err(Error::InsufficientOffer);
        }

        // Without a fallback, this reads only an instance key: the footprint
        // of a fund without fallback does not grow.
        let fallback = storage::fallback_for_pricing(&env, &fund);
        let valuation = oracle::value(&env, &config, &state, fallback.as_ref())?;
        let ceiling = math::max_principal(
            shares,
            state.share_decimals,
            valuation.price,
            coin.decimals,
            valuation.haircut,
        )?;
        if principal > ceiling {
            return Err(Error::LoanTooLarge);
        }

        let fund_outstanding = state
            .outstanding
            .checked_add(principal)
            .ok_or(Error::ArithmeticOverflow)?;
        let currency_outstanding = storage::currency_outstanding(&env, &config.currency)
            .checked_add(principal)
            .ok_or(Error::ArithmeticOverflow)?;
        if principal > config.max_principal_per_repo
            || fund_outstanding > config.max_outstanding
            || currency_outstanding > storage::currency_cap(&env, &config.currency)
        {
            return Err(Error::CapExceeded);
        }

        // Effects, then interactions. Soroban forbids re-entrancy; the order
        // still keeps the books right if a transfer fails (all reverts).
        let now = env.ledger().timestamp();
        let maturity = now.checked_add(term).ok_or(Error::ArithmeticOverflow)?;
        offer.available = offer
            .available
            .checked_sub(principal)
            .ok_or(Error::ArithmeticOverflow)?;
        storage::set_offer(&env, offer_id, &offer);
        state.outstanding = fund_outstanding;
        // A newer NAV moves the reference as `refresh_reference` would, and
        // the move is published the same way (review finding oracle-4).
        let next_reference = oracle::next_reference(&config, &state, &valuation.nav)?;
        if let Some(next) = next_reference {
            state.reference_nav = next;
            state.reference_time = valuation.nav.timestamp;
        }
        storage::set_fund_state(&env, &fund, &state);
        storage::set_currency_outstanding(&env, &config.currency, currency_outstanding);
        let repo_id = storage::next_id(&env, DataKey::NextRepoId)?;
        storage::set_repo(
            &env,
            repo_id,
            &Repo {
                offer_id,
                borrower: borrower.clone(),
                lender: offer.lender.clone(),
                fund: fund.clone(),
                shares,
                stablecoin: offer.stablecoin.clone(),
                principal,
                rate_bps: offer.rate_bps,
                opened_at: now,
                maturity,
                status: RepoStatus::Open,
            },
        );
        storage::bump_instance(&env);

        token_io::pull(&env, &fund, &borrower, shares)?;
        token_io::push(&env, &offer.stablecoin, &borrower, principal);

        RepoOpened {
            repo_id,
            borrower,
            offer_id,
            lender: offer.lender,
            fund: fund.clone(),
            shares,
            principal,
            rate_bps: offer.rate_bps,
            maturity,
        }
        .publish(&env);
        // The valuation behind the loan, which a lender, the issuer or an
        // auditor can then evidence from the contract's own trail (review
        // finding oracle-4, 20 October 2026).
        let (fx, fx_applied, fx_time) = valuation.fx.map_or((0, 0, 0), |leg| {
            (
                leg.rate.price.mantissa(),
                leg.applied.mantissa(),
                leg.rate.timestamp,
            )
        });
        RepoValued {
            repo_id,
            fund: fund.clone(),
            nav: valuation.nav.price.mantissa(),
            nav_time: valuation.nav.timestamp,
            fx,
            fx_applied,
            fx_time,
            price: valuation.price.mantissa(),
            haircut_bps: valuation.haircut.get(),
        }
        .publish(&env);
        if next_reference.is_some() {
            ReferenceUpdated {
                fund,
                nav: state.reference_nav,
                timestamp: state.reference_time,
            }
            .publish(&env);
        }
        Ok(repo_id)
    }

    /// Interest due if repurchased now.
    pub fn repo_due(env: Env, repo_id: u64) -> Result<i128, Error> {
        let repo = storage::repo(&env, repo_id)?;
        if repo.status != RepoStatus::Open {
            return Err(Error::RepoNotOpen);
        }
        interest_due(&env, &repo)
    }

    /// Repays and recovers the shares, even paused. Borrower.
    pub fn repurchase(env: Env, repo_id: u64) -> Result<(), Error> {
        let mut repo = storage::repo(&env, repo_id)?;
        if repo.status != RepoStatus::Open {
            return Err(Error::RepoNotOpen);
        }
        repo.borrower.require_auth();
        let interest = interest_due(&env, &repo)?;

        let repayment = repo
            .principal
            .checked_add(interest)
            .ok_or(Error::ArithmeticOverflow)?;
        let mut offer = storage::offer(&env, repo.offer_id)?;
        offer.available = offer
            .available
            .checked_add(repayment)
            .ok_or(Error::ArithmeticOverflow)?;
        storage::set_offer(&env, repo.offer_id, &offer);
        release_outstanding(&env, &repo)?;
        repo.status = RepoStatus::Repurchased;
        storage::set_repo(&env, repo_id, &repo);
        storage::bump_instance(&env);

        token_io::pull(&env, &repo.stablecoin, &repo.borrower, repayment)?;

        RepoRepurchased {
            repo_id,
            principal: repo.principal,
            interest,
        }
        .publish(&env);
        deliver_shares(&env, repo_id, &repo.fund, &repo.borrower, repo.shares);
        Ok(())
    }

    /// From maturity, sends the shares to `to`: the lender, or a holder
    /// approved for the fund. Lender.
    pub fn seize(env: Env, repo_id: u64, to: Address) -> Result<(), Error> {
        let mut repo = storage::repo(&env, repo_id)?;
        if repo.status != RepoStatus::Open {
            return Err(Error::RepoNotOpen);
        }
        if env.ledger().timestamp() < repo.maturity {
            return Err(Error::NotMatured);
        }
        repo.lender.require_auth();
        // Seized shares never go to the steward, whatever approval it holds
        // (MMF Regulation, Art. 35): this covers an approval granted before
        // version 4, and a lender of record named steward since.
        if is_steward_or_last(&env, &repo.fund, &to) {
            return Err(Error::StewardCannotLend);
        }
        // The lender of record was approved when the repo opened: a
        // revocation since must not take its recourse away (review findings
        // auth-1, econ-2 and state-2, 20 October 2026). The default settles;
        // without a current approval the shares wait in the contract,
        // recorded for the lender, until it is approved again or redirects
        // them to an approved holder (decision S8). Any other recipient needs
        // its own approval.
        let approved = storage::lender_approved_extending(&env, &repo.fund, &to);
        if !approved && to != repo.lender {
            return Err(Error::LenderNotApproved);
        }

        release_outstanding(&env, &repo)?;
        repo.status = RepoStatus::Defaulted;
        storage::set_repo(&env, repo_id, &repo);
        storage::bump_instance(&env);

        RepoSeized {
            repo_id,
            to: to.clone(),
            shares: repo.shares,
        }
        .publish(&env);
        if approved {
            deliver_shares(&env, repo_id, &repo.fund, &to, repo.shares);
        } else {
            defer_shares(&env, repo_id, &repo.fund, &to, repo.shares);
        }
        Ok(())
    }

    /// Retries a deferred delivery; false if refused. Anyone.
    pub fn release(env: Env, repo_id: u64) -> Result<bool, Error> {
        let pending = storage::pending_release(&env, repo_id).ok_or(Error::NothingToRelease)?;
        let repo = storage::repo(&env, repo_id)?;
        // Seized shares reach only a holder approved for the fund, never its
        // steward (decision S8): while the lender of record stays revoked,
        // they wait as they do when the token refuses.
        let withheld = repo.status == RepoStatus::Defaulted
            && (!storage::lender_approved_extending(&env, &pending.fund, &pending.to)
                || is_steward_or_last(&env, &pending.fund, &pending.to));
        // The transfer goes first so that a refusal leaves the record as it
        // is; Soroban forbids re-entering this contract during the call.
        if withheld || !token_io::try_push(&env, &pending.fund, &pending.to, pending.shares) {
            storage::bump_pending_release(&env, repo_id);
            return Ok(false);
        }
        storage::remove_pending_release(&env, repo_id);
        storage::bump_instance(&env);
        SharesReleased {
            repo_id,
            to: pending.to,
            shares: pending.shares,
        }
        .publish(&env);
        Ok(true)
    }

    /// Changes a deferred delivery's beneficiary. Beneficiary.
    pub fn redirect_release(env: Env, repo_id: u64, to: Address) -> Result<(), Error> {
        let mut pending = storage::pending_release(&env, repo_id).ok_or(Error::NothingToRelease)?;
        // A "delivery" to the contract itself would close the record while
        // the shares stay here, unattributed: the share balance would no
        // longer match the books, the mismatch `TransferMismatch` reports.
        if to == env.current_contract_address() {
            return Err(Error::TransferMismatch);
        }
        let repo = storage::repo(&env, repo_id)?;
        match repo.status {
            RepoStatus::Repurchased => repo.borrower.require_auth(),
            RepoStatus::Defaulted => {
                repo.lender.require_auth();
                if !storage::lender_approved_extending(&env, &repo.fund, &to) {
                    return Err(Error::LenderNotApproved);
                }
                if is_steward_or_last(&env, &repo.fund, &to) {
                    return Err(Error::StewardCannotLend);
                }
            }
            // Shares are only deferred when a repo closes.
            RepoStatus::Open => return Err(Error::NothingToRelease),
        }
        pending.to = to.clone();
        storage::set_pending_release(&env, repo_id, &pending);
        ReleaseRedirected { repo_id, to }.publish(&env);
        Ok(())
    }

    pub fn pending_release(env: Env, repo_id: u64) -> Option<PendingRelease> {
        storage::pending_release(&env, repo_id)
    }

    pub fn get_offer(env: Env, offer_id: u64) -> Option<Offer> {
        storage::offer(&env, offer_id).ok()
    }

    pub fn get_repo(env: Env, repo_id: u64) -> Option<Repo> {
        storage::repo(&env, repo_id).ok()
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn install_max_term(env: &Env, max_term: u64) {
    storage::set_max_term(env, max_term);
    storage::bump_instance(env);
    MaxTermChanged { max_term }.publish(env);
}

/// Installs a guardian by any path. The backup goes: it was agreed with the
/// guardian leaving office, and after a forced change that guardian may be
/// the hostile one.
fn install_guardian(env: &Env, guardian: Address) {
    storage::remove_guardian_backup(env);
    storage::next_governance_generation(env);
    storage::set_guardian(env, &guardian);
    storage::bump_instance(env);
    GuardianChanged { guardian }.publish(env);
}

fn install_envelope(env: &Env, envelope: RiskEnvelope) {
    storage::set_envelope(env, &envelope);
    storage::bump_instance(env);
    EnvelopeChanged { envelope }.publish(env);
}

/// Checks that every bound of an envelope is a valid quantity.
fn check_envelope(envelope: &RiskEnvelope) -> Result<(), Error> {
    Bps::haircut(envelope.min_haircut_bps)?;
    Bps::haircut(envelope.min_fx_haircut_bps)?;
    Bps::haircut(envelope.max_corridor_floor_bps)?;
    Bps::haircut(envelope.max_fx_band_bps)?;
    if envelope.max_yield_bps > BPS_DENOMINATOR {
        return Err(Error::OutsideEnvelope);
    }
    Ok(())
}

/// Whether `next` is at least as strict as `current` on every bound: no
/// minimum lowered, no maximum raised. Such a change cannot let a fund
/// setting through that the current envelope refuses.
fn tightens(next: &RiskEnvelope, current: &RiskEnvelope) -> bool {
    next.min_haircut_bps >= current.min_haircut_bps
        && next.min_fx_haircut_bps >= current.min_fx_haircut_bps
        && next.max_corridor_floor_bps <= current.max_corridor_floor_bps
        && next.max_yield_bps <= current.max_yield_bps
        && next.max_nav_age_secs <= current.max_nav_age_secs
        && next.max_fx_age_secs <= current.max_fx_age_secs
        && next.max_fx_band_bps <= current.max_fx_band_bps
}

/// Refuses `lender` when it is the fund's steward or its steward on record
/// (the `LastSteward` entry, absent for a fund admitted before version 3).
fn ensure_not_steward(
    env: &Env,
    fund: &Address,
    config: &FundConfig,
    lender: &Address,
) -> Result<(), Error> {
    if config.steward == *lender || storage::last_steward(env, fund).is_some_and(|s| s == *lender) {
        return Err(Error::StewardCannotLend);
    }
    Ok(())
}

/// Whether `who` is the fund's steward or its `LastSteward` record. For an
/// admitted fund the two agree whenever the record exists (`install_fund`
/// and `apply_steward_recovery` write both); the record alone covers a
/// removed fund.
fn is_steward_or_last(env: &Env, fund: &Address, who: &Address) -> bool {
    storage::fund(env, fund).is_ok_and(|config| config.steward == *who)
        || storage::last_steward(env, fund).is_some_and(|s| s == *who)
}

/// Whether a steward recovery can still apply: not expired, and proposed
/// against the steward still on record and the governance keys still in
/// office (a recovery signed by replaced keys dies).
fn recovery_can_apply(env: &Env, fund: &Address, pending: &PendingStewardRecovery) -> bool {
    is_live(env, pending.eta)
        && storage::governance_generation(env) == pending.generation
        && storage::steward_on_record(env, fund).is_some_and(|s| s == pending.previous)
}

/// A steward-signed action on `fund` proves the steward key is alive: a
/// pending recovery of that fund, meant for a lost key, goes, whether it
/// could still apply or not.
fn steward_alive(env: &Env, fund: &Address, steward: &Address) {
    drop_pending_steward_recovery(env, fund, steward);
}

fn drop_pending_steward_recovery(env: &Env, fund: &Address, by: &Address) {
    if storage::pending_steward_recovery(env, fund).is_some() {
        storage::remove_pending_steward_recovery(env, fund);
        StewardRecoveryCancelled {
            fund: fund.clone(),
            by: by.clone(),
        }
        .publish(env);
    }
}

fn drop_pending_steward_backup(env: &Env, fund: &Address, by: &Address) -> bool {
    let Some(pending) = storage::pending_steward_backup(env, fund) else {
        return false;
    };
    storage::remove_pending_steward_backup(env, fund);
    StewardBackupChangeCancelled {
        fund: fund.clone(),
        backup: pending.backup,
        by: by.clone(),
    }
    .publish(env);
    true
}

fn install_steward_backup(env: &Env, fund: Address, backup: Address) {
    storage::set_steward_backup(env, &fund, &backup);
    StewardBackupSet { fund, backup }.publish(env);
}

/// Refuses `lender` unless its attestation for the fund was co-signed by the
/// fund's current steward. Reading it extends it.
fn ensure_attested(
    env: &Env,
    fund: &Address,
    config: &FundConfig,
    lender: &Address,
) -> Result<(), Error> {
    if storage::attestation_extending(env, fund, lender)
        .is_some_and(|attestation| attestation.steward == config.steward)
    {
        return Ok(());
    }
    Err(Error::AttestationMissing)
}

fn is_trustee(env: &Env, caller: &Address) -> bool {
    storage::trustee(env).is_some_and(|trustee| trustee == *caller)
}

/// Requires the trustee's signature when one is named, besides the
/// governor's.
fn require_trustee(env: &Env, governor: &Address) {
    if let Some(trustee) = storage::trustee(env) {
        if trustee != *governor {
            trustee.require_auth();
        }
    }
}

/// A trustee consents independently: it holds no governance role and is not
/// about to take one, it is not the sole lender, and it is not the sentinel,
/// a hot key (review finding auth-5, 20 October 2026). A guardian forced in
/// by the governor may become trustee: naming or handing over the trustee
/// drops that pending change.
fn ensure_independent_trustee(env: &Env, trustee: &Address) -> Result<(), Error> {
    if is_governor_or_guardian(env, trustee)
        || storage::sole_lender(env).is_some_and(|lender| lender == *trustee)
        || storage::guardian_backup(env).is_some_and(|backup| backup == *trustee)
        || pending_admin_change(env).is_some_and(|pending| pending.admin == *trustee)
        || is_pending_guardian(env, &DataKey::PendingGuardian, trustee)
        || is_sentinel(env, trustee)
    {
        return Err(Error::TrusteeNotIndependent);
    }
    Ok(())
}

/// The trustee and the sentinel hold no other role, checked in both
/// directions: no role, backup or proposal may name either (second review
/// of rc2, L1, for the trustee; review finding auth-5, 20 October 2026, for
/// the sentinel). `ensure_independent_trustee` and `set_sentinel` check the
/// other direction.
fn ensure_not_trustee_or_sentinel(env: &Env, who: &Address) -> Result<(), Error> {
    if is_trustee(env, who) {
        return Err(Error::TrusteeNotIndependent);
    }
    if is_sentinel(env, who) {
        return Err(Error::SentinelNotIndependent);
    }
    Ok(())
}

/// Whether `who` is the guardian a pending appointment would install; `key`
/// is `PendingGuardian` or `PendingForcedGuardian`.
fn is_pending_guardian(env: &Env, key: &DataKey, who: &Address) -> bool {
    storage::instance_value::<PendingGuardianChange>(env, key)
        .is_some_and(|pending| pending.guardian == *who)
}

/// Records that value can be at stake. The first admission ends the
/// bootstrap, and the proposals timed under its rules go, each cancelled by
/// the contract: a governor handover, which was due at once, and an upgrade,
/// whose eta followed a delay the governor could still shorten at will
/// (review finding auth-4, 20 October 2026). From now on both wait for the
/// delay in force, which only grows. The guardian, the term ceiling, the
/// envelope, the currency caps and the stablecoin registry change at once
/// during bootstrap, so they leave no proposal behind, and a forced guardian
/// change always waits for the longest delay.
fn mark_funds_admitted(env: &Env) {
    if storage::funds_admitted(env) {
        return;
    }
    // A contract upgraded from version 2 has offers but no flag: it left
    // the bootstrap with its first offer, and its proposals already waited
    // for the delay in force.
    let bootstrap = !storage::past_bootstrap(env);
    storage::mark_funds_admitted(env);
    if !bootstrap {
        return;
    }
    let by = env.current_contract_address();
    if let Some(pending) = pending_admin_change(env) {
        remove_pending_admin(env);
        AdminProposalCancelled {
            proposed: pending.admin,
            by: by.clone(),
        }
        .publish(env);
    }
    drop_pending_upgrade(env, &by);
}

/// The pending governor handover: the version 4 record, or a version 3
/// `PendingAdmin` left by an upgrade. The latter is never honoured: it was
/// proposed without the delay, so it shows as expired (eta 0) and can only
/// be cleared, by a cancellation, a veto or a new proposal.
fn pending_admin_change(env: &Env) -> Option<PendingAdminChange> {
    if let Some(pending) = storage::instance_value(env, &DataKey::PendingAdminChange) {
        return Some(pending);
    }
    let admin = storage::instance_value(env, &DataKey::PendingAdmin)?;
    Some(PendingAdminChange { admin, eta: 0 })
}

fn remove_pending_admin(env: &Env) {
    storage::remove_instance(env, &DataKey::PendingAdminChange);
    storage::remove_instance(env, &DataKey::PendingAdmin);
}

/// Removes the pending governor handover and publishes its cancellation by
/// `by`.
fn drop_pending_admin(env: &Env, by: &Address) -> Result<(), Error> {
    let pending = pending_admin_change(env).ok_or(Error::NotProposed)?;
    remove_pending_admin(env);
    storage::bump_instance(env);
    AdminProposalCancelled {
        proposed: pending.admin,
        by: by.clone(),
    }
    .publish(env);
    Ok(())
}

fn is_governor_or_guardian(env: &Env, caller: &Address) -> bool {
    *caller == storage::governor(env) || *caller == storage::guardian(env)
}

fn is_sentinel(env: &Env, caller: &Address) -> bool {
    storage::sentinel(env).is_some_and(|sentinel| sentinel == *caller)
}

/// Who may pause and withdraw a proposal: the governor, the guardian, and
/// the sentinel, the automated key that can do nothing else (rc4). Vetoes
/// and handovers stay with the human keys.
fn may_cancel(env: &Env, caller: &Address) -> bool {
    is_governor_or_guardian(env, caller) || is_sentinel(env, caller)
}

/// Entries wait until a code upgrade is followed by `migrate`; exits never
/// check (decision S6).
fn ensure_schema_current(env: &Env) -> Result<(), Error> {
    if storage::schema_version(env) < SCHEMA_VERSION {
        return Err(Error::SchemaOutdated);
    }
    Ok(())
}

/// A stablecoin's decimals, refused unless they are `STABLECOIN_DECIMALS`:
/// at a registration, at its proposal and at its apply.
fn check_stablecoin_decimals(env: &Env, stablecoin: &Address) -> Result<u32, Error> {
    let decimals = token_io::decimals(env, stablecoin);
    if decimals != STABLECOIN_DECIMALS {
        return Err(Error::StablecoinNotAccepted);
    }
    Ok(decimals)
}

fn install_stablecoin(env: &Env, stablecoin: Address, currency: Symbol, decimals: u32) {
    let config = StablecoinConfig {
        currency: currency.clone(),
        decimals,
    };
    storage::set_stablecoin(env, &stablecoin, &config);
    storage::bump_instance(env);
    StablecoinSet {
        stablecoin,
        currency,
    }
    .publish(env);
}

/// Whether `caller` is the steward on record of `fund`: the current one, or
/// after a removal the last installed one, who keeps the issuer's say over a
/// re-admission.
fn is_steward(env: &Env, fund: &Address, caller: &Address) -> bool {
    storage::steward_on_record(env, fund).is_some_and(|steward| steward == *caller)
}

/// When a proposal made now may apply.
fn eta(env: &Env) -> Result<u64, Error> {
    env.ledger()
        .timestamp()
        .checked_add(storage::timelock_delay(env, DEFAULT_TIMELOCK_SECS))
        .ok_or(Error::ArithmeticOverflow)
}

/// Whether a proposal with this eta can still be applied: it has not passed
/// its grace period.
fn is_live(env: &Env, eta: u64) -> bool {
    env.ledger().timestamp() <= eta.saturating_add(PROPOSAL_GRACE_SECS)
}

/// A proposal applies from its eta to the end of its grace period.
/// Deadlines are compared to the ledger time, never inferred from a TTL.
fn ensure_due(env: &Env, eta: u64) -> Result<(), Error> {
    if env.ledger().timestamp() < eta {
        return Err(Error::TimelockPending);
    }
    if !is_live(env, eta) {
        return Err(Error::ProposalExpired);
    }
    Ok(())
}

fn install_currency_cap(env: &Env, currency: Symbol, cap: i128) {
    storage::set_currency_cap(env, &currency, cap);
    storage::bump_instance(env);
    CurrencyCapSet { currency, cap }.publish(env);
}

fn install_fund_limits(env: &Env, fund: Address, config: FundConfig) {
    storage::set_fund(env, &fund, &config);
    FundLimitsSet {
        fund,
        haircut_bps: config.haircut_bps,
        max_principal_per_repo: config.max_principal_per_repo,
        max_outstanding: config.max_outstanding,
    }
    .publish(env);
}

// Each `drop_pending_*` removes a proposal, publishes its cancellation with
// `by`, and reports whether there was one.

fn drop_pending_max_term(env: &Env, by: &Address) -> bool {
    let Some(pending) =
        storage::instance_value::<PendingMaxTermChange>(env, &DataKey::PendingMaxTerm)
    else {
        return false;
    };
    storage::remove_instance(env, &DataKey::PendingMaxTerm);
    MaxTermChangeCancelled {
        max_term: pending.max_term,
        by: by.clone(),
    }
    .publish(env);
    true
}

fn drop_pending_upgrade(env: &Env, by: &Address) {
    if let Some(pending) = storage::pending_upgrade(env) {
        storage::remove_pending_upgrade(env);
        UpgradeCancelled {
            wasm_hash: pending.wasm_hash,
            by: by.clone(),
        }
        .publish(env);
    }
}

fn drop_pending_guardian(env: &Env, by: &Address) -> bool {
    let Some(pending) =
        storage::instance_value::<PendingGuardianChange>(env, &DataKey::PendingGuardian)
    else {
        return false;
    };
    storage::remove_instance(env, &DataKey::PendingGuardian);
    GuardianChangeCancelled {
        guardian: pending.guardian,
        by: by.clone(),
    }
    .publish(env);
    true
}

fn drop_pending_forced_guardian(env: &Env, by: &Address) -> bool {
    let Some(pending) =
        storage::instance_value::<PendingGuardianChange>(env, &DataKey::PendingForcedGuardian)
    else {
        return false;
    };
    storage::remove_instance(env, &DataKey::PendingForcedGuardian);
    ForcedGuardianChangeCancelled {
        guardian: pending.guardian,
        by: by.clone(),
    }
    .publish(env);
    true
}

fn drop_pending_envelope(env: &Env, by: &Address) -> bool {
    let Some(pending) =
        storage::instance_value::<PendingEnvelopeChange>(env, &DataKey::PendingEnvelope)
    else {
        return false;
    };
    storage::remove_instance(env, &DataKey::PendingEnvelope);
    EnvelopeChangeCancelled {
        envelope: pending.envelope,
        by: by.clone(),
    }
    .publish(env);
    true
}

fn drop_pending_currency_cap(env: &Env, currency: &Symbol, by: &Address) -> bool {
    let mut pending = storage::pending_currency_caps(env);
    if pending.remove(currency.clone()).is_none() {
        return false;
    }
    storage::set_pending_currency_caps(env, &pending);
    CurrencyCapChangeCancelled {
        currency: currency.clone(),
        by: by.clone(),
    }
    .publish(env);
    true
}

fn drop_pending_fund_change(env: &Env, fund: &Address, by: &Address) -> bool {
    if storage::pending_fund_change(env, fund).is_none() {
        return false;
    }
    storage::remove_pending_fund_change(env, fund);
    FundChangeCancelled {
        fund: fund.clone(),
        by: by.clone(),
    }
    .publish(env);
    true
}

fn drop_pending_reanchor(env: &Env, fund: &Address, by: &Address) -> bool {
    if storage::pending_reanchor(env, fund).is_none() {
        return false;
    }
    storage::remove_pending_reanchor(env, fund);
    ReanchorCancelled {
        fund: fund.clone(),
        by: by.clone(),
    }
    .publish(env);
    true
}

fn drop_pending_fallback(env: &Env, fund: &Address, by: &Address) -> bool {
    if storage::pending_fallback(env, fund).is_none() {
        return false;
    }
    storage::remove_pending_fallback(env, fund);
    FallbackCancelled {
        fund: fund.clone(),
        by: by.clone(),
    }
    .publish(env);
    true
}

/// The configuration that prices a fund: its current one, or for a removed
/// fund the one of its pending re-admission.
fn pricing_config(env: &Env, fund: &Address) -> Result<FundConfig, Error> {
    if let Ok(config) = storage::fund(env, fund) {
        return Ok(config);
    }
    storage::pending_fund_change(env, fund)
        .filter(|p| is_live(env, p.eta))
        .map(|p| p.config)
        .ok_or(Error::FundNotAccepted)
}

/// Fresh readings of a configuration's NAV feed and, for a cross price, its
/// FX feed, each with the feed's own decimals. The NAV follows the pricing
/// rule: fresh primary, checked against an active fallback. Read when a
/// re-anchor is proposed and again when it applies: the references it
/// installs take these decimals, so a feed below `MIN_FEED_DECIMALS` is
/// refused, as at admission.
fn read_anchor(
    env: &Env,
    fund: &Address,
    config: &FundConfig,
) -> Result<(oracle::Reading, Option<oracle::Reading>), Error> {
    let fallback = storage::fallback_for_pricing(env, fund);
    let nav = oracle::read_primary_checked(
        env,
        config,
        check_feed_decimals(OracleClient::new(env, &config.oracle).decimals())?,
        fallback.as_ref(),
    )?;
    let fx = match &config.source {
        PriceSource::Cross(leg) => Some(oracle::read_fresh(
            env,
            &leg.oracle,
            &leg.asset,
            check_feed_decimals(OracleClient::new(env, &leg.oracle).decimals())?,
            leg.max_age_secs,
        )?),
        PriceSource::Direct => None,
    };
    Ok((nav, fx))
}

fn drop_pending_fund_limits(env: &Env, fund: &Address, by: &Address) -> bool {
    if storage::pending_fund_limits(env, fund).is_none() {
        return false;
    }
    storage::remove_pending_fund_limits(env, fund);
    FundLimitsChangeCancelled {
        fund: fund.clone(),
        by: by.clone(),
    }
    .publish(env);
    true
}

/// Drops every proposal a governor makes alone, when the role changes hands.
/// Fund replacements, fallbacks and fund limits carry a steward's signature
/// and stay. Stablecoin registrations stay too, as they cannot be listed:
/// only the governor in office applies one (`apply_stablecoin_change`).
fn drop_governor_proposals(env: &Env, by: &Address) {
    drop_pending_upgrade(env, by);
    drop_pending_guardian(env, by);
    drop_pending_forced_guardian(env, by);
    drop_pending_max_term(env, by);
    drop_pending_envelope(env, by);
    // Bounded by MAX_PENDING_CURRENCY_CAPS.
    for currency in storage::pending_currency_caps(env).keys() {
        drop_pending_currency_cap(env, &currency, by);
    }
}

/// Consumes the pending upgrade if it names `wasm_hash` and its delay has
/// elapsed.
fn take_due_upgrade(env: &Env, wasm_hash: &BytesN<32>) -> Result<(), Error> {
    let pending = storage::pending_upgrade(env).ok_or(Error::NotProposed)?;
    if pending.wasm_hash != *wasm_hash {
        return Err(Error::NotProposed);
    }
    ensure_due(env, pending.eta)?;
    storage::remove_pending_upgrade(env);
    Ok(())
}

/// Validates a fund configuration and computes the runtime state it would
/// install, without writing anything: envelope, oracle currencies, decimals,
/// fresh NAV and FX readings, the currency rule under open repos, and the
/// base of an active fallback feed. Used at admission, at the proposal of a
/// replacement and again when the replacement applies.
///
/// A first admission anchors the references on the fresh readings: two keys
/// sign it and nobody is exposed yet. A replacement (or a re-admission)
/// keeps the references it finds, since whoever applies it picks the moment
/// and must not be able to re-anchor on a spot price; a new feed is accepted
/// only if it agrees with them (see `carry_nav_reference` and
/// `carry_fx_reference`). `check_path` turns that agreement check off for
/// the proposal of a removed fund's re-admission, which is checked at the
/// apply, after a possible re-anchor. `fx_anchor` is the rate stored by a
/// proposal that gives the fund its first FX leg.
fn prepare_fund(
    env: &Env,
    fund: &Address,
    config: &FundConfig,
    check_path: bool,
    fx_anchor: Option<i128>,
) -> Result<FundState, Error> {
    check_fund_config(env, config)?;
    // A steward is never a lender on its fund (MMF Regulation, Art. 35):
    // naming an approved lender as steward would make it both.
    if storage::lender_approved(env, fund, &config.steward) {
        return Err(Error::StewardCannotLend);
    }
    let nav_oracle = OracleClient::new(env, &config.oracle);
    let nav_decimals = check_feed_decimals(nav_oracle.decimals())?;
    let fx_decimals = match &config.source {
        PriceSource::Cross(fx) => {
            check_feed_decimals(OracleClient::new(env, &fx.oracle).decimals())?
        }
        PriceSource::Direct => 0,
    };
    let nav = oracle::read_fresh(
        env,
        &config.oracle,
        &config.oracle_asset,
        nav_decimals,
        config.nav_max_age_secs,
    )?;
    let rate = match &config.source {
        PriceSource::Cross(fx) => Some(oracle::read_fresh(
            env,
            &fx.oracle,
            &fx.asset,
            fx_decimals,
            fx.max_age_secs,
        )?),
        PriceSource::Direct => None,
    };
    let previous = storage::fund_state(env, fund).ok();
    let current = storage::fund(env, fund).ok();
    if let Some(previous) = &previous {
        if previous.outstanding > 0 && previous.currency != config.currency {
            return Err(Error::CurrencyMismatch);
        }
    }
    // A fallback backs up one NAV oracle: a new oracle in another base would
    // make the two feeds incomparable. Remove the fallback first.
    if let Some((feed, _)) = storage::fallback(env, fund) {
        if OracleClient::new(env, &feed.oracle).base() != nav_oracle.base() {
            return Err(Error::CurrencyMismatch);
        }
    }
    let (reference_nav, reference_time) = match &previous {
        None => (nav.price.mantissa(), nav.timestamp),
        Some(previous) => carry_nav_reference(
            current.as_ref(),
            config,
            previous,
            &nav,
            nav_decimals,
            check_path,
        )?,
    };
    let reference_fx = match (&config.source, &rate) {
        (PriceSource::Cross(leg), Some(rate)) => carry_fx_reference(
            current.as_ref(),
            previous.as_ref(),
            leg,
            rate,
            fx_decimals,
            check_path,
            fx_anchor,
        )?,
        _ => 0,
    };
    Ok(FundState {
        currency: config.currency.clone(),
        share_decimals: token_io::decimals(env, fund),
        nav_decimals,
        fx_decimals,
        reference_nav,
        reference_time,
        reference_fx,
        outstanding: previous.as_ref().map_or(0, |s| s.outstanding),
        frozen: previous.as_ref().is_some_and(|s| s.frozen),
    })
}

/// The NAV reference a replacement installs: the current one, expressed with
/// the new feed's decimals. When the NAV feed changes (oracle or asset, or
/// the fund was removed and nothing is known of it), the new feed's reading
/// must lie in the corridor around that reference, with the current
/// corridor settings when there are any: a feed that disagrees with the path
/// the fund has followed is refused, whoever picks the moment of the apply.
/// As for any valuation, the corridor grows over at most the NAV age bound
/// (`oracle::check_corridor`): after a long quiet spell or a long removal
/// the check is no wider than one NAV age after the reference (verification
/// of review finding arith-2, 20 October 2026). A fund whose NAV outgrew it
/// is refreshed or re-anchored first.
fn carry_nav_reference(
    current: Option<&FundConfig>,
    next: &FundConfig,
    previous: &FundState,
    nav: &oracle::Reading,
    nav_decimals: u32,
    check_path: bool,
) -> Result<(i128, u64), Error> {
    let reference =
        math::rescale_floor(previous.reference_nav, previous.nav_decimals, nav_decimals)?;
    let same_feed =
        current.is_some_and(|c| c.oracle == next.oracle && c.oracle_asset == next.oracle_asset);
    if check_path && !same_feed {
        let anchored = FundState {
            reference_nav: reference,
            nav_decimals,
            ..previous.clone()
        };
        oracle::check_corridor(current.unwrap_or(next), &anchored, nav)?;
    }
    Ok((reference, previous.reference_time))
}

/// The FX reference a replacement installs. The current reference stays,
/// expressed with the new feed's decimals; when the FX leg changes (oracle or
/// asset), the new rate must lie within the current band around it. Without
/// an earlier FX reference (the fund was priced directly), the proposal
/// takes the rate it reads as the anchor (`fx_anchor` is then `None`), and
/// the apply keeps that anchor if its own rate lies within the leg's band
/// of it: whoever applies does not pick the anchor.
fn carry_fx_reference(
    current: Option<&FundConfig>,
    previous: Option<&FundState>,
    next: &FxLeg,
    rate: &oracle::Reading,
    fx_decimals: u32,
    check_path: bool,
    fx_anchor: Option<i128>,
) -> Result<i128, Error> {
    let Some(previous) = previous.filter(|p| p.reference_fx > 0) else {
        return match fx_anchor {
            None => Ok(rate.price.mantissa()),
            Some(anchor) if math::within_band(rate.price.mantissa(), anchor, next.band_bps)? => {
                Ok(anchor)
            }
            Some(_) => Err(Error::PriceOutOfBand),
        };
    };
    let reference = math::rescale_floor(previous.reference_fx, previous.fx_decimals, fx_decimals)?;
    let current_leg = current.and_then(|c| match &c.source {
        PriceSource::Cross(leg) => Some(leg),
        PriceSource::Direct => None,
    });
    if !check_path
        || current_leg.is_some_and(|leg| leg.oracle == next.oracle && leg.asset == next.asset)
    {
        return Ok(reference);
    }
    let band = current_leg.map_or(next.band_bps, |leg| leg.band_bps);
    if !math::within_band(rate.price.mantissa(), reference, band)? {
        return Err(Error::PriceOutOfBand);
    }
    Ok(reference)
}

/// Writes a validated configuration and its state, and records its steward
/// as the one a later re-admission must hear from. Proposals made against
/// the configuration it replaces go: pending loosened limits and a pending
/// re-anchor (both read against the old settings), and a pending fallback
/// when the steward who signed it is no longer the steward. They are
/// cancelled by the contract itself, as no caller chose it.
fn install_fund(env: &Env, fund: Address, config: FundConfig, state: FundState) {
    let by = env.current_contract_address();
    drop_pending_fund_limits(env, &fund, &by);
    drop_pending_reanchor(env, &fund, &by);
    if storage::steward_on_record(env, &fund).is_some_and(|previous| previous != config.steward) {
        drop_pending_fallback(env, &fund, &by);
        // A recovery and a backup concern the steward leaving office; the
        // new one names its own backup.
        drop_pending_steward_recovery(env, &fund, &by);
        drop_pending_steward_backup(env, &fund, &by);
        storage::remove_steward_backup(env, &fund);
    }
    storage::set_fund(env, &fund, &config);
    storage::set_fund_state(env, &fund, &state);
    storage::set_last_steward(env, &fund, &config.steward);
    mark_funds_admitted(env);
    storage::bump_instance(env);
    FundSet {
        fund,
        oracle: config.oracle,
        haircut_bps: config.haircut_bps,
    }
    .publish(env);
}

/// Checks a fallback feed for a fund and returns its decimals, when it is
/// proposed and again when it is applied.
///
/// A fallback is a second source: never the primary feed itself, and it must
/// agree with a fresh primary. A stale or silent primary refuses it, with
/// the primary's error, instead of letting it be installed compared with
/// nothing (review finding oracle-5, 20 October 2026). The divergence
/// tolerance is capped by the envelope's corridor floor: the floor is how
/// far below the model the protocol lets a NAV fall before it calls the
/// price faulty, so two feeds of the same NAV that differ by more than that
/// cannot both be right. The age limit may not exceed the envelope's NAV
/// age nor the fund's own limit for its primary feed: a backup older than
/// the primary would be allowed to be is no backup.
fn check_fallback(
    env: &Env,
    fund: &Address,
    config: &FundConfig,
    feed: &FallbackFeed,
) -> Result<u32, Error> {
    let envelope = storage::envelope(env);
    if feed.max_age_secs == 0
        || feed.max_age_secs > envelope.max_nav_age_secs.min(config.nav_max_age_secs)
        || feed.max_divergence_bps == 0
        || feed.max_divergence_bps > envelope.max_corridor_floor_bps
        || (feed.oracle == config.oracle && feed.asset == config.oracle_asset)
    {
        return Err(Error::OutsideEnvelope);
    }
    let fallback = OracleClient::new(env, &feed.oracle);
    if fallback.base() != OracleClient::new(env, &config.oracle).base() {
        return Err(Error::CurrencyMismatch);
    }
    let decimals = check_feed_decimals(fallback.decimals())?;
    let state = storage::fund_state(env, fund)?;
    // The feed must track the shares now, and agree with a fresh primary.
    let backup = oracle::read_fallback(env, config, feed, decimals, state.nav_decimals)?;
    let nav = oracle::read_fresh(
        env,
        &config.oracle,
        &config.oracle_asset,
        state.nav_decimals,
        config.nav_max_age_secs,
    )?;
    if !math::within_band(
        backup.price.mantissa(),
        nav.price.mantissa(),
        feed.max_divergence_bps,
    )? {
        return Err(Error::PriceDivergence);
    }
    Ok(decimals)
}

/// The decimals of a NAV, FX or fallback feed, refused below
/// `MIN_FEED_DECIMALS`: at admission, at a replacement, and when a fallback
/// or a re-anchor is proposed or applied.
fn check_feed_decimals(decimals: u32) -> Result<u32, Error> {
    if decimals < MIN_FEED_DECIMALS {
        return Err(Error::OutsideEnvelope);
    }
    Ok(decimals)
}

/// Sends the shares a closed repo owes. When the token refuses, the shares
/// stay in the contract, recorded for `to` (decision S9).
fn deliver_shares(env: &Env, repo_id: u64, fund: &Address, to: &Address, shares: i128) {
    if token_io::try_push(env, fund, to, shares) {
        return;
    }
    defer_shares(env, repo_id, fund, to, shares);
}

/// Keeps the shares a closed repo owes in the contract, recorded for `to`
/// until `release` delivers them: after a token refusal (decision S9), or
/// for seized shares whose recipient is not approved (decision S8).
fn defer_shares(env: &Env, repo_id: u64, fund: &Address, to: &Address, shares: i128) {
    storage::set_pending_release(
        env,
        repo_id,
        &PendingRelease {
            fund: fund.clone(),
            to: to.clone(),
            shares,
        },
    );
    ReleaseDeferred {
        repo_id,
        to: to.clone(),
        shares,
    }
    .publish(env);
}

/// Smallest haircut, in basis points, that covers a fund's NAV corridor: a
/// true NAV at the corridor's bottom and a wrong reading at its top lie at
/// most two floors plus one NAV age bound of growth apart (`math::corridor`),
/// the growth rounded up. Review findings arith-2, oracle-1 and econ-1 of
/// 20 October 2026; the fixtures' 200 / 10 / 500 / 26 h need 22.
fn corridor_haircut_bps(config: &FundConfig) -> Result<i128, Error> {
    let growth = math::mul_div_ceil(
        i128::from(config.max_yield_bps),
        i128::from(config.nav_max_age_secs),
        math::YEAR_SECS,
    )?;
    i128::from(config.corridor_floor_bps)
        .checked_mul(2)
        .and_then(|floors| floors.checked_add(growth))
        .ok_or(Error::ArithmeticOverflow)
}

/// Checks a fund configuration against the envelope, its haircut against
/// its NAV corridor, and the currencies its oracles report in.
fn check_fund_config(env: &Env, config: &FundConfig) -> Result<(), Error> {
    let envelope = storage::envelope(env);
    let haircut = Bps::haircut(config.haircut_bps)?;
    if haircut.get() < envelope.min_haircut_bps
        || config.corridor_floor_bps > envelope.max_corridor_floor_bps
        || config.max_yield_bps > envelope.max_yield_bps
        || config.nav_max_age_secs == 0
        || config.nav_max_age_secs > envelope.max_nav_age_secs
    {
        return Err(Error::OutsideEnvelope);
    }
    // The envelope's cross-invariant: each bound may hold on its own while
    // the haircut leaves part of the corridor uncovered.
    if i128::from(haircut.get()) < corridor_haircut_bps(config)? {
        return Err(Error::OutsideEnvelope);
    }
    if config.max_principal_per_repo <= 0
        || config.max_outstanding <= 0
        || config.max_principal_per_repo > config.max_outstanding
    {
        return Err(Error::InvalidAmount);
    }
    let nav_base = OracleClient::new(env, &config.oracle).base();
    match &config.source {
        PriceSource::Direct => {
            if nav_base != Asset::Other(config.currency.clone()) {
                return Err(Error::CurrencyMismatch);
            }
        }
        PriceSource::Cross(fx) => {
            let fx_haircut = Bps::haircut(fx.haircut_bps)?;
            haircut.plus(fx_haircut)?;
            if fx_haircut.get() < envelope.min_fx_haircut_bps
                || fx.max_age_secs == 0
                || fx.max_age_secs > envelope.max_fx_age_secs
                || fx.band_bps == 0
                || fx.band_bps > envelope.max_fx_band_bps
            {
                return Err(Error::OutsideEnvelope);
            }
            // S22. The valuation divides by the higher of the rate and the
            // reference (`oracle::value`), so an admitted rate overvalues
            // the shares by at most the band.
            if fx.band_bps > fx.haircut_bps {
                return Err(Error::FxBandExceedsHaircut);
            }
            if OracleClient::new(env, &fx.oracle).base() != nav_base
                || fx.asset != Asset::Other(config.currency.clone())
            {
                return Err(Error::CurrencyMismatch);
            }
        }
    }
    Ok(())
}

fn set_reference(
    env: &Env,
    fund: &Address,
    state: &mut FundState,
    nav: i128,
    timestamp: u64,
) -> PriceData {
    state.reference_nav = nav;
    state.reference_time = timestamp;
    storage::set_fund_state(env, fund, state);
    ReferenceUpdated {
        fund: fund.clone(),
        nav,
        timestamp,
    }
    .publish(env);
    PriceData {
        price: nav,
        timestamp,
    }
}

fn interest_due(env: &Env, repo: &Repo) -> Result<i128, Error> {
    let elapsed = env
        .ledger()
        .timestamp()
        .saturating_sub(repo.opened_at)
        .max(MIN_TERM_SECS);
    math::interest(repo.principal, repo.rate_bps, math::ceil_to_hour(elapsed)?)
}

/// Removes a repo's principal from the fund and currency totals. The fund
/// state outlives the fund's registry entry, so this works after a removal.
fn release_outstanding(env: &Env, repo: &Repo) -> Result<(), Error> {
    let mut state = storage::fund_state(env, &repo.fund)?;
    state.outstanding = state
        .outstanding
        .checked_sub(repo.principal)
        .ok_or(Error::ArithmeticOverflow)?
        .max(0);
    storage::set_fund_state(env, &repo.fund, &state);
    let total = storage::currency_outstanding(env, &state.currency)
        .checked_sub(repo.principal)
        .ok_or(Error::ArithmeticOverflow)?
        .max(0);
    storage::set_currency_outstanding(env, &state.currency, total);
    Ok(())
}

#[cfg(test)]
mod test;
#[cfg(test)]
mod test_math;
#[cfg(test)]
mod test_perf;
