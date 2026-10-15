#![cfg(test)]
// Property tests of the fixed-point arithmetic (`math.rs`). The security
// lints of the workspace target contract code; these tests compute exact
// reference values with plain arithmetic, inside ranges where it cannot
// overflow.
#![allow(
    clippy::arithmetic_side_effects,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]
extern crate std;

use proptest::prelude::*;

use crate::error::Error;
use crate::math::{self, Bps, Price, BPS, YEAR_SECS};

/// Ten years, in seconds: far beyond any repo (30 days at most).
const TEN_YEARS: u64 = 315_360_000;
const HOUR: u64 = 3_600;

/// The only errors the arithmetic may return.
fn typed(error: Error) -> bool {
    matches!(
        error,
        Error::ArithmeticOverflow | Error::InvalidPrice | Error::InvalidHaircut
    )
}

proptest! {
    /// Interest grows with time, principal and rate, and is the simple
    /// interest model (actual/365) rounded up by less than one unit: never
    /// below it, in favour of the lender.
    #[test]
    fn interest_is_monotonic_and_never_below_the_model(
        principal in 0i128..=1_000_000_000_000_000,
        extra_principal in 0i128..=1_000_000_000_000,
        rate in 0u32..=10_000,
        extra_rate in 0u32..=1_000,
        elapsed in 0u64..=TEN_YEARS,
        extra_time in 0u64..=TEN_YEARS,
    ) {
        let interest = math::interest(principal, rate, elapsed).unwrap();
        let model = principal * i128::from(rate) * i128::from(elapsed);
        let denominator = BPS * YEAR_SECS;
        prop_assert!(interest * denominator >= model);
        prop_assert!(interest == 0 || (interest - 1) * denominator < model);

        let later = math::interest(principal, rate, elapsed + extra_time).unwrap();
        let larger = math::interest(principal + extra_principal, rate, elapsed).unwrap();
        let dearer = math::interest(principal, (rate + extra_rate).min(10_000), elapsed).unwrap();
        prop_assert!(later >= interest);
        prop_assert!(larger >= interest);
        prop_assert!(dearer >= interest);
    }

    /// A duration rounds up to the next whole hour, or overflows as a typed
    /// error at the very top of the range.
    #[test]
    fn ceil_to_hour_rounds_up_to_whole_hours(seconds in any::<u64>()) {
        match math::ceil_to_hour(seconds) {
            Ok(hours) => {
                prop_assert_eq!(hours % HOUR, 0);
                prop_assert!(hours >= seconds);
                prop_assert!(hours - seconds < HOUR);
            }
            Err(error) => {
                prop_assert_eq!(error, Error::ArithmeticOverflow);
                prop_assert!(seconds > u64::MAX - HOUR);
            }
        }
    }

    /// What shares secure never exceeds their exact value in the stablecoin's
    /// units minus the haircut, and it grows with the shares and falls with
    /// the haircut.
    #[test]
    fn max_principal_never_exceeds_the_value_after_the_haircut(
        shares in 0i128..=1_000_000_000_000,
        extra_shares in 0i128..=1_000_000_000_000,
        mantissa in 1i128..=1_000_000_000_000,
        price_decimals in 0u32..=9,
        share_decimals in 0u32..=9,
        coin_decimals in 0u32..=9,
        haircut in 0u32..10_000,
        extra_haircut in 0u32..10_000,
    ) {
        let price = Price::new(mantissa, price_decimals).unwrap();
        let cut = Bps::haircut(haircut).unwrap();
        let secured =
            math::max_principal(shares, share_decimals, price, coin_decimals, cut).unwrap();
        prop_assert!(secured >= 0);
        // secured <= shares * price / 10^pd * 10^cd / 10^sd * (1 - h), exactly.
        let pow = |e: u32| 10i128.pow(e);
        let kept = BPS - i128::from(haircut);
        let left = secured * BPS * pow(price_decimals) * pow(share_decimals);
        let right = shares * mantissa * kept * pow(coin_decimals);
        prop_assert!(left <= right, "{} > {}", left, right);

        let more = math::max_principal(
            shares + extra_shares, share_decimals, price, coin_decimals, cut,
        )
        .unwrap();
        prop_assert!(more >= secured);
        let harsher = Bps::haircut((haircut + extra_haircut).min(9_999)).unwrap();
        let less =
            math::max_principal(shares, share_decimals, price, coin_decimals, harsher).unwrap();
        prop_assert!(less <= secured);
    }

    /// Scaling up then down returns the amount; scaling down then up loses
    /// less than one unit of the coarser precision, never gains.
    #[test]
    fn rescale_round_trips(
        amount in 0i128..=1_000_000_000_000_000_000,
        decimals in 0u32..=18,
        shift in 0u32..=18,
    ) {
        let finer = decimals + shift;
        let up = math::rescale_floor(amount, decimals, finer).unwrap();
        prop_assert_eq!(math::rescale_floor(up, finer, decimals).unwrap(), amount);
        let down = math::rescale_floor(amount, finer, decimals).unwrap();
        let back = math::rescale_floor(down, decimals, finer).unwrap();
        prop_assert!(back <= amount);
        prop_assert!(amount - back < 10i128.pow(shift));
    }

    /// The corridor brackets its reference, its top bracket the model path,
    /// and both the top and the path only rise with time.
    #[test]
    fn corridor_bounds_are_ordered(
        reference in 1i128..=100_000_000_000_000_000_000,
        reference_time in 0u64..=u64::from(u32::MAX),
        elapsed in 0u64..=TEN_YEARS,
        later in 0u64..=TEN_YEARS,
        floor in 0u32..10_000,
        yield_bps in 0u32..=10_000,
    ) {
        let observed = reference_time + elapsed;
        let (low, high) =
            math::corridor(reference, reference_time, observed, floor, yield_bps).unwrap();
        let path = math::model_path(reference, reference_time, observed, yield_bps).unwrap();
        prop_assert!(0 <= low && low <= reference);
        prop_assert!(reference <= path && path <= high);
        prop_assert!(math::within_band(reference, reference, floor).unwrap());

        let (_, higher) =
            math::corridor(reference, reference_time, observed + later, floor, yield_bps).unwrap();
        let further =
            math::model_path(reference, reference_time, observed + later, yield_bps).unwrap();
        prop_assert!(higher >= high);
        prop_assert!(further >= path);
    }

    /// Whatever the inputs, the arithmetic returns a value or a typed error;
    /// it never panics (the test profile keeps overflow checks on).
    #[test]
    fn extreme_inputs_give_typed_errors_not_panics(
        a in any::<i128>(),
        b in any::<i128>(),
        c in any::<i128>(),
        small in any::<u32>(),
        other in any::<u32>(),
        third in any::<u32>(),
        time in any::<u64>(),
        later in any::<u64>(),
    ) {
        let check = |result: Result<i128, Error>| match result {
            Ok(_) => Ok(()),
            Err(error) if typed(error) => Ok(()),
            Err(error) => Err(TestCaseError::fail(std::format!("{error:?}"))),
        };
        check(math::pow10(small))?;
        check(math::mul_div_floor(a, b, c))?;
        check(math::mul_div_ceil(a, b, c))?;
        check(math::rescale_floor(a, small, other))?;
        check(math::interest(a, small, time))?;
        check(math::model_path(a, time, later, small))?;
        check(math::within_band(a, b, small).map(i128::from))?;
        check(math::corridor(a, time, later, small, other).map(|(low, _)| low))?;
        check(math::ceil_to_hour(time).map(i128::from))?;
        if let (Ok(price), Ok(quote), Ok(cut)) =
            (Price::new(a, small % 40), Price::new(b, other % 40), Bps::haircut(third))
        {
            check(price.divided_by(quote).map(|p| p.mantissa()))?;
            check(math::max_principal(c, small, price, other, cut))?;
        }
        if let (Ok(first), Ok(second)) = (Bps::haircut(small), Bps::haircut(other)) {
            check(first.plus(second).map(|sum| i128::from(sum.get())))?;
        }
    }
}

