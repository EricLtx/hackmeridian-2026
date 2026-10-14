#![cfg(test)]
// The security lints of the workspace target contract code. Tests assert,
// index and unwrap on purpose.
#![allow(
    clippy::arithmetic_side_effects,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
extern crate std;

use super::*;
use crate::math;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal, Symbol,
};

// ---------------------------------------------------------------------------
// Mock SEP-40 oracle
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone)]
enum MockKey {
    Base,
    Decimals,
    Price(Asset),
}

#[contract]
struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn __constructor(env: Env, base: Asset, decimals: u32) {
        env.storage().instance().set(&MockKey::Base, &base);
        env.storage().instance().set(&MockKey::Decimals, &decimals);
    }

    pub fn set_price(env: Env, asset: Asset, price: i128, timestamp: u64) {
        env.storage()
            .instance()
            .set(&MockKey::Price(asset), &PriceData { price, timestamp });
    }

    pub fn base(env: Env) -> Asset {
        env.storage().instance().get(&MockKey::Base).unwrap()
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&MockKey::Decimals).unwrap()
    }

    pub fn lastprice(env: Env, asset: Asset) -> Option<PriceData> {
        env.storage().instance().get(&MockKey::Price(asset))
    }
}

// ---------------------------------------------------------------------------
// Constants of the scenario
// ---------------------------------------------------------------------------

/// One token unit with 7 decimals, like every Stellar asset.
const ONE: i128 = 10_000_000;
const NAV_DECIMALS: u32 = 14;
/// 1.05 EUR per share.
const NAV_EUR: i128 = 105_000_000_000_000;
/// 1.17 USD per share.
const NAV_USD: i128 = 117_000_000_000_000;
/// 1.1188 USD per EUR, as read on the Reflector testnet FX feed on 14 Oct 2026.
const EUR_USD: i128 = 111_880_000_000_000;
const T0: u64 = 1_800_000_000;
const HOUR: u64 = 3_600;
const DAY: u64 = 86_400;
const RATE_BPS: u32 = 300;

fn eur(env: &Env) -> Symbol {
    Symbol::new(env, "EUR")
}

fn usd(env: &Env) -> Symbol {
    Symbol::new(env, "USD")
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

struct Fixture {
    env: Env,
    contract_id: Address,
    client: OpenWindowClient<'static>,
    governor: Address,
    guardian: Address,
    steward: Address,
    lender: Address,
    borrower: Address,
    shares: Address,
    eurc: Address,
    nav_oracle: Address,
    oracle: MockOracleClient<'static>,
}

fn leak<T>(value: T) -> &'static T {
    std::boxed::Box::leak(std::boxed::Box::new(value))
}

fn new_token(env: &Env) -> Address {
    let issuer = Address::generate(env);
    env.register_stellar_asset_contract_v2(issuer).address()
}

fn mint(env: &Env, token: &Address, to: &Address, amount: i128) {
    StellarAssetClient::new(env, token).mint(to, &amount);
}

fn balance(env: &Env, token: &Address, who: &Address) -> i128 {
    TokenClient::new(env, token).balance(who)
}

/// Deployed contract, roles, tokens and a EUR NAV oracle. Nothing admitted.
fn bare() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    let governor = Address::generate(&env);
    let contract_id = env.register(OpenWindow, (governor.clone(),));
    let client = OpenWindowClient::new(leak(env.clone()), leak(contract_id.clone()));
    let nav_oracle = env.register(MockOracle, (Asset::Other(eur(&env)), NAV_DECIMALS));
    let oracle = MockOracleClient::new(leak(env.clone()), leak(nav_oracle.clone()));
    let shares = new_token(&env);
    oracle.set_price(&Asset::Stellar(shares.clone()), &NAV_EUR, &T0);
    Fixture {
        guardian: governor.clone(),
        steward: Address::generate(&env),
        lender: Address::generate(&env),
        borrower: Address::generate(&env),
        eurc: new_token(&env),
        env,
        contract_id,
        client,
        governor,
        shares,
        nav_oracle,
        oracle,
    }
}

fn fund_config(f: &Fixture) -> FundConfig {
    FundConfig {
        oracle: f.nav_oracle.clone(),
        oracle_asset: Asset::Stellar(f.shares.clone()),
        haircut_bps: 200,
        steward: f.steward.clone(),
        currency: eur(&f.env),
        source: PriceSource::Direct,
        nav_max_age_secs: 26 * HOUR,
        corridor_floor_bps: 10,
        max_yield_bps: 500,
        max_principal_per_repo: 500_000 * ONE,
        max_outstanding: 5_000_000 * ONE,
    }
}

/// Fund admitted, EURC registered with a cap, lender approved, balances
/// minted, one offer of 100,000 EURC at 3 %.
fn ready() -> (Fixture, u64) {
    let f = bare();
    f.client.set_stablecoin(&f.eurc, &eur(&f.env));
    f.client.set_currency_cap(&eur(&f.env), &(10_000_000 * ONE));
    f.client.set_fund(&f.shares, &fund_config(&f));
    f.client.approve_lender(&f.shares, &f.lender, &true);
    mint(&f.env, &f.eurc, &f.lender, 1_000_000 * ONE);
    mint(&f.env, &f.eurc, &f.borrower, 100_000 * ONE);
    mint(&f.env, &f.shares, &f.borrower, 1_000_000 * ONE);
    let offer_id = f.client.create_offer(
        &f.lender,
        &f.eurc,
        &(100_000 * ONE),
        &RATE_BPS,
        &(7 * DAY),
        &vec![&f.env, f.shares.clone()],
    );
    (f, offer_id)
}

/// Opens a repo of 10,000 shares against 10,000 EURC for 64 hours.
fn open(f: &Fixture, offer_id: u64) -> u64 {
    f.client.open_repo(
        &f.borrower,
        &offer_id,
        &f.shares,
        &(10_000 * ONE),
        &(10_000 * ONE),
        &(64 * HOUR),
    )
}

fn advance(f: &Fixture, seconds: u64) {
    let now = f.env.ledger().timestamp();
    f.env.ledger().set_timestamp(now + seconds);
}

/// Publishes a NAV for the fund's shares, stamped at the current ledger time.
fn publish_nav(f: &Fixture, nav: i128) {
    let now = f.env.ledger().timestamp();
    f.oracle
        .set_price(&Asset::Stellar(f.shares.clone()), &nav, &now);
}

// ---------------------------------------------------------------------------
// Governor, guardian and envelope
// ---------------------------------------------------------------------------

