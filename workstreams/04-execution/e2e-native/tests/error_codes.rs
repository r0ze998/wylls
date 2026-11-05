//! Error numbers, one place (workstream 04): the game program's codes
//! (frontier-abi `FrontierError` 1–61, 99 and `CqError` 62–…), their
//! generated copies (frontier-abi/vectors/v2/errors.json and the two
//! generated JS tables), and the prize program's codes (0x100–…) against
//! the two hand-kept JS tables. Fails on a number used twice in one table
//! or on any copy that disagrees with the Rust definition — the check to
//! run after applying a workstream's patch that adds a code (⑧ and ⑩
//! both reported using 94).

use std::collections::BTreeMap;

use frontier_abi::error::FrontierError;
use frontier_abi::v2::error::CqError;
use permutation_prize::PrizeError as P;

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../..");

fn read(rel: &str) -> String {
    std::fs::read_to_string(format!("{ROOT}/{rel}")).unwrap_or_else(|e| panic!("{rel}: {e}"))
}

/// `(code, name)` pairs in text order: every `"code": N` / `"code":N`
/// followed by its `"name"`.
fn json_pairs(s: &str) -> Vec<(u32, String)> {
    let mut out = vec![];
    let mut rest = s;
    while let Some(i) = rest.find("\"code\"") {
        rest = &rest[i + 6..];
        let num: String = rest
            .trim_start_matches([':', ' '])
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let Some(j) = rest.find("\"name\"") else {
            break;
        };
        let after = &rest[j + 6..];
        let q1 = after.find('"').unwrap();
        let q2 = after[q1 + 1..].find('"').unwrap();
        out.push((num.parse().unwrap(), after[q1 + 1..q1 + 1 + q2].to_string()));
        rest = &after[q1 + 1 + q2..];
    }
    out
}

/// `0x1NN: 'Name'` pairs of a PRIZE_ERRORS table.
fn prize_js(s: &str) -> Vec<(u32, String)> {
    let start = s.find("PRIZE_ERRORS").expect("PRIZE_ERRORS");
    let body = &s[start..s[start..].find("});").unwrap() + start];
    body.split(',')
        .filter_map(|p| {
            let (k, v) = p.split_once(':')?;
            let k = k.trim().trim_start_matches(['{', '(', ' ']).trim();
            let k = k.rsplit(' ').next()?;
            let code = u32::from_str_radix(k.strip_prefix("0x")?, 16).ok()?;
            Some((code, v.trim().trim_matches(['\'', '"', ' ']).to_string()))
        })
        .collect()
}

fn dups(v: &[(u32, String)]) -> Vec<u32> {
    let mut seen = BTreeMap::new();
    let mut d = vec![];
    for (c, _) in v {
        if seen.insert(*c, ()).is_some() {
            d.push(*c);
        }
    }
    d
}

fn rust_game() -> Vec<(u32, String)> {
    let mut v: Vec<(u32, String)> = FrontierError::ALL
        .iter()
        .map(|e| (e.code(), format!("{e:?}")))
        .chain(CqError::ALL.iter().map(|e| (e.code(), format!("{e:?}"))))
        .collect();
    v.sort();
    v
}

#[test]
fn game_error_numbers_are_unique_and_every_copy_agrees() {
    let rust = rust_game();
    assert!(
        dups(&rust).is_empty(),
        "a code used twice in the Rust enums: {:?}",
        dups(&rust)
    );
    for rel in [
        "frontier-abi/vectors/v2/errors.json",
        "permutation-gateway/client/src/frontier/abi-v2-errors.mjs",
        "permutation-server/web/sdk/frontier/abi-v2-errors.mjs",
    ] {
        let mut copy = json_pairs(&read(rel));
        assert!(
            dups(&copy).is_empty(),
            "{rel}: a code used twice: {:?}",
            dups(&copy)
        );
        copy.sort();
        // Reserved numbers (14) are in the copies only; compare the rest.
        copy.retain(|(c, n)| !n.starts_with("Reserved") || rust.iter().any(|(rc, _)| rc == c));
        assert_eq!(copy, rust, "{rel} differs from frontier-abi's enums");
    }
}

#[test]
fn prize_error_numbers_are_unique_and_every_copy_agrees() {
    let mut rust: Vec<(u32, String)> = [
        P::BadData,
        P::BadAccount,
        P::BadParams,
        P::NotOperator,
        P::WrongState,
        P::AlreadyPaid,
        P::SeasonNotEnded,
        P::ProvinceNotFinal,
        P::NoKeep,
        P::TallyIncomplete,
        P::BadShares,
        P::BadProof,
        P::NotWinner,
        P::AlreadyClaimed,
        P::NothingToPay,
        P::Overflow,
        P::WrongExpectedCount,
        P::ContinuousSeason,
    ]
    .iter()
    .map(|e| (*e as u32, format!("{e:?}")))
    .collect();
    rust.sort();
    assert!(dups(&rust).is_empty());
    for rel in [
        "permutation-gateway/client/src/frontier/prize.mjs",
        "permutation-server/web/sdk/frontier/prize.mjs",
    ] {
        let mut copy = prize_js(&read(rel));
        assert!(
            dups(&copy).is_empty(),
            "{rel}: a code used twice: {:?}",
            dups(&copy)
        );
        copy.sort();
        assert_eq!(
            copy, rust,
            "{rel} differs from permutation-prize's PrizeError"
        );
    }
}

/// The free numbers right after the ones in use (for proposals; adopting a
/// number is a separate decision).
#[test]
fn next_free_numbers() {
    let used: Vec<u32> = rust_game().iter().map(|x| x.0).collect();
    let next: Vec<u32> = (1..=200)
        .filter(|c| !used.contains(c))
        .filter(|c| *c > 61)
        .take(4)
        .collect();
    println!(
        "game program: highest in use {:?}; next free above 61: {next:?}",
        used.iter().filter(|c| **c < 99).max()
    );
    assert_eq!(
        next.first(),
        Some(&94),
        "the base's next free game code (both ⑧ and ⑩ reported 94)"
    );
}
