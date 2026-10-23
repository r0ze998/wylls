//! The keeper's caravan duties (S1 stage 1b, `S1-1B-CONTRACT.md` §4.4).
//!
//! | duty | trigger | write | class | role |
//! |---|---|---|---|---|
//! | Deliveries | a caravan past its arrival whose path Provinces resolved past its last slot bell, no raid open on it | SettleCaravan | D | `settle` |
//! | Default raids | an open raid past the raider's window (`RAID_DECIDE_BELLS`) | DefaultRaid: the take home along the kernel's fastest path; a burn when the raiding holding is gone, or from `RAID_BURN_AFTER_BELLS` after the window when no walk reaches it | D | `settle` |
//!
//! Both are paid: SettleCaravan by the caravan's fee, DefaultRaid by the
//! raided caravan's fee (the loot's rent and fee come back when the loot
//! is settled, its `RENT_TO` the keeper).
//!
//! **What it knows.** The caravans come from the feed's CARAVAN_SENT
//! records (a restart re-reads the feed from cursor 0); a CARAVAN_SETTLED
//! ends one. The slots and the resolve cursor are the play duty's Province
//! reads (`ConquestDuty::provs`). Nothing here is trusted over the chain:
//! a Caravan already closed answers absent and is dropped; a write the
//! program refuses is retried by the engine or planned again later.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use fclient::abi::{tag, Class};
use fclient::conquest::{CqEvent, CqLog, LogPlace, LogRun};
use fclient::ix::v2::{self as ix2, DefaultRaidArgs};
use fclient::ix::HoldingRef;
use fclient::ports::{ChainPort, PortResult};
use frontier_abi::v2::layout::player::{citizen as C2, holding as H2};
use frontier_abi::v2::layout::province::caravan_slot as CS;
use frontier_abi::v2::layout::s1::{caravan as CV, place as PL};
use permutation_rules::frontier::caravan::{
    self as kc, caravan_id, CaravanSlot, Land, MAX_CARAVAN_SLOTS, RAID_BURN_AFTER_BELLS,
    RAID_DECIDE_BELLS,
};
use permutation_rules::frontier::geometry::ProvinceCoord;
use solana_address::Address;

use crate::conquest::CqProv;
use crate::engine::{BuildCtx, Engine, Outcome, WriteSpec};
use crate::Tick;

/// Slots between two plans of a write whose accounts did not allow it.
pub const CARAVAN_RETRY_SLOTS: u64 = 8;
/// The keys this duty writes (`ConquestDuty::on_outcome` routes them).
pub const KINDS: [&str; 2] = ["csettle", "draid"];

/// A caravan on the road, from its CARAVAN_SENT.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Moving {
    pub arrive_ts: i64,
    pub dst: LogPlace,
    pub runs: Vec<LogRun>,
}

#[derive(Clone, Debug, Default)]
pub struct CaravanStats {
    pub sent_seen: u64,
    pub settles_planned: u64,
    pub settles_landed: u64,
    pub defaults_planned: u64,
    pub defaults_landed: u64,
    pub defaults_burned: u64,
}

#[derive(Default)]
pub struct CaravanDuty {
    /// `(owner_tag, seq)` → the caravan.
    pub moving: BTreeMap<(u64, u32), Moving>,
    /// The slot id of every known caravan (`caravan_id`).
    by_id: BTreeMap<u64, (u64, u32)>,
    pub stats: CaravanStats,
    done: BTreeSet<String>,
    tried: BTreeMap<String, u64>,
}

fn ru32(d: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_le_bytes(d.get(o..o + 4)?.try_into().ok()?))
}
fn ru64(d: &[u8], o: usize) -> Option<u64> {
    Some(u64::from_le_bytes(d.get(o..o + 8)?.try_into().ok()?))
}
fn ri16(d: &[u8], o: usize) -> Option<i16> {
    Some(i16::from_le_bytes(d.get(o..o + 2)?.try_into().ok()?))
}
fn rkey(d: &[u8], o: usize) -> Option<Address> {
    Some(Address::new_from_array(d.get(o..o + 32)?.try_into().ok()?))
}