#[test]
fn constructor_sets_roles_and_defaults() {
    let f = bare();
    assert_eq!(f.client.admin(), f.governor);
    assert_eq!(f.client.guardian(), f.governor);
    assert_eq!(f.client.version(), 2);
    assert_eq!(f.client.max_term(), DEFAULT_MAX_TERM_SECS);
    assert_eq!(f.client.envelope(), default_envelope());
    assert!(!f.client.is_paused());
    assert_eq!(f.client.currency_cap(&eur(&f.env)), 0);
}

#[test]
fn intruder_cannot_take_the_governor_role() {
    let f = bare();
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_admin",
            args: (intruder.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_set_admin(&intruder).is_err());
    assert_eq!(f.client.admin(), f.governor);
}

#[test]
fn governor_handover_takes_two_steps() {
    let f = bare();
    let successor = Address::generate(&f.env);
    f.client.set_admin(&successor);
    assert_eq!(f.client.admin(), f.governor);
    f.client.accept_admin();
    assert_eq!(f.env.auths()[0].0, successor);
    assert_eq!(f.client.admin(), successor);
    assert_eq!(f.client.try_accept_admin(), Err(Ok(Error::Unauthorized)));
}

#[test]
fn intruder_cannot_upgrade() {
    let f = bare();
    let intruder = Address::generate(&f.env);
    let hash = soroban_sdk::BytesN::from_array(&f.env, &[7u8; 32]);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "upgrade",
            args: (hash.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_upgrade(&hash).is_err());
}

#[test]
fn max_term_cannot_go_below_the_minimum_term() {
    let f = bare();
    assert_eq!(
        f.client.try_set_max_term(&(MIN_TERM_SECS - 1)),
        Err(Ok(Error::InvalidTerm))
    );
    assert_eq!(
        f.client.try_set_max_term(&(MAX_TERM_CEILING_SECS + 1)),
        Err(Ok(Error::InvalidTerm))
    );
    f.client.set_max_term(&(3 * DAY));
    assert_eq!(f.client.max_term(), 3 * DAY);
}

#[test]
fn envelope_rejects_a_haircut_of_one_unit() {
    let f = bare();
    let mut envelope = default_envelope();
    envelope.min_haircut_bps = 10_000;
    assert_eq!(
        f.client.try_set_envelope(&envelope),
        Err(Ok(Error::InvalidHaircut))
    );
}

#[test]
fn guardian_pauses_intruder_cannot_and_only_governor_unpauses() {
    let f = bare();
    let guardian = Address::generate(&f.env);
    f.client.set_guardian(&guardian);
    let intruder = Address::generate(&f.env);
    assert_eq!(f.client.try_pause(&intruder), Err(Ok(Error::Unauthorized)));
    f.client.pause(&guardian);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert!(f.client.is_paused());
    f.client.unpause();
    assert_eq!(f.env.auths()[0].0, f.governor);
    assert!(!f.client.is_paused());
}

// ---------------------------------------------------------------------------
// Fund admission: two keys, envelope, currencies, fresh price
// ---------------------------------------------------------------------------

#[test]
fn admission_requires_the_steward_signature_too() {
    let f = bare();
    let config = fund_config(&f);
    f.env.mock_auths(&[MockAuth {
        address: &f.governor,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_fund",
            args: (f.shares.clone(), config.clone()).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_set_fund(&f.shares, &config).is_err());
    assert!(f.client.get_fund(&f.shares).is_none());
}

#[test]
fn admission_reads_decimals_and_anchors_the_reference() {
    let f = bare();
    f.client.set_fund(&f.shares, &fund_config(&f));
    let state = f.client.get_fund_state(&f.shares).unwrap();
    assert_eq!(state.share_decimals, 7);
    assert_eq!(state.nav_decimals, NAV_DECIMALS);
    assert_eq!(state.reference_nav, NAV_EUR);
    assert_eq!(state.reference_time, T0);
    assert_eq!(state.outstanding, 0);
    assert_eq!(state.currency, eur(&f.env));
}

#[test]
fn admission_enforces_the_envelope() {
    let f = bare();
    let mut low_haircut = fund_config(&f);
    low_haircut.haircut_bps = 50;
    let mut wide_floor = fund_config(&f);
    wide_floor.corridor_floor_bps = 100;
    let mut no_age = fund_config(&f);
    no_age.nav_max_age_secs = 0;
    let mut fast_growth = fund_config(&f);
    fast_growth.max_yield_bps = 2_000;
    for config in [low_haircut, wide_floor, no_age, fast_growth] {
        assert_eq!(
            f.client.try_set_fund(&f.shares, &config),
            Err(Ok(Error::OutsideEnvelope))
        );
    }
    let mut caps = fund_config(&f);
    caps.max_principal_per_repo = caps.max_outstanding + 1;
    assert_eq!(
        f.client.try_set_fund(&f.shares, &caps),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn admission_refuses_an_oracle_in_the_wrong_currency() {
    let f = bare();
    let mut config = fund_config(&f);
    config.currency = usd(&f.env);
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::CurrencyMismatch))
    );
}

#[test]
fn admission_needs_a_fresh_price() {
    let f = bare();
    advance(&f, 27 * HOUR);
    assert_eq!(
        f.client.try_set_fund(&f.shares, &fund_config(&f)),
        Err(Ok(Error::StalePrice))
    );
    let unknown = new_token(&f.env);
    let mut config = fund_config(&f);
    config.oracle_asset = Asset::Stellar(unknown);
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::NoPrice))
    );
}

// ---------------------------------------------------------------------------
// Valuation: direct, cross, corridor, freshness
// ---------------------------------------------------------------------------

#[test]
fn quote_values_shares_minus_the_haircut() {
    let (f, _) = ready();
    let quote = f.client.quote(&f.shares, &(10_000 * ONE), &f.eurc);
    assert_eq!(quote.price, NAV_EUR);
    assert_eq!(quote.haircut_bps, 200);
    // 10,000 shares x 1.05 EUR x 98 % = 10,290 EUR.
    assert_eq!(quote.max_principal, 10_290 * ONE);
}

/// A fund whose NAV oracle reports in USD, borrowed against in EUR through an
/// FX feed reporting in the same USD base.
fn cross_fund() -> (Fixture, Address) {
    let f = bare();
    let usd_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    let usd_client = MockOracleClient::new(&f.env, &usd_oracle);
    usd_client.set_price(&Asset::Stellar(f.shares.clone()), &NAV_USD, &T0);
    let fx_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    MockOracleClient::new(&f.env, &fx_oracle).set_price(&Asset::Other(eur(&f.env)), &EUR_USD, &T0);
    let mut config = fund_config(&f);
    config.oracle = usd_oracle;
    config.source = PriceSource::Cross(FxLeg {
        oracle: fx_oracle.clone(),
        asset: Asset::Other(eur(&f.env)),
        haircut_bps: 200,
        max_age_secs: 3 * DAY,
        band_bps: 500,
    });
    f.client.set_stablecoin(&f.eurc, &eur(&f.env));
    f.client.set_fund(&f.shares, &config);
    (f, fx_oracle)
}

