//! `frontier-bots --conquest` against the MC herald fixture (MC contract
//! v1.3 §8.6, §11 CQ2-F; `cq_*`): the fleet reads the herald's files of a
//! Frontier-7 epoch (a synthetic fixture now; the recorded one is CQ3-E's),
//! plans once for the faction, and its bots act in the relay's sponsored
//! shapes: the lead host's owner sounds the horn (DeclareSiege 0xA0 with
//! the §5.5 account list), a bot with no host at home musters for the
//! plan, outposts are filed (0xA3), and the report carries the §8.6
//! `conquest` and `activity` sections.

use std::collections::BTreeMap;
use std::sync::Mutex;

use fclient::ports::PortError;
use fclient::{Address, Hash, Keypair, Signer};
use frontier_abi::v2::layout::player::{citizen as C2, holding as H2};
use frontier_abi::v2::prologue::accounts_of;
use frontier_abi::v2::tags::Ix as V2;
use frontier_agents::cqfixture::{self, fixture, CqFixture, BELL, END_BELL, GENESIS_TS};
use frontier_agents::keys;
use frontier_agents::obs::{b64, b64_encode, Overview, OverviewRec};
use frontier_agents::profile::{AgentSpec, Arch};
use frontier_bots::bot::{ClockSource, Config, Shared};
use frontier_bots::conquest::{Conquest, CqConfig};
use frontier_bots::fleet::Fleet;
use frontier_bots::ports::{Answer, HeraldPort, NoDirect, RelayPort};
use serde_json::{json, Value};

const SEED: u64 = 11;

/// What the relay saw: (tag, accounts, data) of every sponsored send.
#[derive(Default)]
struct Seen {
    sends: Vec<(u8, usize, Vec<u8>)>,
}

struct MockRelay {
    fee_payer: Keypair,
    seen: Mutex<Seen>,
    /// DeclareSiege refusals the mock returns (code), if any.
    refuse_declare: Option<&'static str>,
}

impl MockRelay {
    fn new() -> MockRelay {
        MockRelay {
            fee_payer: Keypair::new_from_array([0xFE; 32]),
            seen: Mutex::new(Seen::default()),
            refuse_declare: None,
        }
    }
}

impl RelayPort for MockRelay {
    async fn get(&self, path: &str) -> Result<Answer, PortError> {
        assert!(path.starts_with("/f/relay"), "{path}");
        Ok(Answer::new(
            200,
            json!({
                "feePayer": self.fee_payer.pubkey().to_string(),
                "blockhash": Hash::new_from_array([7; 32]).to_string(),
                "lastValidBlockHeight": 1_000,
            }),
        ))
    }

    async fn post(&self, path: &str, b: &Value) -> Result<Answer, PortError> {
        if path == "/f/nudge" {
            return Ok(Answer::new(200, json!({"ok": true})));
        }
        assert_eq!(path, "/f/relay", "{path}");
        let wire = b64(b["tx"].as_str().unwrap()).unwrap();
        let t = fclient::tx::from_wire(&wire).unwrap();
        let msg = &t.message;
        let ix = msg.instructions.last().unwrap();
        let tg = ix.data[0];
        self.seen
            .lock()
            .unwrap()
            .sends
            .push((tg, ix.accounts.len(), ix.data.clone()));
        if tg == 0xA0 {
            if let Some(code) = self.refuse_declare {
                return Ok(Answer::new(400, json!({"ok": false, "code": code})));
            }
        }
        Ok(Answer::new(200, json!({"ok": true, "signature": "s"})))
    }
}

/// The herald as a map of the files it would serve.
struct MapHerald {
    files: BTreeMap<String, Vec<u8>>,
    /// Every path asked for, in order.
    asked: Mutex<Vec<String>>,
}

impl HeraldPort for MapHerald {
    async fn get(&self, path: &str) -> Result<Option<Vec<u8>>, PortError> {
        self.asked.lock().unwrap().push(path.to_string());
        let p = path.trim_start_matches('/');
        let key = if p.ends_with(".bin") || p.ends_with(".json") {
            p.to_string()
        } else {
            format!("{p}.json")
        };
        Ok(self.files.get(&key).cloned())
    }
}

fn wallet(seed: u64, i: u32) -> Address {
    keys::wallet(seed, i).pubkey()
}

