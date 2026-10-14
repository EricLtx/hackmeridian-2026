//! Storage access. Every write of a persistent entry extends its TTL; every
//! privileged path extends the instance TTL. Deadlines never derive from TTLs.

use soroban_sdk::{panic_with_error, Address, Env, Symbol};

use crate::error::Error;
use crate::types::{DataKey, FundConfig, FundState, Offer, Repo, RiskEnvelope, StablecoinConfig};

// Ledgers close about every 5 seconds: 17,280 ledgers a day.
const DAY_IN_LEDGERS: u32 = 17_280;
const BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
const BUMP_TO: u32 = 120 * DAY_IN_LEDGERS;

pub fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(BUMP_THRESHOLD, BUMP_TO);
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
