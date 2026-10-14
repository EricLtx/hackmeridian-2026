//! Storage access. Every write of a persistent entry extends its TTL; every
//! privileged path extends the instance TTL (not the code: see `bump_instance`).
//! Deadlines never derive from TTLs.

use soroban_sdk::{panic_with_error, Address, Env, Map, Symbol};

use crate::error::Error;
use crate::types::{
    DataKey, FallbackFeed, FundConfig, FundState, Offer, PendingCurrencyCapChange, PendingFallback,
    PendingFundChange, PendingFundLimitsChange, PendingRelease, PendingUpgrade, Repo, RiskEnvelope,
    StablecoinConfig,
};

// Ledgers close about every 5 seconds: 17,280 ledgers a day.
const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const BUMP_TO: u32 = 120 * DAY_IN_LEDGERS;

/// Extends the contract instance only, never the code. `instance().extend_ttl`
/// would extend the WASM code entry as well, and rent grows with entry size:
/// with a 75 KB code entry, the user who crossed the threshold paid about
/// 530 XLM of rent on testnet (October 2026), above the largest fee one
/// transaction may carry. The code is kept alive by the operator instead
/// (monitoring TTL detector, ExtendFootprintTtl), in small increments.
pub fn bump_instance(env: &Env) {
    env.deployer().extend_ttl_for_contract_instance(
        env.current_contract_address(),
        BUMP_THRESHOLD,
        BUMP_TO,
    );
}

fn bump(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, BUMP_THRESHOLD, BUMP_TO);
}

fn put<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(env: &Env, key: &DataKey, value: &V) {
    env.storage().persistent().set(key, value);
    bump(env, key);
}

/// Reads a protocol-wide value kept in instance storage, such as a pending
/// governance change.
pub fn instance_value<V: soroban_sdk::TryFromVal<Env, soroban_sdk::Val>>(
    env: &Env,
    key: &DataKey,
) -> Option<V> {
    env.storage().instance().get(key)
}

pub fn set_instance<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(
    env: &Env,
    key: &DataKey,
    value: &V,
) {
    env.storage().instance().set(key, value);
}

pub fn remove_instance(env: &Env, key: &DataKey) {
    env.storage().instance().remove(key);
}

// -- Roles -------------------------------------------------------------------

pub fn governor(env: &Env) -> Address {
    // Set by the constructor, so always present. A typed error beats an
    // opaque trap if that assumption ever breaks (e.g. a faulty migration).
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

/// Loads the governor from storage and requires its authorization.
pub fn require_governor(env: &Env) -> Address {
    let governor = governor(env);
    governor.require_auth();
    governor
}

pub fn set_governor(env: &Env, governor: &Address) {
    env.storage().instance().set(&DataKey::Admin, governor);
}

pub fn guardian(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Guardian)
        .unwrap_or_else(|| governor(env))
}

pub fn set_guardian(env: &Env, guardian: &Address) {
    env.storage().instance().set(&DataKey::Guardian, guardian);
}

pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&DataKey::Paused, &paused);
}

pub fn ensure_not_paused(env: &Env) -> Result<(), Error> {
    if is_paused(env) {
        return Err(Error::Paused);
    }
    Ok(())
}

// -- Protocol settings -------------------------------------------------------

pub fn envelope(env: &Env) -> RiskEnvelope {
    env.storage()
        .instance()
        .get(&DataKey::Envelope)
        .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialized))
}

pub fn set_envelope(env: &Env, envelope: &RiskEnvelope) {
    env.storage().instance().set(&DataKey::Envelope, envelope);
}

pub fn max_term(env: &Env, default: u64) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::MaxTerm)
        .unwrap_or(default)
}

pub fn set_max_term(env: &Env, max_term: u64) {
    env.storage().instance().set(&DataKey::MaxTerm, &max_term);
}

/// Returns the next identifier of a counter and advances it.
pub fn next_id(env: &Env, key: DataKey) -> Result<u64, Error> {
    let id: u64 = env.storage().instance().get(&key).unwrap_or(1);
    let next = id.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
    env.storage().instance().set(&key, &next);
    Ok(id)
}

pub fn currency_cap(env: &Env, currency: &Symbol) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::CurrencyCap(currency.clone()))
        .unwrap_or(0)
}

pub fn set_currency_cap(env: &Env, currency: &Symbol, cap: i128) {
    env.storage()
        .instance()
        .set(&DataKey::CurrencyCap(currency.clone()), &cap);
}

pub fn currency_outstanding(env: &Env, currency: &Symbol) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::CurrencyOutstanding(currency.clone()))
        .unwrap_or(0)
}

pub fn set_currency_outstanding(env: &Env, currency: &Symbol, amount: i128) {
    env.storage()
        .instance()
        .set(&DataKey::CurrencyOutstanding(currency.clone()), &amount);
}

// -- Registries ---------------------------------------------------------------

pub fn stablecoin(env: &Env, token: &Address) -> Result<StablecoinConfig, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Stablecoin(token.clone()))
        .ok_or(Error::StablecoinNotAccepted)
}

