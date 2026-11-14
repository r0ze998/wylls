//! **TEST-ONLY contest pair** (runner `--contest-pair contest-pair-v1 --second-wallet <base58 public key>`, accepted only
//! together with the capture demo; never the natural preset's behaviour). One memory-only world, TWO players: the second
//! wallet is funded like the first (fees and rent only), its own page Joins and PlaceHomes with its own memory-only key,
//! and the same keeper loop serves its village (`keeper_loop::Pilot::add_village`). Both sides are people: there is no
//! automatic opponent. No rule, parameter or account is changed for either player.
use fclient::Address;
use serde_json::{json, Value};

pub const PAIR_MODE: &str = "contest-pair-v1";
pub const PAIR_SCHEMA: &str = "frontier-localnet-contest-pair-v1";

/// Takes `--contest-pair contest-pair-v1 --second-wallet <key>` out of the arguments: both exactly once or neither.
/// `(rest, Some(second))`, `(args, None)` without them; anything else is refused (an unknown mode, one without the other,
/// a repeat, a key that is not a canonical, usable public key).
pub fn take_pair_args(args: Vec<String>) -> Result<(Vec<String>, Option<Address>), String> {
    let (mut mode, mut wallet, mut rest) = (None::<String>, None::<String>, vec![]);
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--contest-pair" => { if mode.is_some() { return Err("--contest-pair given twice".into()); } mode = Some(it.next().ok_or("--contest-pair needs its mode")?); }
            "--second-wallet" => { if wallet.is_some() { return Err("--second-wallet given twice".into()); } wallet = Some(it.next().ok_or("--second-wallet needs a public key")?); }
            _ => rest.push(a),
        }
    }
    match (mode, wallet) {
        (None, None) => Ok((rest, None)),
        (Some(m), Some(w)) if m == PAIR_MODE => {
            let key: Address = w.parse().map_err(|_| "--second-wallet is not a public key".to_string())?;
            if key.to_string() != w { return Err("--second-wallet is not a canonical public key".into()); }
            if key == Address::default() { return Err("--second-wallet is not a usable public key".into()); }
            Ok((rest, Some(key)))
        }
        (Some(m), Some(_)) => Err(format!("--contest-pair must be {PAIR_MODE}, not {m}")),
        _ => Err("--contest-pair and --second-wallet go together".into()),
    }
}

/// The world's first line states the pair (the launcher checks it against its own options).
pub fn pair_metadata(meta: &mut Value, second: &Address) {
    meta["contest_pair"] = json!({"mode": PAIR_MODE, "second_wallet": second.to_string(), "test_only": true, "automatic_opponent": false});
}

/// One line about the second player (public facts only).
pub fn line(step: &str, extra: Value) -> Value {
    let mut v = json!({"schema": PAIR_SCHEMA, "pair_step": step, "test_only": true});
    if let (Some(m), Some(e)) = (v.as_object_mut(), extra.as_object()) { for (k, x) in e { m.insert(k.clone(), x.clone()); } }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    fn v(s: &[&str]) -> Vec<String> { s.iter().map(|x| x.to_string()).collect() }
    const K: &str = "Avexj6jFeyqKwd6V9Y8M7PVSqQEWmFJXAnAroC1wv3FJ";
    #[test]
    fn the_pair_options_are_explicit_exact_and_together() {
        assert_eq!(take_pair_args(v(&["--keeper", "k"])).unwrap(), (v(&["--keeper", "k"]), None), "without them: one player, unchanged");
        let (rest, w) = take_pair_args(v(&["--second-wallet", K, "--keeper", "k", "--contest-pair", PAIR_MODE])).unwrap();
        assert_eq!(rest, v(&["--keeper", "k"])); assert_eq!(w.unwrap().to_string(), K);
        for bad in [v(&["--contest-pair", PAIR_MODE]), v(&["--second-wallet", K]), v(&["--contest-pair", "pair-v2", "--second-wallet", K]),
            v(&["--contest-pair", PAIR_MODE, "--second-wallet", "not-a-key"]), v(&["--contest-pair", PAIR_MODE, "--contest-pair", PAIR_MODE, "--second-wallet", K]),
            v(&["--contest-pair", PAIR_MODE, "--second-wallet", K, "--second-wallet", K]), v(&["--contest-pair"]),
            v(&["--contest-pair", PAIR_MODE, "--second-wallet", "11111111111111111111111111111111"])] {
            assert!(take_pair_args(bad.clone()).is_err(), "{bad:?}");
        }
    }
    #[test]
    fn the_first_line_states_the_pair_and_no_automatic_opponent() {
        let mut m = json!({"world": "natural"});
        pair_metadata(&mut m, &K.parse().unwrap());
        assert_eq!(m["contest_pair"], json!({"mode": PAIR_MODE, "second_wallet": K, "test_only": true, "automatic_opponent": false}));
        let l = line("home", json!({"p": 1}));
        assert_eq!((l["schema"].as_str(), l["test_only"].as_bool(), l["p"].as_i64()), (Some(PAIR_SCHEMA), Some(true), Some(1)));
    }
}
