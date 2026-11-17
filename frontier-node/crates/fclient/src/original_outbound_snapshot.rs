//! Bounded original outbound observations from one account RPC response.
//! Public identity and account-byte context only: no signing, sealing, send,
//! planner admission, or assertion that the RPC source is authentic/current.
use crate::{
    addr::season_pda,
    decode::Season,
    snapshot::{Snapshot, SnapshotSource},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use frontier_abi::{
    addr::AddrCtx,
    v2::layout::AccountKind,
    world_index::{
        expedition::{AccountFamily, AccountResolver},
        land::WideProvince,
        tiles::{TileAddress, WideTile},
        ProvinceKey, WideCoord, WideHostRef,
    },
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_address::Address;

pub const REQUEST_SCHEMA: &str = "frontier-original-outbound-snapshot-request-v1";
pub const REPORT_SCHEMA: &str = "frontier-original-outbound-snapshot-v1";
pub const MAX_REQUEST_BYTES: usize = 8 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;
pub const MAX_ACCOUNT_BYTES: usize = 4864;
pub const MAX_READ_KEYS: usize = 9;
pub type Error = &'static str;

#[derive(Clone, Debug)]
pub struct Request {
    program: Address,
    min_slot: u64,
    keys: Vec<Address>,
    source_keys: [Address; 5],
    route: Vec<(ProvinceKey, Address)>,
    season_id: u64,
    program_version: u16,
    ruleset_hash: [u8; 32],
    echo: Value,
    digest: String,
}
impl Request {
    pub fn program(&self) -> Address {
        self.program
    }
    pub fn min_slot(&self) -> u64 {
        self.min_slot
    }
    pub fn required_keys(&self) -> &[Address] {
        &self.keys
    }
    pub fn source_keys(&self) -> &[Address; 5] {
        &self.source_keys
    }
    pub fn route(&self) -> &[(ProvinceKey, Address)] {
        &self.route
    }
}
fn exact(v: &Value, fields: &[&str]) -> Result<(), Error> {
    let o = v.as_object().ok_or("RequestShape")?;
    if o.len() != fields.len() || fields.iter().any(|k| !o.contains_key(*k)) {
        return Err("RequestShape");
    }
    Ok(())
}
fn text(v: &Value) -> Result<&str, Error> {
    v.as_str().ok_or("RequestShape")
}
fn decimal<T: std::str::FromStr + ToString>(v: &Value) -> Result<T, Error> {
    let s = text(v)?;
    if s.len() > 20 {
        return Err("RequestInteger");
    }
    let n: T = s.parse().map_err(|_| "RequestInteger")?;
    if n.to_string() != s {
        return Err("RequestInteger");
    }
    Ok(n)
}
fn public(v: &Value) -> Result<Address, Error> {
    let s = text(v)?;
    let a: Address = s.parse().map_err(|_| "RequestAddress")?;
    if a == Address::default() || a.to_string() != s {
        return Err("RequestAddress");
    }
    Ok(a)
}
fn hex_bytes<const N: usize>(v: &Value) -> Result<[u8; N], Error> {
    let s = text(v)?;
    if s.len() != N * 2
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("RequestHex");
    }
    hex::decode(s)
        .map_err(|_| "RequestHex")?
        .try_into()
        .map_err(|_| "RequestHex")
}
pub fn parse_request(bytes: &[u8]) -> Result<Request, Error> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("RequestTooLarge");
    }
    let v: Value = serde_json::from_slice(bytes).map_err(|_| "RequestJson")?;
    exact(
        &v,
        &[
            "schema",
            "operation",
            "cluster",
            "program",
            "season",
            "season_id",
            "deployment",
            "host",
            "wallet",
            "origin",
            "directions",
            "min_slot",
        ],
    )?;
    if v["schema"] != REQUEST_SCHEMA || v["operation"] != "outbound_snapshot" {
        return Err("RequestSchema");
    }
    let cluster = text(&v["cluster"])?;
    if cluster.is_empty()
        || cluster.len() > 32
        || !cluster
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("RequestCluster");
    }
    let program = public(&v["program"])?;
    let season = public(&v["season"])?;
    let wallet = public(&v["wallet"])?;
    let season_id: u64 = decimal(&v["season_id"])?;
    let min_slot: u64 = decimal(&v["min_slot"])?;
    if program == season
        || wallet == program
        || wallet == season
        || season_pda(&program, season_id).0 != season
    {
        return Err("RequestScope");
    }
    exact(&v["deployment"], &["program_version", "ruleset_hash"])?;
    let program_version: u16 = decimal(&v["deployment"]["program_version"])?;
    if program_version & 0x4000 == 0 {
        return Err("RequestVersion");
    }
    let ruleset_hash = hex_bytes::<32>(&v["deployment"]["ruleset_hash"])?;
    let ctx = AddrCtx {
        program: program.to_bytes(),
        season: season.to_bytes(),
    };
    let resolver = AccountResolver::for_season(&ctx).map_err(|_| "RequestScope")?;
    let host = WideHostRef::from_bytes(&hex_bytes::<56>(&v["host"])?).map_err(|_| "RequestHost")?;
    resolver.legacy_host_id(&host).map_err(|_| "RequestHost")?;
    exact(&v["origin"], &["p", "q", "tile"])?;
    let p: i64 = decimal(&v["origin"]["p"])?;
    let q: i64 = decimal(&v["origin"]["q"])?;
    let tile = v["origin"]["tile"]
        .as_u64()
        .filter(|n| *n < 61)
        .ok_or("RequestOrigin")? as u8;
    let origin = ProvinceKey::new(
        host.key().world(),
        WideCoord::checked(p, q).map_err(|_| "RequestOrigin")?,
    );
    if resolver.family(origin).map_err(|_| "RequestOrigin")? != AccountFamily::Legacy {
        return Err("RequestOrigin");
    }
    let directions = v["directions"]
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 32)
        .ok_or("RequestPath")?;
    let mut current = WideTile::of(TileAddress::new(origin, tile).map_err(|_| "RequestOrigin")?);
    let mut entered = Vec::new();
    for d in directions {
        let d = d.as_u64().filter(|n| *n < 6).ok_or("RequestPath")? as usize;
        current = current.neighbors()[d].ok_or("RequestPath")?;
        entered.push(current.province());
    }
    let dest = current.province();
    if resolver.family(dest).map_err(|_| "RequestPath")? != AccountFamily::Wide {
        return Err("RequestDestination");
    }
    let mut route_keys = vec![dest];
    for key in entered {
        if !route_keys.contains(&key) {
            route_keys.push(key);
        }
    }
    if route_keys.len() > 4 {
        return Err("RequestPath");
    }
    let province = |k| {
        resolver
            .province_address(k)
            .map(Address::new_from_array)
            .map_err(|_| "RequestScope")
    };
    let source_keys = [
        season,
        Address::new_from_array(ctx.citizen(&wallet.to_bytes())),
        Address::new_from_array(resolver.holding_address(&host).map_err(|_| "RequestHost")?),
        province(host.key())?,
        province(origin)?,
    ];
    // Home/standing/route aliases are intentional. Other aliases would bind
    // incompatible account families and are rejected before any RPC.
    for i in 0..source_keys.len() {
        if source_keys[i] == program
            || source_keys[i] == wallet
            || source_keys[i] == Address::default()
        {
            return Err("RequestScope");
        }
        for j in 0..i {
            if source_keys[i] == source_keys[j] && (j, i) != (3, 4) {
                return Err("RequestScope");
            }
        }
    }
    let route = route_keys
        .into_iter()
        .map(|k| Ok((k, province(k)?)))
        .collect::<Result<Vec<_>, Error>>()?;
    let mut keys = Vec::new();
    for k in source_keys.iter().chain(route.iter().map(|(_, a)| a)) {
        if !keys.contains(k) {
            keys.push(*k);
        }
    }
    if keys.len() > MAX_READ_KEYS {
        return Err("RequestPath");
    }
    let dirs = directions
        .iter()
        .map(|d| d.as_u64().unwrap().to_string())
        .collect::<Vec<_>>()
        .join(",");
    let tile_text = tile.to_string();
    let fields = [
        text(&v["operation"])?,
        cluster,
        text(&v["program"])?,
        text(&v["season"])?,
        text(&v["season_id"])?,
        text(&v["deployment"]["program_version"])?,
        text(&v["deployment"]["ruleset_hash"])?,
        text(&v["host"])?,
        text(&v["wallet"])?,
        text(&v["origin"]["p"])?,
        text(&v["origin"]["q"])?,
        &tile_text,
        &dirs,
        text(&v["min_slot"])?,
    ];
    let digest = hex::encode(Sha256::digest(format!(
        "{REQUEST_SCHEMA}\n{}\n",
        fields.join("\n")
    )));
    Ok(Request {
        program,
        min_slot,
        keys,
        source_keys,
        route,
        season_id,
        program_version,
        ruleset_hash,
        echo: v,
        digest,
    })
}

