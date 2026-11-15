//! Explicit, bounded RPC observations. Never a fold input or an action authority.
use base64::{engine::general_purpose::STANDARD, Engine};
use fclient::{
    addr::Addresses,
    snapshot::{Snapshot, SnapshotSource},
};
use frontier_abi::{
    addr::AddrCtx,
    bytes::rd_u16,
    world_index::{holding as wh, land as wl, WideCoord, WideHolding, WideProvince, WorldId},
};
use serde_json::{json, Value};
use solana_address::Address;
use std::{collections::HashMap, sync::Arc, time::Duration};

pub const RESPONSE_CAP: usize = 32_768;
pub const DATA_CAP: usize = 9_000;
pub const TIMEOUT: Duration = Duration::from_secs(3);
pub type Fault = &'static str;

struct BoundedSource(fclient::rpc::RpcClient);
impl fclient::snapshot::SnapshotPort for BoundedSource {
    async fn snapshot(
        &self,
        keys: &[Address],
        with_rent: bool,
        min_slot: u64,
    ) -> Result<Snapshot, fclient::snapshot::SnapshotError> {
        use fclient::snapshot::SnapshotError as E;
        if keys.len() != 4 || with_rent {
            return Err(E::Unsupported);
        }
        let mut addresses: Vec<String> = keys.iter().map(ToString::to_string).collect();
        addresses.push(fclient::addr::clock_sysvar().to_string());
        let v = self
            .0
            .call(
                "getMultipleAccounts",
                json!([addresses,
            {"encoding":"base64", "commitment":"confirmed", "minContextSlot":min_slot}]),
            )
            .await
            .map_err(|_| E::Rpc("unavailable".into()))?;
        let entries = v["value"].as_array().ok_or(E::Malformed("entries"))?;
        if entries.len() != 5
            || entries.iter().any(|a| {
                a["executable"].as_bool() != Some(false) || a["data"][1].as_str() != Some("base64")
            })
        {
            return Err(E::Malformed("account metadata"));
        }
        fclient::snapshot::parse_snapshot_response(&v, keys, false, min_slot)
    }
}

pub fn parse_query(raw: &str) -> Result<HashMap<String, String>, Fault> {
    if raw.len() > 256 {
        return Err("BadSelection");
    }
    let mut q = HashMap::new();
    for field in raw.split('&') {
        let (k, v) = field.split_once('=').ok_or("BadSelection")?;
        if q.insert(k.to_owned(), v.to_owned()).is_some() {
            return Err("DuplicateField");
        }
    }
    Selection::parse(&q)?;
    Ok(q)
}

pub struct Live {
    addresses: Addresses,
    world: WorldId,
    ruleset: [u8; 32],
    minimum: u64,
    source: Arc<dyn SnapshotSource>,
}

/// Literal IPv4 loopback only, no DNS, credentials, path, query or fragments.
pub fn loopback_rpc(url: &str) -> bool {
    url.strip_prefix("http://127.0.0.1:")
        .and_then(|s| s.parse::<u16>().ok())
        .is_some_and(|p| p != 0)
}

