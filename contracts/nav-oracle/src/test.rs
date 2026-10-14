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
use soroban_sdk::{
    contractclient, symbol_short,
    testutils::{Address as _, EnvTestConfig, Events as _, MockAuth, MockAuthInvoke},
    Address, Env, Event as _, IntoVal,
};

const DECIMALS: u32 = 14;
const RESOLUTION: u32 = 300;
const T0: u64 = 1_700_000_000;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

struct Fixture {
    env: Env,
    admin: Address,
    contract_id: Address,
    client: NavOracleClient<'static>,
}

fn base() -> Asset {
    Asset::Other(symbol_short!("USD"))
}

fn share() -> Asset {
    Asset::Other(symbol_short!("USTBL"))
}

fn setup() -> Fixture {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(NavOracle, (admin.clone(), base(), DECIMALS, RESOLUTION));
    // The client borrows the Env; leaking a clone keeps the fixture simple.
    let leaked_env: &'static Env = std::boxed::Box::leak(std::boxed::Box::new(env.clone()));
    let leaked_id: &'static Address =
        std::boxed::Box::leak(std::boxed::Box::new(contract_id.clone()));
    let client = NavOracleClient::new(leaked_env, leaked_id);
    Fixture {
        env,
        admin,
        contract_id,
        client,
    }
}

// ---------------------------------------------------------------------------
// Constructor and administration
// ---------------------------------------------------------------------------

#[test]
fn constructor_sets_configuration() {
    let f = setup();
    assert_eq!(f.client.admin(), f.admin);
    assert_eq!(f.client.base(), base());
    assert_eq!(f.client.decimals(), DECIMALS);
    assert_eq!(f.client.resolution(), RESOLUTION);
    assert_eq!(f.client.assets().len(), 0);
    assert_eq!(f.client.last_timestamp(), 0);
    assert_eq!(f.client.lastprice(&share()), None);
    assert_eq!(f.client.prices(&share(), &5), None);
    assert_eq!(f.client.price(&share(), &T0), None);
}

/// Env for tests that panic: the snapshot an Env writes when dropped would
/// otherwise land in the crate directory.
fn env_without_snapshot() -> Env {
    Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    })
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn constructor_rejects_zero_resolution() {
    let env = env_without_snapshot();
    let admin = Address::generate(&env);
    env.register(NavOracle, (admin, base(), DECIMALS, 0u32));
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn constructor_rejects_too_many_decimals() {
    let env = env_without_snapshot();
    let admin = Address::generate(&env);
    env.register(NavOracle, (admin, base(), MAX_DECIMALS + 1, RESOLUTION));
}

#[test]
fn set_admin_requires_current_admin_and_emits_event() {
    let f = setup();
    f.env.mock_all_auths();
    let new_admin = Address::generate(&f.env);

    f.client.set_admin(&new_admin);

    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.admin);
    assert_eq!(
        f.env.events().all(),
        std::vec![AdminChanged {
            previous: f.admin.clone(),
            admin: new_admin.clone(),
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(f.client.admin(), new_admin);
}

#[test]
fn non_admin_cannot_change_admin() {
    let f = setup();
    let intruder = Address::generate(&f.env);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "set_admin",
            args: (&intruder,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);

    assert!(f.client.try_set_admin(&intruder).is_err());
    assert_eq!(f.client.admin(), f.admin);
}

#[test]
fn non_admin_cannot_upgrade() {
    let f = setup();
    let intruder = Address::generate(&f.env);
    let hash = BytesN::from_array(&f.env, &[7u8; 32]);
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "upgrade",
            args: (&hash,).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);

    assert!(f.client.try_upgrade(&hash).is_err());
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

#[test]
fn publish_then_lastprice_and_event() {
    let f = setup();
    f.env.mock_all_auths();

    // 1.0325 with 14 decimals.
    f.client.publish(&share(), &103_250_000_000_000, &T0);

    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.admin);
    assert_eq!(
        f.env.events().all(),
        std::vec![PricePublished {
            asset: share(),
            price: 103_250_000_000_000,
            timestamp: T0,
        }
        .to_xdr(&f.env, &f.contract_id)]
    );
    assert_eq!(
        f.client.lastprice(&share()),
        Some(PriceData {
            price: 103_250_000_000_000,
            timestamp: T0,
        })
    );
    assert_eq!(f.client.last_timestamp(), T0);
    assert_eq!(f.client.assets(), soroban_sdk::vec![&f.env, share()]);
}

#[test]
fn history_is_newest_first_and_bounded() {
    let f = setup();
    f.env.mock_all_auths();

    for i in 0..40u64 {
        f.client
            .publish(&share(), &(1_000 + i as i128), &(T0 + i * 300));
    }

    let records = f.client.prices(&share(), &50).unwrap();
    assert_eq!(records.len(), MAX_HISTORY);
    for (n, record) in records.iter().enumerate() {
        let i = 39 - n as u64;
        assert_eq!(
            record,
            PriceData {
                price: 1_000 + i as i128,
                timestamp: T0 + i * 300,
            }
        );
    }

    let three = f.client.prices(&share(), &3).unwrap();
    assert_eq!(three.len(), 3);
    assert_eq!(three.get(0).unwrap().timestamp, T0 + 39 * 300);
    assert_eq!(three.get(2).unwrap().timestamp, T0 + 37 * 300);

    assert_eq!(f.client.prices(&share(), &0).unwrap().len(), 0);
}

#[test]
fn price_at_exact_timestamp() {
    let f = setup();
    f.env.mock_all_auths();

    for i in 0..40u64 {
        f.client
            .publish(&share(), &(1_000 + i as i128), &(T0 + i * 300));
    }

    assert_eq!(
        f.client.price(&share(), &(T0 + 20 * 300)),
        Some(PriceData {
            price: 1_020,
            timestamp: T0 + 20 * 300,
        })
    );
    // Not on a published timestamp.
    assert_eq!(f.client.price(&share(), &(T0 + 20 * 300 + 1)), None);
    // Dropped from the bounded history.
    assert_eq!(f.client.price(&share(), &T0), None);
}

#[test]
fn timestamps_are_not_aligned_on_resolution() {
    let f = setup();
    f.env.mock_all_auths();

    f.client.publish(&share(), &1_000, &(T0 + 7));
    assert_eq!(
        f.client.price(&share(), &(T0 + 7)),
        Some(PriceData {
            price: 1_000,
            timestamp: T0 + 7,
        })
    );
}

#[test]
fn non_monotonic_timestamp_is_refused() {
    let f = setup();
    f.env.mock_all_auths();

    f.client.publish(&share(), &1_000, &T0);
    assert_eq!(
        f.client.try_publish(&share(), &1_001, &(T0 - 1)),
        Err(Ok(Error::NonMonotonicTimestamp))
    );
    assert_eq!(f.client.lastprice(&share()).unwrap().price, 1_000);

    // Same timestamp republishes: the record is replaced, not duplicated.
    f.client.publish(&share(), &1_002, &T0);
    let records = f.client.prices(&share(), &10).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(
        records.get(0).unwrap(),
        PriceData {
            price: 1_002,
            timestamp: T0,
        }
    );
}

#[test]
fn non_positive_price_and_zero_timestamp_are_refused() {
    let f = setup();
    f.env.mock_all_auths();

    assert_eq!(
        f.client.try_publish(&share(), &0, &T0),
        Err(Ok(Error::InvalidPrice))
    );
    assert_eq!(
        f.client.try_publish(&share(), &-1, &T0),
        Err(Ok(Error::InvalidPrice))
    );
    assert_eq!(
        f.client.try_publish(&share(), &1_000, &0),
        Err(Ok(Error::InvalidTimestamp))
    );
    assert_eq!(f.client.lastprice(&share()), None);
    assert_eq!(f.client.assets().len(), 0);
}

#[test]
fn intruder_cannot_publish() {
    let f = setup();
    let intruder = Address::generate(&f.env);
    let asset = share();
    let price: i128 = 1_000;
    f.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &f.contract_id,
            fn_name: "publish",
            args: (&asset, &price, &T0).into_val(&f.env),
            sub_invokes: &[],
        },
    }]);

    assert!(f.client.try_publish(&asset, &price, &T0).is_err());
    assert_eq!(f.client.lastprice(&asset), None);
}

