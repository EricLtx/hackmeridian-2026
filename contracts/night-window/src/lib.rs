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
//! - anyone: refreshes a fund's NAV reference inside the corridor.
//!
//! The pause stops new offers and new repos; it never blocks a repurchase, a
//! withdrawal of an offer or a seizure. Security baseline, invariants and
//! decisions: `docs/securite.md`.

use soroban_sdk::{
    contract, contractimpl, contractmeta, Address, BytesN, ContractExecutable, Env, Symbol, Vec,
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
    Asset, DataKey, FundConfig, FundState, FxLeg, Offer, PriceData, PriceSource, Quote, Repo,
    RepoStatus, RiskEnvelope, StablecoinConfig,
};

use events::*;
use math::Bps;

contractmeta!(key = "binver", val = "0.2.0");
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

/// Envelope at deployment. The governor may tighten or widen it.
pub fn default_envelope() -> RiskEnvelope {
    RiskEnvelope {
        min_haircut_bps: 100,
        min_fx_haircut_bps: 150,
        max_corridor_floor_bps: 50,
        max_yield_bps: 1_000,
        max_nav_age_secs: 3 * 24 * 60 * 60,
        max_fx_age_secs: 3 * 24 * 60 * 60,
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
        env.storage().instance().set(&DataKey::NextOfferId, &1u64);
        env.storage().instance().set(&DataKey::NextRepoId, &1u64);
    }

    // -- Governor -----------------------------------------------------------

    /// Version of the contract interface. Bump on every incompatible change.
    pub fn version() -> u32 {
        2
    }

    /// The governor (historical name kept for interface stability).
    pub fn admin(env: Env) -> Address {
        storage::governor(&env)
    }

    /// Hands the governor role to `new_admin`. Requires the current governor.
    pub fn set_admin(env: Env, new_admin: Address) {
        let previous = storage::require_governor(&env);
        storage::set_governor(&env, &new_admin);
        storage::bump_instance(&env);
        AdminChanged {
            previous,
            admin: new_admin,
        }
        .publish(&env);
    }

    /// Replaces the contract code. The WASM must already be uploaded; storage
    /// and address are kept. Requires the governor.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) {
        storage::require_governor(&env);
        env.deployer()
            .update_current_contract(ContractExecutable::Wasm(new_wasm_hash));
    }

    pub fn max_term(env: Env) -> u64 {
        storage::max_term(&env, DEFAULT_MAX_TERM_SECS)
    }

    /// Sets the ceiling for a repo term, in seconds. Requires the governor.
    pub fn set_max_term(env: Env, max_term: u64) -> Result<(), Error> {
        storage::require_governor(&env);
        if max_term < MIN_TERM_SECS {
            return Err(Error::InvalidTerm);
        }
        storage::set_max_term(&env, max_term);
        storage::bump_instance(&env);
        MaxTermChanged { max_term }.publish(&env);
        Ok(())
    }

    pub fn guardian(env: Env) -> Address {
        storage::guardian(&env)
    }

    /// Appoints the guardian. Requires the governor.
    pub fn set_guardian(env: Env, guardian: Address) {
        storage::require_governor(&env);
        storage::set_guardian(&env, &guardian);
        storage::bump_instance(&env);
        GuardianChanged { guardian }.publish(&env);
    }

    pub fn envelope(env: Env) -> RiskEnvelope {
        storage::envelope(&env)
    }

    /// Sets the risk envelope. Applies to fund settings made afterwards.
    /// Requires the governor.
    pub fn set_envelope(env: Env, envelope: RiskEnvelope) -> Result<(), Error> {
        storage::require_governor(&env);
        Bps::haircut(envelope.min_haircut_bps)?;
        Bps::haircut(envelope.min_fx_haircut_bps)?;
        Bps::haircut(envelope.max_corridor_floor_bps)?;
        if envelope.max_yield_bps > BPS_DENOMINATOR {
            return Err(Error::OutsideEnvelope);
        }
        storage::set_envelope(&env, &envelope);
        storage::bump_instance(&env);
        EnvelopeChanged { envelope }.publish(&env);
        Ok(())
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
    /// the governor sets it. Requires the governor.
    pub fn set_currency_cap(env: Env, currency: Symbol, cap: i128) -> Result<(), Error> {
        storage::require_governor(&env);
        if cap < 0 {
            return Err(Error::InvalidAmount);
        }
        storage::set_currency_cap(&env, &currency, cap);
        storage::bump_instance(&env);
        CurrencyCapSet { currency, cap }.publish(&env);
        Ok(())
    }

    pub fn currency_cap(env: Env, currency: Symbol) -> i128 {
        storage::currency_cap(&env, &currency)
    }

    pub fn currency_outstanding(env: Env, currency: Symbol) -> i128 {
        storage::currency_outstanding(&env, &currency)
    }

    /// Admits a fund, or replaces its configuration. Requires both the
    /// governor and the fund's steward: a two-key admission. Checks the
    /// configuration against the envelope, checks the oracles report in the
    /// right currency, reads the decimals, and sets the NAV reference from a
    /// fresh price. Open repos keep their frozen terms (invariant I9).
    pub fn set_fund(env: Env, fund: Address, config: FundConfig) -> Result<(), Error> {
        storage::require_governor(&env);
        config.steward.require_auth();
        check_fund_config(&env, &config)?;

        let nav_decimals = OracleClient::new(&env, &config.oracle).decimals();
        let fx_decimals = match &config.source {
            PriceSource::Cross(fx) => OracleClient::new(&env, &fx.oracle).decimals(),
            PriceSource::Direct => 0,
        };
        let nav = oracle::read_fresh(
            &env,
            &config.oracle,
            &config.oracle_asset,
            nav_decimals,
            config.nav_max_age_secs,
        )?;
        let previous = storage::fund_state(&env, &fund).ok();
        let state = FundState {
            currency: config.currency.clone(),
            share_decimals: token_io::decimals(&env, &fund),
            nav_decimals,
            fx_decimals,
            reference_nav: nav.price.mantissa(),
            reference_time: nav.timestamp,
            outstanding: previous.as_ref().map_or(0, |s| s.outstanding),
            frozen: previous.as_ref().is_some_and(|s| s.frozen),
        };
        storage::set_fund(&env, &fund, &config);
        storage::set_fund_state(&env, &fund, &state);
        storage::bump_instance(&env);
        FundSet {
            fund,
            oracle: config.oracle,
            haircut_bps: config.haircut_bps,
        }
        .publish(&env);
        Ok(())
    }

    /// Removes a fund from the registry. Open repos on that fund can still be
    /// repurchased or seized: their terms are frozen. Requires the governor.
    pub fn remove_fund(env: Env, fund: Address) -> Result<(), Error> {
        storage::require_governor(&env);
        if !storage::has_fund(&env, &fund) {
            return Err(Error::FundNotAccepted);
        }
        storage::remove_fund(&env, &fund);
        storage::bump_instance(&env);
        FundRemoved { fund }.publish(&env);
        Ok(())
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

    /// Tunes a fund's haircut and caps inside the envelope. Requires the
    /// fund's steward. Open repos keep their frozen terms.
    pub fn set_fund_limits(
        env: Env,
        fund: Address,
        haircut_bps: u32,
        max_principal_per_repo: i128,
        max_outstanding: i128,
    ) -> Result<(), Error> {
        let mut config = storage::fund(&env, &fund)?;
        config.steward.require_auth();
        config.haircut_bps = haircut_bps;
        config.max_principal_per_repo = max_principal_per_repo;
        config.max_outstanding = max_outstanding;
        check_fund_config(&env, &config)?;
        storage::set_fund(&env, &fund, &config);
        FundLimitsSet {
            fund,
            haircut_bps,
            max_principal_per_repo,
            max_outstanding,
        }
        .publish(&env);
        Ok(())
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

    /// Re-anchors the NAV corridor on the oracle's current NAV, for instance
    /// after a legitimate drop. Takes no price from the caller. Requires the
    /// fund's steward.
    pub fn reset_reference(env: Env, fund: Address) -> Result<PriceData, Error> {
        let config = storage::fund(&env, &fund)?;
        config.steward.require_auth();
        let mut state = storage::fund_state(&env, &fund)?;
        let nav = oracle::read_fresh(
            &env,
            &config.oracle,
            &config.oracle_asset,
            state.nav_decimals,
            config.nav_max_age_secs,
        )?;
        Ok(set_reference(
            &env,
            &fund,
            &mut state,
            nav.price.mantissa(),
            nav.timestamp,
        ))
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

    /// Moves a fund's NAV reference forward to the oracle's current NAV when
    /// it is fresh, newer and inside the corridor. Anyone may call it, like
    /// feeding a watchdog: it can only follow the predicted path.
    pub fn refresh_reference(env: Env, fund: Address) -> Result<PriceData, Error> {
        let config = storage::fund(&env, &fund)?;
        let mut state = storage::fund_state(&env, &fund)?;
        let nav = oracle::read_fresh(
            &env,
            &config.oracle,
            &config.oracle_asset,
            state.nav_decimals,
            config.nav_max_age_secs,
        )?;
        oracle::check_corridor(&config, &state, &nav)?;
        if nav.timestamp > state.reference_time {
            return Ok(set_reference(
                &env,
                &fund,
                &mut state,
                nav.price.mantissa(),
                nav.timestamp,
            ));
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
        let valuation = oracle::value(&env, &config, &state)?;
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
        if shares <= 0 || principal <= 0 {
            return Err(Error::InvalidAmount);
        }
        if term < MIN_TERM_SECS || term > offer.max_term || term > Self::max_term(env.clone()) {
            return Err(Error::InvalidTerm);
        }
        if principal > offer.available {
            return Err(Error::InsufficientOffer);
        }

        let valuation = oracle::value(&env, &config, &state)?;
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
        if valuation.nav.timestamp > state.reference_time {
            // The NAV passed the corridor: move the reference along its path.
            state.reference_nav = valuation.nav.price.mantissa();
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
    /// paused. Interest runs at the repo rate until repayment, with a minimum
    /// of one hour; the principal flows back into the offer and the interest
    /// goes to the lender.
    pub fn repurchase(env: Env, repo_id: u64) -> Result<(), Error> {
        let mut repo = storage::repo(&env, repo_id)?;
        if repo.status != RepoStatus::Open {
            return Err(Error::RepoNotOpen);
        }
        repo.borrower.require_auth();
        let interest = interest_due(&env, &repo)?;

        let mut offer = storage::offer(&env, repo.offer_id)?;
        offer.available = offer
            .available
            .checked_add(repo.principal)
            .ok_or(Error::ArithmeticOverflow)?;
        storage::set_offer(&env, repo.offer_id, &offer);
        release_outstanding(&env, &repo)?;
        repo.status = RepoStatus::Repurchased;
        storage::set_repo(&env, repo_id, &repo);

        token_io::pull(&env, &repo.stablecoin, &repo.borrower, repo.principal)?;
        if interest > 0 {
            token_io::forward(
                &env,
                &repo.stablecoin,
                &repo.borrower,
                &repo.lender,
                interest,
            );
        }
        token_io::push(&env, &repo.fund, &repo.borrower, repo.shares);

        RepoRepurchased {
            repo_id,
            principal: repo.principal,
            interest,
        }
        .publish(&env);
        Ok(())
    }

    /// From maturity, the lender seizes the shares of an unpaid repo and sends
    /// them to `to`, the lender or another address the fund's steward
    /// approved. Allowed while paused.
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
        token_io::push(&env, &repo.fund, &to, repo.shares);

        RepoSeized {
            repo_id,
            to,
            shares: repo.shares,
        }
        .publish(&env);
        Ok(())
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
    math::interest(repo.principal, repo.rate_bps, elapsed)
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
