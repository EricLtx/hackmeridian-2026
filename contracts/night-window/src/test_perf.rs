//! Real-time profile of the user-facing entry points, like a WCET bench on an
//! embedded target: the contract, the share token and the feeds run from
//! their release WASM, as on the network, and every call prints what the
//! host metered (CPU instructions, memory, ledger entries read and written,
//! bytes written, events, rent extensions, fee estimate) and its sub-calls.
//!
//! cargo test -p night-window --lib test_perf -- --nocapture --test-threads=1
//!
//! The figures are the host's model: deterministic, the same on every run,
//! and the basis of what a transaction declares and pays. Nothing asserts on
//! them except the per-transaction ceilings the default test host enforces.
#![cfg(all(test, night_window_wasm))]
#![allow(
    clippy::arithmetic_side_effects,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
extern crate std;

use std::{format, println, string::String as StdString, vec::Vec as StdVec};

use crate::types::{Asset, FallbackFeed, FundConfig, FxLeg, PriceSource};
use crate::OpenWindowClient;
use fund_token::FundTokenClient;
use nav_oracle::{Asset as FeedAsset, NavOracleClient};
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger as _},
    token::StellarAssetClient,
    vec, Address, BytesN, Env, String, Symbol, Vec,
};

const ONE: i128 = 10_000_000;
const NAV_DECIMALS: u32 = 14;
const NAV_EUR: i128 = 105_000_000_000_000;
const NAV_USD: i128 = 117_000_000_000_000;
const EUR_USD: i128 = 111_880_000_000_000;
const T0: u64 = 1_800_000_000;
const HOUR: u64 = 3_600;
const DAY: u64 = 86_400;
const DELAY: u64 = 60;

const NIGHT_WINDOW_WASM: &[u8] = include_bytes!(env!("NIGHT_WINDOW_WASM"));

fn sibling_wasm(name: &str) -> &'static [u8] {
    let path = std::path::Path::new(env!("NIGHT_WINDOW_WASM")).with_file_name(name);
    let bytes = std::fs::read(&path).unwrap_or_else(|_| {
        panic!(
            "{} missing: run `stellar contract build` first",
            path.display()
        )
    });
    std::boxed::Box::leak(bytes.into_boxed_slice())
}

fn leak<T>(value: T) -> &'static T {
    std::boxed::Box::leak(std::boxed::Box::new(value))
}

fn eur(env: &Env) -> Symbol {
    Symbol::new(env, "EUR")
}

/// Which share and price the measured fund has.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    /// SEP-41 allowlisted share (fund-token WASM), NAV in EUR.
    Direct,
    /// SEP-41 allowlisted share, NAV in USD crossed through an EUR/USD feed.
    Cross,
    /// Classic asset share through the Stellar Asset Contract, NAV in EUR.
    Sac,
}

struct World {
    env: Env,
    client: OpenWindowClient<'static>,
    steward: Address,
    lender: Address,
    borrower: Address,
    eurc: Address,
    fund: Address,
    nav_feed: Address,
    share_token: Option<FundTokenClient<'static>>,
    offer_id: u64,
}

fn env() -> Env {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();
    env.ledger().set_timestamp(T0);
    env
}

fn sac(env: &Env) -> Address {
    let issuer = Address::generate(env);
    env.register_stellar_asset_contract_v2(issuer).address()
}

fn feed(env: &Env, admin: &Address, base: &str) -> Address {
    env.register(
        sibling_wasm("nav_oracle.wasm"),
        (
            admin.clone(),
            FeedAsset::Other(Symbol::new(env, base)),
            NAV_DECIMALS,
            300u32,
        ),
    )
}

fn publish(env: &Env, feed: &Address, asset: FeedAsset, price: i128) {
    let now = env.ledger().timestamp();
    NavOracleClient::new(env, feed).publish(&asset, &price, &now);
}

fn base_config(world_steward: &Address, env: &Env, fund: &Address, oracle: &Address) -> FundConfig {
    FundConfig {
        oracle: oracle.clone(),
        oracle_asset: Asset::Stellar(fund.clone()),
        haircut_bps: 200,
        steward: world_steward.clone(),
        currency: eur(env),
        source: PriceSource::Direct,
        nav_max_age_secs: 26 * HOUR,
        corridor_floor_bps: 10,
        max_yield_bps: 500,
        max_principal_per_repo: 500_000 * ONE,
        max_outstanding: 5_000_000 * ONE,
    }
}

fn admit_lender(client: &OpenWindowClient, env: &Env, fund: &Address, lender: &Address) {
    client.attest_lender(fund, lender, &BytesN::from_array(env, &[0xA7; 32]));
    client.approve_lender(fund, lender, &true);
}