/// The caravan slots of a Province's bytes.
pub fn slots(pd: &[u8]) -> Vec<CaravanSlot> {
    (0..MAX_CARAVAN_SLOTS)
        .filter_map(|i| {
            pd.get(CS::at(i)..CS::at(i) + CS::SIZE)
                .and_then(CaravanSlot::decode)
        })
        .collect()
}

/// A Province's masks as the walk reads them.
pub fn land(pd: &[u8]) -> Option<Land> {
    use frontier_abi::layout::province::province as PV;
    Some(Land {
        at: ProvinceCoord::new(ri16(pd, PV::P)? as i32, ri16(pd, PV::Q)? as i32),
        passable: ru64(pd, PV::PASSABLE_MASK)?,
        rough: ru64(pd, PV::ROUGH_MASK)?,
        road: ru64(pd, PV::ROAD_MASK)?,
    })
}

/// The address of a logged place (holding or vault).
fn place_address(t: &Tick<'_>, d: &LogPlace) -> Option<Address> {
    match d.kind {
        PL::KIND_HOLDING => Some(t.addrs.holding(d.p as i32, d.q as i32, d.at)),
        PL::KIND_VAULT => Some(t.addrs.vault(d.p as i32, d.q as i32, d.at)),
        _ => None,
    }
}

impl CaravanDuty {
    /// A record from the feed.
    pub fn on_log(&mut self, log: &CqLog) {
        match &log.event {
            CqEvent::CaravanSent {
                owner_tag,
                seq,
                dst,
                arrive_ts,
                runs,
                ..
            } => {
                self.stats.sent_seen += 1;
                self.by_id
                    .insert(caravan_id(*owner_tag, *seq), (*owner_tag, *seq));
                self.moving.insert(
                    (*owner_tag, *seq),
                    Moving {
                        arrive_ts: *arrive_ts,
                        dst: *dst,
                        runs: runs.clone(),
                    },
                );
            }
            CqEvent::CaravanSettled { owner_tag, seq, .. } => {
                self.moving.remove(&(*owner_tag, *seq));
            }
            _ => {}
        }
    }

    /// Routes the engine's outcome of a caravan write; `false`: not ours.
    pub fn on_outcome(&mut self, key: &str, o: &Outcome) -> bool {
        let kind = key.split(':').next().unwrap_or("");
        if !KINDS.contains(&kind) {
            return false;
        }
        if let Outcome::Landed { .. } = o {
            self.done.insert(key.to_string());
            match kind {
                "csettle" => self.stats.settles_landed += 1,
                _ => self.stats.defaults_landed += 1,
            }
        }
        true
    }

    fn backoff(&mut self, key: &str, slot: u64) -> bool {
        if self
            .tried
            .get(key)
            .is_some_and(|&s| slot < s + CARAVAN_RETRY_SLOTS)
        {
            return true;
        }
        self.tried.insert(key.to_string(), slot);
        false
    }

