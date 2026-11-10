#![cfg(feature = "wide-records-experimental")]
//! Pure public-address construction and immutable native role snapshots only.
//! No keys, signatures, processes, RPC, transactions or filesystem writes.
use fclient::wide_resident_draft::{Draft, Error};
use fclient::Address;
use frontier_abi::{
    addr::AddrCtx,
    bytes::rd_arr,
    v2::layout::player::citizen as C,
    world_index::{
        expedition::AccountResolver,
        expedition_resident_event::{Action, Record},
        expedition_resident_ix::DraftCommand,
        wide_ix, ProvinceKey, WideCoord, WideHostRef,
    },
};
use serde_json::{json, Value};
const SHARED: &[u8] = include_bytes!("fixtures/original_resident_draft_v1.json");
const DISSOLVE: &[u8] =
    include_bytes!("../../verify/tests/fixtures/wide_expedition_resident/dissolve_v1.bin");
const RETURN: &[u8] =
    include_bytes!("../../verify/tests/fixtures/wide_expedition_resident/return_v1.bin");
fn address(n: u8) -> Address {
    Address::new_from_array([n; 32])
}
fn context() -> AddrCtx {
    AddrCtx {
        program: [4; 32],
        season: [5; 32],
    }
}
fn selection(ctx: &AddrCtx) -> (WideHostRef, ProvinceKey) {
    let r = AccountResolver::for_season(ctx).unwrap();
    (
        r.legacy_host_ref(frontier_abi::addr::host_id(128, 0, 1, 2, 0).unwrap())
            .unwrap(),
        ProvinceKey::new(r.adapter().world(), WideCoord::checked(129, 0).unwrap()),
    )
}
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}
impl Reader<'_> {
    fn take(&mut self, n: usize) -> &[u8] {
        let end = self.at.checked_add(n).unwrap();
        let out = &self.bytes[self.at..end];
        self.at = end;
        out
    }
    fn arr<const N: usize>(&mut self) -> [u8; N] {
        self.take(N).try_into().unwrap()
    }
    fn byte(&mut self) -> u8 {
        self.take(1)[0]
    }
    fn flag(&mut self) -> bool {
        match self.byte() {
            0 => false,
            1 => true,
            _ => panic!("flag"),
        }
    }
    fn sized(&mut self) -> Vec<u8> {
        let n = u32::from_le_bytes(self.arr()) as usize;
        assert!(n <= 65_536);
        self.take(n).to_vec()
    }
    fn role(&mut self) -> (Address, bool, bool, Vec<u8>) {
        let key = Address::new_from_array(self.arr());
        self.take(32);
        self.flag();
        let signer = self.flag();
        let writable = self.flag();
        assert!(!self.flag());
        self.take(8);
        (key, signer, writable, self.sized())
    }
}
#[test]
fn proposed_roles_and_host_match_both_actual_native_invocations() {
    for (bytes, digest) in [
        (
            DISSOLVE,
            "0d46cd2d175c57c947af8e67f14f2d002e18c9e7e7d47fb4a944e98023f39a84",
        ),
        (
            RETURN,
            "6f22a8e606852e52d87f66e0f2452fd00c6a26aa42716a2fc874feb4643d7da3",
        ),
    ] {
        assert_eq!(
            hex::encode(permutation_rules::hash::sha256(&[bytes])),
            digest
        );
        let mut r = Reader { bytes, at: 0 };
        assert_eq!(r.take(8), b"BRESv001");
        let action = match r.byte() {
            1 => Action::Dissolve,
            2 => Action::Return,
            _ => panic!("action"),
        };
        let program = r.arr();
        let season = r.arr();
        let ctx = AddrCtx { program, season };
        let host = WideHostRef::from_bytes(&r.arr::<56>()).unwrap();
        r.take(16);
        let n = r.byte() as usize;
        assert_eq!(n, if action == Action::Dissolve { 8 } else { 6 });
        let before = (0..n).map(|_| r.role()).collect::<Vec<_>>();
        for _ in 0..n {
            r.role();
        }
        assert_eq!(r.byte(), 2);
        let body = r.sized();
        let other = r.sized();
        assert_eq!(r.at, bytes.len());
        let record = Record::decode(&ctx, &body).unwrap();
        record.pair(&Record::decode(&ctx, &other).unwrap()).unwrap();
        assert_eq!(record.action, action);
        assert_eq!(record.identity.host, host);
        // The shared web vectors are extracted independently from these
        // immutable before-account snapshots, not from Draft's output.
        let vectors: Value = serde_json::from_slice(SHARED).unwrap();
        let id = if action == Action::Dissolve {
            "native_dissolve"
        } else {
            "native_return"
        };
        let vector = vectors["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["id"] == id)
            .unwrap();
        assert_eq!(vector["provenance"]["sha256"], digest);
        assert_eq!(
            vector["request"]["program"],
            Address::new_from_array(program).to_string()
        );
        assert_eq!(
            vector["request"]["season"],
            Address::new_from_array(season).to_string()
        );
        assert_eq!(vector["request"]["host"], hex::encode(host.to_bytes()));
        assert_eq!(
            vector["request"]["original_owner"],
            Address::new_from_array(record.identity.original_owner).to_string()
        );
        assert_eq!(
            vector["expected"]["standing_key"],
            hex::encode(record.identity.standing.to_bytes())
        );
        for (v, (key, signer, writable, _)) in vector["expected"]["roles"]
            .as_array()
            .unwrap()
            .iter()
            .zip(&before)
        {
            assert_eq!(v["address"], key.to_string());
            assert_eq!(v["signer"], *signer);
            assert_eq!(v["writable"], *writable);
        }
        let draft = match action {
            Action::Dissolve => Draft::for_wallet(
                &ctx,
                host,
                record.identity.standing,
                Address::new_from_array(rd_arr::<32>(&before[3].3, C::WALLET).unwrap()),
                before[1].0,
            ),
            Action::Return => Draft::return_home(&ctx, host, record.identity.standing, before[0].0),
        }
        .unwrap();
        assert_eq!(draft.roles().len(), before.len());
        for (role, (key, signer, writable, _)) in draft.roles().iter().zip(&before) {
            assert_eq!(
                (role.address, role.signer, role.writable),
                (*key, *signer, *writable)
            );
        }
        assert_eq!(draft.command().host(), record.identity.host);
        assert_eq!(
            DraftCommand::decode(&ctx, &draft.proposed_bytes()).unwrap(),
            draft.command()
        );
        // Native handlers received Rust arguments, not this new draft wire.
        assert!(wide_ix::WideCommand::decode(&draft.proposed_bytes()).is_err());
        assert!(!draft.public_dispatch_available());
        assert!(!draft.admitted());
    }
}

#[test]
fn independent_shared_web_vectors_pin_bytes_roles_and_complete_content_digest() {
    let v: Value = serde_json::from_slice(SHARED).unwrap();
    assert_eq!(v["schema"], "frontier-original-resident-draft-v1");
    assert_eq!(v["cases"].as_array().unwrap().len(), 4);
    assert_eq!(
        v["digest_domain"],
        std::str::from_utf8(fclient::wide_resident_draft::CONTENT_DIGEST_DOMAIN).unwrap()
    );
    for case in v["cases"].as_array().unwrap() {
        let (r, expected) = (&case["request"], &case["expected"]);
        let program: Address = r["program"].as_str().unwrap().parse().unwrap();
        let season: Address = r["season"].as_str().unwrap().parse().unwrap();
        let ctx = AddrCtx {
            program: program.to_bytes(),
            season: season.to_bytes(),
        };
        let host =
            WideHostRef::from_bytes(&hex::decode(r["host"].as_str().unwrap()).unwrap()).unwrap();
        let standing = ProvinceKey::new(
            host.key().world(),
            WideCoord::checked(
                r["standing"]["p"].as_str().unwrap().parse().unwrap(),
                r["standing"]["q"].as_str().unwrap().parse().unwrap(),
            )
            .unwrap(),
        );
        let payer: Address = r["payer"].as_str().unwrap().parse().unwrap();
        let draft = match case["action"].as_str().unwrap() {
            "Dissolve" => Draft::for_wallet(
                &ctx,
                host,
                standing,
                r["wallet"].as_str().unwrap().parse().unwrap(),
                payer,
            ),
            "Return" => {
                assert!(r["wallet"].is_null());
                Draft::return_home(&ctx, host, standing, payer)
            }
            _ => panic!("unexpected shared action"),
        }
        .unwrap();
        assert_eq!(
            hex::encode(draft.proposed_bytes()),
            expected["bytes_hex"],
            "{}",
            case["id"]
        );
        assert_eq!(
            hex::encode(draft.standing().to_bytes()),
            expected["standing_key"]
        );
        let roles = draft.roles().iter().map(|a| json!({"name":a.name,"address":a.address.to_string(),"signer":a.signer,"writable":a.writable})).collect::<Vec<_>>();
        assert_eq!(json!(roles), expected["roles"], "{}", case["id"]);
        assert_eq!(
            hex::encode(draft.content_digest()),
            expected["content_digest"],
            "{}",
            case["id"]
        );
        assert!(!draft.public_dispatch_available() && !draft.admitted());
        assert!(wide_ix::WideCommand::decode(&draft.proposed_bytes()).is_err());
    }
}

#[test]
fn content_digest_binds_scope_and_roles_that_the_wire_does_not_contain() {
    let ctx = context();
    let (host, standing) = selection(&ctx);
    let base = Draft::return_home(&ctx, host, standing, address(9)).unwrap();
    let far = ProvinceKey::new(
        standing.world(),
        WideCoord::checked((1i64 << 53) + 1, -2).unwrap(),
    );
    for changed in [
        Draft::return_home(&ctx, host, far, address(9)).unwrap(),
        Draft::return_home(&ctx, host, standing, address(10)).unwrap(),
    ] {
        assert_eq!(base.proposed_bytes(), changed.proposed_bytes());
        assert_ne!(base.content_digest(), changed.content_digest());
    }
    let actor = Draft::for_wallet(&ctx, host, standing, address(7), address(8)).unwrap();
    let alias = Draft::for_wallet(&ctx, host, standing, address(7), address(7)).unwrap();
    let other_wallet = Draft::for_wallet(&ctx, host, standing, address(6), address(8)).unwrap();
    assert_eq!(actor.proposed_bytes(), alias.proposed_bytes());
    assert_eq!(actor.proposed_bytes(), other_wallet.proposed_bytes());
    assert_ne!(actor.content_digest(), alias.content_digest());
    assert_ne!(actor.content_digest(), other_wallet.content_digest());
}
#[test]
fn wallet_citizen_and_minimum_privileges_keep_return_permissionless() {
    let ctx = context();
    let (host, standing) = selection(&ctx);
    let d = Draft::for_wallet(&ctx, host, standing, address(7), address(8)).unwrap();
    assert_eq!(
        d.roles()[3].address.to_bytes(),
        ctx.citizen(&address(7).to_bytes())
    );
    assert_eq!(
        d.roles()
            .iter()
            .enumerate()
            .filter(|(_, r)| r.signer)
            .map(|(i, _)| i)
            .collect::<Vec<_>>(),
        vec![0, 1]
    );
    assert_eq!(
        d.roles()
            .iter()
            .enumerate()
            .filter(|(_, r)| r.writable)
            .map(|(i, _)| i)
            .collect::<Vec<_>>(),
        vec![1, 3, 4, 5]
    );
    let r = Draft::return_home(&ctx, host, standing, address(9)).unwrap();
    assert_eq!(r.roles().len(), 6);
    assert_eq!(r.roles().iter().filter(|r| r.signer).count(), 1);
    assert!(r
        .roles()
        .iter()
        .all(|r| r.name != "citizen" && r.name != "actor"));
    assert_eq!(r.roles()[0].address, address(9));
    assert!(!r.not_proven().is_empty());
    assert!(!d.admitted());
    assert!(!r.admitted());
}
#[test]
fn only_actor_payer_alias_is_permitted_and_flags_are_globalized() {
    let ctx = context();
    let (host, standing) = selection(&ctx);
    let d = Draft::for_wallet(&ctx, host, standing, address(7), address(7)).unwrap();
    assert_eq!(d.roles()[0].address, d.roles()[1].address);
    assert!(d.roles()[0].writable && d.roles()[1].writable);
    for role in &d.roles()[2..] {
        assert_eq!(
            Draft::for_wallet(&ctx, host, standing, address(7), role.address),
            Err(Error::Alias)
        );
    }
    let r = Draft::return_home(&ctx, host, standing, address(9)).unwrap();
    for role in &r.roles()[1..] {
        assert_eq!(
            Draft::return_home(&ctx, host, standing, role.address),
            Err(Error::Alias)
        );
    }
    for actor in [Address::default(), Address::new_from_array(ctx.program)] {
        assert_eq!(
            Draft::for_wallet(&ctx, host, standing, actor, address(8)),
            Err(Error::ZeroOrProgramRecipient)
        );
        assert_eq!(
            Draft::return_home(&ctx, host, standing, actor),
            Err(Error::ZeroOrProgramRecipient)
        );
    }
}
#[test]
fn source_family_world_and_full_width_destination_are_explicit() {
    let ctx = context();
    let (host, standing) = selection(&ctx);
    assert_eq!(
        Draft::return_home(&ctx, host, host.key(), address(9)),
        Err(Error::StandingFamily)
    );
    let other = AddrCtx {
        season: [6; 32],
        ..ctx
    };
    let (_, other_standing) = selection(&other);
    assert_eq!(
        Draft::return_home(&ctx, host, other_standing, address(9)),
        Err(Error::StandingFamily)
    );
    let wide_host = WideHostRef::new(standing, 1, 2, 0).unwrap();
    assert_eq!(
        Draft::return_home(&ctx, wide_host, standing, address(9)),
        Err(Error::ContextOrHost)
    );
    assert_eq!(
        Draft::return_home(&other, host, standing, address(9)),
        Err(Error::ContextOrHost)
    );
    let far = ProvinceKey::new(
        standing.world(),
        WideCoord::checked((1i64 << 53) + 1, -2).unwrap(),
    );
    let r = Draft::return_home(&ctx, host, far, address(9)).unwrap();
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    assert_eq!(r.standing(), far);
    assert_eq!(
        r.roles()[2].address.to_bytes(),
        resolver.province_address(far).unwrap()
    );
    assert_eq!(
        r.roles()[4].address.to_bytes(),
        resolver.holding_address(&host).unwrap()
    );
    assert_eq!(
        r.roles()[5].address.to_bytes(),
        resolver.province_address(host.key()).unwrap()
    );
    assert_eq!(r.program().to_bytes(), ctx.program);
    assert_eq!(r.season().to_bytes(), ctx.season);
}
#[test]
fn proposed_bytes_cannot_enter_public_or_nft_dispatch() {
    let ctx = context();
    let (host, standing) = selection(&ctx);
    for d in [
        Draft::for_wallet(&ctx, host, standing, address(7), address(8)).unwrap(),
        Draft::return_home(&ctx, host, standing, address(9)).unwrap(),
    ] {
        let b = d.proposed_bytes();
        assert_eq!(b.len(), 60);
        assert!(wide_ix::WideCommand::decode(&b).is_err());
        assert!(frontier_abi::v2::ix::tag_of(&b).is_err());
        let mut wrap = [0; 65];
        wide_ix::ResidentAct {
            generation: 1,
            inner: &b,
        }
        .encode_into(&mut wrap)
        .unwrap();
        assert!(wide_ix::ResidentAct::decode(&wrap).is_err());
        for n in 0..b.len() {
            assert!(DraftCommand::decode(&ctx, &b[..n]).is_err());
        }
        let mut excess = b.to_vec();
        excess.push(0);
        assert!(DraftCommand::decode(&ctx, &excess).is_err());
        assert!(!d.admitted());
        assert!(!d.public_dispatch_available());
    }
}
