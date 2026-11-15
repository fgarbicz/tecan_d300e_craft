//! JavaScript number semantics needed for a bit-identical port of the JS engine.
//!
//! Rust's float formatting rounds exact decimal ties to even (`format!("{:.1}", 0.25)` = "0.2"), while
//! ECMAScript's `toFixed` / `toExponential` / `toPrecision` pick the larger magnitude ("0.3"). Ties are
//! rare but real for values with few binary digits (2^-20 = 9.5367431640625e-7 → JS "9.536743164063e-7").
//! Every JS numeric primitive the engine relies on is therefore re-implemented here exactly:
//! `Number(text)`, `String(number)`, `toExponential`, `toFixed`, `Number(x.toPrecision(p))`,
//! `Math.round` (half toward +∞, unlike `f64::round`), `Math.max`/`Math.min` (NaN-propagating).

/// ECMAScript WhiteSpace + LineTerminator: the set `String.prototype.trim` strips and RegExp `\s` matches.
/// (Differs from `char::is_whitespace`: JS includes U+FEFF and excludes U+0085.)
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{A}' | '\u{B}' | '\u{C}' | '\u{D}' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

// ---------- Number(text) ----------

/// `Number(s)` (ECMAScript StringToNumber): trims JS whitespace; "" → 0; `0x`/`0o`/`0b` integers;
/// `Infinity` with optional sign; decimal literals; anything else (including Rust's `inf`/`nan`) → NaN.
pub fn to_number(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let b = t.as_bytes();
    if b.len() >= 2 && b[0] == b'0' {
        let bits = match b[1] {
            b'x' | b'X' => Some(4),
            b'o' | b'O' => Some(3),
            b'b' | b'B' => Some(1),
            _ => None,
        };
        if let Some(bits) = bits {
            return parse_radix_pow2(&t[2..], bits);
        }
    }
    if !is_decimal_literal(b) {
        return f64::NAN;
    }
    // The grammar checked above is a subset of what Rust's (correctly rounded) parser accepts.
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// StrDecimalLiteral: [+-]? (digits [. digits?] | . digits) ([eE] [+-]? digits)?
fn is_decimal_literal(b: &[u8]) -> bool {
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let mut ndigits = i - int_start;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let f = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        ndigits += i - f;
    }
    if ndigits == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let e = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == e {
            return false;
        }
    }
    i == b.len()
}

/// Correctly rounded value of a binary/octal/hex digit string (no sign, as in JS).
fn parse_radix_pow2(digits: &str, bits: u32) -> f64 {
    if digits.is_empty() {
        return f64::NAN;
    }
    let radix = 1u32 << bits;
    let mut v: u128 = 0;
    let mut shift: i32 = 0;
    let mut sticky = false;
    for ch in digits.chars() {
        let Some(d) = ch.to_digit(radix) else {
            return f64::NAN;
        };
        if v >> (128 - bits) != 0 {
            // v already holds > 120 significant bits: further digits only matter as a sticky bit.
            shift += bits as i32;
            sticky |= d != 0;
            continue;
        }
        v = (v << bits) | d as u128;
    }
    if sticky {
        v |= 1; // far below the 53-bit rounding position, so it only breaks ties correctly
    }
    // u128 -> f64 rounds to nearest, ties to even; scaling by 2^shift is exact (or overflows to ∞).
    (v as f64) * 2f64.powi(shift)
}

// ---------- exact decimal digits ----------

/// Decimal digits of |x| rounded at `keep` significant digits, half away from zero (the JS rule).
/// `exp` is the decimal exponent of the first digit. `x` must be finite and non-zero.
fn round_sig(x: f64, keep: usize) -> (Vec<u8>, i32) {
    let x = x.abs();
    debug_assert!(keep >= 1 && x.is_finite() && x != 0.0);
    // Fast path: Rust's exact formatting differs from JS only on an exact tie at the cut.
    let probe = format!("{:.*e}", keep + 24, x);
    let (pm, _) = probe.split_once('e').unwrap();
    let pd: Vec<u8> = pm.bytes().filter(|c| *c != b'.').collect();
    let tail = &pd[keep..];
    let maybe_tie = tail[0] == b'5' && tail[1..].iter().all(|&c| c == b'0');
    if !maybe_tie {
        let s = format!("{:.*e}", keep - 1, x);
        let (m, e) = s.split_once('e').unwrap();
        return (
            m.bytes().filter(|c| *c != b'.').collect(),
            e.parse().unwrap(),
        );
    }
    let (digits, exp) = exact_digits(x);
    round_half_up(&digits, exp, keep as i64)
}