/// The edges random sampling rarely draws: every combination of extreme
/// values, through the same checks.
#[test]
fn edge_values_give_typed_errors_not_panics() {
    let wide = [i128::MIN, i128::MIN + 1, -1, 0, 1, i128::MAX - 1, i128::MAX];
    let narrow = [0u32, 1, 9_999, 10_000, 10_001, 38, 39, u32::MAX];
    let times = [0u64, 1, HOUR, u64::MAX - HOUR, u64::MAX - 1, u64::MAX];
    let ok = |result: Result<i128, Error>| match result {
        Ok(_) => true,
        Err(error) => typed(error),
    };
    for &a in &wide {
        for &b in &wide {
            for &c in &wide {
                assert!(ok(math::mul_div_floor(a, b, c)));
                assert!(ok(math::mul_div_ceil(a, b, c)));
            }
            for &n in &narrow {
                assert!(ok(math::within_band(a, b, n).map(i128::from)));
                assert!(ok(math::rescale_floor(a, n, n % 40)));
                for &t in &times {
                    assert!(ok(math::interest(a, n, t)));
                    assert!(ok(math::model_path(a, t, t / 2, n)));
                    assert!(ok(math::corridor(a, t / 2, t, n, n).map(|(low, _)| low)));
                }
            }
        }
    }
    for &t in &times {
        assert!(ok(math::ceil_to_hour(t).map(i128::from)));
    }
    assert_eq!(math::ceil_to_hour(u64::MAX), Err(Error::ArithmeticOverflow));
    assert_eq!(
        math::ceil_to_hour(u64::MAX - u64::MAX % HOUR),
        Ok(u64::MAX - u64::MAX % HOUR)
    );
}
