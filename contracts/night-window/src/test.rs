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
    testutils::{Address as _, ContractEvents, Events as _, Ledger as _, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec, Address, BytesN, Env, Event as _, IntoVal, Symbol,
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
    Broken,
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
        if env.storage().instance().has(&MockKey::Broken) {
            panic!("feed down");
        }
        env.storage().instance().get(&MockKey::Price(asset))
    }

    /// Makes `lastprice` trap, like a feed whose contract is broken.
    pub fn set_broken(env: Env, broken: bool) {
        if broken {
            env.storage().instance().set(&MockKey::Broken, &true);
        } else {
            env.storage().instance().remove(&MockKey::Broken);
        }
    }

    /// Keeps the feed's instance live for 200 days of ledgers.
    pub fn keep_alive(env: Env) {
        env.storage()
            .instance()
            .extend_ttl(200 * 17_280, 200 * 17_280);
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
    let asset = env.register_stellar_asset_contract_v2(issuer);
    // A permissioned issuer can revoke authorization, like a real fund share:
    // needed to test an issuer deauthorizing the contract during a repo (S9).
    asset
        .issuer()
        .set_flag(soroban_sdk::testutils::IssuerFlags::RevocableFlag);
    asset.address()
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

/// Events published by Open Window itself during the last invocation, in
/// XDR, for comparison with the expected `#[contractevent]` values.
fn own_events(f: &Fixture) -> ContractEvents {
    f.env.events().all().filter_by_contract(&f.contract_id)
}

/// Appoints a guardian distinct from the governor. After the first
/// admission the appointment goes through the time delay; the NAV is then
/// republished so the fixture stays priced.
fn appoint_guardian(f: &Fixture) -> Address {
    let guardian = Address::generate(&f.env);
    f.client.set_guardian(&guardian);
    if f.client.pending_guardian_change().is_some() {
        advance(f, f.client.timelock_delay());
        f.client.apply_guardian_change();
        let reference = f
            .client
            .get_fund_state(&f.shares)
            .map_or(NAV_EUR, |state| state.reference_nav);
        publish_nav(f, reference);
    }
    assert_eq!(f.client.guardian(), guardian);
    guardian
}

/// TTL the contract gives a persistent entry when it extends it: 120 days.
const BUMP_TO_LEDGERS: u32 = 120 * 17_280;
/// Below this TTL (30 days) the contract extends an entry it touches.
const BUMP_THRESHOLD_LEDGERS: u32 = 30 * 17_280;

/// Lets 91 days of ledgers pass without touching anything: an entry written
/// just before is left with 29 days, under the extension threshold, while
/// every entry written during the test stays live.
fn age_ledgers(f: &Fixture) {
    f.env
        .ledger()
        .with_mut(|ledger| ledger.sequence_number += 91 * 17_280);
}

fn entry_ttl(f: &Fixture, key: &DataKey) -> u32 {
    use soroban_sdk::testutils::storage::Persistent as _;
    f.env
        .as_contract(&f.contract_id, || f.env.storage().persistent().get_ttl(key))
}

/// A contract error as raised by an entry point that returns no `Result`.
fn raised(error: Error) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(error as u32)
}

// ---------------------------------------------------------------------------
// Governor, guardian and envelope
// ---------------------------------------------------------------------------

#[test]
fn constructor_sets_roles_and_defaults() {
    let f = bare();
    assert_eq!(f.client.admin(), f.governor);
    assert_eq!(f.client.guardian(), f.governor);
    assert_eq!(f.client.version(), 3);
    assert_eq!(f.client.timelock_delay(), DEFAULT_TIMELOCK_SECS);
    assert_eq!(f.client.pending_upgrade(), None);
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
    // Raised before the first admission: afterwards an increase waits.
    f.client.set_currency_cap(&eur(&f.env), &(10_000_000 * ONE));
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
// Fallback NAV feed
// ---------------------------------------------------------------------------

/// The fallback feed publishes with fewer decimals than the primary one, so
/// every comparison goes through the rescaling.
const FALLBACK_DECIMALS: u32 = 8;
/// 1.05 EUR per share, with 8 decimals.
const NAV_EUR_8: i128 = 105_000_000;

/// A second SEP-40 feed in the primary feed's base, publishing the same NAV
/// now.
fn second_feed(f: &Fixture, base: Symbol) -> (Address, MockOracleClient<'static>) {
    let id = f
        .env
        .register(MockOracle, (Asset::Other(base), FALLBACK_DECIMALS));
    let feed = MockOracleClient::new(leak(f.env.clone()), leak(id.clone()));
    publish_on(f, &feed, NAV_EUR_8);
    (id, feed)
}

/// Publishes a NAV on `feed`, stamped at the current ledger time.
fn publish_on(f: &Fixture, feed: &MockOracleClient, nav: i128) {
    let now = f.env.ledger().timestamp();
    feed.set_price(&Asset::Stellar(f.shares.clone()), &nav, &now);
}

fn fallback_feed(f: &Fixture, oracle: &Address) -> FallbackFeed {
    FallbackFeed {
        oracle: oracle.clone(),
        asset: Asset::Stellar(f.shares.clone()),
        max_age_secs: 26 * HOUR,
        max_divergence_bps: 20,
    }
}

/// `ready()` plus an active fallback feed. The delay has elapsed, and both
/// feeds have just published the admission NAV.
fn ready_with_fallback() -> (Fixture, u64, MockOracleClient<'static>) {
    let (f, offer_id) = ready();
    let (oracle, feed) = second_feed(&f, eur(&f.env));
    f.client
        .propose_fallback(&f.shares, &fallback_feed(&f, &oracle));
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    publish_on(&f, &feed, NAV_EUR_8);
    f.client.apply_fallback(&f.shares);
    (f, offer_id, feed)
}

#[test]
fn fallback_needs_two_keys_and_the_delay() {
    let (f, _) = ready();
    let (oracle, feed) = second_feed(&f, eur(&f.env));
    let proposal = fallback_feed(&f, &oracle);
    // The governor alone cannot add a price source.
    f.env.mock_auths(&[MockAuth {
        address: &f.governor,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "propose_fallback",
            args: (f.shares.clone(), proposal.clone()).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_propose_fallback(&f.shares, &proposal).is_err());
    f.env.mock_all_auths();

    f.client.propose_fallback(&f.shares, &proposal);
    assert_eq!(f.env.auths()[0].0, f.governor);
    assert_eq!(f.env.auths()[1].0, f.steward);
    let eta = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![FallbackProposed {
            fund: f.shares.clone(),
            oracle: oracle.clone(),
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_fallback(&f.shares),
        Some(PendingFallback {
            feed: proposal.clone(),
            eta
        })
    );
    assert_eq!(f.client.get_fallback(&f.shares), None);
    assert_eq!(
        f.client.try_apply_fallback(&f.shares),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    publish_on(&f, &feed, NAV_EUR_8);
    f.env.set_auths(&[]);
    f.client.apply_fallback(&f.shares);
    assert_eq!(
        own_events(&f),
        std::vec![FallbackSet {
            fund: f.shares.clone(),
            oracle
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.get_fallback(&f.shares), Some(proposal));
    assert_eq!(f.client.pending_fallback(&f.shares), None);
    assert_eq!(
        f.client.try_apply_fallback(&f.shares),
        Err(Ok(Error::NotProposed))
    );
}

#[test]
fn fallback_proposal_checks() {
    let (f, _) = ready();
    let (oracle, feed) = second_feed(&f, eur(&f.env));
    let base = fallback_feed(&f, &oracle);
    let with = |change: fn(&mut FallbackFeed)| {
        let mut feed = base.clone();
        change(&mut feed);
        f.client.try_propose_fallback(&f.shares, &feed)
    };
    let outside = Err(Ok(Error::OutsideEnvelope));
    assert_eq!(with(|feed| feed.max_age_secs = 0), outside);
    assert_eq!(with(|feed| feed.max_age_secs = 3 * DAY + 1), outside);
    // Review finding L4: never older than the fund allows its primary feed
    // (26 hours here), even inside the envelope's 3 days.
    assert_eq!(with(|feed| feed.max_age_secs = 26 * HOUR + 1), outside);
    assert_eq!(with(|feed| feed.max_divergence_bps = 0), outside);
    assert_eq!(with(|feed| feed.max_divergence_bps = 51), outside);
    let unknown = new_token(&f.env);
    assert_eq!(
        f.client.try_propose_fallback(&unknown, &base),
        Err(Ok(Error::FundNotAccepted))
    );
    // A feed in another base cannot be compared with the NAV oracle.
    let (usd_oracle, _) = second_feed(&f, usd(&f.env));
    assert_eq!(
        f.client
            .try_propose_fallback(&f.shares, &fallback_feed(&f, &usd_oracle)),
        Err(Ok(Error::CurrencyMismatch))
    );
    // The feed must track the shares now.
    let mut other_asset = base.clone();
    other_asset.asset = Asset::Stellar(unknown);
    assert_eq!(
        f.client.try_propose_fallback(&f.shares, &other_asset),
        Err(Ok(Error::NoPrice))
    );
    // 0.3 % away from the primary NAV, for a tolerance of 0.2 %.
    publish_on(&f, &feed, NAV_EUR_8 * 1_003 / 1_000);
    assert_eq!(
        f.client.try_propose_fallback(&f.shares, &base),
        Err(Ok(Error::PriceDivergence))
    );
    assert_eq!(f.client.pending_fallback(&f.shares), None);
}

#[test]
fn fallback_is_checked_again_when_applied() {
    let (f, _) = ready();
    let (oracle, feed) = second_feed(&f, eur(&f.env));
    f.client
        .propose_fallback(&f.shares, &fallback_feed(&f, &oracle));
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    // The fallback stopped publishing during the delay.
    assert_eq!(
        f.client.try_apply_fallback(&f.shares),
        Err(Ok(Error::StalePrice))
    );
    publish_on(&f, &feed, NAV_EUR_8 * 1_003 / 1_000);
    assert_eq!(
        f.client.try_apply_fallback(&f.shares),
        Err(Ok(Error::PriceDivergence))
    );
    assert!(f.client.pending_fallback(&f.shares).is_some());
    publish_on(&f, &feed, NAV_EUR_8);
    f.client.apply_fallback(&f.shares);
}

#[test]
fn stale_primary_falls_back_to_a_fresh_fallback() {
    let (f, offer_id, feed) = ready_with_fallback();
    advance(&f, 26 * HOUR + 1);
    publish_on(&f, &feed, NAV_EUR_8);
    let quote = f.client.quote(&f.shares, &(10_000 * ONE), &f.eurc);
    // Rescaled to the primary feed's 14 decimals.
    assert_eq!(quote.price, NAV_EUR);
    assert_eq!(quote.price_decimals, NAV_DECIMALS);
    assert_eq!(quote.nav_timestamp, f.env.ledger().timestamp());
    assert_eq!(quote.max_principal, 10_290 * ONE);
    open(&f, offer_id);
    // The reference moves with the fallback reading, along the model only.
    assert_eq!(
        f.client.refresh_reference(&f.shares).timestamp,
        f.env.ledger().timestamp()
    );
}

#[test]
fn diverging_feeds_block_the_valuation() {
    let (f, offer_id, feed) = ready_with_fallback();
    advance(&f, HOUR);
    publish_nav(&f, NAV_EUR);
    publish_on(&f, &feed, NAV_EUR_8 * 1_003 / 1_000);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceDivergence))
    );
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &offer_id,
            &f.shares,
            &(10_000 * ONE),
            &ONE,
            &DAY
        ),
        Err(Ok(Error::PriceDivergence))
    );
    assert_eq!(
        f.client.try_refresh_reference(&f.shares),
        Err(Ok(Error::PriceDivergence))
    );
    // Within the tolerance, the primary NAV is used.
    publish_on(&f, &feed, NAV_EUR_8 * 1_001 / 1_000);
    assert_eq!(f.client.quote(&f.shares, &ONE, &f.eurc).price, NAV_EUR);
}

#[test]
fn stale_fallback_is_ignored_while_the_primary_is_fresh() {
    let (f, _, feed) = ready_with_fallback();
    // An old, diverging fallback price: too old to count.
    publish_on(&f, &feed, NAV_EUR_8 * 2);
    advance(&f, 26 * HOUR + 1);
    publish_nav(&f, NAV_EUR);
    assert_eq!(f.client.quote(&f.shares, &ONE, &f.eurc).price, NAV_EUR);
}

#[test]
fn both_feeds_stale_is_a_stale_price() {
    let (f, _, _) = ready_with_fallback();
    advance(&f, 26 * HOUR + 1);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::StalePrice))
    );
}

#[test]
fn fallback_price_goes_through_the_corridor() {
    let (f, _, feed) = ready_with_fallback();
    advance(&f, 26 * HOUR + 1);
    publish_on(&f, &feed, NAV_EUR_8 * 102 / 100);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );
}

