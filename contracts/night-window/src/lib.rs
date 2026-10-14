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
//! - guardian: pauses new entries, nothing else;
//! - steward, one per fund (the issuer's key): approves lenders, tunes its
//!   fund inside the envelope, freezes its fund, marks sponsor offers;
//! - anyone: refreshes a fund's NAV reference inside the corridor, applies a
//!   change whose time delay has elapsed, retries a deferred share release.
//!
//! The pause stops new offers and new repos; it never blocks a repurchase, a
//! withdrawal of an offer or a seizure. Upgrades, replacements of an admitted
//! fund and fallback NAV feeds wait for a time delay, during which the
//! guardian can cancel them (decision S7). Security baseline, invariants and
//! decisions: `docs/securite.md`.

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
    Asset, DataKey, FallbackFeed, FundConfig, FundState, FxLeg, Offer, PendingCurrencyCapChange,
    PendingEnvelopeChange, PendingFallback, PendingFundChange, PendingFundLimitsChange,
    PendingGuardianChange, PendingMaxTermChange, PendingRelease, PendingUpgrade, PriceData,
    PriceSource, Quote, Repo, RepoStatus, RiskEnvelope, StablecoinConfig,
};

use events::*;
use math::Bps;

contractmeta!(key = "binver", val = "0.3.0");
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
/// Most funds with an active fallback feed: each one keeps its decimals in
/// instance storage, which every invocation loads.
pub const MAX_FALLBACKS: u32 = 16;
/// Most currencies with a pending cap increase at the same time; they share
/// one instance entry.
pub const MAX_PENDING_CURRENCY_CAPS: u32 = 8;

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
    /// Deploys the contract with its governor, who is also the first guardian.
    pub fn __constructor(env: Env, admin: Address) {
        storage::set_governor(&env, &admin);
        storage::set_guardian(&env, &admin);
        storage::set_max_term(&env, DEFAULT_MAX_TERM_SECS);
        storage::set_envelope(&env, &default_envelope());
        storage::set_timelock_delay(&env, DEFAULT_TIMELOCK_SECS);
        env.storage().instance().set(&DataKey::NextOfferId, &1u64);
        env.storage().instance().set(&DataKey::NextRepoId, &1u64);
    }

    // -- Governor -----------------------------------------------------------

    /// Version of the contract interface. Bump on every incompatible change.
    pub fn version() -> u32 {
        3
    }

    /// The governor (historical name kept for interface stability).
    pub fn admin(env: Env) -> Address {
        storage::governor(&env)
    }

    /// Proposes `new_admin` as governor. Nothing changes until the proposed
    /// address accepts (decision S7: a typo cannot lose the role). Requires
    /// the current governor.
    pub fn set_admin(env: Env, new_admin: Address) {
        let current = storage::require_governor(&env);
        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);
        storage::bump_instance(&env);
        AdminProposed {
            current,
            proposed: new_admin,
        }
        .publish(&env);
    }

    /// Completes a governor handover. Requires the proposed address. The
    /// proposals the previous governor made alone (upgrade, guardian, term
    /// ceiling, envelope, currency caps) are dropped: a handover is often the
    /// answer to a compromised key, and the new governor re-proposes what it
    /// wants.
    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(Error::Unauthorized)?;
        pending.require_auth();
        let previous = storage::governor(&env);
        storage::set_governor(&env, &pending);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        drop_governor_proposals(&env, &pending);
        storage::bump_instance(&env);
        AdminChanged {
            previous,
            admin: pending,
        }
        .publish(&env);
        Ok(())
    }

    /// Time delay applied to upgrades, fund replacements and fallback feeds,
    /// in seconds.
    pub fn timelock_delay(env: Env) -> u64 {
        storage::timelock_delay(&env, DEFAULT_TIMELOCK_SECS)
    }

    /// Sets the time delay, between one minute and thirty days. Until a fund
    /// is first admitted nothing is at stake, so any value in that range is
    /// accepted (a demonstration may run with minutes); from then on, the
    /// delay may only grow, or a compromised governor would shorten the
    /// window before acting. Proposals already made keep their eta. Requires
    /// the governor.
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

    /// Proposes new contract code, applicable by `upgrade` once the delay has
    /// elapsed. Replaces any earlier proposal. Requires the governor.
    pub fn propose_upgrade(env: Env, wasm_hash: BytesN<32>) -> Result<(), Error> {
        storage::require_governor(&env);
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

    /// The proposed upgrade, unless it has expired.
    pub fn pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        storage::pending_upgrade(&env).filter(|p| is_live(&env, p.eta))
    }

    /// Withdraws the proposed upgrade. `caller` must be the governor or the
    /// guardian: the guardian's veto is what the delay is for.
    pub fn cancel_upgrade(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        if !is_governor_or_guardian(&env, &caller) {
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

    /// Replaces the contract code with the proposed WASM, once its delay has
    /// elapsed. The WASM must already be uploaded; storage and address are
    /// kept. Requires the governor. The signature is the one of version 2,
    /// so failures are raised as typed contract errors.
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

    /// Sets the ceiling for a repo term, in seconds. A decrease applies at
    /// once: it only tightens, and it drops a pending increase. After the
    /// first admission, an increase lengthens the exposure of every offer, so
    /// it waits for the time delay and applies through
    /// `apply_max_term_change` (decision S7). Requires the governor.
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

    /// Applies a queued increase of the term ceiling once its delay has
    /// elapsed. Anyone may call it.
    pub fn apply_max_term_change(env: Env) -> Result<(), Error> {
        let pending: PendingMaxTermChange =
            storage::instance_value(&env, &DataKey::PendingMaxTerm).ok_or(Error::NotProposed)?;
        ensure_due(&env, pending.eta)?;
        storage::remove_instance(&env, &DataKey::PendingMaxTerm);
        install_max_term(&env, pending.max_term);
        Ok(())
    }

    /// Withdraws a queued increase of the term ceiling. `caller` must be the
    /// governor or the guardian.
    pub fn cancel_max_term_change(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        if !is_governor_or_guardian(&env, &caller) {
            return Err(Error::Unauthorized);
        }
        if !drop_pending_max_term(&env, &caller) {
            return Err(Error::NotProposed);
        }
        storage::bump_instance(&env);
        Ok(())
    }

    /// The queued increase of the term ceiling, unless it has expired.
    pub fn pending_max_term_change(env: Env) -> Option<PendingMaxTermChange> {
        storage::instance_value::<PendingMaxTermChange>(&env, &DataKey::PendingMaxTerm)
            .filter(|p| is_live(&env, p.eta))
    }

    pub fn guardian(env: Env) -> Address {
        storage::guardian(&env)
    }

    /// Appoints the guardian. Before the first admission it applies at once.
    /// Afterwards it waits for the time delay and applies through
    /// `apply_guardian_change`, and the current guardian can cancel it: a
    /// governor key alone cannot remove the veto inside the window in which
    /// that veto is needed (decision S7). Requires the governor. The
    /// signature is the one of version 2, so failures are raised as typed
    /// contract errors.
    pub fn set_guardian(env: Env, guardian: Address) {
        storage::require_governor(&env);
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

    /// Appoints the proposed guardian once the delay has elapsed. Anyone may
    /// call it.
    pub fn apply_guardian_change(env: Env) -> Result<(), Error> {
        let pending: PendingGuardianChange =
            storage::instance_value(&env, &DataKey::PendingGuardian).ok_or(Error::NotProposed)?;
        ensure_due(&env, pending.eta)?;
        storage::remove_instance(&env, &DataKey::PendingGuardian);
        install_guardian(&env, pending.guardian);
        Ok(())
    }

    /// Withdraws a proposed guardian change. `caller` must be the governor
    /// or the current guardian.
    pub fn cancel_guardian_change(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        if !is_governor_or_guardian(&env, &caller) {
            return Err(Error::Unauthorized);
        }
        if !drop_pending_guardian(&env, &caller) {
            return Err(Error::NotProposed);
        }
        storage::bump_instance(&env);
        Ok(())
    }

    /// The proposed guardian, unless the proposal has expired.
    pub fn pending_guardian_change(env: Env) -> Option<PendingGuardianChange> {
        storage::instance_value::<PendingGuardianChange>(&env, &DataKey::PendingGuardian)
            .filter(|p| is_live(&env, p.eta))
    }

    /// Passes the guardian role to `guardian`, at once. Requires the current
    /// guardian: a guardian can always hand its role over, so a key rotation
    /// never waits.
    pub fn hand_over_guardian(env: Env, guardian: Address) {
        storage::guardian(&env).require_auth();
        install_guardian(&env, guardian);
    }

    /// Imposes a guardian without the current one, for a guardian key that is
    /// lost or hostile and cancels every ordinary change. It waits for the
    /// longest delay, thirty days in public, and only the governor can cancel
    /// it: the guardian it replaces has no veto here, or a lost key would
    /// freeze governance forever. Replaces an earlier forced change. Requires
    /// the governor. The signature returns nothing like `set_guardian`, so
    /// failures are raised as typed contract errors.
    pub fn force_guardian_change(env: Env, guardian: Address) {
        storage::require_governor(&env);
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

    /// Appoints the forced guardian once its thirty days have elapsed.
    /// Anyone may call it.
    pub fn apply_forced_guardian_change(env: Env) -> Result<(), Error> {
        let pending: PendingGuardianChange =
            storage::instance_value(&env, &DataKey::PendingForcedGuardian)
                .ok_or(Error::NotProposed)?;
        ensure_due(&env, pending.eta)?;
        storage::remove_instance(&env, &DataKey::PendingForcedGuardian);
        install_guardian(&env, pending.guardian);
        Ok(())
    }

    /// Withdraws a forced guardian change. Requires the governor, and only
    /// the governor.
    pub fn cancel_forced_guardian_change(env: Env) -> Result<(), Error> {
        let governor = storage::require_governor(&env);
        if !drop_pending_forced_guardian(&env, &governor) {
            return Err(Error::NotProposed);
        }
        storage::bump_instance(&env);
        Ok(())
    }

    /// The forced guardian change, unless it has expired.
    pub fn pending_forced_guardian_change(env: Env) -> Option<PendingGuardianChange> {
        storage::instance_value::<PendingGuardianChange>(&env, &DataKey::PendingForcedGuardian)
            .filter(|p| is_live(&env, p.eta))
    }

    pub fn envelope(env: Env) -> RiskEnvelope {
        storage::envelope(&env)
    }

    /// Sets the risk envelope. Applies to fund settings made afterwards. An
    /// envelope that only tightens (every minimum at least the current one,
    /// every maximum at most the current one) applies at once and drops a
    /// pending loosening. After the first admission, any loosening waits for
    /// the time delay and applies through `apply_envelope_change` (decision
    /// S7). Requires the governor.
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

    /// Applies a queued envelope once its delay has elapsed. Anyone may call
    /// it.
    pub fn apply_envelope_change(env: Env) -> Result<(), Error> {
        let pending: PendingEnvelopeChange =
            storage::instance_value(&env, &DataKey::PendingEnvelope).ok_or(Error::NotProposed)?;
        ensure_due(&env, pending.eta)?;
        check_envelope(&pending.envelope)?;
        storage::remove_instance(&env, &DataKey::PendingEnvelope);
        install_envelope(&env, pending.envelope);
        Ok(())
    }

    /// Withdraws a queued envelope. `caller` must be the governor or the
    /// guardian.
    pub fn cancel_envelope_change(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        if !is_governor_or_guardian(&env, &caller) {
            return Err(Error::Unauthorized);
        }
        if !drop_pending_envelope(&env, &caller) {
            return Err(Error::NotProposed);
        }
        storage::bump_instance(&env);
        Ok(())
    }

    /// The queued envelope, unless it has expired.
    pub fn pending_envelope_change(env: Env) -> Option<PendingEnvelopeChange> {
        storage::instance_value::<PendingEnvelopeChange>(&env, &DataKey::PendingEnvelope)
            .filter(|p| is_live(&env, p.eta))
    }

    /// Registers a stablecoin for a currency; its decimals are read from the
    /// token. Requires the governor.
    pub fn set_stablecoin(env: Env, stablecoin: Address, currency: Symbol) {
        storage::require_governor(&env);
        let config = StablecoinConfig {
            currency: currency.clone(),
            decimals: token_io::decimals(&env, &stablecoin),
        };
        storage::set_stablecoin(&env, &stablecoin, &config);
        storage::bump_instance(&env);
        StablecoinSet {
            stablecoin,
            currency,
        }
        .publish(&env);
    }

    /// Removes a stablecoin. Open repos and offers keep working for exits.
    /// Requires the governor.
    pub fn remove_stablecoin(env: Env, stablecoin: Address) -> Result<(), Error> {
        storage::require_governor(&env);
        storage::remove_stablecoin(&env, &stablecoin)?;
        StablecoinRemoved { stablecoin }.publish(&env);
        Ok(())
    }

    pub fn get_stablecoin(env: Env, stablecoin: Address) -> Option<StablecoinConfig> {
        storage::stablecoin(&env, &stablecoin).ok()
    }

    /// Caps open principals in a currency. Unset means zero: no lending until
    /// the governor sets it. A decrease applies at once and drops a pending
    /// increase. After the first admission, an increase raises the exposure
    /// of every lender in that currency, so it waits for the time delay and
    /// applies through `apply_currency_cap_change` (decision S7). Requires
    /// the governor.
    pub fn set_currency_cap(env: Env, currency: Symbol, cap: i128) -> Result<(), Error> {
        let governor = storage::require_governor(&env);
        if cap < 0 {
            return Err(Error::InvalidAmount);
        }
        if storage::past_bootstrap(&env) && cap > storage::currency_cap(&env, &currency) {
            let mut pending = storage::pending_currency_caps(&env);
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

    /// Applies a queued currency cap increase once its delay has elapsed.
    /// Anyone may call it.
    pub fn apply_currency_cap_change(env: Env, currency: Symbol) -> Result<(), Error> {
        let mut pending = storage::pending_currency_caps(&env);
        let change = pending.get(currency.clone()).ok_or(Error::NotProposed)?;
        ensure_due(&env, change.eta)?;
        pending.remove(currency.clone());
        storage::set_pending_currency_caps(&env, &pending);
        install_currency_cap(&env, currency, change.cap);
        Ok(())
    }

    /// Withdraws a queued currency cap increase. `caller` must be the
    /// governor or the guardian.
    pub fn cancel_currency_cap_change(
        env: Env,
        currency: Symbol,
        caller: Address,
    ) -> Result<(), Error> {
        caller.require_auth();
        if !is_governor_or_guardian(&env, &caller) {
            return Err(Error::Unauthorized);
        }
        if !drop_pending_currency_cap(&env, &currency, &caller) {
            return Err(Error::NotProposed);
        }
        storage::bump_instance(&env);
        Ok(())
    }

    /// The queued cap increase of a currency, unless it has expired.
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

    /// Admits a fund, or proposes a replacement of its configuration.
    /// Requires both the governor and the fund's steward: a two-key
    /// admission. A replacement also requires the current steward, and
    /// cannot change the currency while repos are open. Checks the
    /// configuration against the envelope, checks the oracles report in the
    /// right currency, reads the decimals and fresh prices.
    ///
    /// A first admission applies at once: no offer can list the fund yet, so
    /// nobody is exposed to it. A replacement changes the oracle or the
    /// haircut under existing offers, so it is stored and applies through
    /// `apply_fund_change` once the time delay has elapsed (decision S7). A
    /// fund that was removed keeps its runtime state, so its re-admission is
    /// a replacement too: removing then re-admitting cannot skip the delay,
    /// nor the issuer: the steward on record (the last installed one, kept
    /// after a removal) must sign when the new configuration names another.
    /// A replacement keeps the NAV and FX references unless it changes the
    /// feed, and then the new feed must agree with them. Open repos keep
    /// their frozen terms (invariant I9).
    pub fn set_fund(env: Env, fund: Address, config: FundConfig) -> Result<(), Error> {
        storage::require_governor(&env);
        config.steward.require_auth();
        if let Some(on_record) = storage::steward_on_record(&env, &fund) {
            if on_record != config.steward {
                on_record.require_auth();
            }
        }
        let state = prepare_fund(&env, &fund, &config)?;
        if storage::fund_state(&env, &fund).is_ok() {
            let eta = eta(&env)?;
            storage::set_pending_fund_change(&env, &fund, &PendingFundChange { config, eta });
            storage::mark_funds_admitted(&env);
            storage::bump_instance(&env);
            FundChangeProposed { fund, eta }.publish(&env);
            return Ok(());
        }
        install_fund(&env, fund, config, state);
        Ok(())
    }

    /// Applies a fund replacement whose delay has elapsed, within its grace
    /// period. Anyone may call it: the keys signed the proposal. The
    /// configuration is checked again now, with fresh prices. The references
    /// carry over from the current state, so the caller's choice of moment
    /// cannot re-anchor them on a spot price; a new feed must agree with
    /// them. On failure the proposal stays for a later attempt.
    pub fn apply_fund_change(env: Env, fund: Address) -> Result<(), Error> {
        let pending = storage::pending_fund_change(&env, &fund).ok_or(Error::NotProposed)?;
        ensure_due(&env, pending.eta)?;
        let state = prepare_fund(&env, &fund, &pending.config)?;
        storage::remove_pending_fund_change(&env, &fund);
        install_fund(&env, fund, pending.config, state);
        Ok(())
    }

    /// Withdraws a pending fund replacement. `caller` must be the governor,
    /// the guardian or the fund's current steward.
    pub fn cancel_fund_change(env: Env, fund: Address, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        if !is_governor_or_guardian(&env, &caller) && !is_steward(&env, &fund, &caller) {
            return Err(Error::Unauthorized);
        }
        if storage::pending_fund_change(&env, &fund).is_none() {
            return Err(Error::NotProposed);
        }
        storage::remove_pending_fund_change(&env, &fund);
        storage::bump_instance(&env);
        FundChangeCancelled { fund, by: caller }.publish(&env);
        Ok(())
    }

    /// The pending replacement of a fund, unless it has expired.
    pub fn pending_fund_change(env: Env, fund: Address) -> Option<PendingFundChange> {
        storage::pending_fund_change(&env, &fund).filter(|p| is_live(&env, p.eta))
    }

    /// Removes a fund from the registry, at once: removal never harms an open
    /// repo. Open repos on that fund can still be repurchased or seized:
    /// their terms are frozen. A pending replacement and the fallback feed go
    /// with it, so that nothing brings the fund back on its own. Requires
    /// the governor.
    pub fn remove_fund(env: Env, fund: Address) -> Result<(), Error> {
        let governor = storage::require_governor(&env);
        if !storage::has_fund(&env, &fund) {
            return Err(Error::FundNotAccepted);
        }
        storage::remove_fund(&env, &fund);
        if storage::pending_fund_change(&env, &fund).is_some() {
            storage::remove_pending_fund_change(&env, &fund);
            FundChangeCancelled {
                fund: fund.clone(),
                by: governor.clone(),
            }
            .publish(&env);
        }
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

    // -- Fallback NAV feed ----------------------------------------------------

    /// Proposes a fallback NAV feed for a fund. It is an oracle change, so it
    /// needs the same two keys as an admission and waits for the time delay.
    /// The feed must report in the NAV oracle's base, publish a fresh price
    /// for the shares now and agree with the primary feed when that one is
    /// fresh; its age limit stays within the envelope's NAV age, and its
    /// divergence tolerance within the envelope's corridor floor. Replaces
    /// any earlier proposal. At most `MAX_FALLBACKS` funds may have one.
    /// Requires the governor and the fund's steward.
    pub fn propose_fallback(env: Env, fund: Address, feed: FallbackFeed) -> Result<(), Error> {
        storage::require_governor(&env);
        let config = storage::fund(&env, &fund)?;
        config.steward.require_auth();
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

    /// Activates a proposed fallback feed once its delay has elapsed, after
    /// checking it again. Anyone may call it.
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

    /// Withdraws a proposed fallback feed. `caller` must be the governor, the
    /// guardian or the fund's steward.
    pub fn cancel_fallback(env: Env, fund: Address, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        if !is_governor_or_guardian(&env, &caller) && !is_steward(&env, &fund, &caller) {
            return Err(Error::Unauthorized);
        }
        if storage::pending_fallback(&env, &fund).is_none() {
            return Err(Error::NotProposed);
        }
        storage::remove_pending_fallback(&env, &fund);
        storage::bump_instance(&env);
        FallbackCancelled { fund, by: caller }.publish(&env);
        Ok(())
    }

    /// Removes a fund's fallback feed, at once: removing a source never
    /// loosens a check. It does stop valuation when the primary feed stops,
    /// so it takes more than one ordinary key: the guardian alone (the role
    /// that acts in emergencies), or the governor and the fund's steward
    /// together, `caller` being either of them; the other one must sign too.
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

    /// The fallback feed proposed for a fund, unless it has expired.
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

    /// Suspends new offers and new repos. `caller` must be the guardian or
    /// the governor. Exits stay open.
    pub fn pause(env: Env, caller: Address) -> Result<(), Error> {
        caller.require_auth();
        if caller != storage::guardian(&env) && caller != storage::governor(&env) {
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

    /// Lifts the pause. Requires the governor.
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

    /// Tunes a fund's haircut and caps inside the envelope. A change that
    /// only tightens (haircut not lower, caps not higher) applies at once and
    /// drops a pending loosening. Any loosening exposes the fund's lenders
    /// more on one key, so it waits for the time delay and applies through
    /// `apply_fund_limits_change`, during which the governor or the guardian
    /// can cancel it (decision S7). Requires the fund's steward. Open repos
    /// keep their frozen terms.
    pub fn set_fund_limits(
        env: Env,
        fund: Address,
        haircut_bps: u32,
        max_principal_per_repo: i128,
        max_outstanding: i128,
    ) -> Result<(), Error> {
        let current = storage::fund(&env, &fund)?;
        current.steward.require_auth();
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
        install_fund_limits(&env, fund, config);
        Ok(())
    }

    /// Applies a queued loosening of a fund's limits once its delay has
    /// elapsed, after checking it against the envelope again. Anyone may call
    /// it.
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

    /// Withdraws a queued loosening of a fund's limits. `caller` must be the
    /// governor, the guardian or the fund's steward.
    pub fn cancel_fund_limits_change(
        env: Env,
        fund: Address,
        caller: Address,
    ) -> Result<(), Error> {
        caller.require_auth();
        if !is_governor_or_guardian(&env, &caller) && !is_steward(&env, &fund, &caller) {
            return Err(Error::Unauthorized);
        }
        if !drop_pending_fund_limits(&env, &fund, &caller) {
            return Err(Error::NotProposed);
        }
        Ok(())
    }

    /// The queued loosening of a fund's limits, unless it has expired.
    pub fn pending_fund_limits_change(env: Env, fund: Address) -> Option<PendingFundLimitsChange> {
        storage::pending_fund_limits(&env, &fund).filter(|p| is_live(&env, p.eta))
    }

    /// Approves or revokes a lender for a fund, from the issuer's own list of
    /// authorized holders: seized shares can then always reach the lender
    /// (decision S8). Requires the fund's steward.
    pub fn approve_lender(
        env: Env,
        fund: Address,
        lender: Address,
        approved: bool,
    ) -> Result<(), Error> {
        let config = storage::fund(&env, &fund)?;
        config.steward.require_auth();
        storage::set_lender_approved(&env, &fund, &lender, approved);
        LenderApproval {
            fund,
            lender,
            approved,
        }
        .publish(&env);
        Ok(())
    }

    pub fn is_lender_approved(env: Env, fund: Address, lender: Address) -> bool {
        storage::lender_approved(&env, &fund, &lender)
    }

    /// Suspends or resumes new repos on a fund. Exits stay open. Requires the
    /// fund's steward.
    pub fn freeze_fund(env: Env, fund: Address, frozen: bool) -> Result<(), Error> {
        let config = storage::fund(&env, &fund)?;
        config.steward.require_auth();
        let mut state = storage::fund_state(&env, &fund)?;
        state.frozen = frozen;
        storage::set_fund_state(&env, &fund, &state);
        FundFrozen { fund, frozen }.publish(&env);
        Ok(())
    }

    /// Lowers the NAV reference to the oracle's current NAV, for instance after
    /// a legitimate drop. It can only lower it: upward, the reference follows
    /// the model path, so a steward who also runs the feed cannot inflate the
    /// collateral. Takes no price from the caller; the NAV follows the same
    /// rule as a valuation, so a fresh fallback stands in for a silent
    /// primary feed. Requires the fund's steward.
    pub fn reset_reference(env: Env, fund: Address) -> Result<PriceData, Error> {
        let config = storage::fund(&env, &fund)?;
        config.steward.require_auth();
        let mut state = storage::fund_state(&env, &fund)?;
        let fallback = storage::fallback_for_pricing(&env, &fund);
        let nav = oracle::read_nav(&env, &config, &state, fallback.as_ref())?;
        let lowered = nav.price.mantissa().min(state.reference_nav);
        let timestamp = nav.timestamp.max(state.reference_time);
        Ok(set_reference(&env, &fund, &mut state, lowered, timestamp))
    }

    /// Marks or unmarks an offer as its issuer's sponsor offer. The fund must
    /// be accepted by the offer. Requires the fund's steward.
    pub fn set_sponsor(env: Env, offer_id: u64, fund: Address, sponsor: bool) -> Result<(), Error> {
        let config = storage::fund(&env, &fund)?;
        config.steward.require_auth();
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

    /// Moves a fund's NAV reference forward when the oracle's NAV is fresh,
    /// newer and inside the corridor. The reference never falls and rises at
    /// most along the model path. Anyone may call it, like feeding a watchdog:
    /// it cannot be made to follow a faulty feed.
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

    /// Last NAV of a fund's shares as reported by its oracle, unchecked.
    pub fn fund_price(env: Env, fund: Address) -> Result<PriceData, Error> {
        let config = storage::fund(&env, &fund)?;
        OracleClient::new(&env, &config.oracle)
            .lastprice(&config.oracle_asset)
            .ok_or(Error::NoPrice)
    }

    /// What `shares` of `fund` can secure now in `stablecoin`, with every
    /// check `open_repo` applies to the price. Read-only.
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

    /// Lender deposits `amount` of `stablecoin` with their terms. The lender
    /// must be approved by the steward of every fund listed. Returns the
    /// offer identifier.
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
            if !storage::lender_approved(&env, &fund, &lender) {
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

    /// Lender takes back `amount` of the stablecoins not lent. Works while
    /// paused.
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

    /// Borrower locks `shares` of `fund` against `offer_id` and receives
    /// `principal` stablecoins in the same transaction, for `term` seconds.
    /// The contract refuses rather than adjusts: the borrower states what
    /// they want. Returns the repo identifier.
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
        // The steward may have revoked the lender since the offer was made:
        // a seized position must always be deliverable (decision S8).
        if !storage::lender_approved(&env, &fund, &offer.lender) {
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
        if let Some(next) = oracle::next_reference(&config, &state, &valuation.nav)? {
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
            fund,
            shares,
            principal,
            rate_bps: offer.rate_bps,
            maturity,
        }
        .publish(&env);
        Ok(repo_id)
    }

    /// Interest due on a repo if it were repurchased now.
    pub fn repo_due(env: Env, repo_id: u64) -> Result<i128, Error> {
        let repo = storage::repo(&env, repo_id)?;
        if repo.status != RepoStatus::Open {
            return Err(Error::RepoNotOpen);
        }
        interest_due(&env, &repo)
    }

    /// Borrower repays principal and interest and gets the shares back.
    /// Allowed before and after maturity until the repo is seized, and while
    /// paused. Interest runs at the repo rate until repayment, per started
    /// hour, with a minimum of one hour. Principal and interest both flow back
    /// into the offer, where the lender withdraws them: nothing in the
    /// borrower's exit depends on an address the lender controls.
    ///
    /// If the share token refuses to return the shares (issuer freeze,
    /// allowlist removal, clawback), the debt still settles and the repo
    /// closes; the shares stay attributed to the borrower as a pending
    /// release that anyone can retry with `release` (decision S9). A failed
    /// repayment still reverts everything.
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

    /// From maturity, the lender seizes the shares of an unpaid repo and sends
    /// them to `to`, the lender or another address the fund's steward
    /// approved. Allowed while paused. If the share token refuses the
    /// delivery, the repo still defaults and the shares wait for `to` as a
    /// pending release (decision S9).
    pub fn seize(env: Env, repo_id: u64, to: Address) -> Result<(), Error> {
        let mut repo = storage::repo(&env, repo_id)?;
        if repo.status != RepoStatus::Open {
            return Err(Error::RepoNotOpen);
        }
        if env.ledger().timestamp() < repo.maturity {
            return Err(Error::NotMatured);
        }
        repo.lender.require_auth();
        if !storage::lender_approved(&env, &repo.fund, &to) {
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
        deliver_shares(&env, repo_id, &repo.fund, &to, repo.shares);
        Ok(())
    }

    /// Retries the delivery of shares a closed repo owes, to the beneficiary
    /// recorded. Anyone may call it, typically once the issuer has lifted the
    /// freeze or restored the allowlist; only the beneficiary can change
    /// itself (`redirect_release`), and no other path moves these shares.
    /// Works while paused. Returns whether the shares were delivered. A
    /// refusal is not an error: the call succeeds so that the record's TTL
    /// extension is kept, and the record waits for the next attempt.
    pub fn release(env: Env, repo_id: u64) -> Result<bool, Error> {
        let pending = storage::pending_release(&env, repo_id).ok_or(Error::NothingToRelease)?;
        // The transfer goes first so that a refusal leaves the record as it
        // is; Soroban forbids re-entering this contract during the call.
        if !token_io::try_push(&env, &pending.fund, &pending.to, pending.shares) {
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

    /// Changes where the shares awaiting release go, for instance when the
    /// issuer will never let the recorded address hold them again. After a
    /// repurchase the shares are the borrower's, so the borrower signs and
    /// picks any address; after a seizure they are the lender's, so the
    /// lender signs and picks another address the fund's steward approved
    /// (decision S8). Delivery still goes through `release`.
    pub fn redirect_release(env: Env, repo_id: u64, to: Address) -> Result<(), Error> {
        let mut pending = storage::pending_release(&env, repo_id).ok_or(Error::NothingToRelease)?;
        let repo = storage::repo(&env, repo_id)?;
        match repo.status {
            RepoStatus::Repurchased => repo.borrower.require_auth(),
            RepoStatus::Defaulted => {
                repo.lender.require_auth();
                if !storage::lender_approved(&env, &repo.fund, &to) {
                    return Err(Error::LenderNotApproved);
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

fn install_guardian(env: &Env, guardian: Address) {
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

fn is_governor_or_guardian(env: &Env, caller: &Address) -> bool {
    *caller == storage::governor(env) || *caller == storage::guardian(env)
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
/// and stay.
fn drop_governor_proposals(env: &Env, by: &Address) {
    if let Some(pending) = storage::pending_upgrade(env) {
        storage::remove_pending_upgrade(env);
        UpgradeCancelled {
            wasm_hash: pending.wasm_hash,
            by: by.clone(),
        }
        .publish(env);
    }
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
/// `carry_fx_reference`).
fn prepare_fund(env: &Env, fund: &Address, config: &FundConfig) -> Result<FundState, Error> {
    check_fund_config(env, config)?;
    let nav_oracle = OracleClient::new(env, &config.oracle);
    let nav_decimals = nav_oracle.decimals();
    let fx_decimals = match &config.source {
        PriceSource::Cross(fx) => OracleClient::new(env, &fx.oracle).decimals(),
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
        Some(previous) => {
            carry_nav_reference(current.as_ref(), config, previous, &nav, nav_decimals)?
        }
    };
    let reference_fx = match (&config.source, &rate) {
        (PriceSource::Cross(leg), Some(rate)) => {
            carry_fx_reference(current.as_ref(), previous.as_ref(), leg, rate, fx_decimals)?
        }
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
fn carry_nav_reference(
    current: Option<&FundConfig>,
    next: &FundConfig,
    previous: &FundState,
    nav: &oracle::Reading,
    nav_decimals: u32,
) -> Result<(i128, u64), Error> {
    let reference =
        math::rescale_floor(previous.reference_nav, previous.nav_decimals, nav_decimals)?;
    let same_feed =
        current.is_some_and(|c| c.oracle == next.oracle && c.oracle_asset == next.oracle_asset);
    if !same_feed {
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
/// an earlier FX reference (the fund was priced directly), there is nothing
/// to carry and the rate is anchored as at admission.
fn carry_fx_reference(
    current: Option<&FundConfig>,
    previous: Option<&FundState>,
    next: &FxLeg,
    rate: &oracle::Reading,
    fx_decimals: u32,
) -> Result<i128, Error> {
    let Some(previous) = previous.filter(|p| p.reference_fx > 0) else {
        return Ok(rate.price.mantissa());
    };
    let reference = math::rescale_floor(previous.reference_fx, previous.fx_decimals, fx_decimals)?;
    let current_leg = current.and_then(|c| match &c.source {
        PriceSource::Cross(leg) => Some(leg),
        PriceSource::Direct => None,
    });
    if current_leg.is_some_and(|leg| leg.oracle == next.oracle && leg.asset == next.asset) {
        return Ok(reference);
    }
    let band = current_leg.map_or(next.band_bps, |leg| leg.band_bps);
    if !math::within_band(rate.price.mantissa(), reference, band)? {
        return Err(Error::PriceOutOfBand);
    }
    Ok(reference)
}

/// Writes a validated configuration and its state, and records its steward
/// as the one a later re-admission must hear from.
fn install_fund(env: &Env, fund: Address, config: FundConfig, state: FundState) {
    storage::set_fund(env, &fund, &config);
    storage::set_fund_state(env, &fund, &state);
    storage::set_last_steward(env, &fund, &config.steward);
    storage::mark_funds_admitted(env);
    storage::bump_instance(env);
    FundSet {
        fund,
        oracle: config.oracle,
        haircut_bps: config.haircut_bps,
    }
    .publish(env);
}

/// Checks a fallback feed for a fund and returns its decimals.
///
/// The divergence tolerance is capped by the envelope's corridor floor: the
/// floor is how far below the model the protocol lets a NAV fall before it
/// calls the price faulty, so two feeds of the same NAV that differ by more
/// than that cannot both be right. The age limit may not exceed the
/// envelope's NAV age nor the fund's own limit for its primary feed: a
/// backup older than the primary would be allowed to be is no backup.
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
    {
        return Err(Error::OutsideEnvelope);
    }
    let fallback = OracleClient::new(env, &feed.oracle);
    if fallback.base() != OracleClient::new(env, &config.oracle).base() {
        return Err(Error::CurrencyMismatch);
    }
    let decimals = fallback.decimals();
    let state = storage::fund_state(env, fund)?;
    // The feed must track the shares now, and agree with a fresh primary.
    oracle::read_fallback(env, config, feed, decimals, state.nav_decimals)?;
    let candidate = (feed.clone(), decimals);
    if let Err(Error::PriceDivergence) = oracle::read_nav(env, config, &state, Some(&candidate)) {
        return Err(Error::PriceDivergence);
    }
    Ok(decimals)
}

/// Sends the shares a closed repo owes. When the token refuses, the shares
/// stay in the contract, recorded for `to` (decision S9).
fn deliver_shares(env: &Env, repo_id: u64, fund: &Address, to: &Address, shares: i128) {
    if token_io::try_push(env, fund, to, shares) {
        return;
    }
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

/// Checks a fund configuration against the envelope and the currencies its
/// oracles report in.
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