impl Live {
    pub fn new(
        program: Address,
        season: u64,
        ruleset: [u8; 32],
        minimum: u64,
        source: Arc<dyn SnapshotSource>,
    ) -> Result<Self, Fault> {
        if minimum == 0 || ruleset == [0; 32] {
            return Err("UnpinnedObservation");
        }
        let addresses = Addresses::new(program, season);
        let world =
            WorldId::derive_legacy_season(&addresses.season.to_bytes(), &program.to_bytes())
                .map_err(|_| "BadWorld")?;
        Ok(Self {
            addresses,
            world,
            ruleset,
            minimum,
            source,
        })
    }
    pub fn rpc(
        program: Address,
        season: u64,
        ruleset: [u8; 32],
        minimum: u64,
        url: &str,
    ) -> Result<Self, Fault> {
        if !loopback_rpc(url) {
            return Err("LoopbackRpcRequired");
        }
        Self::new(
            program,
            season,
            ruleset,
            minimum,
            Arc::new(BoundedSource(
                fclient::rpc::RpcClient::new_with_response_limit(url, RESPONSE_CAP),
            )),
        )
    }
    /// Exactly one read. No discovery, retries, secondary reads or persistence.
    pub async fn observe(&self, query: &HashMap<String, String>) -> Result<Value, Fault> {
        let request = Selection::parse(query)?;
        let min = request.min_slot.max(self.minimum);
        let ctx = AddrCtx {
            program: self.addresses.program.to_bytes(),
            season: self.addresses.season.to_bytes(),
        };
        let keys = [
            Address::new_from_array(wh::holding_address(&ctx, request.coord, request.site)),
            Address::new_from_array(wl::province_address(&ctx, request.coord)),
            request.citizen,
            self.addresses.season,
        ];
        let snapshot = tokio::time::timeout(TIMEOUT, self.source.snapshot_boxed(&keys, false, min))
            .await
            .map_err(|_| "ObservationTimeout")?
            .map_err(|_| "ObservationUnavailable")?;
        self.checked(&request, &keys, min, &snapshot)
    }
    fn checked(
        &self,
        r: &Selection,
        keys: &[Address; 4],
        min: u64,
        s: &Snapshot,
    ) -> Result<Value, Fault> {
        if !s.meta().verify(min, Some(&s.clock()), None, s.accounts())
            || s.meta().context_slot() < min
            || s.accounts().len() != 4
        {
            return Err("IncoherentObservation");
        }
        let mut data = Vec::new();
        let mut total = 0usize;
        for key in keys {
            let a = s
                .accounts()
                .get(key)
                .and_then(Option::as_ref)
                .ok_or("MissingAccount")?;
            total = total.checked_add(a.data.len()).ok_or("ReadTooLarge")?;
            if total > DATA_CAP {
                return Err("ReadTooLarge");
            }
            if a.owner != self.addresses.program || a.executable {
                return Err("ForeignAccount");
            }
            data.push(a.data.as_slice());
        }
        let h = WideHolding::read(data[0]).map_err(|_| "BadHolding")?;
        let p = WideProvince::read(data[1]).map_err(|_| "BadProvince")?;
        if h.world != self.world
            || p.world != self.world
            || h.season_id != self.addresses.season_id
            || p.season_id != self.addresses.season_id
            || h.coord != r.coord
            || p.coord != r.coord
            || h.site != r.site
            || h.gen != r.gen
            || h.owner_citizen != r.citizen.to_bytes()
        {
            return Err("IdentityMismatch");
        }
        use frontier_abi::v2::layout::{
            player::citizen as C,
            province::{province as P, site as M},
            world::season as S,
        };
        if data[2].len() != C::SIZE
            || rd_u16(data[2], C::LAYOUT_VERSION) != Some(2)
            || data[3].len() != S::SIZE
            || rd_u16(data[3], S::LAYOUT_VERSION) != Some(2)
        {
            return Err("UnsupportedLayout");
        }
        let citizen = fclient::decode::Citizen::decode(data[2]).map_err(|_| "BadCitizen")?;
        let season = fclient::decode::Season::decode(data[3]).map_err(|_| "BadSeason")?;
        if citizen.h.season_id != self.addresses.season_id
            || self.addresses.citizen_of(data[2]) != Some(r.citizen)
            || wh::ref_of(data[2], h.slot).map_err(|_| "BadCitizenSlot")? != wh::WIDE_SLOT_MARKER
        {
            return Err("CitizenBindingMismatch");
        }
        // Only the known S1 wide version, never an arbitrary operator-supplied version.
        if season.h.season_id != self.addresses.season_id
            || season.bump != self.addresses.bump
            || season.program_version != 0x4004
            || season.ruleset_hash != self.ruleset
            || rd_u16(data[3], S::RULES_VERSION)
                != Some(frontier_abi::v2::presets::RULES_VERSION_S1)
        {
            return Err("UnsupportedDeployment");
        }
        let mirror = P::site(r.site as usize);
        if data[1][mirror + M::GEN] != r.gen || data[1][mirror + M::STATE] != M::STATE_HOLDING {
            return Err("ProvinceGenerationMismatch");
        }
        let accounts: Vec<Value> = keys.iter().zip(["holding", "province", "citizen", "season"]).map(|(key, kind)| {
            let a = s.accounts()[key].as_ref().expect("checked presence");
            json!({"kind": kind, "address": key.to_string(), "owner": a.owner.to_string(),
                "lamports": a.lamports.to_string(), "executable": false, "data_b64": STANDARD.encode(&a.data)})
        }).collect();
        Ok(
            json!({"v": 1, "kind": "wide-village-rpc-observation", "label": "RPC observed at slot",
            "observed_slot": s.meta().context_slot().to_string(), "min_slot": min.to_string(),
            "program": self.addresses.program.to_string(), "season": self.addresses.season_id.to_string(),
            "world": hex::encode(self.world.as_bytes()), "ruleset_hash": hex::encode(self.ruleset),
            "program_version": 0x4004, "citizen": r.citizen.to_string(), "p": r.coord.p().to_string(),
            "q": r.coord.q().to_string(), "site": r.site, "gen": r.gen, "slot": h.slot,
            "current": false, "authenticated": false, "executable": false, "source_complete": false,
            "wallet_ownership_verified": false, "commitment": "confirmed", "single_response": true,
            "snapshot_digest": hex::encode(s.meta().digest()), "accounts": accounts,
            "clock": {"address": fclient::addr::clock_sysvar().to_string(),
                "owner": fclient::snapshot::sysvar_owner().to_string(), "executable": false,
                "data_b64": STANDARD.encode(s.clock().encode())}}),
        )
    }
}

pub struct Selection {
    pub citizen: Address,
    pub coord: WideCoord,
    pub site: u8,
    pub gen: u8,
    pub min_slot: u64,
}
impl Selection {
    pub fn parse(q: &HashMap<String, String>) -> Result<Self, Fault> {
        let names = ["citizen", "p", "q", "site", "gen", "min_slot"];
        if q.len() != names.len()
            || q.keys().any(|k| !names.contains(&k.as_str()))
            || q.values().any(|v| v.len() > 44)
        {
            return Err("BadSelection");
        }
        let citizen: Address = q["citizen"].parse().map_err(|_| "BadCitizen")?;
        let p = q["p"].parse().map_err(|_| "BadCoordinate")?;
        let qv = q["q"].parse().map_err(|_| "BadCoordinate")?;
        let coord = WideCoord::checked(p, qv).map_err(|_| "BadCoordinate")?;
        let site = q["site"].parse::<u8>().map_err(|_| "BadSite")?;
        let gen = q["gen"].parse::<u8>().map_err(|_| "BadGeneration")?;
        let min_slot = q["min_slot"].parse::<u64>().map_err(|_| "BadSlot")?;
        if citizen.to_string() != q["citizen"]
            || p.to_string() != q["p"]
            || qv.to_string() != q["q"]
            || site.to_string() != q["site"]
            || gen.to_string() != q["gen"]
            || min_slot.to_string() != q["min_slot"]
        {
            return Err("NonCanonicalSelection");
        }
        if coord.ring() < 129 || site >= 12 || gen == 0 || gen == 255 || min_slot == 0 {
            return Err("BadSelection");
        }
        Ok(Self {
            citizen,
            coord,
            site,
            gen,
            min_slot,
        })
    }
}