#[test]
fn guardian_cancels_a_fallback_and_the_steward_removes_one_at_once() {
    let (f, _, _) = ready_with_fallback();
    let guardian = appoint_guardian(&f);
    let (oracle, _) = second_feed(&f, eur(&f.env));
    f.client
        .propose_fallback(&f.shares, &fallback_feed(&f, &oracle));
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_cancel_fallback(&f.shares, &intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_fallback(&f.shares, &guardian);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(
        own_events(&f),
        std::vec![FallbackCancelled {
            fund: f.shares.clone(),
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.pending_fallback(&f.shares), None);
    assert_eq!(
        f.client.try_cancel_fallback(&f.shares, &guardian),
        Err(Ok(Error::NotProposed))
    );

    // Removal is immediate, and the guardian may do it alone.
    f.client.remove_fallback(&f.shares, &guardian);
    assert_eq!(f.env.auths().len(), 1);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(
        own_events(&f),
        std::vec![FallbackRemoved {
            fund: f.shares.clone(),
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.get_fallback(&f.shares), None);
    assert_eq!(
        f.client.try_remove_fallback(&f.shares, &guardian),
        Err(Ok(Error::NoFallback))
    );
    // Without the fallback, a stale primary stops valuation again.
    advance(&f, 26 * HOUR + 1);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::StalePrice))
    );
}

/// Review finding L2: with a fallback, a primary feed whose contract traps
/// counts as silent, and the fallback stands in.
#[test]
fn a_reverting_primary_falls_back() {
    let (f, _, _) = ready_with_fallback();
    f.oracle.set_broken(&true);
    let quote = f.client.quote(&f.shares, &ONE, &f.eurc);
    assert_eq!(quote.price, NAV_EUR);
    // Without the fallback, the same failure reverts the valuation.
    f.client.remove_fallback(&f.shares, &f.governor);
    assert!(f.client.try_quote(&f.shares, &ONE, &f.eurc).is_err());
}

/// Review finding L3: a fresh but unusable fallback price fails closed; a
/// stale or reverting fallback is ignored.
#[test]
fn a_fresh_but_invalid_fallback_fails_closed() {
    let (f, _, feed) = ready_with_fallback();
    publish_on(&f, &feed, 0);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceDivergence))
    );
    let now = f.env.ledger().timestamp();
    feed.set_price(&Asset::Stellar(f.shares.clone()), &NAV_EUR_8, &(now + 60));
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceDivergence))
    );
    // A backup that traps is silent, not invalid: the primary is used.
    feed.set_broken(&true);
    assert_eq!(f.client.quote(&f.shares, &ONE, &f.eurc).price, NAV_EUR);
}

/// Review finding L6: the fallback entry is read by operations that never
/// write it; reading it to price the fund extends its TTL.
#[test]
fn pricing_extends_the_fallback_entry() {
    let (f, _, feed) = ready_with_fallback();
    f.oracle.keep_alive();
    feed.keep_alive();
    let key = DataKey::Fallback(f.shares.clone());
    age_ledgers(&f);
    assert!(entry_ttl(&f, &key) < BUMP_THRESHOLD_LEDGERS);
    publish_nav(&f, NAV_EUR);
    publish_on(&f, &feed, NAV_EUR_8);
    f.env.set_auths(&[]);
    f.client.refresh_reference(&f.shares);
    assert_eq!(entry_ttl(&f, &key), BUMP_TO_LEDGERS);
}

/// Review finding L7: the fallback decimals live in instance storage, so the
/// number of funds with a fallback is capped.
#[test]
fn fallbacks_are_capped() {
    let (f, _) = ready();
    let count = |f: &Fixture| -> u32 {
        f.env.as_contract(&f.contract_id, || {
            f.env
                .storage()
                .instance()
                .get(&DataKey::FallbackCount)
                .unwrap_or(0)
        })
    };
    f.env.as_contract(&f.contract_id, || {
        f.env
            .storage()
            .instance()
            .set(&DataKey::FallbackCount, &MAX_FALLBACKS);
    });
    let (oracle, _) = second_feed(&f, eur(&f.env));
    assert_eq!(
        f.client
            .try_propose_fallback(&f.shares, &fallback_feed(&f, &oracle)),
        Err(Ok(Error::LimitReached))
    );
    f.env.as_contract(&f.contract_id, || {
        f.env
            .storage()
            .instance()
            .set(&DataKey::FallbackCount, &0u32);
    });
    let (f, _, _) = ready_with_fallback();
    assert_eq!(count(&f), 1);
    f.client.remove_fallback(&f.shares, &f.governor);
    assert_eq!(count(&f), 0);
}

#[test]
fn removing_a_fund_removes_its_fallback() {
    let (f, _, _) = ready_with_fallback();
    f.client.remove_fund(&f.shares);
    assert_eq!(f.client.get_fallback(&f.shares), None);
}

/// A NAV feed in another base cannot replace the primary: first the active
/// fallback is in the way, then the new NAV, in other units, does not lie
/// on the fund's path (review finding H1).
#[test]
fn fund_change_to_an_oracle_in_another_base_is_refused() {
    let (f, _, _) = ready_with_fallback();
    let (usd_oracle, usd_feed) = second_feed(&f, usd(&f.env));
    publish_on(&f, &usd_feed, NAV_USD / 1_000_000);
    let fx_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    let fx_feed = MockOracleClient::new(&f.env, &fx_oracle);
    let now = f.env.ledger().timestamp();
    fx_feed.set_price(&Asset::Other(eur(&f.env)), &EUR_USD, &now);
    let mut config = fund_config(&f);
    config.oracle = usd_oracle;
    config.source = PriceSource::Cross(FxLeg {
        oracle: fx_oracle,
        asset: Asset::Other(eur(&f.env)),
        haircut_bps: 200,
        max_age_secs: 3 * DAY,
        band_bps: 500,
    });
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::CurrencyMismatch))
    );
    f.client.remove_fallback(&f.shares, &f.governor);
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::PriceOutOfBand))
    );
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
}

