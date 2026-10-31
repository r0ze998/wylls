//! `frontier-stack drill`: one test citizen of a local world, driven by hand
//! (continuous-world verification, workstream 08). Local worlds only: it
//! talks to the run's own `127.0.0.1` port, pays with the run's operator
//! key and keeps its own wallet in `RUN/drill/wallet.seed`.
//!
//! ```text
//! frontier-stack drill --run-id ID --do setup            # Join + PlaceHome (faction 0)
//! frontier-stack drill --run-id ID --do vault [--at N]   # BuildVault N steps from the home (default 6)
//! frontier-stack drill --run-id ID --do send --cargo R:U[,R:U] [--back]
//! frontier-stack drill --run-id ID --do close-vault
//! frontier-stack drill --run-id ID --do status
//! ```
//!
//! Every write is the program's own instruction built by fclient (Join,
//! PlaceHome, BuildVault, SendCaravan, CloseVault); a refusal is printed as
//! the program gave it. Settles are left to the keeper. `status` prints the
//! citizen, its home's stores, the vault's stores and every caravan account
//! of the citizen with its lamports, so a run can be compared before and
//! after a test boundary and a `down`/`resume`.

use std::time::Duration;

use fclient::addr::Addresses;
use fclient::decode::{Citizen, Holding, Province};
use fclient::ix::v2::{PlaceRef, SendCaravanArgs};
use fclient::ix::{self, HoldingRef, Player, Site};
use fclient::{Address, Keypair, Signer};
use frontier_abi::v2::layout::s1::{caravan as CV, vault as VA};
use permutation_rules::frontier::geometry::{locate, ring_provinces, ProvinceCoord};
use permutation_rules::hex::{Hex, DIRECTIONS};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::chain::Chain;
use crate::run::RunDir;

/// The caravan fee the program takes at least (`caravan::CARAVAN_FEE`).
const CARAVAN_FEE: u64 = permutation_rules::frontier::caravan::CARAVAN_FEE;
/// The faction of the test citizen.
const FACTION: u8 = 0;

/// What `drill` was asked to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DrillOp {
    Setup,
    Vault(usize),
    Send { cargo: [u32; 8], back: bool },
    CloseVault,
    Status,
}

/// `--do`, `--at`, `--cargo` and `--back` as given.
pub fn parse_op(
    what: Option<&str>,
    at: Option<&str>,
    cargo: Option<&str>,
    back: bool,
) -> Result<DrillOp, String> {
    match what.unwrap_or("status") {
        "setup" => Ok(DrillOp::Setup),
        "vault" => Ok(DrillOp::Vault(
            at.map(|s| s.parse::<usize>().map_err(|_| "--at: steps"))
                .transpose()?
                .unwrap_or(6),
        )),
        "send" => {
            let mut c = [0u32; 8];
            for part in cargo.ok_or("--do send needs --cargo R:U[,R:U]")?.split(',') {
                let (r, u) = part.split_once(':').ok_or("--cargo is R:U")?;
                let r: usize = r.trim().parse().map_err(|_| "--cargo: R is 0..7")?;
                let u: u32 = u.trim().parse().map_err(|_| "--cargo: U is units")?;
                *c.get_mut(r).ok_or("--cargo: R is 0..7")? = u;
            }
            Ok(DrillOp::Send { cargo: c, back })
        }
        "close-vault" => Ok(DrillOp::CloseVault),
        "status" => Ok(DrillOp::Status),
        other => Err(format!(
            "--do {other}: setup, vault, send, close-vault or status"
        )),
    }
}