/// A deployed Open Window with one fund of `kind`, the euro stablecoin, an
/// approved lender and one offer of 100,000 at 3 % on that fund.
fn world(kind: Kind) -> World {
    let env = env();
    let governor = Address::generate(&env);
    let steward = Address::generate(&env);
    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    let contract = env.register(NIGHT_WINDOW_WASM, (governor.clone(),));
    let client = OpenWindowClient::new(leak(env.clone()), leak(contract.clone()));
    client.set_timelock_delay(&DELAY);

    let eurc = sac(&env);
    client.set_stablecoin(&eurc, &eur(&env));
    client.set_currency_cap(&eur(&env), &(10_000_000 * ONE));

    let (fund, share_token) = match kind {
        Kind::Direct | Kind::Cross => {
            let fund = env.register(
                sibling_wasm("fund_token.wasm"),
                (
                    steward.clone(),
                    7u32,
                    String::from_str(&env, "Test fund share"),
                    String::from_str(&env, "tFUND"),
                ),
            );
            let token = FundTokenClient::new(leak(env.clone()), leak(fund.clone()));
            for holder in [&borrower, &lender, &contract] {
                token.set_whitelisted(holder, &true);
            }
            token.mint(&borrower, &(1_000_000 * ONE));
            (fund, Some(token))
        }
        Kind::Sac => {
            let fund = sac(&env);
            StellarAssetClient::new(&env, &fund).mint(&borrower, &(1_000_000 * ONE));
            (fund, None)
        }
    };

    let nav_feed = match kind {
        Kind::Cross => feed(&env, &steward, "USD"),
        _ => feed(&env, &steward, "EUR"),
    };
    let nav = if kind == Kind::Cross {
        NAV_USD
    } else {
        NAV_EUR
    };
    publish(&env, &nav_feed, FeedAsset::Stellar(fund.clone()), nav);
    let mut config = base_config(&steward, &env, &fund, &nav_feed);
    if kind == Kind::Cross {
        let fx_feed = feed(&env, &steward, "USD");
        publish(&env, &fx_feed, FeedAsset::Other(eur(&env)), EUR_USD);
        config.source = PriceSource::Cross(FxLeg {
            oracle: fx_feed,
            asset: Asset::Other(eur(&env)),
            haircut_bps: 200,
            max_age_secs: 3 * DAY,
            band_bps: 200,
        });
    }
    client.set_fund(&fund, &config);
    admit_lender(&client, &env, &fund, &lender);
    StellarAssetClient::new(&env, &eurc).mint(&lender, &(1_000_000 * ONE));
    StellarAssetClient::new(&env, &eurc).mint(&borrower, &(100_000 * ONE));
    let offer_id = client.create_offer(
        &lender,
        &eurc,
        &(100_000 * ONE),
        &300,
        &(7 * DAY),
        &vec![&env, fund.clone()],
    );
    World {
        env,
        client,
        steward,
        lender,
        borrower,
        eurc,
        fund,
        nav_feed,
        share_token,
        offer_id,
    }
}

/// Adds an active fallback feed agreeing with the primary.
fn with_fallback(w: &World) -> Address {
    let backup = feed(&w.env, &w.steward, "EUR");
    publish(&w.env, &backup, FeedAsset::Stellar(w.fund.clone()), NAV_EUR);
    w.client.propose_fallback(
        &w.fund,
        &FallbackFeed {
            oracle: backup.clone(),
            asset: Asset::Stellar(w.fund.clone()),
            max_age_secs: 26 * HOUR,
            max_divergence_bps: 50,
        },
    );
    advance(w, DELAY);
    w.client.apply_fallback(&w.fund);
    publish(
        &w.env,
        &w.nav_feed,
        FeedAsset::Stellar(w.fund.clone()),
        NAV_EUR,
    );
    publish(&w.env, &backup, FeedAsset::Stellar(w.fund.clone()), NAV_EUR);
    backup
}

fn advance(w: &World, seconds: u64) {
    let now = w.env.ledger().timestamp();
    w.env.ledger().set_timestamp(now + seconds);
}

fn open(w: &World) -> u64 {
    w.client.open_repo(
        &w.borrower,
        &w.offer_id,
        &w.fund,
        &(10_000 * ONE),
        &(9_000 * ONE),
        &(64 * HOUR),
    )
}

/// One measured call: what the host metered for the last top-level invocation.
struct Row {
    name: StdString,
    instructions: i64,
    mem: i64,
    reads: u32,
    writes: u32,
    write_bytes: u32,
    events: u32,
    rent_bumps: u32,
    fee: i64,
    calls: StdString,
}

