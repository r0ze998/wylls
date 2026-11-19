//! **TEST-ONLY operator AI war world** (natural runner `--operator-villages <abs path>/operators.json`, accepted on any
//! natural world; the launcher passes it for a world opened with `--operator-residents` and `--operator-war
//! operator-war-v1`, and for a wide world with operator residents). Two things, both off-chain and both with the
//! program's own instructions only (the second, the ring opening, only in the capture demo):
//!
//! 1. **the keeper serves the operator residents' villages too.** The keeper loop reveals and settles the marches of
//!    the villages it watches (the player's, and the contest pair's second); an operator resident's march would be
//!    sent and never revealed. Here, once the launcher has written `operators.json` (public addresses only), each
//!    wallet's home Holding — read from its own Citizen's slot 1, once its own PlaceHome landed — is handed to the same
//!    keeper loop (`keeper_loop::run_paced_with`'s `more` channel, exactly as the pair's second village is). No key of
//!    any resident is known here; nothing is signed for them; the keeper's own fee payer pays its own steps, as for
//!    the player's village.
//! 2. **the rest of the demo's new ring is opened.** The demo opens the new ring's provinces next to the player's home
//!    only; a war of six nations needs every nation's border keeps. After the demo's own `ready`, every province of
//!    that ring still absent is opened by the program's permissionless OpenProvince (each simulated first; a refusal
//!    sends nothing and moves on), in a fixed order (p, then q). No rule, parameter, turn length or keep timer changes.
//!
//! Every line says `test_only: true`. Nothing is written to an account directly.
use std::path::{Path, PathBuf};
use std::time::Duration;

use fclient::addr::Addresses;
use fclient::{ix, Address, Signer};
use frontier_abi::layout::player::holding_ref as HR;
use frontier_abi::v2::layout::player::citizen as C;
use localnet::server::{lock, Shared};
use permutation_rules::frontier::geometry::ProvinceCoord;
use serde_json::{json, Value};

use crate::capture_demo::{bytes, funded, send};
use crate::keeper_loop::MoreVillage;
use crate::local_keeper as lk;

pub const VILLAGES_SCHEMA: &str = "frontier-localnet-operator-villages-v1";
/// The launcher's file of the operator residents (public addresses only): its schema.
pub const OPERATORS_FILE_SCHEMA: &str = "frontier-local-play-operator-residents-v1";
/// At most this many operator villages are served (the launcher's own maximum per world).
pub const MAX_OPERATOR_VILLAGES: usize = 12;
const POLL: Duration = Duration::from_secs(1);

fn line(step: &str, extra: Value) -> Value {
    let mut v = json!({"schema": VILLAGES_SCHEMA, "operator_step": step, "test_only": true});
    if let (Some(o), Value::Object(e)) = (v.as_object_mut(), extra) {
        o.extend(e);
    }
    v
}

/// `--operator-villages <abs path>` out of the runner's arguments: `(rest, Some(path))` when given exactly once with an
/// absolute path to a file named `operators.json`; `(args, None)` when absent; anything else is refused.
pub fn take_villages_args(args: Vec<String>) -> Result<(Vec<String>, Option<PathBuf>), String> {
    let mut rest = vec![];
    let mut path = None::<PathBuf>;
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        if a == "--operator-villages" {
            if path.is_some() {
                return Err("--operator-villages twice".into());
            }
            let v = it.next().ok_or("--operator-villages needs a value")?;
            let p = PathBuf::from(&v);
            if !p.is_absolute() || p.file_name().and_then(|n| n.to_str()) != Some("operators.json")
            {
                return Err(
                    "--operator-villages must be an absolute path to operators.json".into(),
                );
            }
            path = Some(p);
        } else {
            rest.push(a);
        }
    }
    Ok((rest, path))
}

/// The wallets of the launcher's `operators.json` (`{schema, test_only: true, wallets: [base58…]}`), each once, at most
/// [`MAX_OPERATOR_VILLAGES`]; `None` while the file is not a whole, valid record yet.
pub fn parse_wallets(text: &str) -> Option<Vec<Address>> {
    let v: Value = serde_json::from_str(text).ok()?;
    if v.get("schema")?.as_str()? != OPERATORS_FILE_SCHEMA || v.get("test_only")?.as_bool()? != true
    {
        return None;
    }
    let mut out: Vec<Address> = vec![];
    for w in v.get("wallets")?.as_array()? {
        let a: Address = w.as_str()?.parse().ok()?;
        if out.contains(&a) {
            return None;
        }
        out.push(a);
    }
    (!out.is_empty() && out.len() <= MAX_OPERATOR_VILLAGES).then_some(out)
}

