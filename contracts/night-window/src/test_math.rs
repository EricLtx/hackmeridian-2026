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

/// An unsigned 256-bit integer, four 64-bit limbs, most significant first so
/// that the derived order is the numeric one: the exact products the
/// properties compare at 18 decimals do not fit in i128.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
struct Wide([u64; 4]);

impl Wide {
    fn of(value: i128) -> Self {
        let value = u128::try_from(value).expect("non-negative");
        Wide([0, 0, (value >> 64) as u64, value as u64])
    }

    /// `self * factor`, exactly; panics beyond 256 bits.
    fn times(self, factor: i128) -> Self {
        let factor = u128::try_from(factor).expect("non-negative");
        let limbs = [self.0[3], self.0[2], self.0[1], self.0[0]];
        let digits = [factor as u64, (factor >> 64) as u64];
        let mut out = [0u64; 7];
        for (i, &limb) in limbs.iter().enumerate() {
            let mut carry = 0u128;
            for (j, &digit) in digits.iter().enumerate() {
                let sum = u128::from(out[i + j]) + u128::from(limb) * u128::from(digit) + carry;
                out[i + j] = sum as u64;
                carry = sum >> 64;
            }
            let mut k = i + 2;
            while carry > 0 {
                let sum = u128::from(out[k]) + carry;
                out[k] = sum as u64;
                carry = sum >> 64;
                k += 1;
            }
        }
        assert!(out[4..].iter().all(|&limb| limb == 0), "beyond 256 bits");
        Wide([out[3], out[2], out[1], out[0]])
    }

    /// `self + term`, exactly; panics beyond 256 bits.
    fn plus(self, term: i128) -> Self {
        let mut carry = u128::try_from(term).expect("non-negative");
        let mut limbs = self.0;
        for limb in limbs.iter_mut().rev() {
            let sum = u128::from(*limb) + (carry & u128::from(u64::MAX));
            *limb = sum as u64;
            carry = (carry >> 64) + (sum >> 64);
        }
        assert_eq!(carry, 0, "beyond 256 bits");
        Wide(limbs)
    }
}