#[test]
fn assets_grow_and_are_bounded() {
    let f = setup();
    f.env.mock_all_auths();

    for i in 0..MAX_ASSETS {
        let asset = Asset::Stellar(Address::generate(&f.env));
        f.client.publish(&asset, &1_000, &(T0 + i as u64));
        // Publishing an asset again does not add it twice.
        f.client.publish(&asset, &1_001, &(T0 + i as u64 + 1));
        assert_eq!(f.client.assets().len(), i + 1);
    }

    let extra = Asset::Other(symbol_short!("EUR"));
    assert_eq!(
        f.client.try_publish(&extra, &1_000, &T0),
        Err(Ok(Error::TooManyAssets))
    );
    assert_eq!(f.client.assets().len(), MAX_ASSETS);
    assert!(!f.client.assets().contains(&extra));
    assert_eq!(f.client.last_timestamp(), T0 + MAX_ASSETS as u64);
}

// ---------------------------------------------------------------------------
// SEP-40 consumer view
// ---------------------------------------------------------------------------

/// The subset of SEP-40 a consumer contract declares on its side. Only the
/// generated client is used; the trait itself is never implemented here.
#[allow(dead_code)]
#[contractclient(name = "Sep40ConsumerClient")]
pub trait Sep40Consumer {
    fn decimals(env: Env) -> u32;
    fn base(env: Env) -> Asset;
    fn lastprice(env: Env, asset: Asset) -> Option<PriceData>;
}

#[test]
fn sep40_consumer_client_reads_the_feed() {
    let f = setup();
    f.env.mock_all_auths();
    f.client.publish(&share(), &103_250_000_000_000, &T0);

    let consumer = Sep40ConsumerClient::new(&f.env, &f.contract_id);
    assert_eq!(consumer.decimals(), DECIMALS);
    assert_eq!(consumer.base(), base());
    assert_eq!(
        consumer.lastprice(&share()),
        Some(PriceData {
            price: 103_250_000_000_000,
            timestamp: T0,
        })
    );
    assert_eq!(
        consumer.lastprice(&Asset::Other(symbol_short!("EUR"))),
        None
    );
}