#[test]
fn cross_price_converts_the_nav_and_adds_the_fx_haircut() {
    let (f, _) = cross_fund();
    let quote = f.client.quote(&f.shares, &(10_000 * ONE), &f.eurc);
    let expected_price = NAV_USD * 10i128.pow(NAV_DECIMALS) / EUR_USD;
    assert_eq!(quote.price, expected_price);
    assert_eq!(quote.haircut_bps, 400);
    let value = 10_000 * ONE * expected_price / 10i128.pow(NAV_DECIMALS);
    assert_eq!(quote.max_principal, value * 9_600 / 10_000);
}

#[test]
fn cross_fund_refuses_an_fx_feed_in_another_base() {
    let f = bare();
    let usd_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    MockOracleClient::new(&f.env, &usd_oracle).set_price(
        &Asset::Stellar(f.shares.clone()),
        &NAV_USD,
        &T0,
    );
    let eur_based = f
        .env
        .register(MockOracle, (Asset::Other(eur(&f.env)), NAV_DECIMALS));
    let mut config = fund_config(&f);
    config.oracle = usd_oracle;
    config.source = PriceSource::Cross(FxLeg {
        oracle: eur_based,
        asset: Asset::Other(eur(&f.env)),
        haircut_bps: 200,
        max_age_secs: 3 * DAY,
        band_bps: 500,
    });
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::CurrencyMismatch))
    );
}

#[test]
fn cross_fund_refuses_an_fx_haircut_below_the_envelope() {
    let f = bare();
    let usd_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    MockOracleClient::new(&f.env, &usd_oracle).set_price(
        &Asset::Stellar(f.shares.clone()),
        &NAV_USD,
        &T0,
    );
    let fx = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    let mut config = fund_config(&f);
    config.oracle = usd_oracle;
    config.source = PriceSource::Cross(FxLeg {
        oracle: fx,
        asset: Asset::Other(eur(&f.env)),
        haircut_bps: 100,
        max_age_secs: 3 * DAY,
        band_bps: 500,
    });
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::OutsideEnvelope))
    );
}

/// Review finding M3: a faulty FX feed cannot inflate the collateral.
#[test]
fn fx_rate_outside_its_band_blocks_the_quote() {
    let (f, fx_oracle) = cross_fund();
    MockOracleClient::new(&f.env, &fx_oracle).set_price(
        &Asset::Other(eur(&f.env)),
        &(EUR_USD * 94 / 100),
        &T0,
    );
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );
    MockOracleClient::new(&f.env, &fx_oracle).set_price(
        &Asset::Other(eur(&f.env)),
        &(EUR_USD * 97 / 100),
        &T0,
    );
    assert!(f.client.try_quote(&f.shares, &ONE, &f.eurc).is_ok());
}

#[test]
fn stale_fx_rate_blocks_the_quote() {
    let (f, _) = cross_fund();
    advance(&f, 3 * DAY + 1);
    MockOracleClient::new(&f.env, &f.client.get_fund(&f.shares).unwrap().oracle).set_price(
        &Asset::Stellar(f.shares.clone()),
        &NAV_USD,
        &(T0 + 3 * DAY),
    );
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::StalePrice))
    );
}

#[test]
fn corridor_refuses_a_drop_below_the_floor() {
    let (f, _) = ready();
    // Floor is 10 bps: a 0.2 % drop is a faulty price, not a market move.
    publish_nav(&f, NAV_EUR * 998 / 1_000);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );
}

#[test]
fn corridor_refuses_a_jump_faster_than_the_maximum_yield() {
    let (f, _) = ready();
    advance(&f, DAY);
    // +1 % in a day while the corridor allows 5 % a year plus 0.1 %.
    publish_nav(&f, NAV_EUR * 101 / 100);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );
}

#[test]
fn corridor_follows_a_normal_accrual() {
    let (f, _) = ready();
    advance(&f, DAY);
    // 2.2 % a year is 0.006 % a day.
    publish_nav(&f, NAV_EUR + NAV_EUR * 6 / 100_000);
    assert!(f.client.try_quote(&f.shares, &ONE, &f.eurc).is_ok());
}

#[test]
fn stale_nav_blocks_the_quote() {
    let (f, _) = ready();
    advance(&f, 26 * HOUR + 1);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::StalePrice))
    );
}

#[test]
fn future_timestamp_is_an_invalid_price() {
    let (f, _) = ready();
    f.oracle
        .set_price(&Asset::Stellar(f.shares.clone()), &NAV_EUR, &(T0 + 10));
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::InvalidPrice))
    );
}

#[test]
fn anyone_refreshes_the_reference_along_the_corridor() {
    let (f, _) = ready();
    advance(&f, DAY);
    let nav = NAV_EUR + NAV_EUR * 6 / 100_000;
    publish_nav(&f, nav);
    f.env.set_auths(&[]);
    let reference = f.client.refresh_reference(&f.shares);
    assert_eq!(reference.price, nav);
    assert_eq!(
        f.client.get_fund_state(&f.shares).unwrap().reference_nav,
        nav
    );
}

/// Review finding H1: a feed publishing +floor at every ledger must not walk
/// the reference away. It may only follow the model path.
#[test]
fn reference_cannot_be_ratcheted_by_a_faulty_feed() {
    let (f, _) = ready();
    let mut nav = NAV_EUR;
    for _ in 0..700 {
        advance(&f, 5);
        nav = nav * 10_010 / 10_000;
        publish_nav(&f, nav);
        let _ = f.client.try_refresh_reference(&f.shares);
    }
    let state = f.client.get_fund_state(&f.shares).unwrap();
    let path = math::model_path(NAV_EUR, T0, T0 + 3_500, 500).unwrap();
    assert!(
        state.reference_nav <= path,
        "{} > {}",
        state.reference_nav,
        path
    );
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );
}