fn measure(env: &Env, name: &str) -> Row {
    let r = env.cost_estimate().resources();
    let fee = env.cost_estimate().fee();
    let mut calls: StdVec<StdString> = StdVec::new();
    if let Some(detail) = env.host().get_detailed_last_invocation_resources() {
        for sub in detail.sub_call_resources.iter() {
            let function = format!("{:?}", sub.invocation);
            let short = function
                .split("ScSymbol(StringM(")
                .nth(1)
                .and_then(|s| s.split(')').next())
                .unwrap_or("?")
                .trim_matches('"')
                .replace('\\', "");
            calls.push(format!("{}:{}k", short, sub.resources.instructions / 1_000));
        }
    }
    Row {
        name: name.into(),
        instructions: r.instructions,
        mem: r.mem_bytes,
        reads: r.memory_read_entries + r.disk_read_entries,
        writes: r.write_entries,
        write_bytes: r.write_bytes,
        events: r.contract_events_size_bytes,
        rent_bumps: r.persistent_entry_rent_bumps,
        fee: fee.total,
        calls: calls.join(" "),
    }
}

/// Real-time budget of every measured call, far above today's figures and
/// far below the network's per-transaction ceilings (400 million
/// instructions, 200 entries written, 132 KB written, 16 KB of events): a
/// regression that doubles a path fails here before it reaches a network.
const BUDGET_INSTRUCTIONS: i64 = 12_000_000;
const BUDGET_WRITES: u32 = 12;
const BUDGET_WRITE_BYTES: u32 = 8_192;
const BUDGET_EVENT_BYTES: u32 = 2_048;

fn check_budget(rows: &[Row]) {
    for r in rows {
        assert!(
            r.instructions <= BUDGET_INSTRUCTIONS,
            "{}: {} instructions over the budget",
            r.name,
            r.instructions
        );
        assert!(
            r.writes <= BUDGET_WRITES,
            "{}: {} entries written over the budget",
            r.name,
            r.writes
        );
        assert!(
            r.write_bytes <= BUDGET_WRITE_BYTES,
            "{}: {} bytes written over the budget",
            r.name,
            r.write_bytes
        );
        assert!(
            r.events <= BUDGET_EVENT_BYTES,
            "{}: {} event bytes over the budget",
            r.name,
            r.events
        );
    }
}