/// The exact decimal expansion of |x| (finite, non-zero): a double has at most 767 significant digits.
fn exact_digits(x: f64) -> (Vec<u8>, i32) {
    let s = format!("{:.1100e}", x.abs());
    let (m, e) = s.split_once('e').unwrap();
    let mut d: Vec<u8> = m.bytes().filter(|c| *c != b'.').collect();
    while d.len() > 1 && *d.last().unwrap() == b'0' {
        d.pop();
    }
    (d, e.parse().unwrap())
}

/// Keep `keep` leading digits of an exact expansion (may be ≤ 0), rounding half up with carry.
/// Returns (digits, exponent of first digit); an all-zero result is returned as (["0"], exp).
fn round_half_up(digits: &[u8], exp: i32, keep: i64) -> (Vec<u8>, i32) {
    if keep < 0 {
        return (vec![b'0'], exp);
    }
    let keep = keep as usize;
    let round_up = digits.get(keep).is_some_and(|&d| d >= b'5');
    let mut out: Vec<u8> = (0..keep).map(|i| *digits.get(i).unwrap_or(&b'0')).collect();
    if !round_up {
        if out.is_empty() {
            return (vec![b'0'], exp);
        }
        return (out, exp);
    }
    // carry
    let mut i = out.len();
    loop {
        if i == 0 {
            out.insert(0, b'1');
            if keep > 0 {
                out.pop();
            }
            return (out, exp + 1);
        }
        i -= 1;
        if out[i] == b'9' {
            out[i] = b'0';
        } else {
            out[i] += 1;
            return (out, exp);
        }
    }
}

// ---------- Number.prototype methods ----------

/// `x.toExponential(f)`.
pub fn to_exponential(x: f64, f: usize) -> String {
    if let Some(s) = non_finite(x) {
        return s;
    }
    if x < 0.0 {
        return format!("-{}", to_exponential(-x, f));
    }
    let (d, e) = if x == 0.0 {
        (vec![b'0'; f + 1], 0)
    } else {
        round_sig(x, f + 1)
    };
    let mut m = String::with_capacity(f + 2);
    m.push(d[0] as char);
    if f > 0 {
        m.push('.');
        m.extend(d[1..].iter().map(|&c| c as char));
    }
    format!("{m}e{}{}", if e < 0 { '-' } else { '+' }, e.abs())
}

/// `x.toFixed(f)`.
pub fn to_fixed(x: f64, f: usize) -> String {
    if let Some(s) = non_finite(x) {
        return s;
    }
    if x.abs() >= 1e21 {
        return to_js_string(x);
    }
    let neg = x < 0.0; // -0 is not < 0: (-0).toFixed(2) = "0.00"
    let ax = x.abs();
    // n = round(ax · 10^f) as a digit string
    let n: String = if ax == 0.0 {
        "0".into()
    } else {
        let probe = format!("{:.*}", f + 24, ax);
        let frac = probe.split_once('.').map(|(_, b)| b).unwrap_or("");
        let tail = &frac.as_bytes()[f..];
        let maybe_tie = tail[0] == b'5' && tail[1..].iter().all(|&c| c == b'0');
        if !maybe_tie {
            format!("{:.*}", f, ax)
                .replace('.', "")
                .trim_start_matches('0')
                .to_string()
        } else {
            let (digits, exp) = exact_digits(ax);
            let (d, e) = round_half_up(&digits, exp, exp as i64 + 1 + f as i64);
            let s: String = d.iter().map(|&c| c as char).collect();
            if s.bytes().all(|c| c == b'0') {
                String::new()
            } else {
                // d has e+1+f digits (or one more after carry: e grew by one) → integer n
                let want = (e as i64 + 1 + f as i64).max(0) as usize;
                let mut s = s;
                while s.len() < want {
                    s.push('0');
                }
                s.trim_start_matches('0').to_string()
            }
        }
    };
    let mut m = if n.is_empty() { "0".to_string() } else { n };
    if f != 0 {
        if m.len() <= f {
            m = "0".repeat(f + 1 - m.len()) + &m;
        }
        let k = m.len();
        m = format!("{}.{}", &m[..k - f], &m[k - f..]);
    }
    if neg {
        format!("-{m}")
    } else {
        m
    }
}