/// A wallet's home village from its own Citizen: slot 1's `(p, q, site)` whose Holding account exists → `(Holding,
/// (p, q))`; `None` while it has no Citizen or no village yet.
pub fn home_of(state: &Shared, a: &Addresses, wallet: &Address) -> Option<(Address, (i16, i16))> {
    let cit = bytes(state, &a.citizen(wallet)).ok()?;
    let slot = C::holding_of_slot(1);
    let at = |o: usize| {
        cit.get(slot + o..slot + o + 2)
            .map(|b| i16::from_le_bytes([b[0], b[1]]))
    };
    let (p, q, site) = (at(HR::P)?, at(HR::Q)?, *cit.get(slot + HR::SITE)?);
    let h = a.holding(p as i32, q as i32, site);
    let hd = bytes(state, &h).ok()?;
    fclient::decode::Holding::decode(&hd).ok()?;
    Some((h, (p, q)))
}

/// Hands each operator village to the keeper loop once (`more`), as soon as its own PlaceHome has landed. Ends when
/// every listed wallet is served, or when stopped. Two villages in one province are both served: each keeper resolves
/// only what its own village needs, as for the contest pair.
pub async fn watch(
    state: Shared,
    a: Addresses,
    path: PathBuf,
    more: tokio::sync::mpsc::UnboundedSender<MoreVillage>,
    mut stop: tokio::sync::watch::Receiver<bool>,
    out: impl Fn(Value),
) {
    let wallets = loop {
        if *stop.borrow() {
            return;
        }
        if let Some(w) = std::fs::read_to_string(&path)
            .ok()
            .as_deref()
            .and_then(parse_wallets)
        {
            break w;
        }
        tokio::select! { _ = tokio::time::sleep(POLL) => {} _ = stop.changed() => {} }
    };
    out(line(
        "wallets",
        json!({"count": wallets.len(), "file": display(&path)}),
    ));
    let mut served = vec![false; wallets.len()];
    while served.iter().any(|s| !s) {
        if *stop.borrow() {
            return;
        }
        for (i, w) in wallets.iter().enumerate() {
            if served[i] {
                continue;
            }
            if let Some((holding, home)) = home_of(&state, &a, w) {
                served[i] = true;
                let sent = more
                    .send((crate::keeper_loop::public_quicknet(), holding, home))
                    .is_ok();
                out(line(
                    "village",
                    json!({"resident": i, "wallet": w.to_string(), "holding": holding.to_string(), "p": home.0, "q": home.1, "keeper": sent}),
                ));
            }
        }
        tokio::select! { _ = tokio::time::sleep(POLL) => {} _ = stop.changed() => {} }
    }
    out(line("all_served", json!({"count": wallets.len()})));
}

fn display(p: &Path) -> String {
    p.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("operators.json")
        .to_string()
}

/// Every province of ring `d`, in the fixed order (p ascending, then q).
pub fn ring_provinces(d: u32) -> Vec<(i32, i32)> {
    let r = d as i32;
    let mut v = vec![];
    for p in -r..=r {
        for q in -r..=r {
            if ProvinceCoord::new(p, q).ring() == d {
                v.push((p, q));
            }
        }
    }
    v
}