#[test]
fn refresh_cannot_follow_a_faulty_price() {
    let (f, _) = ready();
    publish_nav(&f, NAV_EUR / 2);
    assert_eq!(
        f.client.try_refresh_reference(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
}

#[test]
fn steward_cannot_raise_the_reference() {
    let (f, _) = ready();
    advance(&f, HOUR);
    publish_nav(&f, NAV_EUR + NAV_EUR / 1_000);
    assert_eq!(f.client.reset_reference(&f.shares).price, NAV_EUR);
}

#[test]
fn steward_re_anchors_after_a_legitimate_drop() {
    let (f, _) = ready();
    let nav = NAV_EUR * 99 / 100;
    publish_nav(&f, nav);
    assert_eq!(f.client.reset_reference(&f.shares).price, nav);
    assert_eq!(f.env.auths()[0].0, f.steward);
    assert!(f.client.try_quote(&f.shares, &ONE, &f.eurc).is_ok());
}

// ---------------------------------------------------------------------------
// Steward powers
// ---------------------------------------------------------------------------

#[test]
fn intruder_cannot_approve_a_lender() {
    let (f, _) = ready();
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "approve_lender",
            args: (f.shares.clone(), intruder.clone(), true).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f
        .client
        .try_approve_lender(&f.shares, &intruder, &true)
        .is_err());
    assert!(!f.client.is_lender_approved(&f.shares, &intruder));
}

#[test]
fn steward_tunes_limits_only_inside_the_envelope() {
    let (f, _) = ready();
    f.client
        .set_fund_limits(&f.shares, &300, &(1_000 * ONE), &(2_000 * ONE));
    assert_eq!(f.env.auths()[0].0, f.steward);
    assert_eq!(f.client.get_fund(&f.shares).unwrap().haircut_bps, 300);
    assert_eq!(
        f.client
            .try_set_fund_limits(&f.shares, &50, &(1_000 * ONE), &(2_000 * ONE)),
        Err(Ok(Error::OutsideEnvelope))
    );
}

#[test]
fn sponsor_mark_requires_the_fund_in_the_offer() {
    let (f, offer_id) = ready();
    f.client.set_sponsor(&offer_id, &f.shares, &true);
    assert!(f.client.get_offer(&offer_id).unwrap().sponsor);
    let other = new_token(&f.env);
    let mut config = fund_config(&f);
    config.oracle_asset = Asset::Stellar(other.clone());
    f.oracle
        .set_price(&Asset::Stellar(other.clone()), &NAV_EUR, &T0);
    f.client.set_fund(&other, &config);
    assert_eq!(
        f.client.try_set_sponsor(&offer_id, &other, &true),
        Err(Ok(Error::FundNotInOffer))
    );
}

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

#[test]
fn offer_pulls_the_stablecoins() {
    let (f, offer_id) = ready();
    assert_eq!(balance(&f.env, &f.eurc, &f.contract_id), 100_000 * ONE);
    assert_eq!(balance(&f.env, &f.eurc, &f.lender), 900_000 * ONE);
    let offer = f.client.get_offer(&offer_id).unwrap();
    assert_eq!(offer.available, 100_000 * ONE);
    assert!(!offer.sponsor);
}

#[test]
fn offer_checks() {
    let (f, _) = ready();
    let funds = vec![&f.env, f.shares.clone()];
    let unapproved = Address::generate(&f.env);
    mint(&f.env, &f.eurc, &unapproved, ONE);
    assert_eq!(
        f.client
            .try_create_offer(&unapproved, &f.eurc, &ONE, &RATE_BPS, &DAY, &funds),
        Err(Ok(Error::LenderNotApproved))
    );
    let unknown_coin = new_token(&f.env);
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &unknown_coin, &ONE, &RATE_BPS, &DAY, &funds),
        Err(Ok(Error::StablecoinNotAccepted))
    );
    let usdc = new_token(&f.env);
    f.client.set_stablecoin(&usdc, &usd(&f.env));
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &usdc, &ONE, &RATE_BPS, &DAY, &funds),
        Err(Ok(Error::CurrencyMismatch))
    );
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &f.eurc, &0, &RATE_BPS, &DAY, &funds),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &f.eurc, &ONE, &10_001, &DAY, &funds),
        Err(Ok(Error::InvalidRate))
    );
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &f.eurc, &ONE, &RATE_BPS, &(HOUR - 1), &funds),
        Err(Ok(Error::InvalidTerm))
    );
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &f.eurc, &ONE, &RATE_BPS, &(8 * DAY), &funds),
        Err(Ok(Error::InvalidTerm))
    );
    let duplicate = vec![&f.env, f.shares.clone(), f.shares.clone()];
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &f.eurc, &ONE, &RATE_BPS, &DAY, &duplicate),
        Err(Ok(Error::TooManyFunds))
    );
    let empty = soroban_sdk::Vec::<Address>::new(&f.env);
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &f.eurc, &ONE, &RATE_BPS, &DAY, &empty),
        Err(Ok(Error::TooManyFunds))
    );
    let mut nine = soroban_sdk::Vec::<Address>::new(&f.env);
    for _ in 0..9 {
        nine.push_back(Address::generate(&f.env));
    }
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &f.eurc, &ONE, &RATE_BPS, &DAY, &nine),
        Err(Ok(Error::TooManyFunds))
    );
    f.client.pause(&f.guardian);
    assert_eq!(
        f.client
            .try_create_offer(&f.lender, &f.eurc, &ONE, &RATE_BPS, &DAY, &funds),
        Err(Ok(Error::Paused))
    );
}

#[test]
fn withdrawal_returns_unlent_stablecoins_even_when_paused() {
    let (f, offer_id) = ready();
    f.client.pause(&f.guardian);
    f.client.withdraw_offer(&offer_id, &(40_000 * ONE));
    assert_eq!(f.env.auths()[0].0, f.lender);
    assert_eq!(
        f.client.get_offer(&offer_id).unwrap().available,
        60_000 * ONE
    );
    assert_eq!(balance(&f.env, &f.eurc, &f.lender), 940_000 * ONE);
    assert_eq!(
        f.client.try_withdraw_offer(&offer_id, &(60_000 * ONE + 1)),
        Err(Ok(Error::InsufficientOffer))
    );
}

#[test]
fn intruder_cannot_withdraw_an_offer() {
    let (f, offer_id) = ready();
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "withdraw_offer",
            args: (offer_id, ONE).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_withdraw_offer(&offer_id, &ONE).is_err());
}

// ---------------------------------------------------------------------------
// Opening a repo
// ---------------------------------------------------------------------------

