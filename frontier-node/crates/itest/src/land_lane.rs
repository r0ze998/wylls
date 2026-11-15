//! **TEST-ONLY land lane** (runner `--land-preview land-preview-v1`, launcher `--world-option land-preview-v1`;
//! accepted only together with the capture demo's synthetic clock, never the natural preset's behaviour).
//!
//! The land preview's crank ("Standing Ground" in reduced form, `permutation_rules::frontier::land`): a separate
//! loop beside the keeper (the keeper's own files are unchanged) that, every few seconds, for each opened Province
//! that has something to fold (a village, a host, or land already held):
//!
//! 1. sends the program's own **FoldLand** (provisional 0xCD) with the neighbouring land records, until the
//!    province's land record has folded every bell the Province has resolved;
//! 2. once a village's land yield is at least an hour behind (six folded bells), sends the program's own
//!    **ClaimLandYield** (0xCE) for that holding: its production × its nation's land bonus there, credited to its
//!    stores.
//!
//! Nothing is written directly; no rule, parameter or turn length changes (the land numbers are the program build's
//! `LandParams::PREVIEW`: 6 bells standing to claim, 72 to take, 36 for cut-off land to fall). Every line it prints
//! says `test_only: true`.
use std::collections::BTreeMap;
use std::time::Duration;

use fclient::addr::Addresses;
use fclient::{AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::AddrCtx;
use frontier_abi::land_preview::{self as fl, land as LD};
use frontier_abi::v2::layout::province::{province as P, site as SM};
use localnet::server::{lock, Shared};
use permutation_rules::frontier::geometry::ProvinceCoord;
use serde_json::{json, Value};

use crate::keeper_loop::{fund_fresh, submit_and_wait, Sent};

pub const LAND_MODE: &str = "land-preview-v1";
pub const LAND_SCHEMA: &str = "frontier-localnet-land-preview-v1";
/// How often the lane looks (wall clock).
pub const LOOK_EVERY: Duration = Duration::from_secs(2);
/// A holding's yield is claimed once this many folded bells are unpaid.
pub const CLAIM_AFTER_BELLS: u32 = 6;

/// `--land-preview land-preview-v1` out of the runner's arguments: `(rest, true)` when given exactly once,
/// `(args, false)` when absent; anything else is refused.
pub fn take_land_args(args: Vec<String>) -> Result<(Vec<String>, bool), String> {
    let mut rest = vec![];
    let mut mode = None::<String>;
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        if a == "--land-preview" {
            if mode.is_some() {
                return Err("--land-preview twice".into());
            }
            mode = Some(it.next().ok_or("--land-preview needs a value")?);
        } else {
            rest.push(a);
        }
    }
    match mode {
        None => Ok((rest, false)),
        Some(m) if m == LAND_MODE => Ok((rest, true)),
        Some(m) => Err(format!("--land-preview must be exactly {LAND_MODE}, not {m}")),
    }
}

/// The world's first line on a land world: the `land_preview` statement the launcher checks.
pub fn land_metadata(meta: &mut Value) {
    if let Some(m) = meta.as_object_mut() {
        m.insert(
            "land_preview".into(),
            json!({"mode": LAND_MODE, "rule": permutation_rules::frontier::land::LAND_RULE, "version": permutation_rules::frontier::land::LAND_VERSION,
                   "stand_bells": 6, "seize_bells": 72, "fray_bells": 36, "per_tile_bps": 200, "cap_bps": 3000,
                   "tags": {"fold_land": fl::TAG_FOLD_LAND, "claim_land_yield": fl::TAG_CLAIM_LAND_YIELD}, "provisional_tags": true, "test_only": true}),
        );
    }
}

fn line(step: &str, extra: Value) -> Value {
    let mut v = json!({"schema": LAND_SCHEMA, "land_step": step, "test_only": true});
    if let (Some(o), Value::Object(e)) = (v.as_object_mut(), extra) {
        o.extend(e);
    }
    v
}

fn ctx_of(a: &Addresses) -> AddrCtx {
    AddrCtx { program: a.program.to_bytes(), season: a.season.to_bytes() }
}

/// The land record's address of `(p, q)`.
pub fn land_address(a: &Addresses, p: i16, q: i16) -> Address {
    Address::new_from_array(fl::land_address(&ctx_of(a), p, q))
}