/// The run's chain, addresses, operator key and the drill wallet.
fn world(rd: &RunDir) -> Result<(Chain, Addresses, Keypair, Keypair), String> {
    let state = rd.load_state()?;
    let port = state["ports"]["localnet"]
        .as_u64()
        .ok_or("state.json names no localnet port")?;
    let program: Address = state["program"]
        .as_str()
        .ok_or("state.json names no program")?
        .parse()
        .map_err(|_| "invalid saved program")?;
    let season = state["season_id"].as_u64().ok_or("missing season id")?;
    let seed = std::fs::read_to_string(rd.path("keys/operator.seed")).map_err(|e| e.to_string())?;
    let seed: [u8; 32] = hex::decode(seed.trim())
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "invalid operator seed")?;
    let dir = rd.path("drill");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let wpath = dir.join("wallet.seed");
    let wseed: [u8; 32] = match std::fs::read_to_string(&wpath) {
        Ok(s) => hex::decode(s.trim())
            .map_err(|e| e.to_string())?
            .try_into()
            .map_err(|_| "invalid drill seed")?,
        Err(_) => {
            let s: [u8; 32] = Sha256::digest(
                format!("wylls-08 drill wallet {} {season}", rd.path("").display()).as_bytes(),
            )
            .into();
            std::fs::write(&wpath, hex::encode(s)).map_err(|e| e.to_string())?;
            s
        }
    };
    Ok((
        Chain::new(&format!("http://127.0.0.1:{port}"), program),
        Addresses::new(program, season),
        Keypair::new_from_array(seed),
        Keypair::new_from_array(wseed),
    ))
}

async fn account(chain: &Chain, k: &Address) -> Result<Option<(u64, Vec<u8>)>, String> {
    Ok(chain
        .accounts(&[*k])
        .await?
        .into_iter()
        .next()
        .flatten()
        .map(|a| (a.lamports, a.data)))
}

fn player(op: &Keypair, wallet: &Keypair) -> Player {
    Player {
        actor: wallet.pubkey(),
        payer: op.pubkey(),
        wallet: wallet.pubkey(),
    }
}

async fn send(
    chain: &Chain,
    ixs: &[fclient::Instruction],
    op: &Keypair,
    wallet: &Keypair,
) -> Result<(), String> {
    chain
        .send_op(ixs, &[op, wallet], Duration::from_secs(30))
        .await
}

fn i64_at(d: &[u8], o: usize) -> i64 {
    d.get(o..o + 8)
        .map_or(0, |b| i64::from_le_bytes(b.try_into().unwrap()))
}
fn u32_at(d: &[u8], o: usize) -> u32 {
    d.get(o..o + 4)
        .map_or(0, |b| u32::from_le_bytes(b.try_into().unwrap()))
}

/// The citizen's first holding (slot 1), with its tile.
async fn home(
    chain: &Chain,
    a: &Addresses,
    wallet: &Keypair,
) -> Result<(Citizen, Holding), String> {
    let (_, cd) = account(chain, &a.citizen(&wallet.pubkey()))
        .await?
        .ok_or("no Citizen yet: run --do setup")?;
    let c = Citizen::decode(&cd).map_err(|e| format!("citizen: {e:?}"))?;
    let s = c.holding[0];
    let (_, hd) = account(chain, &a.holding(s.p as i32, s.q as i32, s.site))
        .await?
        .ok_or("no home holding yet")?;
    let h = Holding::decode(&hd).map_err(|e| format!("holding: {e:?}"))?;
    Ok((c, h))
}

/// The directions of a shortest path from `from` to `to` over the passable
/// tiles of Province `(p, q)`, never leaving it.
fn local_dirs(p: i16, q: i16, pass: u64, from: u8, to: u8) -> Option<Vec<u8>> {
    use std::collections::{HashMap, VecDeque};
    let pc = ProvinceCoord::new(p as i32, q as i32);
    let mut prev: HashMap<u8, (u8, u8)> = HashMap::new();
    let mut queue = VecDeque::from([from]);
    prev.insert(from, (from, 9));
    while let Some(t) = queue.pop_front() {
        if t == to {
            let mut dirs = vec![];
            let mut x = t;
            while x != from {
                let (pr, d) = prev[&x];
                dirs.push(d);
                x = pr;
            }
            dirs.reverse();
            return Some(dirs);
        }
        let h = pc.tile(t)?;
        for (d, (dq, dr)) in DIRECTIONS.iter().enumerate() {
            let (sp, st) = locate(Hex::new(h.q + dq, h.r + dr));
            if (sp.p, sp.q) != (p as i32, q as i32)
                || pass & (1u64 << st) == 0
                || prev.contains_key(&st)
            {
                continue;
            }
            prev.insert(st, (t, d as u8));
            queue.push_back(st);
        }
    }
    None
}

fn vault_path() -> &'static str {
    "drill/vault.json"
}