#[test]
fn open_moves_shares_in_and_stablecoins_out_in_one_transaction() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    assert_eq!(f.env.auths()[0].0, f.borrower);
    assert_eq!(balance(&f.env, &f.shares, &f.contract_id), 10_000 * ONE);
    assert_eq!(balance(&f.env, &f.eurc, &f.borrower), 110_000 * ONE);
    let repo = f.client.get_repo(&repo_id).unwrap();
    assert_eq!(repo.status, RepoStatus::Open);
    assert_eq!(repo.lender, f.lender);
    assert_eq!(repo.rate_bps, RATE_BPS);
    assert_eq!(repo.maturity, T0 + 64 * HOUR);
    assert_eq!(
        f.client.get_offer(&offer_id).unwrap().available,
        90_000 * ONE
    );
    assert_eq!(
        f.client.get_fund_state(&f.shares).unwrap().outstanding,
        10_000 * ONE
    );
    assert_eq!(f.client.currency_outstanding(&eur(&f.env)), 10_000 * ONE);
}

#[test]
fn open_lends_exactly_the_ceiling_and_not_one_unit_more() {
    let (f, offer_id) = ready();
    let shares = 10_000 * ONE;
    let ceiling = f.client.quote(&f.shares, &shares, &f.eurc).max_principal;
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &shares,
            &(ceiling + 1),
            &DAY
        ),
        Err(Ok(Error::LoanTooLarge))
    );
    assert!(f
        .client
        .try_open_repo(&f.borrower, &offer_id, &f.shares, &shares, &ceiling, &DAY)
        .is_ok());
}

#[test]
fn open_checks_terms_offer_and_fund() {
    let (f, offer_id) = ready();
    let shares = 10_000 * ONE;
    let principal = 1_000 * ONE;
    let try_open = |term: u64| {
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &shares,
            &principal,
            &term,
        )
    };
    assert_eq!(try_open(HOUR - 1), Err(Ok(Error::InvalidTerm)));
    assert_eq!(try_open(7 * DAY + 1), Err(Ok(Error::InvalidTerm)));
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(1_000_000 * ONE),
            &(100_000 * ONE + 1),
            &DAY
        ),
        Err(Ok(Error::InsufficientOffer))
    );
    let other = new_token(&f.env);
    assert_eq!(
        f.client
            .try_open_repo(&f.borrower, &offer_id, &other, &shares, &principal, &DAY),
        Err(Ok(Error::FundNotInOffer))
    );
    assert_eq!(
        f.client
            .try_open_repo(&f.borrower, &99, &f.shares, &shares, &principal, &DAY),
        Err(Ok(Error::OfferNotFound))
    );
    f.client.freeze_fund(&f.shares, &true);
    assert_eq!(try_open(DAY), Err(Ok(Error::FundFrozen)));
    f.client.freeze_fund(&f.shares, &false);
    f.client.pause(&f.guardian);
    assert_eq!(try_open(DAY), Err(Ok(Error::Paused)));
}

#[test]
fn open_enforces_the_three_caps() {
    let (f, offer_id) = ready();
    let shares = 100_000 * ONE;
    f.client
        .set_fund_limits(&f.shares, &200, &(5_000 * ONE), &(8_000 * ONE));
    let try_open = |principal: i128| {
        f.client
            .try_open_repo(&f.borrower, &offer_id, &f.shares, &shares, &principal, &DAY)
    };
    assert_eq!(try_open(5_000 * ONE + 1), Err(Ok(Error::CapExceeded)));
    assert!(try_open(5_000 * ONE).is_ok());
    assert_eq!(try_open(3_000 * ONE + 1), Err(Ok(Error::CapExceeded)));
    f.client.set_currency_cap(&eur(&f.env), &(7_000 * ONE));
    assert_eq!(try_open(2_000 * ONE + 1), Err(Ok(Error::CapExceeded)));
    assert!(try_open(2_000 * ONE).is_ok());
}

#[test]
fn open_refuses_a_faulty_or_stale_price() {
    let (f, offer_id) = ready();
    publish_nav(&f, NAV_EUR * 2);
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(10_000 * ONE),
            &ONE,
            &DAY
        ),
        Err(Ok(Error::PriceOutOfBand))
    );
    publish_nav(&f, NAV_EUR);
    advance(&f, 27 * HOUR);
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(10_000 * ONE),
            &ONE,
            &DAY
        ),
        Err(Ok(Error::StalePrice))
    );
}

#[test]
fn open_with_a_removed_stablecoin_is_refused() {
    let (f, offer_id) = ready();
    f.client.remove_stablecoin(&f.eurc);
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(10_000 * ONE),
            &ONE,
            &DAY
        ),
        Err(Ok(Error::StablecoinNotAccepted))
    );
}

#[test]
fn cross_currency_repo_opens_and_closes() {
    let (f, _) = cross_fund();
    f.client.set_currency_cap(&eur(&f.env), &(10_000_000 * ONE));
    f.client.approve_lender(&f.shares, &f.lender, &true);
    mint(&f.env, &f.eurc, &f.lender, 100_000 * ONE);
    mint(&f.env, &f.shares, &f.borrower, 10_000 * ONE);
    mint(&f.env, &f.eurc, &f.borrower, 100 * ONE);
    let offer_id = f.client.create_offer(
        &f.lender,
        &f.eurc,
        &(100_000 * ONE),
        &RATE_BPS,
        &(7 * DAY),
        &vec![&f.env, f.shares.clone()],
    );
    let ceiling = f
        .client
        .quote(&f.shares, &(10_000 * ONE), &f.eurc)
        .max_principal;
    let repo_id = f.client.open_repo(
        &f.borrower,
        &offer_id,
        &f.shares,
        &(10_000 * ONE),
        &ceiling,
        &DAY,
    );
    advance(&f, HOUR);
    f.client.repurchase(&repo_id);
    assert_eq!(balance(&f.env, &f.shares, &f.borrower), 10_000 * ONE);
}

/// Review finding M5: a revoked lender's offer stops lending.
#[test]
fn revoked_lender_offers_stop_lending() {
    let (f, offer_id) = ready();
    f.client.approve_lender(&f.shares, &f.lender, &false);
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(10_000 * ONE),
            &ONE,
            &DAY
        ),
        Err(Ok(Error::LenderNotApproved))
    );
    // The lender can still take the stablecoins back.
    f.client.withdraw_offer(&offer_id, &(100_000 * ONE));
}

/// Review finding M1: replacing a fund's configuration needs its current
/// steward too, not only the governor and whoever the governor names.
#[test]
fn replacing_a_steward_needs_the_current_steward() {
    let (f, _) = ready();
    let mut config = fund_config(&f);
    let successor = Address::generate(&f.env);
    config.steward = successor.clone();
    f.env.mock_auths(&[
        MockAuth {
            address: &f.governor,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "set_fund",
                args: (f.shares.clone(), config.clone()).into_val(&f.env),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &successor,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "set_fund",
                args: (f.shares.clone(), config.clone()).into_val(&f.env),
                sub_invokes: &[],
            },
        },
    ]);
    assert!(f.client.try_set_fund(&f.shares, &config).is_err());
    f.env.mock_all_auths();
    assert_eq!(f.client.get_fund(&f.shares).unwrap().steward, f.steward);
}