pub fn failure(request: Option<&Request>, code: Error) -> Value {
    json!({"schema":REPORT_SCHEMA,"status":"blocked","request_digest":request.map(|r| &r.digest),"scope":request.map(|r| &r.echo),
        "source":null,"clock":null,"accounts":null,"route":null,"blocker":{"code":code},"observation_only":true,
        "dispatch_available":false,"executable":false,"admitted":false,"signed":false,"enqueued":false})
}

/// Validate and serialize the *same* sealed snapshot without merging reads.
/// The caller still performs resident/eligibility and route arithmetic checks.
pub fn report(request: &Request, snapshot: &Snapshot) -> Value {
    match checked_report(request, snapshot) {
        Ok(v) => v,
        Err(code) => failure(Some(request), code),
    }
}
fn checked_report(r: &Request, s: &Snapshot) -> Result<Value, Error> {
    if s.meta().min_slot() != r.min_slot
        || s.meta().context_slot() < r.min_slot
        || s.rent().is_some()
        || s.accounts().len() != r.keys.len()
        || r.keys.iter().any(|k| !s.accounts().contains_key(k))
        || !s
            .meta()
            .verify(r.min_slot, Some(&s.clock()), None, s.accounts())
    {
        return Err("SnapshotMismatch");
    }
    let account = |address: &Address| -> Result<Value, Error> {
        let Some(a) = s.accounts().get(address).ok_or("SnapshotMismatch")? else {
            return Ok(Value::Null);
        };
        if a.owner != r.program || a.executable || a.data.len() > MAX_ACCOUNT_BYTES {
            return Err("SnapshotAccount");
        }
        Ok(
            json!({"address":address.to_string(),"owner":a.owner.to_string(),"lamports":a.lamports.to_string(),
            "executable":false,"bytes_b64":STANDARD.encode(&a.data)}),
        )
    };
    let mut accounts = serde_json::Map::new();
    for ((name, kind), address) in ["season", "citizen", "holding", "home", "standing"]
        .into_iter()
        .zip([
            AccountKind::Season,
            AccountKind::Citizen,
            AccountKind::Holding,
            AccountKind::Province,
            AccountKind::Province,
        ])
        .zip(&r.source_keys)
    {
        let a = s.accounts()[address].as_ref().ok_or("SourceAbsent")?;
        if a.data.len() != kind.size()
            || a.data.get(..8) != Some(kind.magic().as_slice())
            || u64::from_le_bytes(a.data[8..16].try_into().unwrap()) != r.season_id
            || u16::from_le_bytes(a.data[16..18].try_into().unwrap()) != 2
        {
            return Err("SourceLayout");
        }
        accounts.insert(name.to_string(), account(address)?);
    }
    let season = Season::decode(&s.accounts()[&r.source_keys[0]].as_ref().unwrap().data)
        .map_err(|_| "SourceLayout")?;
    if season.program_version != r.program_version || season.ruleset_hash != r.ruleset_hash {
        return Err("DeploymentMismatch");
    }
    let mut route = Vec::new();
    for (key, address) in &r.route {
        if let Some(a) = &s.accounts()[address] {
            let valid = if key.coord().ring() > 128 {
                WideProvince::read(&a.data).is_ok_and(|p| {
                    p.world == key.world() && p.coord == key.coord() && p.season_id == r.season_id
                })
            } else {
                crate::decode::Province::decode(&a.data).is_ok_and(|p| {
                    p.h.layout_version == 2
                        && p.h.season_id == r.season_id
                        && i64::from(p.p) == key.coord().p()
                        && i64::from(p.q) == key.coord().q()
                        && a.data.len() == AccountKind::Province.size()
                })
            };
            if !valid {
                return Err("RouteIdentity");
            }
        }
        route.push(json!({"key":hex::encode(key.to_bytes()),"p":key.coord().p().to_string(),"q":key.coord().q().to_string(),"account":account(address)?}));
    }
    let c = s.clock();
    let v = json!({"schema":REPORT_SCHEMA,"status":"snapshot","request_digest":r.digest,"scope":r.echo,
        "source":{"kind":"single_snapshot_source","read_calls":"1","coherent":true,"single_response":true,
            "context_slot":s.meta().context_slot().to_string(),"min_slot":r.min_slot.to_string(),"commitment":"confirmed",
            "digest":hex::encode(s.meta().digest()),"authority_verified":false,"freshness":"unknown","complete_world_view":false},
        "clock":{"slot":c.slot.to_string(),"unix_timestamp":c.unix_timestamp.to_string(),"bytes_b64":STANDARD.encode(c.encode())},
        "accounts":accounts,"route":route,"blocker":null,"observation_only":true,
        "dispatch_available":false,"executable":false,"admitted":false,"signed":false,"enqueued":false});
    if serde_json::to_vec(&v).map_err(|_| "OutputTooLarge")?.len() > MAX_OUTPUT_BYTES {
        return Err("OutputTooLarge");
    }
    Ok(v)
}
pub async fn read(request: &Request, source: &dyn SnapshotSource) -> Value {
    match source
        .snapshot_boxed(&request.keys, false, request.min_slot)
        .await
    {
        Ok(s) => report(request, &s),
        Err(_) => failure(Some(request), "SnapshotUnavailable"),
    }
}