/// After the demo's own `ready` (`ready` turns true): every province of the demo's new ring (the last opened ring)
/// still absent is opened by the program's OpenProvince, simulated first (a refusal sends nothing), in
/// [`ring_provinces`] order. One line per province, then a summary.
pub async fn open_rest(
    state: Shared,
    a: Addresses,
    mut ready: tokio::sync::watch::Receiver<bool>,
    mut stop: tokio::sync::watch::Receiver<bool>,
    out: impl Fn(Value),
) -> Result<(), String> {
    while !*ready.borrow() {
        if *stop.borrow() {
            return Ok(());
        }
        tokio::select! { r = ready.changed() => { if r.is_err() { return Ok(()); } } _ = stop.changed() => {} }
    }
    let d = u16::from_le_bytes(
        bytes(&state, &a.frontier())?[frontier_abi::layout::world::frontier::RINGS_OPENED..][..2]
            .try_into()
            .map_err(|_| "Frontier")?,
    )
    .checked_sub(1)
    .ok_or("no ring is open")?;
    let opener = funded(&state, 500_000_000_000, &stop).await?;
    let (mut opened, mut refused, mut present) = (0u32, 0u32, 0u32);
    for (p, q) in ring_provinces(d as u32) {
        if *stop.borrow() {
            return Ok(());
        }
        if lock(&state).account(&a.province(p, q)).is_some() {
            present += 1;
            continue;
        }
        let ix = ix::open_province(&a, opener.pubkey(), p as i16, q as i16);
        let sim = {
            let c = lock(&state);
            lk::simulate_ix(&c, &opener, &ix)
        };
        match sim {
            Ok(r) if r.err.is_none() => {
                send(
                    &state,
                    &opener,
                    ix,
                    &format!("OpenProvince {:?}", (p, q)),
                    &mut stop,
                )
                .await?;
                opened += 1;
                out(line("province_opened", json!({"p": p, "q": q, "ring": d})));
            }
            Ok(r) => {
                refused += 1;
                out(line(
                    "province_refused",
                    json!({"p": p, "q": q, "ring": d, "why": format!("{:?} (code {:?})", r.err, r.code)}),
                ));
            }
            Err(e) => {
                refused += 1;
                out(line(
                    "province_refused",
                    json!({"p": p, "q": q, "ring": d, "why": e}),
                ));
            }
        }
    }
    out(line(
        "ring_open",
        json!({"ring": d, "opened": opened, "already": present, "refused": refused}),
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_option_is_exact_absolute_and_once() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let (rest, p) = take_villages_args(s(&[
            "--a",
            "1",
            "--operator-villages",
            "/w/x/operators.json",
            "--b",
        ]))
        .unwrap();
        assert_eq!(rest, s(&["--a", "1", "--b"]));
        assert_eq!(p, Some(PathBuf::from("/w/x/operators.json")));
        assert_eq!(
            take_villages_args(s(&["--a"])).unwrap(),
            (s(&["--a"]), None)
        );
        for bad in [
            &["--operator-villages"][..],
            &["--operator-villages", "rel/operators.json"],
            &["--operator-villages", "/w/other.json"],
            &[
                "--operator-villages",
                "/a/operators.json",
                "--operator-villages",
                "/a/operators.json",
            ],
        ] {
            assert!(take_villages_args(s(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_wallets_come_only_from_a_whole_test_only_record() {
        let w1 = Address::new_from_array([7; 32]).to_string();
        let w2 = Address::new_from_array([9; 32]).to_string();
        let rec = |extra: &str, ws: &[&str]| {
            format!("{{\"schema\":\"{OPERATORS_FILE_SCHEMA}\",\"test_only\":true{extra},\"wallets\":{}}}", serde_json::to_string(ws).unwrap())
        };
        assert_eq!(parse_wallets(&rec("", &[&w1, &w2])).unwrap().len(), 2);
        assert!(parse_wallets(&rec("", &[&w1, &w1])).is_none(), "each once");
        assert!(parse_wallets(&rec("", &[])).is_none());
        assert!(parse_wallets(&rec("", &["not-base58!"])).is_none());
        assert!(
            parse_wallets(&rec("", &[&w1])[..20]).is_none(),
            "a partly written file is not read"
        );
        assert!(parse_wallets(&rec("", &[&w1]).replace("true", "false")).is_none());
        assert!(parse_wallets(&rec("", &[&w1]).replace(OPERATORS_FILE_SCHEMA, "other")).is_none());
    }

    #[test]
    fn a_ring_is_every_province_of_that_ring_once_in_a_fixed_order() {
        for d in 1..=6u32 {
            let v = ring_provinces(d);
            assert_eq!(v.len() as u32, 6 * d, "ring {d}");
            assert!(v.iter().all(|&(p, q)| ProvinceCoord::new(p, q).ring() == d));
            let mut s = v.clone();
            s.sort();
            assert_eq!(s, v, "p, then q");
        }
    }

    #[test]
    fn the_runner_wires_it_on_any_natural_world_opens_rings_only_in_the_demo_and_writes_nothing_directly() {
        let bin = include_str!("bin/localnet_natural_play.rs");
        // (loop-play4 B-6: no longer refused outside the demo; the ring opening stays the demo's own)
        assert!(!bin.contains("--operator-villages is accepted only together with"));
        assert!(bin.contains("if demo.is_some() { tokio::spawn(async move {\n                        if let Err(e) = itest::operator_villages::open_rest("));
        assert!(bin.contains("itest::operator_villages::watch("));
        assert!(bin.contains("itest::operator_villages::open_rest("));
        let src = include_str!("operator_villages.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap()];
        for w in ["set_account", "write_account", "account_mut", ".store("] {
            assert!(!body.contains(w), "nothing is written directly: {w}");
        }
        let open = body.find("let ix = ix::open_province(").unwrap();
        assert!(
            body[open..]
                .find("lk::simulate_ix(&c, &opener, &ix)")
                .unwrap()
                < body[open..].find("send(\n                    &state,\n                    &opener,\n                    ix,").unwrap(),
            "simulated before sent"
        );
    }
}