/// The fixture's files for the bots: `/h/season` (an MC season at the
/// fixture's epoch), `/h/overview/{ring}/latest.bin`, every province at the
/// epoch's last bell and `latest`, and `/h/me/{wallet}` of the fleet
/// (faction 0's wallets with a reserve to muster from; the victim holds the
/// fixture's `home` site, so the target's owner Citizen is a fleet wallet).
fn herald_files(f: &CqFixture, seed: u64, victim_at: (i16, i16, u8)) -> BTreeMap<String, Vec<u8>> {
    let m1 = frontier_agents::fixture::world();
    let mut files = BTreeMap::new();
    // Season: M1's file with the MC season's version, times and id.
    let mut sj: Value = serde_json::from_slice(&m1.files["h/season.json"]).unwrap();
    let mut sb = b64(sj["bytes_b64"].as_str().unwrap()).unwrap();
    use fclient::abi::layout::season as s;
    // The chained header's season id (offset 8, every account).
    sb[8..16].copy_from_slice(&cqfixture::SEASON_ID.to_le_bytes());
    sb[s::PROGRAM_VERSION..s::PROGRAM_VERSION + 2].copy_from_slice(&2u16.to_le_bytes());
    sb[s::GENESIS_TS..s::GENESIS_TS + 8].copy_from_slice(&GENESIS_TS.to_le_bytes());
    sb[s::END_BELL..s::END_BELL + 4].copy_from_slice(&END_BELL.to_le_bytes());
    sb[s::JOIN_CLOSE_BELL..s::JOIN_CLOSE_BELL + 4].copy_from_slice(&(6 * 144u32).to_le_bytes());
    // Frontier-7's conquest block at 896 (a Season v2's tail).
    let cq = frontier_abi::v2::presets::FRONTIER_7.to_bytes();
    let o = frontier_abi::v2::presets::SEASON_CQ_OFFSET;
    sb[o..o + cq.len()].copy_from_slice(&cq);
    sj["bytes_b64"] = json!(b64_encode(&sb));
    sj["season"] = json!(cqfixture::SEASON_ID.to_string());
    sj["genesisTs"] = json!(GENESIS_TS);
    sj["latestUnix"] = json!(cqfixture::ts(BELL) + 100);
    sj["rMax"] = json!(16);
    sj["rings"] = json!((0..=cqfixture::RINGS)
        .map(|d| json!({"d": d, "seed": hex::encode(cqfixture::ring_seed(d))}))
        .collect::<Vec<_>>());
    files.insert(
        "h/season.json".to_string(),
        serde_json::to_vec(&sj).unwrap(),
    );
    // Provinces and overviews.
    let mut by_ring: BTreeMap<u32, Vec<OverviewRec>> = BTreeMap::new();
    for (&(p, q), bytes) in &f.epoch.provinces {
        let pj = json!({
            "v": 1, "key": format!("pv:{p},{q}"), "bell": BELL - 1, "slot": 1,
            "bytes": b64_encode(bytes),
        });
        let body = serde_json::to_vec(&pj).unwrap();
        files.insert(
            format!("h/province/{p},{q}/{}.json", BELL - 1),
            body.clone(),
        );
        files.insert(format!("h/province/{p},{q}/latest.json"), body);
        let ring =
            permutation_rules::frontier::geometry::ProvinceCoord::new(p as i32, q as i32).ring();
        by_ring.entry(ring).or_default().push(OverviewRec {
            p,
            q,
            owners: [7; 12],
            sites: [0; 12],
            hosts: [0; 7],
            clash: false,
            dormant: false,
            opened: true,
            resolved_next: BELL,
        });
    }
    for (ring, mut recs) in by_ring {
        recs.sort_by_key(|r| (r.p, r.q));
        let o = Overview {
            season: cqfixture::SEASON_ID,
            ring: ring as u16,
            bell: BELL - 1,
            slot: 1,
            provinces: recs,
        };
        files.insert(format!("h/overview/{ring}/latest.bin"), o.encode());
    }
    // The fleet: wallets 0..=FLEET (faction 0) and the victim.
    let addrs =
        fclient::addr::Addresses::new(frontier_agents::fixture::program(), cqfixture::SEASON_ID);
    for w in &f.epoch.wallets {
        let key = wallet(seed, w.agent);
        let mut c = w.citizen.clone().unwrap();
        c[C2::WALLET..C2::WALLET + 32].copy_from_slice(key.as_ref());
        let mut hs: Vec<Vec<u8>> = w.holdings.clone();
        for h in &mut hs {
            // A reserve of every unit (whole troops) to muster from.
            for u in 0..8 {
                let o = H2::RESERVE + u * 4;
                h[o..o + 4].copy_from_slice(&3_000u32.to_le_bytes());
            }
        }
        if w.agent == cqfixture::VICTIM {
            // The victim's first holding is the site the test aims at.
            let r = victim_at;
            hs[0][H2::P..H2::P + 2].copy_from_slice(&r.0.to_le_bytes());
            hs[0][H2::Q..H2::Q + 2].copy_from_slice(&r.1.to_le_bytes());
            hs[0][H2::SITE] = r.2;
        }
        let holdings: Vec<Value> = hs
            .iter()
            .map(|h| {
                let p = i16::from_le_bytes([h[H2::P], h[H2::P + 1]]);
                let q = i16::from_le_bytes([h[H2::Q], h[H2::Q + 1]]);
                json!({"address": addrs.holding(p as i32, q as i32, h[H2::SITE]).to_string(),
                       "bytes_b64": b64_encode(h)})
            })
            .collect();
        let me = json!({
            "v": 1, "wallet": key.to_string(),
            "citizen": {"address": addrs.citizen(&key).to_string(), "bytes_b64": b64_encode(&c)},
            "holdings": holdings, "slots": [],
            "quota": {"left": 38, "resetsAt": GENESIS_TS + 86_400},
        });
        files.insert(format!("h/me/{key}.json"), serde_json::to_vec(&me).unwrap());
    }
    files
}