pub fn set_stablecoin(env: &Env, token: &Address, config: &StablecoinConfig) {
    put(env, &DataKey::Stablecoin(token.clone()), config);
}

pub fn remove_stablecoin(env: &Env, token: &Address) -> Result<(), Error> {
    let key = DataKey::Stablecoin(token.clone());
    if !env.storage().persistent().has(&key) {
        return Err(Error::StablecoinNotAccepted);
    }
    env.storage().persistent().remove(&key);
    Ok(())
}

pub fn fund(env: &Env, fund: &Address) -> Result<FundConfig, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Fund(fund.clone()))
        .ok_or(Error::FundNotAccepted)
}

pub fn has_fund(env: &Env, fund: &Address) -> bool {
    env.storage().persistent().has(&DataKey::Fund(fund.clone()))
}

pub fn set_fund(env: &Env, fund: &Address, config: &FundConfig) {
    put(env, &DataKey::Fund(fund.clone()), config);
}

pub fn remove_fund(env: &Env, fund: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::Fund(fund.clone()));
}

pub fn fund_state(env: &Env, fund: &Address) -> Result<FundState, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::FundState(fund.clone()))
        .ok_or(Error::FundNotAccepted)
}

pub fn set_fund_state(env: &Env, fund: &Address, state: &FundState) {
    put(env, &DataKey::FundState(fund.clone()), state);
}

pub fn lender_approved(env: &Env, fund: &Address, lender: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::Lender(fund.clone(), lender.clone()))
        .unwrap_or(false)
}

pub fn set_lender_approved(env: &Env, fund: &Address, lender: &Address, approved: bool) {
    let key = DataKey::Lender(fund.clone(), lender.clone());
    if approved {
        put(env, &key, &true);
    } else {
        env.storage().persistent().remove(&key);
    }
}

// -- Positions ----------------------------------------------------------------

pub fn offer(env: &Env, offer_id: u64) -> Result<Offer, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Offer(offer_id))
        .ok_or(Error::OfferNotFound)
}

pub fn set_offer(env: &Env, offer_id: u64, offer: &Offer) {
    put(env, &DataKey::Offer(offer_id), offer);
}

pub fn repo(env: &Env, repo_id: u64) -> Result<Repo, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Repo(repo_id))
        .ok_or(Error::RepoNotFound)
}

pub fn set_repo(env: &Env, repo_id: u64, repo: &Repo) {
    put(env, &DataKey::Repo(repo_id), repo);
}

pub fn pending_release(env: &Env, repo_id: u64) -> Option<PendingRelease> {
    env.storage()
        .persistent()
        .get(&DataKey::PendingRelease(repo_id))
}

pub fn set_pending_release(env: &Env, repo_id: u64, release: &PendingRelease) {
    put(env, &DataKey::PendingRelease(repo_id), release);
}

pub fn remove_pending_release(env: &Env, repo_id: u64) {
    env.storage()
        .persistent()
        .remove(&DataKey::PendingRelease(repo_id));
}

// -- Time delay (decision S7) --------------------------------------------------

pub fn timelock_delay(env: &Env, default: u64) -> u64 {
    env.storage()
        .instance()
        .get(&DataKey::TimelockDelay)
        .unwrap_or(default)
}

pub fn set_timelock_delay(env: &Env, delay: u64) {
    env.storage()
        .instance()
        .set(&DataKey::TimelockDelay, &delay);
}

/// Whether value can be at stake: a fund was admitted, or an offer was ever
/// created. The second test covers a contract upgraded from version 2, whose
/// funds were admitted before the flag existed: offers need admitted funds.
pub fn past_bootstrap(env: &Env) -> bool {
    let admitted: bool = env
        .storage()
        .instance()
        .get(&DataKey::FundsAdmitted)
        .unwrap_or(false);
    let next_offer: u64 = env
        .storage()
        .instance()
        .get(&DataKey::NextOfferId)
        .unwrap_or(1);
    admitted || next_offer > 1
}

pub fn mark_funds_admitted(env: &Env) {
    env.storage().instance().set(&DataKey::FundsAdmitted, &true);
}

pub fn pending_upgrade(env: &Env) -> Option<PendingUpgrade> {
    env.storage().instance().get(&DataKey::PendingUpgrade)
}

pub fn set_pending_upgrade(env: &Env, pending: &PendingUpgrade) {
    env.storage()
        .instance()
        .set(&DataKey::PendingUpgrade, pending);
}

pub fn remove_pending_upgrade(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingUpgrade);
}

pub fn pending_fund_change(env: &Env, fund: &Address) -> Option<PendingFundChange> {
    env.storage()
        .persistent()
        .get(&DataKey::PendingFundChange(fund.clone()))
}

pub fn set_pending_fund_change(env: &Env, fund: &Address, pending: &PendingFundChange) {
    put(env, &DataKey::PendingFundChange(fund.clone()), pending);
}

pub fn remove_pending_fund_change(env: &Env, fund: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::PendingFundChange(fund.clone()));
}