async fn setup(chain: &Chain, a: &Addresses, op: &Keypair, wallet: &Keypair) -> Result<(), String> {
    let st = chain.status().await?;
    if account(chain, &a.citizen(&wallet.pubkey()))
        .await?
        .is_none()
    {
        println!("Join(faction {FACTION}) wallet {}", wallet.pubkey());
        let i = ix::join(
            a,
            wallet.pubkey(),
            op.pubkey(),
            FACTION,
            &wallet.pubkey(),
            st.now + 25 * 86_400,
            None,
        );
        chain
            .send_op(&[i], &[op, wallet], Duration::from_secs(30))
            .await?;
    }
    let (_, cd) = account(chain, &a.citizen(&wallet.pubkey()))
        .await?
        .ok_or("Join landed but no Citizen")?;
    let c = Citizen::decode(&cd).map_err(|e| format!("citizen: {e:?}"))?;
    if c.holdings_n > 0 {
        println!("already has a home");
        return Ok(());
    }
    // Sites of the faction's ring-2 and ring-3 provinces, in order; the
    // program decides (placement and every other rule are its own).
    let p = player(op, wallet);
    for ring in [2u32, 3] {
        for pc in ring_provinces(ring) {
            let Some((_, pd)) = account(chain, &a.province(pc.p, pc.q)).await? else {
                continue;
            };
            let Ok(pv) = Province::decode(&pd) else {
                continue;
            };
            for s in 0..pv.site_count.min(12) {
                if pv.site_mirror[s as usize].state != 0 {
                    continue;
                }
                let site = Site {
                    p: pc.p as i16,
                    q: pc.q as i16,
                    site: s,
                };
                let i = ix::place_home(a, &p, site, FACTION, c.join_shard);
                match send(chain, &[i], op, wallet).await {
                    Ok(()) => {
                        println!("PlaceHome({},{} site {s}) landed", pc.p, pc.q);
                        return Ok(());
                    }
                    Err(e) => println!(
                        "PlaceHome({},{} site {s}) refused: {}",
                        pc.p,
                        pc.q,
                        e.lines().next().unwrap_or("")
                    ),
                }
            }
        }
    }
    Err("no site took the home".into())
}

async fn vault(
    rd: &RunDir,
    chain: &Chain,
    a: &Addresses,
    op: &Keypair,
    wallet: &Keypair,
    steps: usize,
) -> Result<(), String> {
    let (_, h) = home(chain, a, wallet).await?;
    let (_, pd) = account(chain, &a.province(h.p as i32, h.q as i32))
        .await?
        .ok_or("no home province")?;
    let pv = Province::decode(&pd).map_err(|e| format!("province: {e:?}"))?;
    let sites = &pv.sites[..pv.site_count as usize];
    let tile = (0..61u8)
        .filter(|t| !sites.contains(t) && *t != pv.camp.tile)
        .find(|&t| {
            local_dirs(h.p, h.q, pv.passable_mask, h.tile, t).is_some_and(|d| d.len() == steps)
        })
        .ok_or(format!("no tile {steps} steps from the home"))?;
    println!("BuildVault({},{} tile {tile}), {steps} steps", h.p, h.q);
    let i = ix::v2::build_vault(
        a,
        &player(op, wallet),
        HoldingRef {
            p: h.p,
            q: h.q,
            site: h.site,
        },
        (h.p, h.q),
        tile,
    );
    send(chain, &[i], op, wallet).await?;
    std::fs::write(
        rd.path(vault_path()),
        json!({"p": h.p, "q": h.q, "tile": tile}).to_string(),
    )
    .map_err(|e| e.to_string())
}

fn saved_vault(rd: &RunDir) -> Result<(i16, i16, u8), String> {
    let v: Value = serde_json::from_str(
        &std::fs::read_to_string(rd.path(vault_path())).map_err(|_| "no vault yet: --do vault")?,
    )
    .map_err(|e| e.to_string())?;
    Ok((
        v["p"].as_i64().unwrap_or(0) as i16,
        v["q"].as_i64().unwrap_or(0) as i16,
        v["tile"].as_u64().unwrap_or(0) as u8,
    ))
}