/// `Number(x.toPrecision(p))`: x rounded to p significant digits (half away from zero), re-parsed.
pub fn to_precision_number(x: f64, p: usize) -> f64 {
    if !x.is_finite() {
        return x;
    }
    if x == 0.0 {
        return 0.0; // (-0).toPrecision(p) = "0.000…" → +0
    }
    let (d, e) = round_sig(x, p);
    let s: String = d.iter().map(|&c| c as char).collect();
    let v: f64 = format!("{s}e{}", e - (p as i32 - 1)).parse().unwrap();
    if x < 0.0 {
        -v
    } else {
        v
    }
}

/// `String(x)` / `Number.prototype.toString()` (ECMAScript Number::toString, radix 10).
pub fn to_js_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x < 0.0 {
        return format!("-{}", to_js_string(-x));
    }
    if x.is_infinite() {
        return "Infinity".into();
    }
    // Shortest round-trip digits (Rust and V8 both choose the shortest, closest representation).
    let s = format!("{:e}", x);
    let (m, e) = s.split_once('e').unwrap();
    let mut digits: String = m.chars().filter(|c| *c != '.').collect();
    let mut n = e.parse::<i32>().unwrap() + 1;
    // ECMAScript: of two shortest candidates equally close to x, choose the even one. That happens when x
    // lies exactly halfway between two k-digit decimals (e.g. 1190777871235077.25 → "…077.2"); Rust
    // may return either, so check for an exact tie and re-pick.
    let k = digits.len();
    let probe = format!("{:.*e}", k + 24, x);
    let pd: Vec<u8> = probe
        .split_once('e')
        .unwrap()
        .0
        .bytes()
        .filter(|c| *c != b'.')
        .collect();
    if pd[k] == b'5' && pd[k + 1..].iter().all(|&c| c == b'0') {
        let (ex, eexp) = exact_digits(x);
        if ex.len() == k + 1 && ex[k] == b'5' {
            let lo = (ex[..k].to_vec(), eexp);
            let hi = round_half_up(&ex, eexp, k as i64);
            let parses = |(d, e): &(Vec<u8>, i32)| {
                let ds: String = d.iter().map(|&c| c as char).collect();
                format!("{ds}e{}", *e - (d.len() as i32 - 1)).parse::<f64>() == Ok(x)
            };
            let even = |(d, _): &(Vec<u8>, i32)| (d.last().unwrap() - b'0') % 2 == 0;
            if let Some((d, e)) = [lo, hi].into_iter().find(|c| even(c) && parses(c)) {
                let mut ds: String = d.iter().map(|&c| c as char).collect();
                while ds.len() > 1 && ds.ends_with('0') {
                    ds.pop();
                }
                digits = ds;
                n = e + 1;
            }
        }
    }
    let k = digits.len() as i32;
    if k <= n && n <= 21 {
        digits + &"0".repeat((n - k) as usize)
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{}", "0".repeat((-n) as usize), digits)
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    }
}

fn non_finite(x: f64) -> Option<String> {
    if x.is_nan() {
        Some("NaN".into())
    } else if x == f64::INFINITY {
        Some("Infinity".into())
    } else if x == f64::NEG_INFINITY {
        Some("-Infinity".into())
    } else {
        None
    }
}

// ---------- Math ----------

/// `Math.round`: nearest integer, ties toward +∞ (`f64::round` rounds ties away from zero).
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() || x == 0.0 || x.abs() >= 4503599627370496.0 {
        return x; // ±0, NaN, ±∞ and |x| ≥ 2^52 (already integral) are returned unchanged
    }
    let f = x.floor();
    let r = if x - f >= 0.5 { f + 1.0 } else { f }; // x − floor(x) is exact here
    if r == 0.0 && x < 0.0 {
        -0.0
    } else {
        r
    }
}