/// `max_principal` as rc4 computed it, `shares * mantissa` first: the result
/// the split product must give wherever this one fits.
fn rc4_max_principal(
    shares: i128,
    share_decimals: u32,
    price: Price,
    coin_decimals: u32,
    haircut: Bps,
) -> Result<i128, Error> {
    let value = math::mul_div_floor(shares, price.mantissa(), math::pow10(price.decimals())?)?;
    let value = math::rescale_floor(value, share_decimals, coin_decimals)?;
    math::mul_div_floor(value, BPS - i128::from(haircut.get()), BPS)
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
    /// units minus the haircut, it grows with the shares and falls with the
    /// haircut, and it is what rc4 computed wherever rc4's product fitted
    /// (review finding arith-5). Up to 18 decimals everywhere; an error is an
    /// intermediate value that does not fit in i128.
    #[test]
    fn max_principal_never_exceeds_the_value_after_the_haircut(
        shares in 0i128..=1_000_000_000_000_000_000_000_000_000_000,
        extra_shares in 0i128..=1_000_000_000_000_000_000_000_000_000_000,
        mantissa in 1i128..=1_000_000_000_000_000_000_000_000,
        scales in (0u32..=30, 0u32..=24),
        price_decimals in 0u32..=18,
        share_decimals in 0u32..=18,
        coin_decimals in 0u32..=18,
        haircut in 0u32..10_000,
        extra_haircut in 0u32..10_000,
    ) {
        let shares = shares / 10i128.pow(scales.0);
        let mantissa = (mantissa / 10i128.pow(scales.1)).max(1);
        let price = Price::new(mantissa, price_decimals).unwrap();
        let cut = Bps::haircut(haircut).unwrap();
        let pow = |e: u32| 10i128.pow(e);
        let kept = BPS - i128::from(haircut);
        // shares * price / 10^pd * 10^cd / 10^sd * (1 - h), exactly, times
        // BPS * 10^pd * 10^sd.
        let exact = |shares: i128| {
            Wide::of(shares).times(mantissa).times(kept).times(pow(coin_decimals))
        };
        let secured = match math::max_principal(shares, share_decimals, price, coin_decimals, cut)
        {
            Ok(secured) => secured,
            Err(error) => {
                // The value in the share's units, or in the stablecoin's
                // units times what the haircut keeps, exceeds i128.
                prop_assert_eq!(error, Error::ArithmeticOverflow);
                let unit = pow(price_decimals);
                let in_shares = Wide::of(shares).times(mantissa)
                    >= Wide::of(i128::MAX).times(unit).plus(unit);
                let in_coins = exact(shares)
                    > Wide::of(i128::MAX).times(unit).times(pow(share_decimals));
                prop_assert!(in_shares || in_coins);
                return Ok(());
            }
        };
        prop_assert!(secured >= 0);
        let left = Wide::of(secured)
            .times(BPS)
            .times(pow(price_decimals))
            .times(pow(share_decimals));
        prop_assert!(left <= exact(shares));
        if let Ok(rc4) = rc4_max_principal(shares, share_decimals, price, coin_decimals, cut) {
            prop_assert_eq!(secured, rc4);
        }

        match math::max_principal(
            shares + extra_shares, share_decimals, price, coin_decimals, cut,
        ) {
            Ok(more) => prop_assert!(more >= secured),
            Err(error) => prop_assert_eq!(error, Error::ArithmeticOverflow),
        }
        let harsher = Bps::haircut((haircut + extra_haircut).min(9_999)).unwrap();
        let less =
            math::max_principal(shares, share_decimals, price, coin_decimals, harsher).unwrap();
        prop_assert!(less <= secured);
    }

    /// Splitting the product (review finding arith-5) changes no result:
    /// wherever `shares * mantissa` fits in i128, the value is the direct
    /// formula's, at every precision up to 18 decimals.
    #[test]
    fn share_value_is_the_direct_formula_where_it_fits(
        shares in 0i128..=10_000_000_000_000_000_000,
        mantissa in 1i128..=10_000_000_000_000_000_000,
        scales in (0u32..=19, 0u32..=19),
        decimals in 0u32..=18,
    ) {
        let shares = shares / 10i128.pow(scales.0);
        let mantissa = (mantissa / 10i128.pow(scales.1)).max(1);
        let price = Price::new(mantissa, decimals).unwrap();
        let direct = math::mul_div_floor(shares, mantissa, 10i128.pow(decimals)).unwrap();
        prop_assert_eq!(math::share_value(shares, price), Ok(direct));
    }

    /// Beyond the direct formula's reach, the value is still the exact floor
    /// of `shares * mantissa / 10^decimals`, and the only error left is a
    /// value that does not fit in i128.
    #[test]
    fn share_value_is_exact_beyond_the_direct_formula(
        shares in 0i128..=i128::MAX,
        mantissa in 1i128..=i128::MAX,
        scales in (0u32..=38, 0u32..=38),
        decimals in 0u32..=18,
    ) {
        let shares = shares / 10i128.pow(scales.0);
        let mantissa = (mantissa / 10i128.pow(scales.1)).max(1);
        let unit = 10i128.pow(decimals);
        let product = Wide::of(shares).times(mantissa);
        match math::share_value(shares, Price::new(mantissa, decimals).unwrap()) {
            Ok(value) => {
                prop_assert!(Wide::of(value).times(unit) <= product);
                prop_assert!(product < Wide::of(value).times(unit).plus(unit));
            }
            Err(error) => {
                prop_assert_eq!(error, Error::ArithmeticOverflow);
                prop_assert!(product >= Wide::of(i128::MAX).times(unit).plus(unit));
            }
        }
    }

    /// The bounds round inward (review finding arith-4): a value passes the
    /// band exactly when it lies within it in exact arithmetic, whatever the
    /// precision, so nothing beyond the configured band passes and the
    /// reference itself always does.
    #[test]
    fn within_band_is_the_exact_band(
        reference in 1i128..=1_000_000_000_000_000_000_000_000_000_000,
        scale in 0u32..=30,
        offset in -1_000i128..=1_000,
        band in 0u32..10_000,
    ) {
        let reference = (reference / 10i128.pow(scale)).max(1);
        let band_i = i128::from(band);
        let (low, high) = (reference * (BPS - band_i), reference * (BPS + band_i));
        prop_assert!(math::within_band(reference, reference, band).unwrap());
        for edge in [low / BPS, high / BPS, reference] {
            let value = edge + offset;
            let exact = value * BPS >= low && value * BPS <= high;
            prop_assert_eq!(math::within_band(value, reference, band).unwrap(), exact);
        }
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
    /// and both the top and the path only rise with time. Their growth
    /// counts over at most the window: past it, the bounds stay those of an
    /// observation one window after the reference.
    #[test]
    fn corridor_bounds_are_ordered(
        reference in 1i128..=100_000_000_000_000_000_000,
        reference_time in 0u64..=u64::from(u32::MAX),
        elapsed in 0u64..=TEN_YEARS,
        later in 0u64..=TEN_YEARS,
        floor in 0u32..10_000,
        yield_bps in 0u32..=10_000,
        window in 0u64..=TEN_YEARS,
    ) {
        let observed = reference_time + elapsed;
        let (low, high) =
            math::corridor(reference, reference_time, observed, floor, yield_bps, window)
                .unwrap();
        let path =
            math::model_path(reference, reference_time, observed, yield_bps, window).unwrap();
        prop_assert!(0 <= low && low <= reference);
        prop_assert!(reference <= path && path <= high);
        prop_assert!(math::within_band(reference, reference, floor).unwrap());

        let (_, higher) = math::corridor(
            reference, reference_time, observed + later, floor, yield_bps, window,
        )
        .unwrap();
        let further =
            math::model_path(reference, reference_time, observed + later, yield_bps, window)
                .unwrap();
        prop_assert!(higher >= high);
        prop_assert!(further >= path);

        let capped = reference_time + elapsed.min(window);
        prop_assert_eq!(
            (low, high),
            math::corridor(reference, reference_time, capped, floor, yield_bps, u64::MAX)
                .unwrap()
        );
        prop_assert_eq!(
            path,
            math::model_path(reference, reference_time, capped, yield_bps, u64::MAX).unwrap()
        );

        // The bounds are the exact ones rounded inward (review finding
        // arith-4): the low one up, the high one down.
        let year_bps = BPS * YEAR_SECS;
        let floor_i = i128::from(floor);
        let numerator = year_bps
            + floor_i * YEAR_SECS
            + i128::from(yield_bps) * i128::from(elapsed.min(window));
        prop_assert!(low * BPS >= reference * (BPS - floor_i));
        prop_assert!((low - 1) * BPS < reference * (BPS - floor_i));
        prop_assert!(high * year_bps <= reference * numerator);
        prop_assert!((high + 1) * year_bps > reference * numerator);
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
        window in any::<u64>(),
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
        check(math::model_path(a, time, later, small, window))?;
        check(math::within_band(a, b, small).map(i128::from))?;
        check(math::corridor(a, time, later, small, other, window).map(|(low, _)| low))?;
        check(math::ceil_to_hour(time).map(i128::from))?;
        if let (Ok(price), Ok(quote), Ok(cut)) =
            (Price::new(a, small % 40), Price::new(b, other % 40), Bps::haircut(third))
        {
            check(price.divided_by(quote).map(|p| p.mantissa()))?;
            check(math::share_value(c, price))?;
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
                if let Ok(price) = Price::new(b, n % 40) {
                    assert!(ok(math::share_value(a, price)));
                }
                for &t in &times {
                    assert!(ok(math::interest(a, n, t)));
                    for &w in &times {
                        assert!(ok(math::model_path(a, t / 2, t, n, w)));
                        assert!(ok(math::corridor(a, t / 2, t, n, n, w).map(|(low, _)| low)));
                    }
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