async fn caravan(
    rd: &RunDir,
    chain: &Chain,
    a: &Addresses,
    op: &Keypair,
    wallet: &Keypair,
    cargo: [u32; 8],
    back: bool,
) -> Result<(), String> {
    let (c, h) = home(chain, a, wallet).await?;
    let (vp, vq, vt) = saved_vault(rd)?;
    let (_, pd) = account(chain, &a.province(h.p as i32, h.q as i32))
        .await?
        .ok_or("no home province")?;
    let pv = Province::decode(&pd).map_err(|e| format!("province: {e:?}"))?;
    let (_, vd) = account(chain, &a.vault(vp as i32, vq as i32, vt))
        .await?
        .ok_or("no vault account")?;
    let vgen = vd[VA::GEN];
    let hplace = PlaceRef::Holding {
        h: HoldingRef {
            p: h.p,
            q: h.q,
            site: h.site,
        },
        gen: h.gen,
    };
    let vplace = PlaceRef::Vault {
        p: vp,
        q: vq,
        tile: vt,
        gen: vgen,
    };
    let (src, dst, from, to) = if back {
        (vplace, hplace, vt, h.tile)
    } else {
        (hplace, vplace, h.tile, vt)
    };
    let dirs = local_dirs(h.p, h.q, pv.passable_mask, from, to).ok_or("no local path")?;
    let path = permutation_rules::frontier::caravan::pack(&dirs).ok_or("path too long")?;
    let seq = u32_at(
        &account(chain, &a.citizen(&wallet.pubkey()))
            .await?
            .ok_or("no citizen")?
            .1,
        frontier_abi::v2::layout::player::citizen::CARAVANS,
    );
    let _ = c;
    let x = SendCaravanArgs {
        seq,
        src,
        dst,
        steps: dirs.len() as u8,
        path,
        cargo,
        fee: CARAVAN_FEE,
        provinces: vec![(h.p, h.q)],
    };
    println!(
        "SendCaravan(seq {seq}, {} -> {}, {} steps, cargo {cargo:?})",
        if back { "vault" } else { "home" },
        if back { "home" } else { "vault" },
        dirs.len()
    );
    let i = ix::v2::send_caravan(a, &player(op, wallet), &x);
    send(chain, &[i], op, wallet).await
}

async fn close_vault(
    rd: &RunDir,
    chain: &Chain,
    a: &Addresses,
    op: &Keypair,
    wallet: &Keypair,
) -> Result<(), String> {
    let (vp, vq, vt) = saved_vault(rd)?;
    let (_, vd) = account(chain, &a.vault(vp as i32, vq as i32, vt))
        .await?
        .ok_or("no vault account")?;
    let rent_to = Address::new_from_array(vd[VA::RENT_TO..VA::RENT_TO + 32].try_into().unwrap());
    println!("CloseVault({vp},{vq} tile {vt}) rent to {rent_to}");
    let i = ix::v2::close_vault(a, &player(op, wallet), (vp, vq, vt), rent_to);
    send(chain, &[i], op, wallet).await
}