/// FoldLand of `(p, q)` with the neighbours' land records that exist (`next`).
pub fn fold_ix(a: &Addresses, payer: &Address, p: i16, q: i16, next: &[Address], max_bells: u8) -> Instruction {
    let mut metas = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new_readonly(a.province(p.into(), q.into()), false),
        AccountMeta::new(land_address(a, p, q), false),
        AccountMeta::new_readonly(Address::new_from_array([0; 32]), false),
    ];
    metas.extend(next.iter().take(6).map(|k| AccountMeta::new_readonly(*k, false)));
    Instruction { program_id: a.program, accounts: metas, data: vec![fl::TAG_FOLD_LAND, max_bells] }
}

/// ClaimLandYield of the holding at `(p, q, site)`.
pub fn claim_ix(a: &Addresses, payer: &Address, p: i16, q: i16, site: u8) -> Instruction {
    let ctx = ctx_of(a);
    let metas = vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new_readonly(a.province(p.into(), q.into()), false),
        AccountMeta::new(land_address(a, p, q), false),
        AccountMeta::new(Address::new_from_array(ctx.holding(p.into(), q.into(), site)), false),
    ];
    Instruction { program_id: a.program, accounts: metas, data: vec![fl::TAG_CLAIM_LAND_YIELD] }
}

/// What the lane must do in one province, from the chain's records (pure over the bytes).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Todo {
    /// Bells resolved but not folded (0: nothing to fold).
    pub fold_behind: u32,
    /// Sites whose yield is at least [`CLAIM_AFTER_BELLS`] behind.
    pub claim_sites: Vec<u8>,
    /// Tiles per nation now.
    pub tiles: BTreeMap<u8, u32>,
}

/// The work of one province: `pd` its v2 bytes, `ld` its land record when it exists.
pub fn todo(pd: &[u8], ld: Option<&[u8]>) -> Option<Todo> {
    if pd.len() < P::SIZE {
        return None;
    }
    let resolved_next = u32::from_le_bytes(pd[P::RESOLVED_NEXT..P::RESOLVED_NEXT + 4].try_into().ok()?);
    let x = fl::province_inputs(pd).ok()?;
    let busy = x.sites.iter().any(|s| s.holding.is_some()) || !x.hosts.is_empty();
    let mut t = Todo::default();
    match ld {
        None => {
            if !busy || resolved_next == 0 {
                return None;
            }
            t.fold_behind = 1;
        }
        Some(d) => {
            let h = fl::read_header(d).ok()?;
            let version = u16::from_le_bytes(d.get(LD::VERSION..LD::VERSION + 2)?.try_into().ok()?);
            let (next, l) = if version == 0 { (h.yield_bell[0], None) } else {
                let l = fl::read_land(d).ok()?;
                (l.next_bell, Some(l))
            };
            t.fold_behind = resolved_next.saturating_sub(next);
            if let Some(l) = l {
                for f in 0..6u8 {
                    let n = l.tiles_of(f);
                    if n > 0 {
                        t.tiles.insert(f, n);
                    }
                }
                for (s, site) in x.sites.iter().enumerate() {
                    if site.holding.is_some() && pd[P::site(s) + SM::STATE] == SM::STATE_HOLDING && l.next_bell >= h.yield_bell[s] + CLAIM_AFTER_BELLS {
                        t.claim_sites.push(s as u8);
                    }
                }
                if !busy && t.tiles.is_empty() {
                    t.fold_behind = 0;
                }
            }
        }
    }
    Some(t)
}