fn roster() -> Vec<AgentSpec> {
    (0..=cqfixture::VICTIM)
        .map(|i| AgentSpec {
            index: i,
            arch: Arch::Bot,
            faction: if i == cqfixture::VICTIM { 1 } else { 0 },
            join_day: 0,
            join_bell: 0,
            persona: None,
        })
        .collect()
}

type Run = (
    Fleet<MapHerald, MockRelay, NoDirect>,
    frontier_bots::report::Report,
);

async fn run(relay: MockRelay, cfg: CqConfig) -> Run {
    run_seed(SEED, fixture().roles.home, relay, cfg).await
}

/// One step of every bot at the fixture's epoch, with the fleet seed and
/// the site the victim wallet's holding is moved to.
async fn run_seed(seed: u64, victim_at: (i16, i16, u8), relay: MockRelay, cfg: CqConfig) -> Run {
    let f = fixture();
    let sh = Shared::new(
        MapHerald {
            files: herald_files(&f, seed, victim_at),
            asked: Mutex::new(vec![]),
        },
        relay,
        None::<NoDirect>,
        Config::new(seed),
        // Past the epoch's first minutes: the bots read epoch bell 300.
        ClockSource::fixed(cqfixture::ts(BELL) + 200),
    );
    let r = roster();
    let sh = sh.with_conquest(Conquest::new(seed, &r, cfg));
    let mut fleet = Fleet::new(sh, &r);
    fleet.step_all(false, 4).await;
    let report = fleet.shared.report.lock().unwrap().clone();
    (fleet, report)
}