/// Review finding L1: a single governor or steward key cannot remove a
/// fallback; both together can, and so can the guardian alone.
#[test]
fn removing_a_fallback_takes_the_guardian_or_both_governor_and_steward() {
    let (f, _, _) = ready_with_fallback();
    // While the governor is also the guardian, its key alone is the
    // guardian's: appoint a separate one.
    appoint_guardian(&f);
    for (alone, caller) in [(&f.governor, &f.governor), (&f.steward, &f.steward)] {
        f.env.mock_auths(&[MockAuth {
            address: alone,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "remove_fallback",
                args: (f.shares.clone(), caller.clone()).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(f.client.try_remove_fallback(&f.shares, caller).is_err());
    }
    f.env.mock_all_auths();
    assert!(f.client.get_fallback(&f.shares).is_some());
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_remove_fallback(&f.shares, &intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.remove_fallback(&f.shares, &f.governor);
    let signers: std::vec::Vec<Address> = f.env.auths().into_iter().map(|a| a.0).collect();
    assert_eq!(signers, std::vec![f.governor.clone(), f.steward.clone()]);
    assert_eq!(
        own_events(&f),
        std::vec![FallbackRemoved {
            fund: f.shares.clone(),
            by: f.governor.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.get_fallback(&f.shares), None);
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
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
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
// Time delay on upgrades and fund changes (decision S7)
// ---------------------------------------------------------------------------

fn wasm_hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

#[test]
fn upgrade_needs_a_proposal_its_delay_and_the_same_hash() {
    let f = bare();
    let hash = wasm_hash(&f.env, 7);
    assert_eq!(
        f.client.try_upgrade(&hash),
        Err(Ok(raised(Error::NotProposed)))
    );
    // A newer proposal replaces the older one and restarts the delay.
    f.client.propose_upgrade(&wasm_hash(&f.env, 6));
    advance(&f, HOUR);
    f.client.propose_upgrade(&hash);
    assert_eq!(f.env.auths()[0].0, f.governor);
    let eta = T0 + HOUR + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![UpgradeProposed {
            wasm_hash: hash.clone(),
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_upgrade(),
        Some(PendingUpgrade {
            wasm_hash: hash.clone(),
            eta
        })
    );
    advance(&f, DEFAULT_TIMELOCK_SECS - 1);
    assert_eq!(
        f.client.try_upgrade(&hash),
        Err(Ok(raised(Error::TimelockPending)))
    );
    advance(&f, 1);
    assert_eq!(
        f.client.try_upgrade(&wasm_hash(&f.env, 6)),
        Err(Ok(raised(Error::NotProposed)))
    );
    // The refusals left the proposal in place.
    assert_eq!(f.client.pending_upgrade().unwrap().wasm_hash, hash);
}

#[test]
fn guardian_cancels_an_upgrade_and_an_intruder_cannot() {
    let f = bare();
    let guardian = Address::generate(&f.env);
    f.client.set_guardian(&guardian);
    let hash = wasm_hash(&f.env, 7);
    f.client.propose_upgrade(&hash);
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_cancel_upgrade(&intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_upgrade(&guardian);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(
        own_events(&f),
        std::vec![UpgradeCancelled {
            wasm_hash: hash.clone(),
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.pending_upgrade(), None);
    assert_eq!(
        f.client.try_cancel_upgrade(&guardian),
        Err(Ok(Error::NotProposed))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    assert_eq!(
        f.client.try_upgrade(&hash),
        Err(Ok(raised(Error::NotProposed)))
    );
}

#[test]
fn intruder_cannot_propose_an_upgrade_or_cancel_in_the_governors_name() {
    let f = bare();
    let intruder = Address::generate(&f.env);
    let hash = wasm_hash(&f.env, 7);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "propose_upgrade",
            args: (hash.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_propose_upgrade(&hash).is_err());
    f.env.mock_all_auths();
    assert_eq!(f.client.pending_upgrade(), None);
    f.client.propose_upgrade(&hash);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "cancel_upgrade",
            args: (f.governor.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_cancel_upgrade(&f.governor).is_err());
    f.env.mock_all_auths();
    assert!(f.client.pending_upgrade().is_some());
}

#[test]
fn delay_moves_freely_before_the_first_admission_then_only_grows() {
    let f = bare();
    f.client.set_timelock_delay(&600);
    assert_eq!(
        own_events(&f),
        std::vec![TimelockDelayChanged { delay: 600 }.to_xdr(&f.env, &f.contract_id)]
    );
    // Nothing is at stake yet: a demonstration may shorten it.
    f.client.set_timelock_delay(&300);
    assert_eq!(f.client.timelock_delay(), 300);
    assert_eq!(
        f.client.try_set_timelock_delay(&(MIN_TIMELOCK_SECS - 1)),
        Err(Ok(Error::OutsideEnvelope))
    );
    assert_eq!(
        f.client.try_set_timelock_delay(&(MAX_TIMELOCK_SECS + 1)),
        Err(Ok(Error::OutsideEnvelope))
    );
    f.client.set_fund(&f.shares, &fund_config(&f));
    assert_eq!(
        f.client.try_set_timelock_delay(&299),
        Err(Ok(Error::DelayCannotDecrease))
    );
    f.client.set_timelock_delay(&DEFAULT_TIMELOCK_SECS);
    assert_eq!(f.client.timelock_delay(), DEFAULT_TIMELOCK_SECS);
    assert_eq!(
        f.client
            .try_set_timelock_delay(&(DEFAULT_TIMELOCK_SECS - 1)),
        Err(Ok(Error::DelayCannotDecrease))
    );
}

/// A contract upgraded from version 2 has admitted funds but no admission
/// flag; its offers are enough to close the bootstrap window.
#[test]
fn delay_cannot_decrease_on_a_contract_upgraded_with_offers() {
    let (f, _) = ready();
    f.env.as_contract(&f.contract_id, || {
        f.env.storage().instance().remove(&DataKey::FundsAdmitted);
        f.env.storage().instance().remove(&DataKey::TimelockDelay);
    });
    assert_eq!(f.client.timelock_delay(), DEFAULT_TIMELOCK_SECS);
    assert_eq!(
        f.client.try_set_timelock_delay(&300),
        Err(Ok(Error::DelayCannotDecrease))
    );
}

#[test]
fn intruder_cannot_change_the_delay() {
    let f = bare();
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_timelock_delay",
            args: (300u64,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_set_timelock_delay(&300).is_err());
    assert_eq!(f.client.timelock_delay(), DEFAULT_TIMELOCK_SECS);
}

/// The admitted configuration with a higher haircut.
fn replacement(f: &Fixture) -> FundConfig {
    let mut config = fund_config(f);
    config.haircut_bps = 300;
    config
}

#[test]
fn fund_replacement_waits_for_the_delay_then_anyone_applies_it() {
    let (f, _) = ready();
    let config = replacement(&f);
    f.client.set_fund(&f.shares, &config);
    let eta = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![FundChangeProposed {
            fund: f.shares.clone(),
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_fund_change(&f.shares),
        Some(PendingFundChange {
            config: config.clone(),
            fx_anchor: 0,
            eta
        })
    );
    // Nothing changed yet: offers keep lending on the admitted terms.
    assert_eq!(f.client.get_fund(&f.shares).unwrap().haircut_bps, 200);
    assert_eq!(f.client.quote(&f.shares, &ONE, &f.eurc).haircut_bps, 200);
    advance(&f, DEFAULT_TIMELOCK_SECS - 1);
    publish_nav(&f, NAV_EUR);
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, 1);
    // Whoever applies picks the moment, here one with a higher spot NAV.
    publish_nav(&f, NAV_EUR * 10_005 / 10_000);
    f.env.set_auths(&[]);
    f.client.apply_fund_change(&f.shares);
    assert!(f.env.auths().is_empty());
    assert_eq!(
        own_events(&f),
        std::vec![FundSet {
            fund: f.shares.clone(),
            oracle: f.nav_oracle.clone(),
            haircut_bps: 300
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.get_fund(&f.shares), Some(config));
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
    // Review finding H1: same feed, so the references carry over; the spot
    // price at the moment of the apply anchors nothing.
    let state = f.client.get_fund_state(&f.shares).unwrap();
    assert_eq!((state.reference_nav, state.reference_time), (NAV_EUR, T0));
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::NotProposed))
    );
}

#[test]
fn steward_cancels_a_fund_replacement_and_an_intruder_cannot() {
    let (f, _) = ready();
    f.client.set_fund(&f.shares, &replacement(&f));
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_cancel_fund_change(&f.shares, &intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_fund_change(&f.shares, &f.steward);
    assert_eq!(f.env.auths()[0].0, f.steward);
    assert_eq!(
        own_events(&f),
        std::vec![FundChangeCancelled {
            fund: f.shares.clone(),
            by: f.steward.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
    assert_eq!(
        f.client.try_cancel_fund_change(&f.shares, &f.governor),
        Err(Ok(Error::NotProposed))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::NotProposed))
    );
    assert_eq!(f.client.get_fund(&f.shares).unwrap().haircut_bps, 200);
}

#[test]
fn guardian_cancels_a_fund_replacement() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    f.client.set_fund(&f.shares, &replacement(&f));
    f.client.cancel_fund_change(&f.shares, &guardian);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
}

#[test]
fn fund_change_is_checked_again_when_applied() {
    let (f, _) = ready();
    f.client.set_fund(&f.shares, &replacement(&f));
    advance(&f, DEFAULT_TIMELOCK_SECS);
    // The NAV published at admission is stale by now: the change waits.
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::StalePrice))
    );
    assert!(f.client.pending_fund_change(&f.shares).is_some());
    // A tighter envelope set in the meantime applies too.
    let mut envelope = default_envelope();
    envelope.min_haircut_bps = 400;
    f.client.set_envelope(&envelope);
    publish_nav(&f, NAV_EUR);
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::OutsideEnvelope))
    );
    // Loosening it back waits for its own delay.
    f.client.set_envelope(&default_envelope());
    advance(&f, DEFAULT_TIMELOCK_SECS);
    f.client.apply_envelope_change();
    publish_nav(&f, NAV_EUR);
    f.client.apply_fund_change(&f.shares);
    assert_eq!(f.client.get_fund(&f.shares).unwrap().haircut_bps, 300);
}

#[test]
fn currency_rule_is_checked_again_when_applied() {
    let (f, offer_id) = ready();
    let usd_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    let usd_feed = MockOracleClient::new(&f.env, &usd_oracle);
    // The new feed publishes a value on the fund's current path, so that it
    // passes the corridor and only the currency rule is at stake.
    usd_feed.set_price(&Asset::Stellar(f.shares.clone()), &NAV_EUR, &T0);
    let mut config = fund_config(&f);
    config.oracle = usd_oracle;
    config.currency = usd(&f.env);
    // No repo is open yet: the proposal passes.
    f.client.set_fund(&f.shares, &config);
    open(&f, offer_id);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    let now = f.env.ledger().timestamp();
    usd_feed.set_price(&Asset::Stellar(f.shares.clone()), &NAV_EUR, &now);
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::CurrencyMismatch))
    );
    assert!(f.client.pending_fund_change(&f.shares).is_some());
}

#[test]
fn removing_a_fund_drops_its_pending_change_and_its_readmission_waits() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    f.client.set_fund(&f.shares, &replacement(&f));
    f.client.remove_fund(&f.shares);
    assert_eq!(
        own_events(&f),
        std::vec![
            FundChangeCancelled {
                fund: f.shares.clone(),
                by: f.governor.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            FundRemoved {
                fund: f.shares.clone()
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
    // Removing then re-admitting is a replacement: it waits too.
    f.client.set_fund(&f.shares, &fund_config(&f));
    assert_eq!(f.client.get_fund(&f.shares), None);
    assert!(f.client.pending_fund_change(&f.shares).is_some());
    // With no steward in place, the guardian holds the veto.
    f.client.cancel_fund_change(&f.shares, &guardian);
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
}

// -- Guardian, term ceiling and envelope behind the same delay --------------

#[test]
fn guardian_is_appointed_at_once_before_the_first_admission() {
    let f = bare();
    let guardian = Address::generate(&f.env);
    f.client.set_guardian(&guardian);
    assert_eq!(
        own_events(&f),
        std::vec![GuardianChanged {
            guardian: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.guardian(), guardian);
    assert_eq!(f.client.pending_guardian_change(), None);
}

#[test]
fn guardian_change_waits_after_the_first_admission_then_anyone_applies_it() {
    let (f, _) = ready();
    let successor = Address::generate(&f.env);
    f.client.set_guardian(&successor);
    assert_eq!(f.env.auths()[0].0, f.governor);
    let eta = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![GuardianChangeProposed {
            guardian: successor.clone(),
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_guardian_change(),
        Some(PendingGuardianChange {
            guardian: successor.clone(),
            eta
        })
    );
    assert_eq!(f.client.guardian(), f.governor);
    advance(&f, DEFAULT_TIMELOCK_SECS - 1);
    assert_eq!(
        f.client.try_apply_guardian_change(),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, 1);
    f.env.set_auths(&[]);
    f.client.apply_guardian_change();
    assert!(f.env.auths().is_empty());
    assert_eq!(
        own_events(&f),
        std::vec![GuardianChanged {
            guardian: successor.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.guardian(), successor);
    assert_eq!(f.client.pending_guardian_change(), None);
    assert_eq!(
        f.client.try_apply_guardian_change(),
        Err(Ok(Error::NotProposed))
    );
}

#[test]
fn current_guardian_or_governor_cancels_a_guardian_change() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    let successor = Address::generate(&f.env);
    f.client.set_guardian(&successor);
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_cancel_guardian_change(&intruder),
        Err(Ok(Error::Unauthorized))
    );
    // The proposed guardian holds no role until the change applies.
    assert_eq!(
        f.client.try_cancel_guardian_change(&successor),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_guardian_change(&guardian);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(
        own_events(&f),
        std::vec![GuardianChangeCancelled {
            guardian: successor.clone(),
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.pending_guardian_change(), None);
    assert_eq!(
        f.client.try_cancel_guardian_change(&guardian),
        Err(Ok(Error::NotProposed))
    );
    f.client.set_guardian(&successor);
    f.client.cancel_guardian_change(&f.governor);
    assert_eq!(f.env.auths()[0].0, f.governor);
    assert_eq!(f.client.pending_guardian_change(), None);
    assert_eq!(f.client.guardian(), guardian);
}

#[test]
fn intruder_cannot_replace_the_guardian() {
    let (f, _) = ready();
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_guardian",
            args: (intruder.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_set_guardian(&intruder).is_err());
    f.env.mock_all_auths();
    assert_eq!(f.client.pending_guardian_change(), None);
    assert_eq!(f.client.guardian(), f.governor);
}

/// The bypass this delay closes: with the governor key alone, an attacker
/// proposes a malicious upgrade and, to stop the guardian from vetoing it,
/// a guardian of their own. Both wait for the same delay, and the current
/// guardian cancels the guardian change first, then the upgrade.
#[test]
fn governor_key_alone_cannot_remove_the_veto_within_one_window() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    let accomplice = Address::generate(&f.env);
    let malicious = wasm_hash(&f.env, 66);
    f.client.propose_upgrade(&malicious);
    f.client.set_guardian(&accomplice);
    // Inside the window, the accomplice is not the guardian yet.
    assert_eq!(
        f.client.try_cancel_upgrade(&accomplice),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(
        f.client.try_apply_guardian_change(),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS - 1);
    f.client.cancel_guardian_change(&guardian);
    f.client.cancel_upgrade(&guardian);
    assert_eq!(f.env.auths()[0].0, guardian);
    advance(&f, 1);
    assert_eq!(
        f.client.try_apply_guardian_change(),
        Err(Ok(Error::NotProposed))
    );
    assert_eq!(
        f.client.try_upgrade(&malicious),
        Err(Ok(raised(Error::NotProposed)))
    );
    assert_eq!(f.client.guardian(), guardian);
}

#[test]
fn max_term_moves_freely_before_the_first_admission() {
    let f = bare();
    f.client.set_max_term(&(10 * DAY));
    assert_eq!(
        own_events(&f),
        std::vec![MaxTermChanged { max_term: 10 * DAY }.to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.max_term(), 10 * DAY);
    assert_eq!(f.client.pending_max_term_change(), None);
}

#[test]
fn max_term_decrease_is_immediate_and_an_increase_waits() {
    let (f, _) = ready();
    f.client.set_max_term(&(3 * DAY));
    assert_eq!(
        own_events(&f),
        std::vec![MaxTermChanged { max_term: 3 * DAY }.to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.max_term(), 3 * DAY);
    f.client.set_max_term(&(10 * DAY));
    let eta = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![MaxTermChangeProposed {
            max_term: 10 * DAY,
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_max_term_change(),
        Some(PendingMaxTermChange {
            max_term: 10 * DAY,
            eta
        })
    );
    assert_eq!(f.client.max_term(), 3 * DAY);
    assert_eq!(
        f.client.try_set_max_term(&(MAX_TERM_CEILING_SECS + 1)),
        Err(Ok(Error::InvalidTerm))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS - 1);
    assert_eq!(
        f.client.try_apply_max_term_change(),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, 1);
    f.env.set_auths(&[]);
    f.client.apply_max_term_change();
    assert!(f.env.auths().is_empty());
    assert_eq!(
        own_events(&f),
        std::vec![MaxTermChanged { max_term: 10 * DAY }.to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.max_term(), 10 * DAY);
    assert_eq!(f.client.pending_max_term_change(), None);
    assert_eq!(
        f.client.try_apply_max_term_change(),
        Err(Ok(Error::NotProposed))
    );
}

#[test]
fn guardian_or_governor_cancels_a_max_term_increase() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    f.client.set_max_term(&(10 * DAY));
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_cancel_max_term_change(&intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_max_term_change(&guardian);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(
        own_events(&f),
        std::vec![MaxTermChangeCancelled {
            max_term: 10 * DAY,
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.pending_max_term_change(), None);
    assert_eq!(
        f.client.try_cancel_max_term_change(&guardian),
        Err(Ok(Error::NotProposed))
    );
    f.client.set_max_term(&(10 * DAY));
    f.client.cancel_max_term_change(&f.governor);
    assert_eq!(f.client.pending_max_term_change(), None);
    assert_eq!(f.client.max_term(), DEFAULT_MAX_TERM_SECS);
}

#[test]
fn intruder_cannot_change_the_max_term() {
    let (f, _) = ready();
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_max_term",
            args: (10 * DAY,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_set_max_term(&(10 * DAY)).is_err());
    f.env.mock_all_auths();
    assert_eq!(f.client.pending_max_term_change(), None);
}

/// The default envelope with a faster maximum yield: a loosening.
fn looser_envelope() -> RiskEnvelope {
    let mut envelope = default_envelope();
    envelope.max_yield_bps = 2_000;
    envelope
}

#[test]
fn envelope_moves_freely_before_the_first_admission() {
    let f = bare();
    f.client.set_envelope(&looser_envelope());
    assert_eq!(
        own_events(&f),
        std::vec![EnvelopeChanged {
            envelope: looser_envelope()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.envelope(), looser_envelope());
    assert_eq!(f.client.pending_envelope_change(), None);
}

#[test]
fn envelope_tightening_is_immediate_and_any_loosening_waits() {
    let (f, _) = ready();
    let mut tighter = default_envelope();
    tighter.min_haircut_bps = 150;
    tighter.max_nav_age_secs = 2 * DAY;
    f.client.set_envelope(&tighter);
    assert_eq!(
        own_events(&f),
        std::vec![EnvelopeChanged {
            envelope: tighter.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.envelope(), tighter);
    // One bound tighter and one looser is still a loosening.
    let mut mixed = tighter.clone();
    mixed.min_fx_haircut_bps = 300;
    mixed.max_fx_band_bps = 600;
    f.client.set_envelope(&mixed);
    let eta = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![EnvelopeChangeProposed {
            envelope: mixed.clone(),
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_envelope_change(),
        Some(PendingEnvelopeChange {
            envelope: mixed.clone(),
            eta
        })
    );
    assert_eq!(f.client.envelope(), tighter);
    // An invalid envelope is refused at once, queued or not.
    let mut invalid = looser_envelope();
    invalid.min_haircut_bps = 10_000;
    assert_eq!(
        f.client.try_set_envelope(&invalid),
        Err(Ok(Error::InvalidHaircut))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS - 1);
    assert_eq!(
        f.client.try_apply_envelope_change(),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, 1);
    f.env.set_auths(&[]);
    f.client.apply_envelope_change();
    assert!(f.env.auths().is_empty());
    assert_eq!(
        own_events(&f),
        std::vec![EnvelopeChanged {
            envelope: mixed.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.envelope(), mixed);
    assert_eq!(f.client.pending_envelope_change(), None);
    assert_eq!(
        f.client.try_apply_envelope_change(),
        Err(Ok(Error::NotProposed))
    );
}

#[test]
fn guardian_or_governor_cancels_an_envelope_loosening() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    f.client.set_envelope(&looser_envelope());
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_cancel_envelope_change(&intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_envelope_change(&guardian);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(
        own_events(&f),
        std::vec![EnvelopeChangeCancelled {
            envelope: looser_envelope(),
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.pending_envelope_change(), None);
    assert_eq!(
        f.client.try_cancel_envelope_change(&guardian),
        Err(Ok(Error::NotProposed))
    );
    f.client.set_envelope(&looser_envelope());
    f.client.cancel_envelope_change(&f.governor);
    assert_eq!(f.client.pending_envelope_change(), None);
    assert_eq!(f.client.envelope(), default_envelope());
}

#[test]
fn intruder_cannot_change_the_envelope() {
    let (f, _) = ready();
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_envelope",
            args: (looser_envelope(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_set_envelope(&looser_envelope()).is_err());
    f.env.mock_all_auths();
    assert_eq!(f.client.pending_envelope_change(), None);
    assert_eq!(f.client.envelope(), default_envelope());
}

// -- Review of version 3: references, expiry, issuer, limits, guardian -----

/// Review finding H1: a new NAV feed must agree with the reference the fund
/// has followed, at the proposal and again at the apply; the reference
/// carries over in the new feed's decimals.
#[test]
fn a_new_nav_feed_must_lie_on_the_funds_path() {
    let (f, _) = ready();
    let (oracle, feed) = second_feed(&f, eur(&f.env));
    let mut config = fund_config(&f);
    config.oracle = oracle;
    // 2 % above the reference in a day: outside the corridor.
    publish_on(&f, &feed, NAV_EUR_8 * 102 / 100);
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::PriceOutOfBand))
    );
    publish_on(&f, &feed, NAV_EUR_8);
    f.client.set_fund(&f.shares, &config);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    // The applier picks a moment when the new feed is off the path: refused,
    // and the proposal waits.
    publish_on(&f, &feed, NAV_EUR_8 * 102 / 100);
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
    assert!(f.client.pending_fund_change(&f.shares).is_some());
    publish_on(&f, &feed, NAV_EUR_8);
    f.client.apply_fund_change(&f.shares);
    let state = f.client.get_fund_state(&f.shares).unwrap();
    assert_eq!(state.nav_decimals, FALLBACK_DECIMALS);
    assert_eq!((state.reference_nav, state.reference_time), (NAV_EUR_8, T0));
}

/// Review finding H1, FX leg: a new FX feed must lie within the current band
/// around the current reference rate, which carries over.
#[test]
fn a_new_fx_feed_must_lie_within_the_current_band() {
    let (f, _) = cross_fund();
    let mut config = f.client.get_fund(&f.shares).unwrap();
    let nav_feed = MockOracleClient::new(&f.env, &config.oracle);
    let fx_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    let fx_feed = MockOracleClient::new(&f.env, &fx_oracle);
    let PriceSource::Cross(mut leg) = config.source.clone() else {
        panic!("cross fund");
    };
    leg.oracle = fx_oracle;
    config.source = PriceSource::Cross(leg);
    let publish = |rate: i128| {
        let now = f.env.ledger().timestamp();
        fx_feed.set_price(&Asset::Other(eur(&f.env)), &rate, &now);
        nav_feed.set_price(&Asset::Stellar(f.shares.clone()), &NAV_USD, &now);
    };
    // 6 % away from the reference rate, for a band of 5 %.
    publish(EUR_USD * 94 / 100);
    assert_eq!(
        f.client.try_set_fund(&f.shares, &config),
        Err(Ok(Error::PriceOutOfBand))
    );
    publish(EUR_USD * 97 / 100);
    f.client.set_fund(&f.shares, &config);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish(EUR_USD * 94 / 100);
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
    publish(EUR_USD * 97 / 100);
    f.client.apply_fund_change(&f.shares);
    assert_eq!(
        f.client.get_fund_state(&f.shares).unwrap().reference_fx,
        EUR_USD
    );
}

/// Review findings H1b and M3: a proposal applies from its eta to the end of
/// its seven-day grace period, then it is gone.
#[test]
fn proposals_expire_after_their_grace_period() {
    let (f, _) = ready();
    f.client.set_fund(&f.shares, &replacement(&f));
    let hash = wasm_hash(&f.env, 7);
    f.client.propose_upgrade(&hash);
    advance(&f, DEFAULT_TIMELOCK_SECS + PROPOSAL_GRACE_SECS);
    publish_nav(&f, NAV_EUR);
    // The last second of the grace period still counts.
    assert!(f.client.pending_upgrade().is_some());
    f.client.apply_fund_change(&f.shares);
    advance(&f, 1);
    assert_eq!(f.client.pending_upgrade(), None);
    assert_eq!(
        f.client.try_upgrade(&hash),
        Err(Ok(raised(Error::ProposalExpired)))
    );
    f.client.set_max_term(&(10 * DAY));
    advance(&f, DEFAULT_TIMELOCK_SECS + PROPOSAL_GRACE_SECS + 1);
    assert_eq!(f.client.pending_max_term_change(), None);
    assert_eq!(
        f.client.try_apply_max_term_change(),
        Err(Ok(Error::ProposalExpired))
    );
    // A new proposal replaces the expired one.
    f.client.set_max_term(&(10 * DAY));
    assert!(f.client.pending_max_term_change().is_some());
}

/// Review finding H2: after a removal, re-admitting the fund under another
/// steward still needs the last one, who also keeps the right to cancel.
#[test]
fn readmission_after_removal_needs_the_last_steward() {
    let (f, _) = ready();
    f.client.remove_fund(&f.shares);
    let newcomer = Address::generate(&f.env);
    let mut config = fund_config(&f);
    config.steward = newcomer.clone();
    let signs = |address: &Address| MockAuth {
        address: leak(address.clone()),
        invoke: leak(MockAuthInvoke {
            contract: leak(f.contract_id.clone()),
            fn_name: "set_fund",
            args: (f.shares.clone(), config.clone()).into_val(&f.env),
            sub_invokes: &[],
        }),
    };
    f.env.mock_auths(&[signs(&f.governor), signs(&newcomer)]);
    assert!(f.client.try_set_fund(&f.shares, &config).is_err());
    f.env
        .mock_auths(&[signs(&f.governor), signs(&newcomer), signs(&f.steward)]);
    f.client.set_fund(&f.shares, &config);
    f.env.mock_all_auths();
    assert!(f.client.pending_fund_change(&f.shares).is_some());
    f.client.cancel_fund_change(&f.shares, &f.steward);
    assert_eq!(f.env.auths()[0].0, f.steward);
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
}

#[test]
fn fund_limits_tighten_at_once_and_loosen_after_the_delay() {
    let (f, _) = ready();
    f.client
        .set_fund_limits(&f.shares, &300, &(400_000 * ONE), &(4_000_000 * ONE));
    assert_eq!(
        own_events(&f),
        std::vec![FundLimitsSet {
            fund: f.shares.clone(),
            haircut_bps: 300,
            max_principal_per_repo: 400_000 * ONE,
            max_outstanding: 4_000_000 * ONE
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    // A lower haircut is a loosening, even with the caps unchanged.
    f.client
        .set_fund_limits(&f.shares, &200, &(400_000 * ONE), &(4_000_000 * ONE));
    let eta = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![FundLimitsChangeProposed {
            fund: f.shares.clone(),
            haircut_bps: 200,
            max_principal_per_repo: 400_000 * ONE,
            max_outstanding: 4_000_000 * ONE,
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_fund_limits_change(&f.shares),
        Some(PendingFundLimitsChange {
            haircut_bps: 200,
            max_principal_per_repo: 400_000 * ONE,
            max_outstanding: 4_000_000 * ONE,
            eta
        })
    );
    assert_eq!(f.client.get_fund(&f.shares).unwrap().haircut_bps, 300);
    assert_eq!(
        f.client.try_apply_fund_limits_change(&f.shares),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    f.env.set_auths(&[]);
    f.client.apply_fund_limits_change(&f.shares);
    assert!(f.env.auths().is_empty());
    assert_eq!(f.client.get_fund(&f.shares).unwrap().haircut_bps, 200);
    assert_eq!(f.client.pending_fund_limits_change(&f.shares), None);
    assert_eq!(
        f.client.try_apply_fund_limits_change(&f.shares),
        Err(Ok(Error::NotProposed))
    );
}

#[test]
fn fund_limits_loosening_is_cancelled_by_the_right_roles_or_a_tightening() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    let loosen = || {
        f.client
            .set_fund_limits(&f.shares, &200, &(600_000 * ONE), &(5_000_000 * ONE))
    };
    loosen();
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_cancel_fund_limits_change(&f.shares, &intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_fund_limits_change(&f.shares, &guardian);
    assert_eq!(
        own_events(&f),
        std::vec![FundLimitsChangeCancelled {
            fund: f.shares.clone(),
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    loosen();
    f.client.cancel_fund_limits_change(&f.shares, &f.governor);
    assert_eq!(f.client.pending_fund_limits_change(&f.shares), None);
    loosen();
    // Review finding M3: a direct tightening drops the pending loosening.
    f.client
        .set_fund_limits(&f.shares, &250, &(500_000 * ONE), &(5_000_000 * ONE));
    assert_eq!(
        own_events(&f),
        std::vec![
            FundLimitsChangeCancelled {
                fund: f.shares.clone(),
                by: f.steward.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            FundLimitsSet {
                fund: f.shares.clone(),
                haircut_bps: 250,
                max_principal_per_repo: 500_000 * ONE,
                max_outstanding: 5_000_000 * ONE
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_fund_limits_change(&f.shares), None);
    // An intruder cannot touch the limits at all.
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_fund_limits",
            args: (f.shares.clone(), 200u32, 600_000 * ONE, 5_000_000 * ONE).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f
        .client
        .try_set_fund_limits(&f.shares, &200, &(600_000 * ONE), &(5_000_000 * ONE))
        .is_err());
    f.env.mock_all_auths();
    assert_eq!(f.client.pending_fund_limits_change(&f.shares), None);
}

#[test]
fn currency_cap_moves_freely_before_the_first_admission() {
    let f = bare();
    f.client.set_currency_cap(&eur(&f.env), &(10 * ONE));
    assert_eq!(f.client.currency_cap(&eur(&f.env)), 10 * ONE);
    assert_eq!(f.client.pending_currency_cap_change(&eur(&f.env)), None);
}

#[test]
fn currency_cap_decrease_is_immediate_and_an_increase_waits() {
    let (f, _) = ready();
    let cap = |amount: i128| f.client.set_currency_cap(&eur(&f.env), &amount);
    cap(5_000_000 * ONE);
    assert_eq!(
        own_events(&f),
        std::vec![CurrencyCapSet {
            currency: eur(&f.env),
            cap: 5_000_000 * ONE
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    cap(20_000_000 * ONE);
    let eta = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![CurrencyCapChangeProposed {
            currency: eur(&f.env),
            cap: 20_000_000 * ONE,
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_currency_cap_change(&eur(&f.env)),
        Some(PendingCurrencyCapChange {
            cap: 20_000_000 * ONE,
            eta
        })
    );
    assert_eq!(f.client.currency_cap(&eur(&f.env)), 5_000_000 * ONE);
    assert_eq!(
        f.client.try_apply_currency_cap_change(&eur(&f.env)),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    f.env.set_auths(&[]);
    f.client.apply_currency_cap_change(&eur(&f.env));
    assert!(f.env.auths().is_empty());
    assert_eq!(f.client.currency_cap(&eur(&f.env)), 20_000_000 * ONE);
    assert_eq!(
        f.client.try_apply_currency_cap_change(&eur(&f.env)),
        Err(Ok(Error::NotProposed))
    );
}

#[test]
fn currency_cap_increase_is_cancelled_by_the_right_roles_or_a_decrease() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    let raise = || f.client.set_currency_cap(&eur(&f.env), &(20_000_000 * ONE));
    raise();
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client
            .try_cancel_currency_cap_change(&eur(&f.env), &intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_currency_cap_change(&eur(&f.env), &guardian);
    assert_eq!(
        own_events(&f),
        std::vec![CurrencyCapChangeCancelled {
            currency: eur(&f.env),
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    raise();
    f.client
        .cancel_currency_cap_change(&eur(&f.env), &f.governor);
    raise();
    f.client.set_currency_cap(&eur(&f.env), &(1_000 * ONE));
    assert_eq!(
        own_events(&f),
        std::vec![
            CurrencyCapChangeCancelled {
                currency: eur(&f.env),
                by: f.governor.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            CurrencyCapSet {
                currency: eur(&f.env),
                cap: 1_000 * ONE
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_currency_cap_change(&eur(&f.env)), None);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_currency_cap",
            args: (eur(&f.env), 2_000 * ONE).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f
        .client
        .try_set_currency_cap(&eur(&f.env), &(2_000 * ONE))
        .is_err());
    f.env.mock_all_auths();
    // At most eight currencies wait at once.
    for i in 0..MAX_PENDING_CURRENCY_CAPS {
        let currency = Symbol::new(&f.env, &std::format!("C{i}"));
        f.client.set_currency_cap(&currency, &ONE);
    }
    assert_eq!(
        f.client.try_set_currency_cap(&usd(&f.env), &ONE),
        Err(Ok(Error::LimitReached))
    );
}

/// Review finding M2: the current guardian can always hand its role over.
#[test]
fn guardian_hands_over_its_role_at_once() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    let successor = Address::generate(&f.env);
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "hand_over_guardian",
            args: (intruder.clone(),).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_hand_over_guardian(&intruder).is_err());
    f.env.mock_all_auths();
    f.client.hand_over_guardian(&successor);
    assert_eq!(f.env.auths()[0].0, guardian);
    assert_eq!(
        own_events(&f),
        std::vec![GuardianChanged {
            guardian: successor.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.guardian(), successor);
}

/// Review finding M2: a lost or hostile guardian cannot freeze governance.
/// The governor forces a new one after thirty days, and the guardian it
/// replaces cannot cancel that.
#[test]
fn governor_forces_a_guardian_change_after_thirty_days() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    let successor = Address::generate(&f.env);
    f.client.force_guardian_change(&successor);
    let eta = f.env.ledger().timestamp() + MAX_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![GuardianChangeForced {
            guardian: successor.clone(),
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_forced_guardian_change(),
        Some(PendingGuardianChange {
            guardian: successor.clone(),
            eta
        })
    );
    // The guardian's veto covers ordinary changes, not this one.
    assert_eq!(
        f.client.try_cancel_guardian_change(&guardian),
        Err(Ok(Error::NotProposed))
    );
    f.env.mock_auths(&[MockAuth {
        address: &guardian,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "cancel_forced_guardian_change",
            args: ().into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_cancel_forced_guardian_change().is_err());
    f.env.mock_all_auths();
    advance(&f, MAX_TIMELOCK_SECS - 1);
    assert_eq!(
        f.client.try_apply_forced_guardian_change(),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, 1);
    f.env.set_auths(&[]);
    f.client.apply_forced_guardian_change();
    f.env.mock_all_auths();
    assert_eq!(f.client.guardian(), successor);

    // The governor may withdraw its own forced change.
    f.client.force_guardian_change(&guardian);
    f.client.cancel_forced_guardian_change();
    assert_eq!(
        own_events(&f),
        std::vec![ForcedGuardianChangeCancelled {
            guardian: guardian.clone(),
            by: f.governor.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.pending_forced_guardian_change(), None);
}

/// Review finding M3: a direct tightening drops the pending loosening of
/// the same setting.
#[test]
fn a_direct_tightening_drops_the_pending_loosening() {
    let (f, _) = ready();
    f.client.set_max_term(&(10 * DAY));
    f.client.set_max_term(&(3 * DAY));
    assert_eq!(
        own_events(&f),
        std::vec![
            MaxTermChangeCancelled {
                max_term: 10 * DAY,
                by: f.governor.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            MaxTermChanged { max_term: 3 * DAY }.to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_max_term_change(), None);
    f.client.set_envelope(&looser_envelope());
    let mut tighter = default_envelope();
    tighter.min_haircut_bps = 150;
    f.client.set_envelope(&tighter);
    assert_eq!(
        own_events(&f),
        std::vec![
            EnvelopeChangeCancelled {
                envelope: looser_envelope(),
                by: f.governor.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            EnvelopeChanged {
                envelope: tighter.clone()
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_envelope_change(), None);
}

/// Review finding M3: a new governor starts with none of the previous
/// governor's own proposals; those a steward signed stay.
#[test]
fn governor_handover_drops_the_governors_proposals() {
    let (f, _) = ready();
    let hash = wasm_hash(&f.env, 7);
    let pending_guardian = Address::generate(&f.env);
    let forced_guardian = Address::generate(&f.env);
    f.client.propose_upgrade(&hash);
    f.client.set_guardian(&pending_guardian);
    f.client.force_guardian_change(&forced_guardian);
    f.client.set_max_term(&(10 * DAY));
    f.client.set_envelope(&looser_envelope());
    f.client.set_currency_cap(&eur(&f.env), &(20_000_000 * ONE));
    f.client.set_fund(&f.shares, &replacement(&f));
    let successor = Address::generate(&f.env);
    f.client.set_admin(&successor);
    f.client.accept_admin();
    let by = successor.clone();
    assert_eq!(
        own_events(&f),
        std::vec![
            UpgradeCancelled {
                wasm_hash: hash,
                by: by.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            GuardianChangeCancelled {
                guardian: pending_guardian,
                by: by.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            ForcedGuardianChangeCancelled {
                guardian: forced_guardian,
                by: by.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            MaxTermChangeCancelled {
                max_term: 10 * DAY,
                by: by.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            EnvelopeChangeCancelled {
                envelope: looser_envelope(),
                by: by.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            CurrencyCapChangeCancelled {
                currency: eur(&f.env),
                by: by.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            AdminChanged {
                previous: f.governor.clone(),
                admin: successor.clone()
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_upgrade(), None);
    assert_eq!(f.client.pending_guardian_change(), None);
    assert_eq!(f.client.pending_forced_guardian_change(), None);
    assert_eq!(f.client.pending_max_term_change(), None);
    assert_eq!(f.client.pending_envelope_change(), None);
    assert_eq!(f.client.pending_currency_cap_change(&eur(&f.env)), None);
    assert!(f.client.pending_fund_change(&f.shares).is_some());
}

// -- Second review of version 3 -----------------------------------------------

/// Second review, M1: a fund admitted before the steward record existed
/// (here: the record erased) is recorded at its removal, and reading the
/// record extends its TTL.
#[test]
fn removal_records_the_steward_and_reading_it_keeps_it_alive() {
    let (f, _) = ready();
    f.env.as_contract(&f.contract_id, || {
        f.env
            .storage()
            .persistent()
            .remove(&DataKey::LastSteward(f.shares.clone()));
    });
    f.client.remove_fund(&f.shares);
    let newcomer = Address::generate(&f.env);
    let mut config = fund_config(&f);
    config.steward = newcomer.clone();
    let signs = |address: &Address| MockAuth {
        address: leak(address.clone()),
        invoke: leak(MockAuthInvoke {
            contract: leak(f.contract_id.clone()),
            fn_name: "set_fund",
            args: (f.shares.clone(), config.clone()).into_val(&f.env),
            sub_invokes: &[],
        }),
    };
    f.env.mock_auths(&[signs(&f.governor), signs(&newcomer)]);
    assert!(f.client.try_set_fund(&f.shares, &config).is_err());
    f.env.mock_all_auths();
    f.client.set_fund(&f.shares, &config);
    let key = DataKey::LastSteward(f.shares.clone());
    age_ledgers(&f);
    assert!(entry_ttl(&f, &key) < BUMP_THRESHOLD_LEDGERS);
    f.client.cancel_fund_change(&f.shares, &f.steward);
    assert_eq!(entry_ttl(&f, &key), BUMP_TO_LEDGERS);
}

/// Second review, M2 (a) and M3: a replacement drops the loosened limits and
/// the re-anchor proposed against the configuration it replaces.
#[test]
fn a_replacement_drops_proposals_made_against_the_old_configuration() {
    let (f, _) = ready();
    f.client.set_fund(&f.shares, &replacement(&f));
    f.client
        .set_fund_limits(&f.shares, &200, &(600_000 * ONE), &(5_000_000 * ONE));
    f.client.propose_reanchor(&f.shares, &NAV_EUR, &0);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    f.client.apply_fund_change(&f.shares);
    let by = f.contract_id.clone();
    assert_eq!(
        own_events(&f),
        std::vec![
            FundLimitsChangeCancelled {
                fund: f.shares.clone(),
                by: by.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            ReanchorCancelled {
                fund: f.shares.clone(),
                by
            }
            .to_xdr(&f.env, &f.contract_id),
            FundSet {
                fund: f.shares.clone(),
                oracle: f.nav_oracle.clone(),
                haircut_bps: 300
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_fund_limits_change(&f.shares), None);
    assert_eq!(f.client.pending_reanchor(&f.shares), None);
}

/// Second review, M2 (b): the steward's direct tightening drops a pending
/// replacement, which would otherwise overwrite it.
#[test]
fn a_limits_tightening_drops_a_pending_replacement() {
    let (f, _) = ready();
    f.client.set_fund(&f.shares, &replacement(&f));
    f.client
        .set_fund_limits(&f.shares, &300, &(400_000 * ONE), &(4_000_000 * ONE));
    assert_eq!(
        own_events(&f),
        std::vec![
            FundChangeCancelled {
                fund: f.shares.clone(),
                by: f.steward.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            FundLimitsSet {
                fund: f.shares.clone(),
                haircut_bps: 300,
                max_principal_per_repo: 400_000 * ONE,
                max_outstanding: 4_000_000 * ONE
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_fund_change(&f.shares), None);
}

/// Second review, M2 (c): when a replacement changes the steward, the
/// fallback the previous steward signed goes.
#[test]
fn a_new_steward_drops_the_fallback_the_previous_one_signed() {
    let (f, _) = ready();
    let mut config = fund_config(&f);
    config.steward = Address::generate(&f.env);
    f.client.set_fund(&f.shares, &config);
    let (oracle, feed) = second_feed(&f, eur(&f.env));
    f.client
        .propose_fallback(&f.shares, &fallback_feed(&f, &oracle));
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    publish_on(&f, &feed, NAV_EUR_8);
    f.client.apply_fund_change(&f.shares);
    assert_eq!(
        own_events(&f),
        std::vec![
            FallbackCancelled {
                fund: f.shares.clone(),
                by: f.contract_id.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            FundSet {
                fund: f.shares.clone(),
                oracle: f.nav_oracle.clone(),
                haircut_bps: 200
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_fallback(&f.shares), None);
}

/// Second review, M3: after a legitimate drop, the governor and the steward
/// re-anchor the fund on the readings of the proposal; whoever applies can
/// neither choose the anchor nor apply it against a feed that moved away.
#[test]
fn reanchor_installs_the_readings_of_the_proposal() {
    let (f, offer_id) = ready();
    let dropped = NAV_EUR * 98 / 100;
    publish_nav(&f, dropped);
    assert_eq!(
        f.client.try_quote(&f.shares, &ONE, &f.eurc),
        Err(Ok(Error::PriceOutOfBand))
    );
    // Two keys: the governor alone cannot propose it.
    f.env.mock_auths(&[MockAuth {
        address: &f.governor,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "propose_reanchor",
            args: (f.shares.clone(), dropped, 0i128).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f
        .client
        .try_propose_reanchor(&f.shares, &dropped, &0)
        .is_err());
    f.env.mock_all_auths();
    f.client.propose_reanchor(&f.shares, &dropped, &0);
    let signers: std::vec::Vec<Address> = f.env.auths().into_iter().map(|a| a.0).collect();
    assert_eq!(signers, std::vec![f.governor.clone(), f.steward.clone()]);
    let eta = T0 + DEFAULT_TIMELOCK_SECS;
    assert_eq!(
        own_events(&f),
        std::vec![ReanchorProposed {
            fund: f.shares.clone(),
            nav: dropped,
            nav_time: T0,
            fx: 0,
            eta
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.pending_reanchor(&f.shares),
        Some(PendingReanchor {
            nav_oracle: f.nav_oracle.clone(),
            nav_asset: Asset::Stellar(f.shares.clone()),
            nav: dropped,
            nav_time: T0,
            nav_decimals: NAV_DECIMALS,
            fx: AnchorFx::Direct,
            eta
        })
    );
    assert_eq!(
        f.client.try_apply_reanchor(&f.shares),
        Err(Ok(Error::TimelockPending))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    // Review of the re-anchor round, item 3: the apply follows the model
    // from the proposed NAV. 0.2 % up in two days is faster than the
    // corridor (0.1 % floor plus 5 % a year), 0.15 % down is below its
    // floor: both refused.
    for moved in [dropped * 1_002 / 1_000, dropped * 9_985 / 10_000] {
        publish_nav(&f, moved);
        assert_eq!(
            f.client.try_apply_reanchor(&f.shares),
            Err(Ok(Error::PriceOutOfBand))
        );
    }
    assert!(f.client.pending_reanchor(&f.shares).is_some());
    // 0.12 % up: more than the 0.1 % floor, but on the model path, which a
    // symmetric band would wrongly refuse. The proposal's readings are
    // installed, not the spot.
    publish_nav(&f, dropped * 10_012 / 10_000);
    f.env.set_auths(&[]);
    f.client.apply_reanchor(&f.shares);
    assert!(f.env.auths().is_empty());
    assert_eq!(
        own_events(&f),
        std::vec![Reanchored {
            fund: f.shares.clone(),
            nav: dropped,
            nav_time: T0,
            fx: 0
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    let state = f.client.get_fund_state(&f.shares).unwrap();
    assert_eq!((state.reference_nav, state.reference_time), (dropped, T0));
    assert_eq!(f.client.pending_reanchor(&f.shares), None);
    f.env.mock_all_auths();
    f.client.open_repo(
        &f.borrower,
        &offer_id,
        &f.shares,
        &(10_000 * ONE),
        &(1_000 * ONE),
        &DAY,
    );
}

#[test]
fn reanchor_is_cancelled_by_the_right_roles() {
    let (f, _) = ready();
    let guardian = appoint_guardian(&f);
    f.client.propose_reanchor(&f.shares, &NAV_EUR, &0);
    let intruder = Address::generate(&f.env);
    assert_eq!(
        f.client.try_cancel_reanchor(&f.shares, &intruder),
        Err(Ok(Error::Unauthorized))
    );
    f.client.cancel_reanchor(&f.shares, &guardian);
    assert_eq!(
        own_events(&f),
        std::vec![ReanchorCancelled {
            fund: f.shares.clone(),
            by: guardian.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.try_cancel_reanchor(&f.shares, &guardian),
        Err(Ok(Error::NotProposed))
    );
    for caller in [&f.steward, &f.governor] {
        f.client.propose_reanchor(&f.shares, &NAV_EUR, &0);
        f.client.cancel_reanchor(&f.shares, caller);
        assert_eq!(f.env.auths()[0].0, *caller);
    }
    assert_eq!(f.client.pending_reanchor(&f.shares), None);
}

/// Second review, M3: a removed fund whose NAV left the old path is
/// re-admitted through a re-anchor on the feed of its pending re-admission.
#[test]
fn readmission_off_the_path_goes_through_a_reanchor() {
    let (f, _) = ready();
    f.client.remove_fund(&f.shares);
    let dropped = NAV_EUR * 98 / 100;
    publish_nav(&f, dropped);
    // The proposal of a removed fund's re-admission defers the path check.
    f.client.set_fund(&f.shares, &fund_config(&f));
    f.client.propose_reanchor(&f.shares, &dropped, &0);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, dropped);
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
    f.client.apply_reanchor(&f.shares);
    f.client.apply_fund_change(&f.shares);
    let state = f.client.get_fund_state(&f.shares).unwrap();
    assert_eq!((state.reference_nav, state.reference_time), (dropped, T0));
    assert!(f.client.get_fund(&f.shares).is_some());
}

/// Re-anchor round, item 1: the signers sign the values. Readings away from
/// them, a rate expected for a directly priced fund, or a value too large
/// for the apply's arithmetic are refused at the proposal.
#[test]
fn reanchor_signers_sign_the_values() {
    let (f, _) = ready();
    // 0.2 % away from the expected NAV, for a 0.1 % floor.
    assert_eq!(
        f.client
            .try_propose_reanchor(&f.shares, &(NAV_EUR * 1_002 / 1_000), &0),
        Err(Ok(Error::PriceOutOfBand))
    );
    assert_eq!(
        f.client.try_propose_reanchor(&f.shares, &NAV_EUR, &EUR_USD),
        Err(Ok(Error::PriceOutOfBand))
    );
    let huge = i128::MAX / 2;
    publish_nav(&f, huge);
    assert_eq!(
        f.client.try_propose_reanchor(&f.shares, &huge, &0),
        Err(Ok(Error::ArithmeticOverflow))
    );
    assert_eq!(f.client.pending_reanchor(&f.shares), None);
}

/// Re-anchor round, item 1, cross price: the expected rate is checked
/// against the leg's band, and the rate is bound to its feed.
#[test]
fn reanchor_of_a_cross_fund_checks_the_expected_rate() {
    let (f, _) = cross_fund();
    let config = f.client.get_fund(&f.shares).unwrap();
    let PriceSource::Cross(leg) = config.source.clone() else {
        panic!("cross fund");
    };
    // 6 % away from the rate, for a band of 5 %.
    assert_eq!(
        f.client
            .try_propose_reanchor(&f.shares, &NAV_USD, &(EUR_USD * 106 / 100)),
        Err(Ok(Error::PriceOutOfBand))
    );
    f.client.propose_reanchor(&f.shares, &NAV_USD, &EUR_USD);
    let pending = f.client.pending_reanchor(&f.shares).unwrap();
    assert_eq!(
        pending.fx,
        AnchorFx::Cross(AnchorRate {
            oracle: leg.oracle,
            asset: leg.asset,
            rate: EUR_USD,
            decimals: NAV_DECIMALS
        })
    );
}

/// Re-anchor round, item 2: a re-anchor is bound to the feeds it read. A
/// fund priced by other feeds at the apply refuses it, and the removed
/// fund's re-anchor goes with the re-admission it was read from.
#[test]
fn reanchor_is_bound_to_the_feeds_it_read() {
    let (f, _) = ready();
    f.client.propose_reanchor(&f.shares, &NAV_EUR, &0);
    // Simulate a fund now priced by another NAV feed than the proposal's.
    f.env.as_contract(&f.contract_id, || {
        let key = DataKey::PendingReanchor(f.shares.clone());
        let mut pending: PendingReanchor = f.env.storage().persistent().get(&key).unwrap();
        pending.nav_oracle = Address::generate(&f.env);
        f.env.storage().persistent().set(&key, &pending);
    });
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish_nav(&f, NAV_EUR);
    assert_eq!(
        f.client.try_apply_reanchor(&f.shares),
        Err(Ok(Error::NotProposed))
    );

    // Removed fund: overwriting or cancelling the re-admission drops the
    // re-anchor read from it.
    f.client.cancel_reanchor(&f.shares, &f.governor);
    f.client.remove_fund(&f.shares);
    f.client.set_fund(&f.shares, &fund_config(&f));
    f.client.propose_reanchor(&f.shares, &NAV_EUR, &0);
    f.client.set_fund(&f.shares, &replacement(&f));
    assert_eq!(f.client.pending_reanchor(&f.shares), None);
    f.client.propose_reanchor(&f.shares, &NAV_EUR, &0);
    f.client.cancel_fund_change(&f.shares, &f.steward);
    assert_eq!(
        own_events(&f),
        std::vec![
            ReanchorCancelled {
                fund: f.shares.clone(),
                by: f.steward.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            FundChangeCancelled {
                fund: f.shares.clone(),
                by: f.steward.clone()
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_reanchor(&f.shares), None);
}

/// Re-anchor round, item 4: the NAV for a re-anchor follows the pricing
/// rule. A fresh fallback that disagrees blocks it, and a fallback cannot
/// stand in for a stale primary.
#[test]
fn reanchor_reads_the_nav_under_the_pricing_rule() {
    let (f, _, feed) = ready_with_fallback();
    let dropped = NAV_EUR * 98 / 100;
    publish_nav(&f, dropped);
    assert_eq!(
        f.client.try_propose_reanchor(&f.shares, &dropped, &0),
        Err(Ok(Error::PriceDivergence))
    );
    advance(&f, 26 * HOUR + 1);
    publish_on(&f, &feed, NAV_EUR_8 * 98 / 100);
    assert_eq!(
        f.client.try_propose_reanchor(&f.shares, &dropped, &0),
        Err(Ok(Error::StalePrice))
    );
    publish_nav(&f, dropped);
    f.client.propose_reanchor(&f.shares, &dropped, &0);
}

/// Second review, L1: a replacement that gives a directly priced fund its
/// first FX leg anchors it on the rate read at the proposal; the apply only
/// checks today's rate lies within the band of it.
#[test]
fn a_first_fx_leg_is_anchored_at_the_proposal() {
    let (f, _) = ready();
    let usd_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    let nav_feed = MockOracleClient::new(&f.env, &usd_oracle);
    let fx_oracle = f
        .env
        .register(MockOracle, (Asset::Other(usd(&f.env)), NAV_DECIMALS));
    let fx_feed = MockOracleClient::new(&f.env, &fx_oracle);
    let publish = |rate: i128| {
        let now = f.env.ledger().timestamp();
        // A NAV on the fund's current path, so that only the FX is at stake.
        nav_feed.set_price(&Asset::Stellar(f.shares.clone()), &NAV_EUR, &now);
        fx_feed.set_price(&Asset::Other(eur(&f.env)), &rate, &now);
    };
    let mut config = fund_config(&f);
    config.oracle = usd_oracle;
    config.source = PriceSource::Cross(FxLeg {
        oracle: fx_oracle,
        asset: Asset::Other(eur(&f.env)),
        haircut_bps: 200,
        max_age_secs: 3 * DAY,
        band_bps: 500,
    });
    publish(EUR_USD);
    f.client.set_fund(&f.shares, &config);
    assert_eq!(
        f.client.pending_fund_change(&f.shares).unwrap().fx_anchor,
        EUR_USD
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    publish(EUR_USD * 94 / 100);
    assert_eq!(
        f.client.try_apply_fund_change(&f.shares),
        Err(Ok(Error::PriceOutOfBand))
    );
    publish(EUR_USD * 97 / 100);
    f.client.apply_fund_change(&f.shares);
    assert_eq!(
        f.client.get_fund_state(&f.shares).unwrap().reference_fx,
        EUR_USD
    );
}

/// Second review, L2: an ordinary guardian change, which the old guardian
/// could veto, settles a forced one still waiting; a hand-over does not.
#[test]
fn an_ordinary_guardian_change_settles_a_forced_one() {
    let (f, _) = ready();
    let forced = Address::generate(&f.env);
    let chosen = Address::generate(&f.env);
    f.client.force_guardian_change(&forced);
    f.client.hand_over_guardian(&Address::generate(&f.env));
    assert!(f.client.pending_forced_guardian_change().is_some());
    f.client.set_guardian(&chosen);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    f.client.apply_guardian_change();
    assert_eq!(
        own_events(&f),
        std::vec![
            ForcedGuardianChangeCancelled {
                guardian: forced,
                by: f.contract_id.clone()
            }
            .to_xdr(&f.env, &f.contract_id),
            GuardianChanged {
                guardian: chosen.clone()
            }
            .to_xdr(&f.env, &f.contract_id)
        ]
    );
    assert_eq!(f.client.pending_forced_guardian_change(), None);
    assert_eq!(f.client.guardian(), chosen);
}

/// Second review, L3: the governor withdraws a handover it proposed.
#[test]
fn governor_cancels_a_proposed_handover() {
    let f = bare();
    let successor = Address::generate(&f.env);
    assert_eq!(f.client.try_cancel_admin(), Err(Ok(Error::NotProposed)));
    f.client.set_admin(&successor);
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "cancel_admin",
            args: ().into_val(&f.env),
            sub_invokes: &[],
        },
    }]);
    assert!(f.client.try_cancel_admin().is_err());
    f.env.mock_all_auths();
    f.client.cancel_admin();
    assert_eq!(f.env.auths()[0].0, f.governor);
    assert_eq!(
        own_events(&f),
        std::vec![AdminProposalCancelled {
            proposed: successor,
            by: f.governor.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.try_accept_admin(), Err(Ok(Error::Unauthorized)));
    assert_eq!(f.client.admin(), f.governor);
}

/// Second review, L4: an expired cap proposal no longer holds one of the
/// eight slots.
#[test]
fn expired_currency_cap_proposals_free_their_slot() {
    let (f, _) = ready();
    for i in 0..MAX_PENDING_CURRENCY_CAPS {
        let currency = Symbol::new(&f.env, &std::format!("C{i}"));
        f.client.set_currency_cap(&currency, &ONE);
    }
    assert_eq!(
        f.client.try_set_currency_cap(&usd(&f.env), &ONE),
        Err(Ok(Error::LimitReached))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS + PROPOSAL_GRACE_SECS + 1);
    f.client.set_currency_cap(&usd(&f.env), &ONE);
    assert!(f.client.pending_currency_cap_change(&usd(&f.env)).is_some());
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
/// repos plus the shares awaiting release (decision S9); totals equal the sum
/// of open principals.
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
    let awaiting: i128 = repos
        .iter()
        .filter_map(|id| f.client.pending_release(id))
        .filter(|p| p.fund == f.shares)
        .map(|p| p.shares)
        .sum();
    assert_eq!(
        balance(&f.env, &f.shares, &f.contract_id),
        locked + awaiting
    );
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
    let (read, written) = constant_open_footprint(&f, offer_id, "no fallback");
    // Version 2 read 17 entries and wrote 9. Extending the instance alone
    // (`storage::bump_instance`) no longer reads the code entry: 16. The
    // fallback check costs a fund without fallback nothing.
    assert_eq!((read, written), (16, 9));
}

/// The same with a fallback feed: the footprint grows by the fallback's own
/// entries and stays constant.
#[test]
fn opening_a_repo_with_a_fallback_touches_a_constant_number_of_entries() {
    let (f, offer_id, feed) = ready_with_fallback();
    // The fallback must be fresh, or it is not read beyond its first entry.
    publish_on(&f, &feed, NAV_EUR_8);
    let (read, written) = constant_open_footprint(&f, offer_id, "with a fallback");
    // The fallback's entry and its oracle's instance.
    assert_eq!((read, written), (18, 9));
}

/// Opens 152 repos and checks the second and the last touch the same number
/// of entries. Returns that footprint (read, written).
fn constant_open_footprint(f: &Fixture, offer_id: u64, label: &str) -> (u32, u32) {
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
    measure(f);
    let first = measure(f);
    for _ in 0..150 {
        measure(f);
    }
    let last = measure(f);
    let read = last.disk_read_entries + last.memory_read_entries;
    assert_eq!(read, first.disk_read_entries + first.memory_read_entries);
    assert_eq!(last.write_entries, first.write_entries);
    std::println!(
        "open_repo footprint, {label}: {read} entries read, {} written; \
         instructions {} -> {} (test host)",
        last.write_entries,
        first.instructions,
        last.instructions
    );
    (read, last.write_entries)
}

/// Ledger entries an invocation read and wrote, and its instructions (test
/// host), from the same metering as the test above.
fn footprint(env: &Env) -> (u32, u32, i64) {
    let resources = env.cost_estimate().resources();
    (
        resources.disk_read_entries + resources.memory_read_entries,
        resources.write_entries,
        resources.instructions,
    )
}

/// Load test (roadmap step 1, review gate "avant le testnet public"): 200
/// repos over four offers from two lenders and five borrowers, then all
/// repurchased. Every `open_repo` and every `repurchase` touches the same
/// number of ledger entries, whether it is the first or the last: nothing in
/// the contract walks the open positions. The invariants hold at the peak and
/// at the end.
#[test]
fn many_repos_keep_a_constant_footprint_per_operation() {
    const REPOS: usize = 200;
    let (f, first_offer) = ready();
    let second_lender = Address::generate(&f.env);
    f.client.approve_lender(&f.shares, &second_lender, &true);
    mint(&f.env, &f.eurc, &second_lender, 1_000_000 * ONE);
    let mut offers = std::vec![first_offer];
    for (lender, rate_bps) in [
        (&f.lender, 250),
        (&second_lender, 300),
        (&second_lender, 400),
    ] {
        offers.push(f.client.create_offer(
            lender,
            &f.eurc,
            &(100_000 * ONE),
            &rate_bps,
            &(7 * DAY),
            &vec![&f.env, f.shares.clone()],
        ));
    }
    let borrowers: std::vec::Vec<Address> = (0..5)
        .map(|_| {
            let borrower = Address::generate(&f.env);
            mint(&f.env, &f.shares, &borrower, 1_000 * ONE);
            mint(&f.env, &f.eurc, &borrower, 1_000 * ONE);
            borrower
        })
        .collect();

    // Five borrowers and four offers: the 200 repos cover every pair.
    let mut repos = std::vec::Vec::with_capacity(REPOS);
    let mut opens = std::vec::Vec::with_capacity(REPOS);
    for i in 0..REPOS {
        repos.push(f.client.open_repo(
            &borrowers[i % borrowers.len()],
            &offers[i % offers.len()],
            &f.shares,
            &(20 * ONE),
            &(10 * ONE),
            &DAY,
        ));
        opens.push(footprint(&f.env));
    }
    check_invariants(&f, &offers, &repos);
    assert_eq!(
        f.client.currency_outstanding(&eur(&f.env)),
        REPOS as i128 * 10 * ONE
    );

    advance(&f, HOUR);
    let mut repurchases = std::vec::Vec::with_capacity(REPOS);
    for repo_id in &repos {
        f.client.repurchase(repo_id);
        repurchases.push(footprint(&f.env));
    }
    check_invariants(&f, &offers, &repos);
    assert_eq!(f.client.currency_outstanding(&eur(&f.env)), 0);
    assert_eq!(balance(&f.env, &f.shares, &f.contract_id), 0);

    // The very first repo creates the contract's share balance entry; from
    // the second on, the footprint must not move.
    let entries = |m: &(u32, u32, i64)| (m.0, m.1);
    let first_open = opens[1];
    let last_open = opens[REPOS - 1];
    for (i, measured) in opens.iter().enumerate().skip(1) {
        assert_eq!(
            entries(measured),
            entries(&first_open),
            "open_repo #{}",
            i + 1
        );
    }
    let first_repurchase = repurchases[0];
    let last_repurchase = repurchases[REPOS - 1];
    for (i, measured) in repurchases.iter().enumerate() {
        assert_eq!(
            entries(measured),
            entries(&first_repurchase),
            "repurchase #{}",
            i + 1
        );
    }
    std::println!(
        "load test, {} repos: open_repo {} entries read, {} written (2nd and last); \
         instructions {} -> {} (test host)",
        REPOS,
        last_open.0,
        last_open.1,
        first_open.2,
        last_open.2
    );
    std::println!(
        "load test, {} repos: repurchase {} entries read, {} written (first and last); \
         instructions {} -> {} (test host)",
        REPOS,
        last_repurchase.0,
        last_repurchase.1,
        first_repurchase.2,
        last_repurchase.2
    );
}

// ---------------------------------------------------------------------------
// Upgrade to the WASM built by `stellar contract build`
// ---------------------------------------------------------------------------

#[cfg(not(night_window_wasm))]
compile_error!(
    "the upgrade test needs target/wasm32v1-none/release/night_window.wasm: \
     run `stellar contract build` before `cargo test` or `cargo clippy --all-targets` \
     (see contracts/night-window/build.rs)"
);

/// The release WASM produced by `stellar contract build`, located by build.rs.
#[cfg(night_window_wasm)]
const NIGHT_WINDOW_WASM: &[u8] = include_bytes!(env!("NIGHT_WINDOW_WASM"));

/// The WASM hash the ledger holds as `contract`'s executable, read from its
/// instance entry. A natively compiled test contract has a pseudo hash here.
#[cfg(night_window_wasm)]
fn executable_hash(env: &Env, contract: &Address) -> Option<[u8; 32]> {
    use soroban_sdk::xdr::{
        ContractExecutable as XdrExecutable, LedgerEntryData, ScAddress, ScVal,
    };
    let address = ScAddress::from(contract);
    env.to_ledger_snapshot()
        .ledger_entries
        .iter()
        .find_map(|(_, (entry, _))| match &entry.data {
            LedgerEntryData::ContractData(data)
                if data.contract == address && data.key == ScVal::LedgerKeyContractInstance =>
            {
                match &data.val {
                    ScVal::ContractInstance(instance) => match &instance.executable {
                        XdrExecutable::Wasm(hash) => Some(hash.0),
                        _ => None,
                    },
                    _ => None,
                }
            }
            _ => None,
        })
}

/// Everything the upgrade must keep, read through the public interface.
#[cfg(night_window_wasm)]
#[derive(Debug, PartialEq)]
struct Snapshot {
    admin: Address,
    guardian: Address,
    paused: bool,
    max_term: u64,
    timelock_delay: u64,
    envelope: RiskEnvelope,
    stablecoin: Option<StablecoinConfig>,
    currency_cap: i128,
    currency_outstanding: i128,
    fund: Option<FundConfig>,
    fund_state: Option<FundState>,
    lender_approved: bool,
    offers: std::vec::Vec<Option<Offer>>,
    repos: std::vec::Vec<Option<Repo>>,
    stablecoins_held: i128,
    shares_held: i128,
}

#[cfg(night_window_wasm)]
fn snapshot(f: &Fixture, offers: &[u64], repos: &[u64]) -> Snapshot {
    Snapshot {
        admin: f.client.admin(),
        guardian: f.client.guardian(),
        paused: f.client.is_paused(),
        max_term: f.client.max_term(),
        timelock_delay: f.client.timelock_delay(),
        envelope: f.client.envelope(),
        stablecoin: f.client.get_stablecoin(&f.eurc),
        currency_cap: f.client.currency_cap(&eur(&f.env)),
        currency_outstanding: f.client.currency_outstanding(&eur(&f.env)),
        fund: f.client.get_fund(&f.shares),
        fund_state: f.client.get_fund_state(&f.shares),
        lender_approved: f.client.is_lender_approved(&f.shares, &f.lender),
        offers: offers.iter().map(|id| f.client.get_offer(id)).collect(),
        repos: repos.iter().map(|id| f.client.get_repo(id)).collect(),
        stablecoins_held: balance(&f.env, &f.eurc, &f.contract_id),
        shares_held: balance(&f.env, &f.shares, &f.contract_id),
    }
}

/// Roadmap step 1 and review gate "avant le testnet public": the nominal
/// upgrade path with a really uploaded WASM. The contract starts as the
/// natively compiled code, holds offers, open repos and a closed one, a
/// separate guardian, a changed term ceiling and the pause flag; the governor
/// proposes the release WASM, waits for the time delay (S7), then switches
/// the contract to it. Every value survives, and the WASM, now
/// running in the VM, still serves the open repos, opens new ones and refuses
/// an intruder's upgrade.
#[cfg(night_window_wasm)]
#[test]
fn upgrade_to_the_built_wasm_keeps_offers_repos_and_roles() {
    let (f, first_offer) = ready();
    let second_offer = f.client.create_offer(
        &f.lender,
        &f.eurc,
        &(50_000 * ONE),
        &500,
        &(3 * DAY),
        &vec![&f.env, f.shares.clone()],
    );
    f.client.set_sponsor(&second_offer, &f.shares, &true);
    let long_repo = open(&f, first_offer);
    let short_repo = f.client.open_repo(
        &f.borrower,
        &second_offer,
        &f.shares,
        &(4_000 * ONE),
        &(3_000 * ONE),
        &(2 * DAY),
    );
    let closed_repo = open(&f, first_offer);
    advance(&f, HOUR);
    f.client.repurchase(&closed_repo);
    let guardian = appoint_guardian(&f);
    f.client.set_max_term(&(5 * DAY));
    f.client.pause(&guardian);

    let offers = [first_offer, second_offer];
    let repos = [long_repo, short_repo, closed_repo];

    // Decision S7: the upgrade is proposed, waits for its delay, and only
    // then can the governor apply it.
    let hash = f.env.deployer().upload_contract_wasm(NIGHT_WINDOW_WASM);
    let native = executable_hash(&f.env, &f.contract_id);
    assert!(native.is_some());
    assert_ne!(native, Some(hash.to_array()));
    f.client.propose_upgrade(&hash);
    assert_eq!(f.env.auths()[0].0, f.governor);
    assert_eq!(
        f.client.try_upgrade(&hash),
        Err(Ok(raised(Error::TimelockPending)))
    );
    advance(&f, DEFAULT_TIMELOCK_SECS);
    assert_eq!(executable_hash(&f.env, &f.contract_id), native);
    // The NAV feed kept publishing during the delay.
    publish_nav(&f, NAV_EUR);

    let before = snapshot(&f, &offers, &repos);
    assert!(before.paused);
    assert_eq!(
        before.repos[2].as_ref().unwrap().status,
        RepoStatus::Repurchased
    );
    f.client.upgrade(&hash);
    assert_eq!(f.env.auths()[0].0, f.governor);
    assert_eq!(
        own_events(&f),
        std::vec![Upgraded {
            wasm_hash: hash.clone()
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        executable_hash(&f.env, &f.contract_id),
        Some(hash.to_array())
    );

    // From here on, every call runs the uploaded WASM in the VM.
    assert_eq!(snapshot(&f, &offers, &repos), before);
    assert_eq!(f.client.version(), 3);
    assert_eq!(f.client.pending_upgrade(), None);
    check_invariants(&f, &offers, &repos);

    // The pause survived: entries stay closed, exits stay open.
    assert_eq!(
        f.client.try_open_repo(
            &f.borrower,
            &first_offer,
            &f.shares,
            &(20 * ONE),
            &(10 * ONE),
            &DAY
        ),
        Err(Ok(Error::Paused))
    );
    advance(&f, HOUR);
    let due = f.client.repo_due(&long_repo);
    f.client.repurchase(&long_repo);
    assert_eq!(f.env.auths()[0].0, f.borrower);
    assert_eq!(
        f.client.get_offer(&first_offer).unwrap().available,
        before.offers[0].as_ref().unwrap().available + 10_000 * ONE + due
    );

    // The governor lifts the pause and a new repo opens on the old offer.
    f.client.unpause();
    assert_eq!(f.env.auths()[0].0, f.governor);
    let new_repo = f.client.open_repo(
        &f.borrower,
        &first_offer,
        &f.shares,
        &(2_000 * ONE),
        &(1_000 * ONE),
        &DAY,
    );
    assert_eq!(new_repo, closed_repo + 1);
    let all_repos = [long_repo, short_repo, closed_repo, new_repo];
    check_invariants(&f, &offers, &all_repos);
    f.client.repurchase(&short_repo);
    f.client.repurchase(&new_repo);
    check_invariants(&f, &offers, &all_repos);
    assert_eq!(f.client.currency_outstanding(&eur(&f.env)), 0);

    // The upgraded contract still refuses an intruder's upgrade, even one
    // whose delay has elapsed.
    f.client.propose_upgrade(&hash);
    advance(&f, DEFAULT_TIMELOCK_SECS);
    let intruder = Address::generate(&f.env);
    let other = soroban_sdk::BytesN::from_array(&f.env, &[7u8; 32]);
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
    assert!(f.client.try_upgrade(&other).is_err());
    assert_eq!(
        executable_hash(&f.env, &f.contract_id),
        Some(hash.to_array())
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

    // -- Decision S9 (version 1.1): issuer freeze, allowlist removal or
    // clawback while a repo is open. The debt still settles; the shares wait
    // as a pending release that anyone can retry.

    const SHARES: i128 = 10_000 * ONE;

    fn open_live(live: &Live, term: u64) -> u64 {
        let f = &live.f;
        f.client.open_repo(
            &f.borrower,
            &live.offer_id,
            &f.shares,
            &SHARES,
            &(10_000 * ONE),
            &term,
        )
    }

    /// Checks the debt side settled, the shares stayed in the contract and
    /// are recorded for `to`, and `release` reports a refusal while the token
    /// still refuses, keeping the record.
    fn assert_deferred(live: &Live, repo_id: u64, to: &Address) {
        let f = &live.f;
        assert_eq!(
            f.client.pending_release(&repo_id),
            Some(PendingRelease {
                fund: f.shares.clone(),
                to: to.clone(),
                shares: SHARES
            })
        );
        assert_eq!(f.client.get_fund_state(&f.shares).unwrap().outstanding, 0);
        assert_eq!(f.client.currency_outstanding(&eur(&f.env)), 0);
        f.env.set_auths(&[]);
        assert!(!f.client.release(&repo_id));
        f.env.mock_all_auths();
        assert!(f.client.pending_release(&repo_id).is_some());
    }

    /// Review finding L6: a record may wait months for the issuer; each
    /// refused attempt extends its TTL.
    #[test]
    fn a_refused_release_extends_the_record() {
        let live = live(true);
        let f = &live.f;
        let repo_id = open_live(&live, DAY);
        live.token.set_frozen(&f.contract_id, &true);
        f.client.repurchase(&repo_id);
        let key = DataKey::PendingRelease(repo_id);
        let repo_key = DataKey::Repo(repo_id);
        age_ledgers(f);
        assert!(entry_ttl(f, &key) < BUMP_THRESHOLD_LEDGERS);
        assert!(entry_ttl(f, &repo_key) < BUMP_THRESHOLD_LEDGERS);
        assert!(!f.client.release(&repo_id));
        assert_eq!(entry_ttl(f, &key), BUMP_TO_LEDGERS);
        // Second review, L5: the repo, which `redirect_release` reads, too.
        assert_eq!(entry_ttl(f, &repo_key), BUMP_TO_LEDGERS);
    }

    /// Anyone retries the release once the token accepts again.
    fn assert_released(live: &Live, repo_id: u64, to: &Address, before: i128) {
        let f = &live.f;
        f.env.set_auths(&[]);
        assert!(f.client.release(&repo_id));
        assert!(f.env.auths().is_empty());
        assert_eq!(
            own_events(f),
            std::vec![SharesReleased {
                repo_id,
                to: to.clone(),
                shares: SHARES
            }
            .to_xdr(&f.env, &f.contract_id)]
        );
        f.env.mock_all_auths();
        assert_eq!(live.token.balance(to), before + SHARES);
        assert_eq!(f.client.pending_release(&repo_id), None);
        assert_eq!(
            f.client.try_release(&repo_id),
            Err(Ok(Error::NothingToRelease))
        );
    }

    #[test]
    fn issuer_freeze_defers_the_shares_and_the_borrower_still_repays() {
        let live = live(true);
        let f = &live.f;
        let repo_id = open_live(&live, DAY);
        advance(f, HOUR);
        live.token.set_frozen(&f.contract_id, &true);
        let interest = f.client.repo_due(&repo_id);
        let borrower_shares = live.token.balance(&f.borrower);
        f.client.repurchase(&repo_id);
        assert_eq!(
            own_events(f),
            std::vec![
                RepoRepurchased {
                    repo_id,
                    principal: 10_000 * ONE,
                    interest
                }
                .to_xdr(&f.env, &f.contract_id),
                ReleaseDeferred {
                    repo_id,
                    to: f.borrower.clone(),
                    shares: SHARES
                }
                .to_xdr(&f.env, &f.contract_id)
            ]
        );
        // The lender is paid; interest stops; the shares stay attributed to
        // the borrower.
        assert_eq!(
            f.client.get_repo(&repo_id).unwrap().status,
            RepoStatus::Repurchased
        );
        assert_eq!(
            f.client.get_offer(&live.offer_id).unwrap().available,
            100_000 * ONE + interest
        );
        assert_eq!(live.token.balance(&f.contract_id), SHARES);
        assert_deferred(&live, repo_id, &f.borrower);
        check_invariants(f, &[live.offer_id], &[repo_id]);
        assert_eq!(
            f.client.try_repurchase(&repo_id),
            Err(Ok(Error::RepoNotOpen))
        );

        live.token.set_frozen(&f.contract_id, &false);
        assert_released(&live, repo_id, &f.borrower, borrower_shares);
        assert_eq!(live.token.balance(&f.contract_id), 0);
        check_invariants(f, &[live.offer_id], &[repo_id]);
    }

    #[test]
    fn seizure_of_frozen_shares_waits_for_the_release() {
        let live = live(true);
        let f = &live.f;
        let repo_id = open_live(&live, 2 * HOUR);
        advance(f, 2 * HOUR);
        live.token.set_frozen(&f.contract_id, &true);
        f.client.seize(&repo_id, &f.lender);
        assert_eq!(
            own_events(f),
            std::vec![
                RepoSeized {
                    repo_id,
                    to: f.lender.clone(),
                    shares: SHARES
                }
                .to_xdr(&f.env, &f.contract_id),
                ReleaseDeferred {
                    repo_id,
                    to: f.lender.clone(),
                    shares: SHARES
                }
                .to_xdr(&f.env, &f.contract_id)
            ]
        );
        assert_eq!(
            f.client.get_repo(&repo_id).unwrap().status,
            RepoStatus::Defaulted
        );
        assert_deferred(&live, repo_id, &f.lender);
        live.token.set_frozen(&f.contract_id, &false);
        assert_released(&live, repo_id, &f.lender, 0);
    }

    #[test]
    fn borrower_removed_from_the_allowlist_still_repays() {
        let live = live(true);
        let f = &live.f;
        let repo_id = open_live(&live, DAY);
        live.token.set_whitelisted(&f.borrower, &false);
        let borrower_shares = live.token.balance(&f.borrower);
        f.client.repurchase(&repo_id);
        assert_deferred(&live, repo_id, &f.borrower);
        // A frozen recipient blocks the release the same way.
        live.token.set_whitelisted(&f.borrower, &true);
        live.token.set_frozen(&f.borrower, &true);
        assert_deferred(&live, repo_id, &f.borrower);
        live.token.set_frozen(&f.borrower, &false);
        assert_released(&live, repo_id, &f.borrower, borrower_shares);
    }

    #[test]
    fn clawback_leaving_too_few_shares_defers_the_release() {
        let live = live(true);
        let f = &live.f;
        let repo_id = open_live(&live, DAY);
        live.token.clawback(&f.contract_id, &(SHARES / 2));
        let borrower_shares = live.token.balance(&f.borrower);
        f.client.repurchase(&repo_id);
        assert_deferred(&live, repo_id, &f.borrower);
        // The issuer restores the shares it took; the release goes through.
        live.token.mint(&f.contract_id, &(SHARES / 2));
        assert_released(&live, repo_id, &f.borrower, borrower_shares);
    }

    #[test]
    fn a_failed_repayment_still_reverts_the_whole_repurchase() {
        let live = live(true);
        let f = &live.f;
        let repo_id = open_live(&live, DAY);
        live.token.set_frozen(&f.contract_id, &true);
        // The borrower spends the stablecoins: the repayment cannot be pulled.
        let spent = balance(&f.env, &f.eurc, &f.borrower);
        let elsewhere = Address::generate(&f.env);
        TokenClient::new(&f.env, &f.eurc).transfer(&f.borrower, &elsewhere, &spent);
        assert!(f.client.try_repurchase(&repo_id).is_err());
        assert_eq!(
            f.client.get_repo(&repo_id).unwrap().status,
            RepoStatus::Open
        );
        assert_eq!(f.client.pending_release(&repo_id), None);
        assert_eq!(
            f.client.get_fund_state(&f.shares).unwrap().outstanding,
            10_000 * ONE
        );
    }

    /// Review finding L8: after a repurchase, the borrower may send its
    /// deferred shares to another address; nobody else can.
    #[test]
    fn borrower_redirects_a_deferred_release() {
        let live = live(true);
        let f = &live.f;
        let repo_id = open_live(&live, DAY);
        live.token.set_whitelisted(&f.borrower, &false);
        f.client.repurchase(&repo_id);
        let custodian = Address::generate(&f.env);
        live.token.set_whitelisted(&custodian, &true);
        f.env.mock_auths(&[MockAuth {
            address: &f.lender,
            invoke: &MockAuthInvoke {
                contract: &f.contract_id,
                fn_name: "redirect_release",
                args: (repo_id, custodian.clone()).into_val(&f.env),
                sub_invokes: &[],
            },
        }]);
        assert!(f.client.try_redirect_release(&repo_id, &custodian).is_err());
        f.env.mock_all_auths();
        // Second review, L6: never to the contract itself, which would keep
        // the shares while dropping the record.
        assert_eq!(
            f.client.try_redirect_release(&repo_id, &f.contract_id),
            Err(Ok(Error::TransferMismatch))
        );
        f.client.redirect_release(&repo_id, &custodian);
        assert_eq!(f.env.auths()[0].0, f.borrower);
        assert_eq!(
            own_events(f),
            std::vec![ReleaseRedirected {
                repo_id,
                to: custodian.clone()
            }
            .to_xdr(&f.env, &f.contract_id)]
        );
        assert_released(&live, repo_id, &custodian, 0);
    }

    /// Review finding L8: after a seizure, the lender may redirect its
    /// deferred shares, but only to an address the steward approved.
    #[test]
    fn lender_redirects_a_seized_release_to_an_approved_lender() {
        let live = live(true);
        let f = &live.f;
        let repo_id = open_live(&live, 2 * HOUR);
        advance(f, 2 * HOUR);
        live.token.set_whitelisted(&f.lender, &false);
        f.client.seize(&repo_id, &f.lender);
        assert_deferred(&live, repo_id, &f.lender);
        let other = Address::generate(&f.env);
        live.token.set_whitelisted(&other, &true);
        assert_eq!(
            f.client.try_redirect_release(&repo_id, &other),
            Err(Ok(Error::LenderNotApproved))
        );
        f.client.approve_lender(&f.shares, &other, &true);
        f.client.redirect_release(&repo_id, &other);
        assert_eq!(f.env.auths()[0].0, f.lender);
        assert_released(&live, repo_id, &other, 0);
    }

    #[test]
    fn release_of_an_unknown_repo_is_refused() {
        let live = live(true);
        assert_eq!(
            live.f.client.try_release(&42),
            Err(Ok(Error::NothingToRelease))
        );
    }
}

/// Operations extend the contract instance but never the WASM code entry:
/// code rent grows with its size, and an ordinary user must not pay it (see
/// `storage::bump_instance`). The operator extends the code separately.
#[cfg(night_window_wasm)]
#[test]
fn operations_extend_the_instance_but_not_the_code() {
    use soroban_sdk::testutils::Deployer as _;
    let env = Env::default();
    env.mock_all_auths();
    let governor = Address::generate(&env);
    let id = env.register(NIGHT_WINDOW_WASM, (governor.clone(),));
    let client = OpenWindowClient::new(&env, &id);
    let instance_before = env.deployer().get_contract_instance_ttl(&id);
    let code_before = env.deployer().get_contract_code_ttl(&id);

    client.set_currency_cap(&eur(&env), &1);

    let instance_after = env.deployer().get_contract_instance_ttl(&id);
    let code_after = env.deployer().get_contract_code_ttl(&id);
    assert!(instance_after > instance_before, "the instance is extended");
    assert_eq!(instance_after, 120 * 17_280);
    assert_eq!(
        code_after, code_before,
        "the code entry is left to the operator"
    );
}

/// Real permissioned shares are often a classic asset with authorization
/// required, held through its Stellar Asset Contract. When the issuer
/// deauthorizes the contract, the asset contract refuses the transfer: the
/// repurchase must still settle and the shares wait, as with `fund-token`.
#[test]
fn asset_contract_deauthorizing_the_contract_defers_the_release() {
    let (f, offer_id) = ready();
    let repo_id = open(&f, offer_id);
    let shares_before = balance(&f.env, &f.shares, &f.borrower);
    let issuer = StellarAssetClient::new(&f.env, &f.shares);

    issuer.set_authorized(&f.contract_id, &false);
    f.client.repurchase(&repo_id);
    let pending = f
        .client
        .pending_release(&repo_id)
        .expect("shares recorded as owed");
    assert_eq!(pending.to, f.borrower);
    assert_eq!(pending.shares, 10_000 * ONE);
    assert!(
        !f.client.release(&repo_id),
        "still refused while deauthorized"
    );
    assert_eq!(balance(&f.env, &f.shares, &f.borrower), shares_before);

    issuer.set_authorized(&f.contract_id, &true);
    assert!(f.client.release(&repo_id));
    assert_eq!(f.client.pending_release(&repo_id), None);
    assert_eq!(
        balance(&f.env, &f.shares, &f.borrower),
        shares_before + 10_000 * ONE
    );
}