/// Review finding M4: the currency cannot change under open repos.
#[test]
fn currency_cannot_change_while_repos_are_open() {
    let (f, offer_id) = ready();
    open(&f, offer_id);
    let usd_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    MockOracleClient::new(&f.env, &usd_oracle).set_price(
        &Asset::Stellar(f.shares.clone()),
        &NAV_USD,
        &T0,
    );
    let mut config = fund_config(&f);
    config.oracle = usd_oracle;
    config.currency = usd(&f.env);
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::CurrencyMismatch))
    );
}

// ---------------------------------------------------------------------------
// Repurchase
// ---------------------------------------------------------------------------

#[test]
fn repurchase_after_a_weekend_pays_interest_to_the_lender() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    advance(&f, 64 * HOUR);
    let principal = 10_000 * ONE;
    let expected = math::interest(principal, RATE_BPS, 64 * HOUR).unwrap();
    // 10,000 EUR at 3 % for 64 hours: 2.19 EUR (219 EUR per million),
    // rounded up to the stroop.
    assert_eq!(expected, 21_917_809);
    assert_eq!(f.client.repo_due(&repo_id), expected);
    let lender_before = balance(&f.env, &f.eurc, &f.lender);
    f.client.repurchase(&repo_id);
    assert_eq!(f.env.auths()[0].0, f.borrower);
    // Nothing is pushed to the lender in the borrower's exit path.
    assert_eq!(balance(&f.env, &f.eurc, &f.lender), lender_before);
    assert_eq!(balance(&f.env, &f.shares, &f.borrower), 1_000_000 * ONE);
    assert_eq!(balance(&f.env, &f.shares, &f.contract_id), 0);
    let repo = f.client.get_repo(&repo_id).unwrap();
    assert_eq!(repo.status, RepoStatus::Repurchased);
    // Principal and interest flow back into the offer; the lender withdraws.
    assert_eq!(
        f.client.get_offer(&offer_id).unwrap().available,
        100_000 * ONE + expected
    );
    f.client
        .withdraw_offer(&offer_id, &(100_000 * ONE + expected));
    assert_eq!(
        balance(&f.env, &f.eurc, &f.lender),
        lender_before + 100_000 * ONE + expected
    );
    assert_eq!(f.client.get_fund_state(&f.shares).unwrap().outstanding, 0);
    assert_eq!(f.client.currency_outstanding(&eur(&f.env)), 0);
}

#[test]
fn interest_accrues_per_started_hour() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    advance(&f, 64 * HOUR + 1);
    assert_eq!(
        f.client.repo_due(&repo_id),
        math::interest(10_000 * ONE, RATE_BPS, 65 * HOUR).unwrap()
    );
    // The amount a borrower signs for holds for the rest of the hour.
    let signed = f.client.repo_due(&repo_id);
    advance(&f, HOUR - 2);
    assert_eq!(f.client.repo_due(&repo_id), signed);
}

#[test]
fn early_repurchase_pays_the_minimum_hour() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    advance(&f, 60);
    assert_eq!(
        f.client.repo_due(&repo_id),
        math::interest(10_000 * ONE, RATE_BPS, HOUR).unwrap()
    );
}

#[test]
fn interest_keeps_running_after_maturity() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    advance(&f, 64 * HOUR + DAY);
    assert_eq!(
        f.client.repo_due(&repo_id),
        math::interest(10_000 * ONE, RATE_BPS, 64 * HOUR + DAY).unwrap()
    );
    f.client.repurchase(&repo_id);
}

#[test]
fn repurchase_works_while_paused_and_only_once() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    f.client.pause(&f.guardian);
    f.client.repurchase(&repo_id);
    assert_eq!(
        f.client.try_repurchase(&repo_id),
        Err(Ok(Error::RepoNotOpen))
    );
    assert_eq!(f.client.try_repurchase(&42), Err(Ok(Error::RepoNotFound)));
}

#[test]
fn intruder_cannot_repurchase() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "repurchase",
            args: (repo_id,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_repurchase(&repo_id).is_err());
}

#[test]
fn terms_are_frozen_at_opening() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    f.client.set_fund_limits(&f.shares, &5_000, &ONE, &ONE);
    f.client.remove_fund(&f.shares);
    advance(&f, 64 * HOUR);
    f.client.repurchase(&repo_id);
    assert_eq!(
        f.client.get_repo(&repo_id).unwrap().status,
        RepoStatus::Repurchased
    );
    assert_eq!(f.client.currency_outstanding(&eur(&f.env)), 0);
}

// ---------------------------------------------------------------------------
// Seizure
// ---------------------------------------------------------------------------

#[test]
fn seizure_waits_for_maturity_and_goes_to_an_approved_address() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    assert_eq!(
        f.client.try_seize(&repo_id, &f.lender),
        Err(Ok(Error::NotMatured))
    );
    advance(&f, 64 * HOUR);
    let stranger = Address::generate(&f.env);
    assert_eq!(
        f.client.try_seize(&repo_id, &stranger),
        Err(Ok(Error::LenderNotApproved))
    );
    f.client.pause(&f.guardian);
    f.client.seize(&repo_id, &f.lender);
    assert_eq!(f.env.auths()[0].0, f.lender);
    assert_eq!(balance(&f.env, &f.shares, &f.lender), 10_000 * ONE);
    let repo = f.client.get_repo(&repo_id).unwrap();
    assert_eq!(repo.status, RepoStatus::Defaulted);
    // The principal is lost to the lender: it does not return to the offer.
    assert_eq!(
        f.client.get_offer(&offer_id).unwrap().available,
        90_000 * ONE
    );
    assert_eq!(f.client.currency_outstanding(&eur(&f.env)), 0);
    assert_eq!(
        f.client.try_repurchase(&repo_id),
        Err(Ok(Error::RepoNotOpen))
    );
}

#[test]
fn intruder_cannot_seize() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    advance(&f, 64 * HOUR);
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "seize",
            args: (repo_id, intruder.clone()).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_seize(&repo_id, &intruder).is_err());
}

// ---------------------------------------------------------------------------
// Invariants and cost
// ---------------------------------------------------------------------------

/// Deterministic pseudo-random generator (64-bit LCG), no dependency.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self, bound: u64) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) % bound
    }
}