    /// Plans the deliveries and the default raids over the Provinces the
    /// play duty last read.
    pub async fn plan<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        engine: &mut Engine,
        provs: &BTreeMap<(i16, i16), CqProv>,
        now_bell: u32,
    ) -> PortResult<()> {
        if t.season.program_version < fclient::abi::PROGRAM_VERSION_S1 || !t.cfg.has_role("settle")
        {
            return Ok(());
        }
        // The open raids by caravan id.
        let mut raids: BTreeMap<u64, ((i16, i16), CaravanSlot)> = BTreeMap::new();
        for (pq, v) in provs {
            for s in slots(&v.data) {
                if s.id != 0 && s.raid_open() {
                    raids.insert(s.id, (*pq, s));
                }
            }
        }
        self.settles(t, port, engine, provs, &raids).await?;
        self.default_raids(t, port, engine, provs, &raids, now_bell)
            .await
    }

    async fn settles<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        engine: &mut Engine,
        provs: &BTreeMap<(i16, i16), CqProv>,
        raids: &BTreeMap<u64, ((i16, i16), CaravanSlot)>,
    ) -> PortResult<()> {
        let due: Vec<((u64, u32), Moving)> = self
            .moving
            .iter()
            .filter(|(k, m)| {
                t.now >= m.arrive_ts
                    && !raids.contains_key(&caravan_id(k.0, k.1))
                    && m.runs.iter().all(|r| {
                        provs
                            .get(&(r.p, r.q))
                            .is_some_and(|v| v.rn > r.first_bell + r.n as u32 - 1)
                    })
            })
            .map(|(k, m)| (*k, m.clone()))
            .collect();
        for ((tag_, seq), m) in due {
            let key = format!("csettle:{tag_:x}:{seq}");
            if self.done.contains(&key) || engine.is_pending(&key) || self.backoff(&key, t.slot) {
                continue;
            }
            let caravan = t.addrs.caravan(tag_, seq);
            let got = port.accounts(&[caravan], 0).await?;
            let Some(cd) = got
                .into_iter()
                .next()
                .flatten()
                .filter(|a| a.owner == t.addrs.program && a.data.len() == CV::SIZE)
                .map(|a| a.data)
            else {
                // Settled already (its record may not have reached us).
                self.moving.remove(&(tag_, seq));
                continue;
            };
            if cd[CV::STATE] != CV::STATE_MOVING {
                continue;
            }
            let (Some(rent_to), Some(dst)) = (rkey(&cd, CV::RENT_TO), place_address(t, &m.dst))
            else {
                continue;
            };
            let n = (cd[CV::N_PROV] as usize).min(4);
            let path: Vec<(i16, i16)> = (0..n)
                .filter_map(|i| {
                    Some((ri16(&cd, CV::province(i))?, ri16(&cd, CV::province(i) + 2)?))
                })
                .collect();
            let (a, ben) = (t.addrs.clone(), t.cfg.beneficiary);
            if engine.ensure(
                WriteSpec {
                    key,
                    kind: "csettle",
                    tag: tag::SETTLE_CARAVAN,
                    class: Class::D,
                    bell: None,
                    region: None,
                    build: Arc::new(move |c: &BuildCtx| {
                        vec![ix2::settle_caravan(
                            &a, c.payer, caravan, dst, ben, rent_to, &path,
                        )]
                    }),
                    deadline_slot: None,
                    not_before_slot: t.slot,
                    fixed_payer: None,
                },
                t.slot,
            ) {
                self.stats.settles_planned += 1;
            }
        }
        Ok(())
    }

    async fn default_raids<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        engine: &mut Engine,
        provs: &BTreeMap<(i16, i16), CqProv>,
        raids: &BTreeMap<u64, ((i16, i16), CaravanSlot)>,
        now_bell: u32,
    ) -> PortResult<()> {
        for (id, (pq, slot)) in raids {
            let raid_bell = slot.first_bell + slot.raid_off as u32;
            let window = raid_bell + RAID_DECIDE_BELLS;
            if now_bell <= window {
                continue;
            }
            let Some(&(tag_, seq)) = self.by_id.get(id) else {
                continue;
            };
            let key = format!("draid:{tag_:x}:{seq}:{raid_bell}");
            if self.done.contains(&key) || engine.is_pending(&key) || self.backoff(&key, t.slot) {
                continue;
            }
            let Some(parts) = frontier_abi::addr::split_host_id(slot.raider) else {
                continue;
            };
            let home = HoldingRef {
                p: parts.province.p as i16,
                q: parts.province.q as i16,
                site: parts.site,
            };
            let caravan = t.addrs.caravan(tag_, seq);
            let got = port.accounts(&[home.address(t.addrs), caravan], 0).await?;
            let program = t.addrs.program;
            let hd = got[0]
                .as_ref()
                .filter(|a| a.owner == program && a.data.len() == H2::SIZE)
                .map(|a| a.data.clone());
            let Some(cd) = got[1]
                .as_ref()
                .filter(|a| a.owner == program && a.data.len() == CV::SIZE)
                .map(|a| a.data.clone())
            else {
                continue;
            };
            let live = hd.as_ref().filter(|d| {
                d[H2::GEN] == parts.gen
                    && matches!(d[H2::STATE], H2::STATE_PROVISIONAL | H2::STATE_FINAL)
            });
            // The raider's Citizen: the holding's owner; with the holding
            // gone any Citizen serves the burn (the raided caravan's).
            let Some(raider_citizen) = live
                .and_then(|d| rkey(d, H2::OWNER_CITIZEN))
                .or_else(|| rkey(&cd, CV::OWNER_CITIZEN))
            else {
                continue;
            };
            let raid_tile = slot.tiles[slot.raid_off as usize];
            let raid_pc = ProvinceCoord::new(pq.0 as i32, pq.1 as i32);
            let (mut steps, mut dirs_path, mut later, mut loot_seq) =
                (0u8, [0u8; 12], vec![], 0u32);
            if let Some(hd) = live {
                let home_pc = ProvinceCoord::new(home.p as i32, home.q as i32);
                let lands: Vec<Land> = provs.values().filter_map(|v| land(&v.data)).collect();
                match kc::fastest_path((raid_pc, raid_tile), (home_pc, hd[H2::TILE]), &lands) {
                    Some((dirs, order)) if !dirs.is_empty() => {
                        steps = dirs.len() as u8;
                        dirs_path = kc::pack(&dirs).unwrap_or([0; 12]);
                        later = order[1..]
                            .iter()
                            .map(|pc| (pc.p as i16, pc.q as i16))
                            .collect();
                    }
                    Some(_) => {}
                    None if now_bell > window + RAID_BURN_AFTER_BELLS => {
                        self.stats.defaults_burned += 1;
                    }
                    // No walk home yet known: wait for the burn delay.
                    None => continue,
                }
                let citizen = port.accounts(&[raider_citizen], 0).await?;
                loot_seq = citizen[0]
                    .as_ref()
                    .and_then(|a| ru32(&a.data, C2::CARAVANS))
                    .unwrap_or(0);
            } else {
                self.stats.defaults_burned += 1;
            }
            let args = DefaultRaidArgs {
                caravan,
                raid: *pq,
                raider_holding: home,
                raider_citizen,
                loot_seq,
                steps,
                path: dirs_path,
                beneficiary: t.cfg.beneficiary,
                provinces: later,
            };
            let a = t.addrs.clone();
            if engine.ensure(
                WriteSpec {
                    key,
                    kind: "draid",
                    tag: tag::DEFAULT_RAID,
                    class: Class::D,
                    bell: Some(raid_bell),
                    region: None,
                    build: Arc::new(move |c: &BuildCtx| {
                        vec![ix2::default_raid(&a, c.payer, &args)]
                    }),
                    deadline_slot: None,
                    not_before_slot: t.slot,
                    fixed_payer: None,
                },
                t.slot,
            ) {
                self.stats.defaults_planned += 1;
            }
        }
        Ok(())
    }

    /// The status block.
    pub fn status(&self) -> serde_json::Value {
        serde_json::json!({
            "moving": self.moving.len(),
            "sentSeen": self.stats.sent_seen,
            "settlesPlanned": self.stats.settles_planned,
            "settlesLanded": self.stats.settles_landed,
            "defaultsPlanned": self.stats.defaults_planned,
            "defaultsLanded": self.stats.defaults_landed,
            "defaultsBurned": self.stats.defaults_burned,
        })
    }
}