/// `Math.pow(x, y)` as node/V8 computes it on this platform: the system `pow`, except that y = 2 gives
/// x·x and y = 0.5 (for x ≥ +0) gives sqrt(x) (V8 special-cases them, as fdlibm does), and the JS
/// rules pow(x, NaN) = NaN and pow(±1, ±∞) = NaN. Measured against node 26 on macOS/arm64:
/// 0 mismatches in 590 000 inputs (tests/differential.rs re-checks the engine's own uses), whereas
/// plain `powf` differs in the last bit for some y = 2 / y = 0.5 inputs (e.g. 9.999999999999998²).
pub fn js_pow(x: f64, y: f64) -> f64 {
    if y.is_nan() || (y.is_infinite() && x.abs() == 1.0) {
        return f64::NAN;
    }
    if y == 2.0 {
        return x * x;
    }
    if y == 0.5 && x.is_sign_positive() {
        return x.sqrt();
    }
    x.powf(y)
}

/// `Math.max(a, b)`: NaN if either is NaN; +0 preferred over −0.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b || (a == b && !(a == 0.0 && a.is_sign_negative())) {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`: NaN if either is NaN; −0 preferred over +0.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b || (a == b && !(a == 0.0 && a.is_sign_positive())) {
        a
    } else {
        b
    }
}

/// `x || 0` for a number that may be undefined: undefined, NaN and ±0 all give +0.
pub fn or0(x: Option<f64>) -> f64 {
    match x {
        Some(v) if v != 0.0 && !v.is_nan() => v,
        _ => 0.0,
    }
}

/// Truthiness of a JS number (`if (x)`): false for undefined, 0 and NaN.
pub fn truthy(x: Option<f64>) -> bool {
    matches!(x, Some(v) if v != 0.0 && !v.is_nan())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ties_round_like_js() {
        assert_eq!(to_fixed(0.5, 0), "1");
        assert_eq!(to_fixed(0.25, 1), "0.3");
        assert_eq!(to_fixed(-0.25, 1), "-0.3");
        assert_eq!(to_fixed(-0.0, 2), "0.00");
        assert_eq!(to_fixed(9.995, 2), "9.99"); // 9.995 is really 9.99499999…
        assert_eq!(to_fixed(0.0001, 2), "0.00");
        assert_eq!(to_exponential(2f64.powi(-20), 12), "9.536743164063e-7");
        assert_eq!(to_exponential(0.125, 1), "1.3e-1");
        assert_eq!(to_exponential(9.5, 0), "1e+1");
        assert_eq!(to_precision_number(0.125, 2), 0.13);
    }

    #[test]
    fn number_parsing() {
        assert_eq!(to_number(""), 0.0);
        assert_eq!(to_number("  1E-05 \n"), 1e-5);
        assert_eq!(to_number("0x10"), 16.0);
        assert_eq!(to_number("5."), 5.0);
        assert!(
            to_number("inf").is_nan() && to_number("nan").is_nan() && to_number("-0x1").is_nan()
        );
        assert_eq!(to_number("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(to_number("0x1fffffffffffff1"), 144115188075855856.0); // rounded, not truncated
    }

    #[test]
    fn to_string_and_round() {
        assert_eq!(to_js_string(1.5e-7), "1.5e-7");
        assert_eq!(to_js_string(1e21), "1e+21");
        assert_eq!(
            to_js_string(123456789012345680000.0),
            "123456789012345680000"
        );
        assert_eq!(to_js_string(0.000001), "0.000001");
        // x = 1190777871235077.25 exactly, halfway between the shortest candidates …077.2 and …077.3: JS picks even
        assert_eq!(
            to_js_string(f64::from_bits(0x4310_ec06_5015_e015)),
            "1190777871235077.2"
        );
        assert!(js_max(-0.0, 0.0).is_sign_positive());
        assert!(js_min(0.0, -0.0).is_sign_negative() && js_max(1.0, f64::NAN).is_nan());
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(0.49999999999999994), 0.0);
        assert!(js_round(-0.4).is_sign_negative());
    }
}