// -- Fallback NAV feed -----------------------------------------------------------

/// The active fallback feed of a fund and its decimals. The instance flag is
/// read first, so a fund without fallback touches no extra ledger entry.
pub fn fallback(env: &Env, fund: &Address) -> Option<(FallbackFeed, u32)> {
    let decimals: u32 = env
        .storage()
        .instance()
        .get(&DataKey::FallbackDecimals(fund.clone()))?;
    let feed: FallbackFeed = env
        .storage()
        .persistent()
        .get(&DataKey::Fallback(fund.clone()))?;
    Some((feed, decimals))
}

/// The active fallback feed, read to price the fund. Extends the entry's
/// TTL: the fallback is read by operations that may never write it again,
/// and an archived fallback would silently stop backing up the primary.
pub fn fallback_for_pricing(env: &Env, fund: &Address) -> Option<(FallbackFeed, u32)> {
    let active = fallback(env, fund)?;
    bump(env, &DataKey::Fallback(fund.clone()));
    Some(active)
}

pub fn fallback_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::FallbackCount)
        .unwrap_or(0)
}

/// Activates or replaces a fund's fallback. The decimals live in instance
/// storage, which every invocation loads: at most `max` funds may have one.
pub fn set_fallback(
    env: &Env,
    fund: &Address,
    feed: &FallbackFeed,
    decimals: u32,
    max: u32,
) -> Result<(), Error> {
    let flag = DataKey::FallbackDecimals(fund.clone());
    if !env.storage().instance().has(&flag) {
        let count = fallback_count(env);
        if count >= max {
            return Err(Error::LimitReached);
        }
        let next = count.checked_add(1).ok_or(Error::ArithmeticOverflow)?;
        env.storage().instance().set(&DataKey::FallbackCount, &next);
    }
    put(env, &DataKey::Fallback(fund.clone()), feed);
    env.storage().instance().set(&flag, &decimals);
    Ok(())
}

pub fn remove_fallback(env: &Env, fund: &Address) {
    let flag = DataKey::FallbackDecimals(fund.clone());
    if env.storage().instance().has(&flag) {
        let count = fallback_count(env).saturating_sub(1);
        env.storage()
            .instance()
            .set(&DataKey::FallbackCount, &count);
    }
    env.storage()
        .persistent()
        .remove(&DataKey::Fallback(fund.clone()));
    env.storage().instance().remove(&flag);
}

// -- Stewards, fund limits and currency caps -----------------------------------

/// The steward on record for a fund: the current configuration's, or after a
/// removal the last installed one's.
pub fn steward_on_record(env: &Env, fund: &Address) -> Option<Address> {
    if let Ok(config) = self::fund(env, fund) {
        return Some(config.steward);
    }
    env.storage()
        .persistent()
        .get(&DataKey::LastSteward(fund.clone()))
}

pub fn set_last_steward(env: &Env, fund: &Address, steward: &Address) {
    put(env, &DataKey::LastSteward(fund.clone()), steward);
}

pub fn pending_fund_limits(env: &Env, fund: &Address) -> Option<PendingFundLimitsChange> {
    env.storage()
        .persistent()
        .get(&DataKey::PendingFundLimits(fund.clone()))
}

pub fn set_pending_fund_limits(env: &Env, fund: &Address, pending: &PendingFundLimitsChange) {
    put(env, &DataKey::PendingFundLimits(fund.clone()), pending);
}

pub fn remove_pending_fund_limits(env: &Env, fund: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::PendingFundLimits(fund.clone()));
}

/// Pending currency cap increases, by currency. One instance entry, so that
/// a governor handover can clear them all.
pub fn pending_currency_caps(env: &Env) -> Map<Symbol, PendingCurrencyCapChange> {
    env.storage()
        .instance()
        .get(&DataKey::PendingCurrencyCaps)
        .unwrap_or_else(|| Map::new(env))
}

pub fn set_pending_currency_caps(env: &Env, pending: &Map<Symbol, PendingCurrencyCapChange>) {
    if pending.is_empty() {
        env.storage()
            .instance()
            .remove(&DataKey::PendingCurrencyCaps);
    } else {
        env.storage()
            .instance()
            .set(&DataKey::PendingCurrencyCaps, pending);
    }
}

/// Extends the TTL of a pending release whose delivery was refused: the
/// record may wait a long time for the issuer.
pub fn bump_pending_release(env: &Env, repo_id: u64) {
    bump(env, &DataKey::PendingRelease(repo_id));
}

pub fn pending_fallback(env: &Env, fund: &Address) -> Option<PendingFallback> {
    env.storage()
        .persistent()
        .get(&DataKey::PendingFallback(fund.clone()))
}

pub fn set_pending_fallback(env: &Env, fund: &Address, pending: &PendingFallback) {
    put(env, &DataKey::PendingFallback(fund.clone()), pending);
}

pub fn remove_pending_fallback(env: &Env, fund: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::PendingFallback(fund.clone()));
}