/// I1: stablecoins held cover the offers; I2: shares held equal the open
/// repos; totals equal the sum of open principals.
fn check_invariants(f: &Fixture, offers: &[u64], repos: &[u64]) {
    let available: i128 = offers
        .iter()
        .map(|id| f.client.get_offer(id).unwrap().available)
        .sum();
    assert_eq!(balance(&f.env, &f.eurc, &f.contract_id), available);
    let open: std::vec::Vec<Repo> = repos
        .iter()
        .map(|id| f.client.get_repo(id).unwrap())
        .filter(|r| r.status == RepoStatus::Open)
        .collect();
    let locked: i128 = open.iter().map(|r| r.shares).sum();
    assert_eq!(balance(&f.env, &f.shares, &f.contract_id), locked);
    let principal: i128 = open.iter().map(|r| r.principal).sum();
    assert_eq!(f.client.currency_outstanding(&eur(&f.env)), principal);
    assert_eq!(
        f.client.get_fund_state(&f.shares).unwrap().outstanding,
        principal
    );
}

#[test]
fn invariants_hold_over_random_sequences() {
    let (f, first_offer) = ready();
    let mut offers = std::vec![first_offer];
    let mut repos: std::vec::Vec<u64> = std::vec::Vec::new();
    let mut rng = Lcg(0x5EED);
    for _ in 0..300 {
        match rng.next(5) {
            0 => {
                let amount = (rng.next(5_000) as i128 + 1) * ONE;
                let id = f.client.create_offer(
                    &f.lender,
                    &f.eurc,
                    &amount,
                    &RATE_BPS,
                    &(7 * DAY),
                    &vec![&f.env, f.shares.clone()],
                );
                offers.push(id);
            }
            1 => {
                let id = offers[rng.next(offers.len() as u64) as usize];
                let available = f.client.get_offer(&id).unwrap().available;
                if available > 0 {
                    let amount = (rng.next(available as u64 / ONE as u64 + 1) as i128).max(1) * ONE;
                    let _ = f.client.try_withdraw_offer(&id, &amount.min(available));
                }
            }
            2 => {
                let id = offers[rng.next(offers.len() as u64) as usize];
                let principal = (rng.next(1_000) as i128 + 1) * ONE;
                if let Ok(Ok(repo_id)) = f.client.try_open_repo(
                    &f.borrower,
                    &id,
                    &f.shares,
                    &(principal * 2),
                    &principal,
                    &(rng.next(6 * DAY) + HOUR),
                ) {
                    repos.push(repo_id);
                }
            }
            3 => {
                if !repos.is_empty() {
                    let id = repos[rng.next(repos.len() as u64) as usize];
                    let _ = f.client.try_repurchase(&id);
                }
            }
            _ => {
                advance(&f, rng.next(2 * DAY));
                publish_nav(
                    &f,
                    f.client.get_fund_state(&f.shares).unwrap().reference_nav,
                );
                if !repos.is_empty() {
                    let id = repos[rng.next(repos.len() as u64) as usize];
                    let _ = f.client.try_seize(&id, &f.lender);
                }
            }
        }
        check_invariants(&f, &offers, &repos);
    }
    assert!(repos.len() > 10, "the sequence must exercise repos");
}

/// I6 and the scalability goal: opening a repo touches the same number of
/// ledger entries whether 1 or 150 repos are open. The footprint is what the
/// network meters: a transaction declares the entries it touches and the host
/// loads only those.
///
/// Instructions are printed, not asserted. The test host keeps the whole
/// ledger in one map and its cost grows with every entry: as a control, a
/// read-only `get_offer`, unrelated to repos, goes from 37,863 to 49,199
/// instructions after 150 repos.
#[test]
fn opening_a_repo_touches_a_constant_number_of_entries() {
    let (f, offer_id) = ready();
    let measure = |f: &Fixture| {
        f.client.open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(20 * ONE),
            &(10 * ONE),
            &DAY,
        );
        f.env.cost_estimate().resources()
    };
    // The first repo creates the contract's share balance entry: warm up.
    measure(&f);
    let first = measure(&f);
    for _ in 0..150 {
        measure(&f);
    }
    let last = measure(&f);
    assert_eq!(
        last.disk_read_entries + last.memory_read_entries,
        first.disk_read_entries + first.memory_read_entries
    );
    assert_eq!(last.write_entries, first.write_entries);
    std::println!(
        "open_repo footprint: {} entries read, {} written; instructions {} -> {} (test host)",
        last.disk_read_entries + last.memory_read_entries,
        last.write_entries,
        first.instructions,
        last.instructions
    );
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

#[test]
fn arithmetic_rounds_in_favour_of_the_lender() {
    // One stroop of interest is still charged.
    assert_eq!(math::interest(1, 1, 1).unwrap(), 1);
    assert_eq!(math::interest(0, RATE_BPS, DAY).unwrap(), 0);
    let price = math::Price::new(NAV_EUR, NAV_DECIMALS).unwrap();
    let haircut = math::Bps::haircut(200).unwrap();
    // 1 stroop of share is worth 1.05 stroop, floored to 1, then 0.98 after
    // the haircut, floored to 0: dust secures nothing.
    assert_eq!(math::max_principal(1, 7, price, 7, haircut).unwrap(), 0);
    // Decimals conversion: 6-decimal stablecoin.
    assert_eq!(
        math::max_principal(10 * ONE, 7, price, 6, haircut).unwrap(),
        10_290_000
    );
    assert_eq!(math::Price::new(0, 7), Err(Error::InvalidPrice));
    assert_eq!(math::Bps::haircut(10_000), Err(Error::InvalidHaircut));
}

#[test]
fn arithmetic_overflow_is_a_typed_error() {
    let price = math::Price::new(i128::MAX / 2, 0).unwrap();
    let haircut = math::Bps::haircut(0).unwrap();
    assert_eq!(
        math::max_principal(i128::MAX / 2, 7, price, 7, haircut),
        Err(Error::ArithmeticOverflow)
    );
    assert_eq!(
        math::interest(i128::MAX, 10_000, u64::MAX),
        Err(Error::ArithmeticOverflow)
    );
}

#[test]
fn corridor_bounds() {
    let (low, high) = math::corridor(1_000_000, 0, 0, 10, 500).unwrap();
    assert_eq!((low, high), (999_000, 1_001_000));
    // A year later the top grows by the maximum yield.
    let (_, high) = math::corridor(1_000_000, 0, 31_536_000, 10, 500).unwrap();
    assert_eq!(high, 1_051_000);
}

// ---------------------------------------------------------------------------
// Integration with the demo contracts: the allowlisted share token and the
// operator-fed SEP-40 feed, compiled natively.
// ---------------------------------------------------------------------------