#[tokio::test]
async fn cq_fleet_plans_and_the_lead_hosts_owner_sounds_the_horn() {
    let (fleet, report) = run(MockRelay::new(), CqConfig { personas_per: 0 }).await;
    let seen = fleet.shared.relay.seen.lock().unwrap();
    let tags: Vec<u8> = seen.sends.iter().map(|s| s.0).collect();
    // One epoch computed from the files, no error reading them.
    assert_eq!(report.cq.epochs, 1, "errors: {:?}", report.errors);
    assert_eq!(report.cq.epochs_unready, 0, "{:?}", report.errors);
    assert!(report.cq.enabled);
    // Faction 0 has a campaign (the occupation slot's home or a keep).
    assert!(
        report.cq.campaigns.keys().any(|k| k.0 == 0),
        "no campaign: {:?}",
        report.cq.campaigns
    );
    // The horn: DeclareSiege (0xA0) in the §5.5 account list, once, from
    // the lead host's owner (wallet 0).
    let declares: Vec<_> = seen.sends.iter().filter(|s| s.0 == 0xA0).collect();
    assert_eq!(
        declares.len(),
        1,
        "tags {tags:?} skipped {:?}",
        report.cq.skipped
    );
    let groups = accounts_of(V2::DeclareSiege);
    let max: usize = groups.iter().map(|g| g.specs.len() * g.max as usize).sum();
    let min: usize = groups.iter().map(|g| g.specs.len() * g.min as usize).sum();
    // The relay adds the fee payer's three budget instructions' accounts
    // only to the transaction; the instruction's own list is §5.5's.
    assert!(
        (min..=max).contains(&declares[0].1),
        "{} accounts, want {min}..={max}",
        declares[0].1
    );
    assert_eq!(declares[0].2[0], 0xA0);
    // A bot with no host at home musters for the plan (Muster tag).
    assert!(
        tags.contains(&fclient::abi::tag::MUSTER),
        "no Muster for the plan's dispatch: {tags:?}"
    );
    // The report: ok declare counted, rates per game day present.
    let j = report.to_json();
    assert_eq!(j["conquest"]["own"]["declare_siege"]["ok"], 1);
    assert_eq!(j["conquest"]["sieges"]["declared"], 1);
    assert!(!j["activity"]["declares_per_bot_day"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(!j["conquest"]["campaigns"].as_array().unwrap().is_empty());
}

/// The local checks and the planner run once per epoch: a second step of
/// every bot in the same epoch sends no second horn (the bot already
/// decided for it), and the hub's plan is the one the herald files give.
#[tokio::test]
async fn cq_an_epoch_is_decided_once_per_bot() {
    let f = fixture();
    let sh = Shared::new(
        MapHerald {
            files: herald_files(&f, SEED, f.roles.home),
            asked: Mutex::new(vec![]),
        },
        MockRelay::new(),
        None::<NoDirect>,
        Config::new(SEED),
        ClockSource::fixed(cqfixture::ts(BELL) + 200),
    );
    let r = roster();
    let sh = sh.with_conquest(Conquest::new(SEED, &r, CqConfig { personas_per: 0 }));
    let mut fleet = Fleet::new(sh, &r);
    fleet.step_all(false, 4).await;
    let first = fleet.shared.relay.seen.lock().unwrap().sends.len();
    fleet.step_all(false, 4).await;
    let second: Vec<u8> = fleet.shared.relay.seen.lock().unwrap().sends[first..]
        .iter()
        .map(|s| s.0)
        .collect();
    assert!(
        !second.contains(&0xA0),
        "the horn was sounded twice in one epoch: {second:?}"
    );
    assert_eq!(fleet.shared.report.lock().unwrap().cq.epochs, 1);
}

/// A refused DeclareSiege is counted by its code in `refused_by_code`
/// (criterion 13's ratio reads it) and is not a declared siege.
#[tokio::test]
async fn cq_a_refused_horn_is_counted_by_code() {
    let mut relay = MockRelay::new();
    relay.refuse_declare = Some("NotLead");
    let (_fleet, report) = run(relay, CqConfig { personas_per: 0 }).await;
    let j = report.to_json();
    assert_eq!(j["conquest"]["sieges"]["declared"], 0);
    assert_eq!(j["conquest"]["sieges"]["refused_by_code"]["NotLead"], 1);
}

/// The conquest personas are dealt to bots with no M1 persona, each at
/// most max(1, bots / 100), deterministically, and assigned bots carry
/// them.
#[tokio::test]
async fn cq_personas_are_dealt_within_one_percent() {
    let r: Vec<AgentSpec> = (0..1_000u32)
        .map(|i| AgentSpec {
            index: i,
            arch: Arch::Bot,
            faction: (i % 6) as u8,
            join_day: 0,
            join_bell: 0,
            persona: (i % 25 == 0).then_some(frontier_agents::Persona::Spammer),
        })
        .collect();
    let a = Conquest::new(SEED, &r, CqConfig { personas_per: 50 });
    assert_eq!(a.cfg.personas_per, 10, "capped at 1% of 1,000");
    assert_eq!(a.personas().len(), 19 * 10);
    for i in a.personas().keys() {
        assert!(r[*i as usize].persona.is_none());
    }
    let mut per: BTreeMap<_, u32> = BTreeMap::new();
    for p in a.personas().values() {
        *per.entry(p.name()).or_default() += 1;
    }
    assert!(per.values().all(|&n| n == 10));
    let b = Conquest::new(SEED, &r, CqConfig { personas_per: 50 });
    assert_eq!(a.personas(), b.personas());
    let mut rep = frontier_bots::report::CqReport::default();
    a.seed_report(&mut rep);
    assert!(rep.enabled && rep.personas_assigned.len() == 19);
    let sh: Shared<MapHerald, MockRelay, NoDirect> = Shared::new(
        MapHerald {
            files: BTreeMap::new(),
            asked: Mutex::new(vec![]),
        },
        MockRelay::new(),
        None,
        Config::new(SEED),
        ClockSource::fixed(0),
    )
    .with_conquest(a);
    let fleet = Fleet::new(sh, &r);
    let with = fleet.bots.iter().filter(|b| b.cq.persona.is_some()).count();
    assert_eq!(with, 190);
}

/// The v2 budgets of the sponsored shapes: the conquest tags carry the
/// v2 table's rows (the bots' `--conquest` Config).
#[test]
fn cq_budgets_cover_the_conquest_tags() {
    let b = frontier_bots::txb::budgets_v2();
    for ix in [V2::DeclareSiege, V2::FileOutpost, V2::RetireHost] {
        let row = frontier_abi::v2::budgets::budget(ix);
        assert_eq!(b.get(ix.tag()).cu_limit, row.cu_limit, "{}", ix.name());
        assert_eq!(
            b.get(ix.tag()).loaded_limit,
            frontier_abi::v2::budgets::loaded_limit(ix),
            "{}",
            ix.name()
        );
    }
    // M1's rows stay for the instructions MC does not change.
    let v1 = frontier_bots::txb::budgets();
    assert_eq!(
        b.get(fclient::abi::tag::JOIN).cu_limit,
        v1.get(fclient::abi::tag::JOIN).cu_limit
    );
}

/// What an epoch costs the herald: the hub reads each opened province once,
/// each joined wallet's `/h/me` once and a handful of shared files, however
/// many bots ask (the hub computes the epoch once, the bots reuse it).
#[tokio::test]
async fn cq_an_epoch_reads_each_file_once() {
    let f = fixture();
    let (fleet, report) = run(MockRelay::new(), CqConfig { personas_per: 0 }).await;
    assert_eq!(report.cq.epochs, 1);
    let asked = fleet.shared.herald.asked.lock().unwrap().clone();
    let prov: Vec<&String> = asked
        .iter()
        .filter(|p| p.starts_with("/h/province/") && p.ends_with(&format!("/{}", BELL - 1)))
        .collect();
    // One per opened province at the epoch's last bell.
    assert_eq!(prov.len(), f.epoch.provinces.len(), "{} files", prov.len());
    let mut uniq = prov.clone();
    uniq.sort();
    uniq.dedup();
    assert_eq!(uniq.len(), prov.len());
    eprintln!(
        "cq epoch reads: {} province files, {} /h/me reads (bots' own observes included), {} total GETs for {} bots",
        prov.len(),
        asked.iter().filter(|p| p.starts_with("/h/me/")).count(),
        asked.len(),
        roster().len()
    );
}

/// A conquest persona runs the whole path: the fleet deals it a wallet, the
/// persona's action goes out as the relay's sponsored DeclareSiege, the
/// program's refusal comes back, and the report's verdict reads it
/// (criterion 13). Here `siege_heartland` is dealt the wallet whose host
/// stands on the fixture's heartland home.
#[tokio::test]
async fn cq_a_persona_declares_and_the_report_judges_its_refusal() {
    let heart_wallet = 3u32;
    let seed = (0..5_000u64)
        .find(|&s| {
            frontier_agents::cqpersona::assign(s, roster().len(), &|_| false, 1)
                .get(&(heart_wallet as usize))
                == Some(&frontier_agents::cqpersona::CqPersona::SiegeHeartland)
        })
        .expect("a seed that deals siege_heartland to wallet 3");
    let mut relay = MockRelay::new();
    relay.refuse_declare = Some("Heartland");
    let (fleet, report) = run_seed(
        seed,
        fixture().roles.heartland,
        relay,
        CqConfig { personas_per: 1 },
    )
    .await;
    let sent: Vec<u8> = fleet
        .shared
        .relay
        .seen
        .lock()
        .unwrap()
        .sends
        .iter()
        .map(|s| s.0)
        .collect();
    assert!(sent.contains(&0xA0), "the persona declared: {sent:?}");
    let o: Vec<_> = report
        .cq
        .outcomes
        .iter()
        .filter(|o| o.bot == heart_wallet)
        .collect();
    assert_eq!(
        o.len(),
        1,
        "{:?} skipped {:?}",
        report.cq.outcomes,
        report.cq.skipped
    );
    assert_eq!(
        o[0].persona,
        Some(frontier_agents::cqpersona::CqPersona::SiegeHeartland)
    );
    assert_eq!(o[0].code.as_deref(), Some("Heartland"));
    assert_eq!(
        report
            .cq
            .verdict(frontier_agents::cqpersona::CqPersona::SiegeHeartland),
        frontier_bots::report::Verdict::Observed
    );
    let j = report.to_json();
    let row = j["conquest"]["personas"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["persona"] == "siege_heartland")
        .unwrap();
    assert_eq!(row["verdict"], "observed");
    assert_eq!(row["results"]["declare_siege:Heartland"], 1);
    assert_eq!(row["bots"], 1);
}