fn print(rows: &[Row]) {
    println!(
        "\n| entry point | CPU insns | mem bytes | entries read | entries written | bytes written | event bytes | rent bumps | fee (stroops) | sub-calls (k insns) |"
    );
    println!("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
    for r in rows {
        println!(
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
            r.name,
            r.instructions,
            r.mem,
            r.reads,
            r.writes,
            r.write_bytes,
            r.events,
            r.rent_bumps,
            r.fee,
            r.calls
        );
    }
}

#[test]
fn test_perf_profile() {
    println!("\nnight_window.wasm: {} bytes", NIGHT_WINDOW_WASM.len());
    let mut rows = StdVec::new();

    // Quotes and openings on each kind of fund.
    for (kind, label) in [
        (Kind::Direct, "direct"),
        (Kind::Cross, "cross FX"),
        (Kind::Sac, "SAC share"),
    ] {
        let w = world(kind);
        w.client.quote(&w.fund, &(10_000 * ONE), &w.eurc);
        rows.push(measure(&w.env, &format!("quote ({label})")));
        open(&w);
        rows.push(measure(&w.env, &format!("open_repo ({label})")));
        // A second opening by another borrower: the steady state, all entries already written once.
        let other = Address::generate(&w.env);
        if let Some(token) = &w.share_token {
            token.set_whitelisted(&other, &true);
            token.mint(&other, &(100_000 * ONE));
        } else {
            StellarAssetClient::new(&w.env, &w.fund).mint(&other, &(100_000 * ONE));
        }
        w.client.open_repo(
            &other,
            &w.offer_id,
            &w.fund,
            &(10_000 * ONE),
            &(9_000 * ONE),
            &(64 * HOUR),
        );
        rows.push(measure(&w.env, &format!("open_repo 2nd ({label})")));
        advance(&w, 10 * HOUR);
        let repo = 1;
        w.client.repo_due(&repo);
        rows.push(measure(&w.env, &format!("repo_due ({label})")));
        w.client.repurchase(&repo);
        rows.push(measure(&w.env, &format!("repurchase ({label})")));
    }

    // Seizure after maturity, to the lender.
    {
        let w = world(Kind::Direct);
        let repo = open(&w);
        advance(&w, 65 * HOUR);
        w.client.seize(&repo, &w.lender);
        rows.push(measure(&w.env, "seize (direct)"));
    }

    // Deferred delivery: the share token refuses the borrower at repurchase,
    // then accepts; release delivers.
    {
        let w = world(Kind::Direct);
        let repo = open(&w);
        advance(&w, 2 * HOUR);
        let token = w.share_token.as_ref().unwrap();
        token.set_frozen(&w.borrower, &true);
        w.client.repurchase(&repo);
        rows.push(measure(&w.env, "repurchase, delivery deferred"));
        token.set_frozen(&w.borrower, &false);
        w.client.release(&repo);
        rows.push(measure(&w.env, "release"));
    }

    // Offers.
    {
        let w = world(Kind::Direct);
        w.client.create_offer(
            &w.lender,
            &w.eurc,
            &(1_000 * ONE),
            &300,
            &(7 * DAY),
            &vec![&w.env, w.fund.clone()],
        );
        rows.push(measure(&w.env, "create_offer (1 fund)"));
        w.client.withdraw_offer(&w.offer_id, &(1_000 * ONE));
        rows.push(measure(&w.env, "withdraw_offer"));
    }

    // Worst case of create_offer: an offer listing the maximum of 8 funds.
    {
        let w = world(Kind::Direct);
        let mut funds: Vec<Address> = vec![&w.env, w.fund.clone()];
        for _ in 1..8 {
            let fund = sac(&w.env);
            publish(
                &w.env,
                &w.nav_feed,
                FeedAsset::Stellar(fund.clone()),
                NAV_EUR,
            );
            w.client
                .set_fund(&fund, &base_config(&w.steward, &w.env, &fund, &w.nav_feed));
            admit_lender(&w.client, &w.env, &fund, &w.lender);
            funds.push_back(fund);
        }
        w.client
            .create_offer(&w.lender, &w.eurc, &(1_000 * ONE), &300, &(7 * DAY), &funds);
        rows.push(measure(&w.env, "create_offer (8 funds, worst case)"));
        // Opening against the 8-fund offer on its last fund: the containment scan is longest.
        let last = funds.get(7).unwrap();
        StellarAssetClient::new(&w.env, &last).mint(&w.borrower, &(100_000 * ONE));
        let offer = w.offer_id + 1;
        w.client.open_repo(
            &w.borrower,
            &offer,
            &last,
            &(10_000 * ONE),
            &(900 * ONE),
            &(64 * HOUR),
        );
        rows.push(measure(&w.env, "open_repo (8-fund offer, last fund)"));
    }

    // Worst case of pricing: an active fallback feed, consulted and compared.
    {
        let w = world(Kind::Direct);
        with_fallback(&w);
        w.client.quote(&w.fund, &(10_000 * ONE), &w.eurc);
        rows.push(measure(&w.env, "quote (fallback consulted)"));
        open(&w);
        rows.push(measure(&w.env, "open_repo (fallback consulted)"));
    }

    // Cross fund with a fallback: the heaviest pricing path.
    {
        let w = world(Kind::Cross);
        let backup = feed(&w.env, &w.steward, "USD");
        publish(&w.env, &backup, FeedAsset::Stellar(w.fund.clone()), NAV_USD);
        w.client.propose_fallback(
            &w.fund,
            &FallbackFeed {
                oracle: backup.clone(),
                asset: Asset::Stellar(w.fund.clone()),
                max_age_secs: 26 * HOUR,
                max_divergence_bps: 50,
            },
        );
        advance(&w, DELAY);
        w.client.apply_fallback(&w.fund);
        publish(
            &w.env,
            &w.nav_feed,
            FeedAsset::Stellar(w.fund.clone()),
            NAV_USD,
        );
        publish(&w.env, &backup, FeedAsset::Stellar(w.fund.clone()), NAV_USD);
        open(&w);
        rows.push(measure(
            &w.env,
            "open_repo (cross FX + fallback, worst case)",
        ));
    }

    print(&rows);
    check_budget(&rows);
}

/// Where the instructions of the heaviest paths go, by host cost type, and
/// the fixed cost of entering the contract (a call that does nothing).
#[test]
fn test_perf_budget_breakdown() {
    let w = world(Kind::Direct);
    w.client.version();
    let entry = measure(&w.env, "version (entry cost only)");
    println!(
        "\n{}: {} insns, {} mem bytes",
        entry.name, entry.instructions, entry.mem
    );
    println!("\n== version: budget by cost type (the price of entering the contract) ==");
    w.env.cost_estimate().budget().print();
    w.client.is_paused();
    let paused = measure(&w.env, "is_paused (entry + one instance read)");
    println!("{}: {} insns", paused.name, paused.instructions);
    open(&w);
    println!("\n== open_repo (direct): budget by cost type ==");
    w.env.cost_estimate().budget().print();
    advance(&w, 10 * HOUR);
    w.client.repurchase(&1);
    println!("\n== repurchase (direct): budget by cost type ==");
    w.env.cost_estimate().budget().print();
}