/// The test citizen's world as JSON (`status`).
pub async fn status_json(
    rd: &RunDir,
    chain: &Chain,
    a: &Addresses,
    op: &Keypair,
    wallet: &Keypair,
) -> Result<Value, String> {
    let st = chain.status().await?;
    let season = chain.season(a).await?.ok_or("no Season")?;
    let bell = frontier_abi::prologue::bell_at(season.genesis_ts, st.now);
    let lam = |x: Option<(u64, Vec<u8>)>| x.map_or(0, |a| a.0);
    let mut out = json!({
        "bell": bell, "now": st.now, "slot": st.slot,
        "operator_lamports": lam(account(chain, &op.pubkey()).await?),
        "wallet": wallet.pubkey().to_string(),
    });
    let Ok((c, h)) = home(chain, a, wallet).await else {
        return Ok(out);
    };
    let tag = c.citizen_tag;
    out["citizen"] =
        json!({"faction": c.faction, "holdings_n": c.holdings_n, "tag": tag.to_string()});
    out["home"] = json!({
        "p": h.p, "q": h.q, "site": h.site, "gen": h.gen, "tile": h.tile,
        "stores_value": h.stores.iter().map(|s| s.value).collect::<Vec<_>>(),
        "stores_t0": h.stores.iter().map(|s| s.t0).collect::<Vec<_>>(),
        "lamports": lam(account(chain, &a.holding(h.p as i32, h.q as i32, h.site)).await?),
    });
    if let Ok((vp, vq, vt)) = saved_vault(rd) {
        let v = account(chain, &a.vault(vp as i32, vq as i32, vt)).await?;
        out["vault"] = match v {
            Some((l, d)) => json!({
                "present": true, "lamports": l, "gen": d[VA::GEN], "state": d[VA::STATE],
                "stores": (0..8).map(|r| i64_at(&d, VA::store(r))).collect::<Vec<_>>(),
                "sent": u32_at(&d, VA::SENT),
            }),
            None => json!({"present": false}),
        };
    }
    let seqs = u32_at(
        &account(chain, &a.citizen(&wallet.pubkey()))
            .await?
            .map_or(vec![], |x| x.1),
        frontier_abi::v2::layout::player::citizen::CARAVANS,
    );
    let mut cvs = vec![];
    for seq in 0..seqs {
        let k = a.caravan(tag, seq);
        cvs.push(match account(chain, &k).await? {
            Some((l, d)) => json!({
                "seq": seq, "present": true, "lamports": l, "state": d[CV::STATE],
                "fee": u64::from_le_bytes(d[CV::FEE..CV::FEE + 8].try_into().unwrap()),
                "arrive_ts": i64_at(&d, CV::ARRIVE_TS), "last_bell": u32_at(&d, CV::LAST_BELL),
                "cargo": (0..8).map(|r| i64_at(&d, CV::cargo(r))).collect::<Vec<_>>(),
            }),
            None => json!({"seq": seq, "present": false}),
        });
    }
    out["caravans_sent"] = json!(seqs);
    out["caravans"] = json!(cvs);
    Ok(out)
}

/// `frontier-stack drill`: one step, then the status. Exit 0 when the write
/// landed (or for `status`), 1 when the program refused it, 2 when the
/// world cannot be read.
pub async fn drill(rd: &RunDir, op: DrillOp) -> i32 {
    let (chain, a, payer, wallet) = match world(rd) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("frontier-stack drill: {e}");
            return 2;
        }
    };
    let sent = match op {
        DrillOp::Status => Ok(()),
        DrillOp::Setup => setup(&chain, &a, &payer, &wallet).await,
        DrillOp::Vault(n) => vault(rd, &chain, &a, &payer, &wallet, n).await,
        DrillOp::Send { cargo, back } => {
            caravan(rd, &chain, &a, &payer, &wallet, cargo, back).await
        }
        DrillOp::CloseVault => close_vault(rd, &chain, &a, &payer, &wallet).await,
    };
    let code = match &sent {
        Ok(()) => 0,
        Err(e) => {
            for l in e
                .lines()
                .filter(|l| !l.contains("invoke [") && !l.contains("consumed"))
            {
                println!("{l}");
            }
            1
        }
    };
    match status_json(rd, &chain, &a, &payer, &wallet).await {
        Ok(s) => println!("{}", serde_json::to_string_pretty(&s).unwrap_or_default()),
        Err(e) => {
            eprintln!("frontier-stack drill: {e}");
            return 2;
        }
    }
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drill_ops_parse() {
        assert_eq!(parse_op(None, None, None, false), Ok(DrillOp::Status));
        assert_eq!(
            parse_op(Some("vault"), None, None, false),
            Ok(DrillOp::Vault(6))
        );
        assert_eq!(
            parse_op(Some("vault"), Some("4"), None, false),
            Ok(DrillOp::Vault(4))
        );
        assert_eq!(
            parse_op(Some("send"), None, Some("0:100,5:30"), true),
            Ok(DrillOp::Send {
                cargo: [100, 0, 0, 0, 0, 30, 0, 0],
                back: true
            })
        );
        assert!(parse_op(Some("send"), None, None, false).is_err());
        assert!(parse_op(Some("send"), None, Some("9:1"), false).is_err());
        assert!(parse_op(Some("nope"), None, None, false).is_err());
    }

    #[test]
    fn a_local_path_stays_in_its_province() {
        // An all-passable ring-4 province: every tile reaches every other.
        let pc = ring_provinces(4)[0];
        let d = local_dirs(pc.p as i16, pc.q as i16, u64::MAX, 30, 0).expect("a path");
        assert!(!d.is_empty() && d.len() <= 8);
    }
}