mod integration {
    use super::*;
    use fund_token::{FundToken, FundTokenClient};
    use nav_oracle::{Asset as FeedAsset, NavOracle, NavOracleClient};
    use soroban_sdk::String;

    struct Live {
        f: Fixture,
        token: FundTokenClient<'static>,
        offer_id: u64,
    }

    /// Open Window with a permissioned share token whose NAV is published in
    /// USD and crossed through a second feed publishing EUR in USD.
    fn live(whitelist_contract: bool) -> Live {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().set_timestamp(T0);
        let governor = Address::generate(&env);
        let steward = Address::generate(&env);
        let lender = Address::generate(&env);
        let borrower = Address::generate(&env);
        let contract_id = env.register(OpenWindow, (governor.clone(),));
        let client = OpenWindowClient::new(leak(env.clone()), leak(contract_id.clone()));

        let shares = env.register(
            FundToken,
            (
                steward.clone(),
                7u32,
                String::from_str(&env, "Test EU T-bill fund share"),
                String::from_str(&env, "tEUTBL"),
            ),
        );
        let token = FundTokenClient::new(leak(env.clone()), leak(shares.clone()));
        for holder in [&borrower, &lender] {
            token.set_whitelisted(holder, &true);
        }
        if whitelist_contract {
            token.set_whitelisted(&contract_id, &true);
        }
        token.mint(&borrower, &(100_000 * ONE));

        let usd = FeedAsset::Other(Symbol::new(&env, "USD"));
        let nav_feed = env.register(
            NavOracle,
            (steward.clone(), usd.clone(), NAV_DECIMALS, 300u32),
        );
        NavOracleClient::new(&env, &nav_feed).publish(
            &FeedAsset::Stellar(shares.clone()),
            &NAV_USD,
            &T0,
        );
        let fx_feed = env.register(NavOracle, (steward.clone(), usd, NAV_DECIMALS, 300u32));
        NavOracleClient::new(&env, &fx_feed).publish(
            &FeedAsset::Other(Symbol::new(&env, "EUR")),
            &EUR_USD,
            &T0,
        );

        let eurc = new_token(&env);
        client.set_stablecoin(&eurc, &eur(&env));
        client.set_currency_cap(&eur(&env), &(10_000_000 * ONE));
        client.set_fund(
            &shares,
            &FundConfig {
                oracle: nav_feed.clone(),
                oracle_asset: Asset::Stellar(shares.clone()),
                haircut_bps: 200,
                steward: steward.clone(),
                currency: eur(&env),
                source: PriceSource::Cross(FxLeg {
                    oracle: fx_feed,
                    asset: Asset::Other(eur(&env)),
                    haircut_bps: 200,
                    max_age_secs: 3 * DAY,
                    band_bps: 500,
                }),
                nav_max_age_secs: 26 * HOUR,
                corridor_floor_bps: 10,
                max_yield_bps: 500,
                max_principal_per_repo: 500_000 * ONE,
                max_outstanding: 5_000_000 * ONE,
            },
        );
        client.approve_lender(&shares, &lender, &true);
        mint(&env, &eurc, &lender, 100_000 * ONE);
        mint(&env, &eurc, &borrower, 1_000 * ONE);
        let offer_id = client.create_offer(
            &lender,
            &eurc,
            &(100_000 * ONE),
            &RATE_BPS,
            &(7 * DAY),
            &vec![&env, shares.clone()],
        );
        let oracle = MockOracleClient::new(leak(env.clone()), leak(nav_feed.clone()));
        Live {
            f: Fixture {
                env,
                contract_id,
                client,
                governor: governor.clone(),
                guardian: governor,
                steward,
                lender,
                borrower,
                shares,
                eurc,
                nav_oracle: nav_feed,
                oracle,
            },
            token,
            offer_id,
        }
    }

    #[test]
    fn full_cycle_with_the_permissioned_share_token_and_live_feeds() {
        let live = live(true);
        let f = &live.f;
        let quote = f.client.quote(&f.shares, &(10_000 * ONE), &f.eurc);
        assert_eq!(quote.haircut_bps, 400);
        let repo_id = f.client.open_repo(
            &f.borrower,
            &live.offer_id,
            &f.shares,
            &(10_000 * ONE),
            &(10_000 * ONE),
            &(64 * HOUR),
        );
        assert_eq!(live.token.balance(&f.contract_id), 10_000 * ONE);
        advance(f, 64 * HOUR);
        f.client.repurchase(&repo_id);
        assert_eq!(live.token.balance(&f.borrower), 100_000 * ONE);
        assert_eq!(live.token.balance(&f.contract_id), 0);
    }

    #[test]
    fn seizure_delivers_permissioned_shares_to_the_whitelisted_lender() {
        let live = live(true);
        let f = &live.f;
        let repo_id = f.client.open_repo(
            &f.borrower,
            &live.offer_id,
            &f.shares,
            &(10_000 * ONE),
            &(10_000 * ONE),
            &(2 * HOUR),
        );
        advance(f, 2 * HOUR);
        f.client.seize(&repo_id, &f.lender);
        assert_eq!(live.token.balance(&f.lender), 10_000 * ONE);
    }

    #[test]
    fn issuer_must_whitelist_the_contract_before_any_repo() {
        let live = live(false);
        let f = &live.f;
        assert!(f
            .client
            .try_open_repo(
                &f.borrower,
                &live.offer_id,
                &f.shares,
                &(10_000 * ONE),
                &(10_000 * ONE),
                &DAY,
            )
            .is_err());
        // Nothing moved: the whole transaction reverted.
        assert_eq!(live.token.balance(&f.borrower), 100_000 * ONE);
        assert_eq!(
            f.client.get_offer(&live.offer_id).unwrap().available,
            100_000 * ONE
        );
    }

    #[test]
    fn issuer_freezing_the_contract_blocks_the_exit_known_limit_s9() {
        // Decision S9 (version 1.1): if the issuer freezes the contract's
        // balance, the repurchase cannot return the shares and reverts. The
        // borrower keeps the stablecoins; the lender can seize only once the
        // issuer lifts the freeze. Documented, not yet handled on-chain.
        let live = live(true);
        let f = &live.f;
        let repo_id = f.client.open_repo(
            &f.borrower,
            &live.offer_id,
            &f.shares,
            &(10_000 * ONE),
            &(10_000 * ONE),
            &DAY,
        );
        live.token.set_frozen(&f.contract_id, &true);
        assert!(f.client.try_repurchase(&repo_id).is_err());
        assert_eq!(
            f.client.get_repo(&repo_id).unwrap().status,
            RepoStatus::Open
        );
        live.token.set_frozen(&f.contract_id, &false);
        f.client.repurchase(&repo_id);
    }
}