/// The lane: runs until `stop`. `out` receives each public line.
pub async fn run(state: Shared, a: Addresses, mut stop: tokio::sync::watch::Receiver<bool>, out: impl Fn(Value)) -> Result<(), String> {
    let payer: Keypair = fund_fresh(&state, &mut stop).await?;
    out(line("started", json!({"look_every_ms": LOOK_EVERY.as_millis() as u64, "claim_after_bells": CLAIM_AFTER_BELLS})));
    let mut last_tiles: BTreeMap<(i32, i32), BTreeMap<u8, u32>> = BTreeMap::new();
    loop {
        if *stop.borrow() {
            return Ok(());
        }
        let work: Vec<((i32, i32), Todo, Vec<Address>)> = {
            let c = lock(&state);
            let mut v = vec![];
            for (p, q) in crate::legacy_march::opened_provinces(&c, &a) {
                let Some(pd) = c.account(&a.province(p, q)).filter(|x| x.owner == a.program).map(|x| x.data) else { continue };
                let ld = c.account(&land_address(&a, p as i16, q as i16)).filter(|x| x.owner == a.program).map(|x| x.data);
                let Some(t) = todo(&pd, ld.as_deref()) else { continue };
                let next: Vec<Address> = ProvinceCoord::new(p, q)
                    .neighbors()
                    .iter()
                    .map(|n| land_address(&a, n.p as i16, n.q as i16))
                    .filter(|k| c.account(k).is_some_and(|x| x.owner == a.program && x.data.len() == LD::SIZE))
                    .collect();
                v.push(((p, q), t, next));
            }
            v
        };
        for ((p, q), t, next) in work {
            if t.fold_behind > 0 {
                let ix = fold_ix(&a, &payer.pubkey(), p as i16, q as i16, &next, fl::MAX_FOLD_BELLS);
                match submit_and_wait(&state, &payer, ix, &format!("FoldLand({p},{q})"), Duration::from_secs(20), &mut stop).await {
                    Sent::Landed(sig) => {
                        if t.fold_behind > 1 || !last_tiles.contains_key(&(p, q)) {
                            out(line("fold", json!({"p": p, "q": q, "behind": t.fold_behind, "signature": sig})));
                        }
                    }
                    Sent::Failed(e) => out(line("fold_refused", json!({"p": p, "q": q, "why": e}))),
                    Sent::Unknown { signature, why } => out(line("fold_unknown", json!({"p": p, "q": q, "signature": signature, "why": why}))),
                }
            }
            for s in &t.claim_sites {
                let ix = claim_ix(&a, &payer.pubkey(), p as i16, q as i16, *s);
                match submit_and_wait(&state, &payer, ix, &format!("ClaimLandYield({p},{q},{s})"), Duration::from_secs(20), &mut stop).await {
                    Sent::Landed(sig) => out(line("yield", json!({"p": p, "q": q, "site": s, "signature": sig}))),
                    Sent::Failed(e) => out(line("yield_refused", json!({"p": p, "q": q, "site": s, "why": e}))),
                    Sent::Unknown { signature, why } => out(line("yield_unknown", json!({"p": p, "q": q, "site": s, "signature": signature, "why": why}))),
                }
            }
            if !t.tiles.is_empty() && last_tiles.get(&(p, q)) != Some(&t.tiles) {
                let tiles: serde_json::Map<String, Value> = t.tiles.iter().map(|(f, n)| (f.to_string(), json!(n))).collect();
                out(line("tiles", json!({"p": p, "q": q, "tiles_by_nation": tiles})));
                last_tiles.insert((p, q), t.tiles.clone());
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(LOOK_EVERY) => {}
            _ = stop.changed() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_option_is_exact_and_once() {
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(take_land_args(a(&["--x", "1"])).unwrap(), (a(&["--x", "1"]), false));
        assert_eq!(take_land_args(a(&["--land-preview", LAND_MODE, "--x"])).unwrap(), (a(&["--x"]), true));
        assert!(take_land_args(a(&["--land-preview", "v2"])).is_err());
        assert!(take_land_args(a(&["--land-preview"])).is_err());
        assert!(take_land_args(a(&["--land-preview", LAND_MODE, "--land-preview", LAND_MODE])).is_err());
    }

    #[test]
    fn an_empty_province_has_nothing_to_fold() {
        let mut pd = vec![0u8; P::SIZE];
        pd[P::RESOLVED_NEXT..P::RESOLVED_NEXT + 4].copy_from_slice(&5u32.to_le_bytes());
        pd[P::KEEP] = 0xFF;
        assert_eq!(todo(&pd, None), None);
        // a village: fold
        pd[P::SITE_COUNT] = 1;
        pd[P::SITES] = 30;
        pd[P::site(0) + SM::STATE] = SM::STATE_HOLDING;
        pd[P::site(0) + SM::FACTION] = 2;
        assert_eq!(todo(&pd, None).unwrap().fold_behind, 1);
    }

    #[test]
    fn the_instructions_name_the_program_and_its_accounts() {
        let a = Addresses::new(Address::new_from_array([0x45; 32]), 11);
        let payer = Address::new_from_array([7; 32]);
        let ix = fold_ix(&a, &payer, 1, -2, &[], 8);
        assert_eq!(ix.data, vec![fl::TAG_FOLD_LAND, 8]);
        assert_eq!(ix.accounts.len(), fl::FOLD_FIXED);
        assert!(ix.accounts[0].is_signer && ix.accounts[0].is_writable && ix.accounts[3].is_writable);
        assert_eq!(ix.accounts[3].pubkey, land_address(&a, 1, -2));
        let c = claim_ix(&a, &payer, 1, -2, 3);
        assert_eq!(c.data, vec![fl::TAG_CLAIM_LAND_YIELD]);
        assert!(c.accounts[4].is_writable);
    }
}
