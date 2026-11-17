//! Chain flow, stage A (workstream 04): the NFT pass joins and its old
//! owner's authority is revoked, run by the **game program's own code** on
//! this host (`--features nft`: permutation-frontier's `nft-experimental`,
//! JoinResident 0xE1 and ResidentAct 0xE2 of ⑳ 45d95e31 / dc55f159).
//!
//! What is new here compared with ⑳'s in-crate harness
//! (`permutation-frontier/src/resident_runtime_tests.rs`, which this does not
//! replace): every instruction goes through the loader's input format and
//! the host's System CPI (Allocate, Assign, AllocateWithSeed, Transfer) with
//! the lamport total checked per transaction, and the result is handed to
//! the next stages of the chain (`CHAIN_OUT/a-join.json`: the Citizen, its
//! `citizen_tag`, the RESIDENT_JOINED record, the owner after the transfer).
//!
//! **No key is generated, derived or signed.** Every address is a literal
//! or one the program itself computes by hashing (PDA, with-seed); the
//! signers are a set of keys the test says signed (no signature exists).
//! Metaplex Core and the resident program are not run: their accounts are
//! written as bytes in the states their instructions leave (⑳'s layout).
#![cfg(feature = "nft")]

use frontier_abi::resident_auth::Policy;
use frontier_abi::resident_citizen as rc;
use frontier_abi::resident_wire as wire;
use frontier_abi::v2::error::CqError as E;
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use frontier_abi::v2::log::{AnyKind, CqKind};
use permutation_frontier::addr;
use permutation_frontier::layout::{frontier as FR, season as S};
use solana_program::instruction::{AccountMeta, Instruction};
use solana_program::pubkey::Pubkey;
use wylls_e2e_native::{rent_exempt, Acct, Host, SYSTEM};

const GAME: [u8; 32] = [0x11; 32];
const PRIZE: [u8; 32] = [0x22; 32];
const RESIDENT_PROGRAM: [u8; 32] = [0x33; 32];
const CORE: [u8; 32] = [0x44; 32];
const COLLECTION: [u8; 32] = [0x55; 32];
const ASSET: [u8; 32] = [0x5a; 32];
const A: [u8; 32] = [0xa1; 32];
const B: [u8; 32] = [0xb2; 32];
const PAYER: [u8; 32] = [0xd4; 32];
const GENESIS: i64 = 1_800_000_000;

fn pk(b: [u8; 32]) -> Pubkey {
    Pubkey::new_from_array(b)
}

fn pda(seeds: &[&[u8]], program: &[u8; 32]) -> [u8; 32] {
    Pubkey::find_program_address(seeds, &pk(*program))
        .0
        .to_bytes()
}

fn guard() -> [u8; 32] {
    pda(&[b"collection-authority"], &RESIDENT_PROGRAM)
}

/// ⑳'s guarded AssetV1 tail (frozen Permanent Freeze Delegate and Permanent
/// Transfer Delegate of the guard authority).
fn guarded_tail(base: usize, guard: &[u8; 32]) -> Vec<u8> {
    let (freeze_at, transfer_at, registry_at) = (base + 9, base + 11, base + 12);
    let mut t = vec![3u8];
    t.extend_from_slice(&(registry_at as u64).to_le_bytes());
    t.extend_from_slice(&[5, 1, 7]);
    t.push(4);
    t.extend_from_slice(&2u32.to_le_bytes());
    for (kind, at) in [(5u8, freeze_at), (7u8, transfer_at)] {
        t.extend_from_slice(&[kind, 3]);
        t.extend_from_slice(guard);
        t.extend_from_slice(&(at as u64).to_le_bytes());
    }
    t.extend_from_slice(&0u32.to_le_bytes());
    t
}

fn asset_bytes(owner: &[u8; 32], guarded: bool) -> Vec<u8> {
    let mut a = vec![1u8];
    a.extend_from_slice(owner);
    a.push(2);
    a.extend_from_slice(&COLLECTION);
    for s in [&b"Resident"[..], &b"https://example.invalid/r.json"[..]] {
        a.extend_from_slice(&(s.len() as u32).to_le_bytes());
        a.extend_from_slice(s);
    }
    a.push(0);
    if guarded {
        let base = a.len();
        a.extend_from_slice(&guarded_tail(base, &guard()));
    }
    a
}

/// The resident program's record of `ASSET` (133 B): generation, no session.
fn resident_bytes(generation: u32) -> Vec<u8> {
    let mut r = vec![0u8; 133];
    r[0] = 0xc2;
    r[1..33].copy_from_slice(&ASSET);
    r[48..52].copy_from_slice(&generation.to_le_bytes());
    r
}

fn custom(e: impl Into<u32>) -> String {
    format!("Custom({})", e.into())
}
fn cq(e: E) -> String {
    format!("Custom({})", e as u32)
}

/// One world (Season `id`) of the game program with the NFT pass in it.
struct World {
    h: Host,
    season_id: u64,
    season: [u8; 32],
    frontier: [u8; 32],
    config: [u8; 32],
    link: [u8; 32],
    resident: [u8; 32],
    citizen: [u8; 32],
    generation: u32,
}

fn owned(owner: [u8; 32], data: Vec<u8>) -> Acct {
    Acct {
        lamports: rent_exempt(data.len()),
        data,
        owner: pk(owner),
        executable: false,
    }
}

impl World {
    fn new(season_id: u64) -> World {
        let mut h = Host::with_game(pk(PRIZE), pk(GAME));
        h.clock.unix_timestamp = GENESIS + 600;
        h.clock.slot = 1_000;
        let bump = Pubkey::find_program_address(
            &[addr::SEASON_PREFIX, &addr::season_seed_id(season_id)],
            &pk(GAME),
        )
        .1;
        let season = addr::season_pda(season_id, bump, &GAME);
        let ctx = addr::ctx(&season, &GAME);
        let mut sd = vec![0u8; K2::Season.size()];
        assert!(write_header(&mut sd, K2::Season, season_id));
        sd[S::STATUS] = S::STATUS_RUNNING;
        sd[S::BUMP] = bump;
        sd[S::R_MAX..S::R_MAX + 2].copy_from_slice(&8u16.to_le_bytes());
        sd[S::RULESET_HASH..S::RULESET_HASH + 32]
            .copy_from_slice(&permutation_frontier::RULESET_HASH);
        sd[S::GENESIS_TS..S::GENESIS_TS + 8].copy_from_slice(&GENESIS.to_le_bytes());
        sd[S::JOIN_CLOSE_BELL..S::JOIN_CLOSE_BELL + 4].copy_from_slice(&100_000u32.to_le_bytes());
        sd[S::END_BELL..S::END_BELL + 4].copy_from_slice(&200_000u32.to_le_bytes());
        sd[S::BUCKET_RATE_PER_H..S::BUCKET_RATE_PER_H + 2].copy_from_slice(&60u16.to_le_bytes());
        sd[S::BUCKET_BURST..S::BUCKET_BURST + 2].copy_from_slice(&20u16.to_le_bytes());
        let mut fd = vec![0u8; K2::Frontier.size()];
        assert!(write_header(&mut fd, K2::Frontier, season_id));
        fd[FR::OPEN_SITES..FR::OPEN_SITES + 4].copy_from_slice(&100u32.to_le_bytes());
        let policy = Policy {
            core_program: CORE,
            resident_program: RESIDENT_PROGRAM,
            collection: COLLECTION,
            guard_authority: guard(),
        };
        let mut pd = vec![0u8; frontier_abi::resident_policy::LEN];
        assert!(frontier_abi::resident_policy::write_once(&mut pd, &policy));
        let config = pda(&[b"nft-resident-policy"], &GAME);
        let link = pda(&[b"nft-citizen-link", &season, &ASSET], &GAME);
        let resident = pda(&[b"resident", &ASSET], &RESIDENT_PROGRAM);
        let citizen = ctx.citizen_by_tag15(&rc::resident_tag15(&ASSET));
        let frontier = ctx.frontier();
        h.set(pk(season), owned(GAME, sd));
        h.set(pk(frontier), owned(GAME, fd));
        h.set(pk(config), owned(GAME, pd));
        h.set(pk(ASSET), owned(CORE, asset_bytes(&A, true)));
        h.set(pk(resident), owned(RESIDENT_PROGRAM, resident_bytes(0)));
        h.fund(pk(PAYER), 10_000_000_000);
        h.set(
            SYSTEM,
            Acct {
                lamports: 1,
                data: vec![],
                owner: wylls_e2e_native::LOADER,
                executable: true,
            },
        );
        World {
            h,
            season_id,
            season,
            frontier,
            config,
            link,
            resident,
            citizen,
            generation: 0,
        }
    }

    /// TransferResident as the resident program leaves it (⑳'s model): the
    /// asset's owner changes and the generation goes up by one.
    fn transfer(&mut self, to: &[u8; 32]) {
        self.generation += 1;
        let a = self.h.accounts.get_mut(&pk(ASSET)).unwrap();
        a.data[1..33].copy_from_slice(to);
        let r = self.h.accounts.get_mut(&pk(self.resident)).unwrap();
        r.data.copy_from_slice(&resident_bytes(self.generation));
    }

    fn join_ix(
        &self,
        owner: [u8; 32],
        signed: bool,
        generation: u32,
        link: [u8; 32],
    ) -> Instruction {
        let mut d = vec![wire::JOIN_RESIDENT];
        d.extend_from_slice(&generation.to_le_bytes());
        d.push(2); // faction
        Instruction {
            program_id: pk(GAME),
            accounts: vec![
                AccountMeta {
                    pubkey: pk(owner),
                    is_signer: signed,
                    is_writable: false,
                },
                AccountMeta::new(pk(PAYER), true),
                AccountMeta::new_readonly(pk(self.season), false),
                AccountMeta::new_readonly(pk(self.frontier), false),
                AccountMeta::new(pk(self.citizen), false),
                AccountMeta::new_readonly(SYSTEM, false),
                AccountMeta::new_readonly(pk(self.config), false),
                AccountMeta::new(pk(link), false),
                AccountMeta::new_readonly(pk(ASSET), false),
                AccountMeta::new_readonly(pk(self.resident), false),
            ],
            data: d,
        }
    }

    fn join(&mut self, owner: [u8; 32], generation: u32) -> Result<(), String> {
        let ix = self.join_ix(owner, true, generation, self.link);
        self.h.send(&[ix], &[pk(owner), pk(PAYER)])
    }

    /// ResidentAct(SetVigil 600) by `actor` with the signed `generation`.
    fn act(&mut self, actor: [u8; 32], signed: bool, generation: u32) -> Result<(), String> {
        let mut d = vec![wire::RESIDENT_ACT];
        d.extend_from_slice(&generation.to_le_bytes());
        d.push(frontier_abi::v2::Ix::SetVigil.tag());
        d.extend_from_slice(&600u16.to_le_bytes());
        let ix = Instruction {
            program_id: pk(GAME),
            accounts: vec![
                AccountMeta {
                    pubkey: pk(actor),
                    is_signer: signed,
                    is_writable: false,
                },
                AccountMeta::new(pk(PAYER), true),
                AccountMeta::new_readonly(pk(self.season), false),
                AccountMeta::new(pk(self.citizen), false),
                AccountMeta::new_readonly(pk(self.config), false),
                AccountMeta::new_readonly(pk(self.link), false),
                AccountMeta::new_readonly(pk(ASSET), false),
                AccountMeta::new_readonly(pk(self.resident), false),
            ],
            data: d,
        };
        let signers: Vec<Pubkey> = if signed {
            vec![pk(actor), pk(PAYER)]
        } else {
            vec![pk(PAYER)]
        };
        self.h.send(&[ix], &signers)
    }

    /// The pass's current holder, read with ⑳'s definition from the asset and
    /// resident account bytes in the host (no second definition here).
    fn holder(&self) -> frontier_abi::resident_auth::Holder {
        use frontier_abi::resident_auth::{holder, Account, Binding, Policy};
        let acct = |k: [u8; 32]| {
            let a = self.h.get(&pk(k)).expect("account");
            (a.owner.to_bytes(), a.data.clone())
        };
        let (ao, ad) = acct(ASSET);
        let (ro, rd) = acct(self.resident);
        holder(
            &Binding {
                asset: ASSET,
                resident: self.resident,
            },
            &Policy {
                core_program: CORE,
                resident_program: RESIDENT_PROGRAM,
                collection: COLLECTION,
                guard_authority: guard(),
            },
            &Account {
                key: ASSET,
                owner: ao,
                data: &ad,
            },
            &Account {
                key: self.resident,
                owner: ro,
                data: &rd,
            },
        )
        .expect("the pass's holder")
    }

    fn at_day(&mut self, day: i64) {
        self.h.clock.unix_timestamp = GENESIS + 600 + day * 86_400;
        self.h.clock.slot = 1_000 + day as u64;
    }

    /// The PS2 records of the last transaction.
    fn records(&self) -> Vec<Vec<u8>> {
        self.h
            .data
            .iter()
            .filter(|f| f.len() == 2 && f[0] == frontier_abi::log::PREFIX[..])
            .map(|f| f[1].clone())
            .collect()
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The stage-A hand-off for the next stages (B: caravan, C: memory,
/// D: outcome, E: prize). Written only when `CHAIN_OUT` names a directory.
fn hand_off(w: &World, record: &[u8], owner_after: &[u8; 32]) {
    let Ok(dir) = std::env::var("CHAIN_OUT") else {
        return;
    };
    let tag = permutation_rules::frontier::addr::citizen_tag(&w.citizen);
    let j = format!(
        concat!(
            "{{\n  \"stage\": \"A\",\n  \"source\": \"workstreams/04-execution/e2e-native/tests/chain_nft.rs\",\n",
            "  \"program\": \"{}\",\n  \"season_id\": {},\n  \"season\": \"{}\",\n",
            "  \"asset\": \"{}\",\n  \"citizen\": \"{}\",\n  \"citizen_tag\": \"{}\",\n",
            "  \"citizen_tag_hex\": \"{:016x}\",\n  \"resident_tag15\": \"{}\",\n",
            "  \"joined_by\": \"{}\",\n  \"owner_after_transfer\": \"{}\",\n  \"generation\": {},\n",
            "  \"resident_joined_record\": \"{}\"\n}}\n"
        ),
        hex(&GAME),
        w.season_id,
        hex(&w.season),
        hex(&ASSET),
        hex(&w.citizen),
        tag,
        tag,
        hex(&rc::resident_tag15(&ASSET)),
        hex(&A),
        hex(owner_after),
        w.generation,
        hex(record),
    );
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(std::path::Path::new(&dir).join("a-join.json"), j).unwrap();
}

/// The chain's first two links: a correct NFT join, then the transfer that
/// revokes the old owner's authority while the Citizen (and its tag, which
/// the caravan and the prize key on) stays with the pass.
#[test]
fn nft_join_then_transfer_revokes_the_old_owner() {
    let mut w = World::new(7);
    // Join: one Citizen at citizen_by_tag15(resident id), owned by the game.
    w.join(A, 0).expect("the owner's first login");
    let c = w.h.get(&pk(w.citizen)).expect("Citizen created").clone();
    assert_eq!(c.owner, pk(GAME));
    assert_eq!(rc::resident_asset(&c.data), Some(ASSET));
    assert_eq!(rc::record_tag15(&c.data), Some(rc::resident_tag15(&ASSET)));
    let link = w.h.get(&pk(w.link)).expect("link created").clone();
    assert_eq!(link.owner, pk(GAME));
    let l = frontier_abi::resident_binding::read(&link.data).unwrap();
    assert_eq!(l.citizen, w.citizen);
    assert_eq!(l.asset, ASSET);
    // RESIDENT_JOINED (kind 130), keyed by the resident id.
    let recs = w.records();
    assert_eq!(recs.len(), 1, "{:?}", w.h.logs);
    let record = recs[0].clone();
    let r = frontier_abi::v2::log::decode(&record).unwrap();
    assert_eq!(r.kind, AnyKind::Cq(CqKind::RESIDENT_JOINED));
    assert_eq!(r.key, rc::resident_tag15(&ASSET));
    assert_eq!(&r.payload[..32], &ASSET);
    assert_eq!(&r.payload[34..38], &0u32.to_le_bytes(), "generation 0");
    // Duplicate: one NFT, one Citizen.
    assert_eq!(
        w.join(A, 0),
        Err(custom(
            permutation_frontier::FrontierError::AlreadyDone as u32
        ))
    );
    // The owner acts.
    w.at_day(1);
    w.act(A, true, 0).expect("owner A acts");
    // Transfer A → B: generation 1. A's authority is gone at once, by any
    // signature (old or fresh); B acts at once with the new generation.
    w.transfer(&B);
    w.at_day(10); // past SetVigil's cooldown (as in ⑳'s harness)
    assert_eq!(w.act(A, true, 0), Err(cq(E::ResidentStaleGeneration)));
    assert_eq!(w.act(A, true, 1), Err(cq(E::ResidentNotCurrentAuthority)));
    assert_eq!(w.act(B, true, 0), Err(cq(E::ResidentStaleGeneration)));
    w.act(B, true, 1).expect("new owner B acts");
    // The Citizen stayed where it was: the pass carries it (and its tag).
    let c2 = w.h.get(&pk(w.citizen)).unwrap();
    assert_eq!(rc::resident_asset(&c2.data), Some(ASSET));
    // The holder as ⑳'s single definition reads it (frontier_abi::resident_auth
    // holder + Holder::authority, ⑳ 4b233e4a): the same answers the program
    // gave above. The hand-off takes the owner and generation from it.
    let h = w.holder();
    assert_eq!((h.owner, h.generation), (B, 1));
    use frontier_abi::resident_auth::{Authority, Refusal};
    let now = w.h.clock.unix_timestamp;
    assert_eq!(h.authority(&A, 0, now, true), Err(Refusal::StaleGeneration));
    assert_eq!(
        h.authority(&A, 1, now, true),
        Err(Refusal::NotCurrentAuthority)
    );
    assert_eq!(h.authority(&B, 1, now, true), Ok(Authority::Owner));
    assert_eq!(w.generation, h.generation);
    hand_off(&w, &record, &h.owner);
}

/// The completion conditions' refusals, through the loader path: forged,
/// missing, mismatched and duplicate joins leave nothing behind.
#[test]
fn forged_missing_mismatched_and_duplicate_joins_are_refused() {
    let mut w = World::new(7);
    let none = |w: &World| w.h.get(&pk(w.citizen)).is_none() && w.h.get(&pk(w.link)).is_none();
    // Missing: the owner did not sign (the program refuses, not the host).
    let ix = w.join_ix(A, false, 0, w.link);
    assert!(w.h.send(&[ix], &[pk(PAYER)]).is_err());
    assert!(none(&w));
    // Mismatched: someone else than the owner; the right owner with a wrong
    // generation.
    assert_eq!(w.join(B, 0), Err(cq(E::ResidentNotCurrentAuthority)));
    assert_eq!(w.join(A, 1), Err(cq(E::ResidentStaleGeneration)));
    assert!(none(&w));
    // Mismatched: another world's link address.
    let other_link = pda(&[b"nft-citizen-link", &[9u8; 32], &ASSET], &GAME);
    let ix = w.join_ix(A, true, 0, other_link);
    assert!(w.h.send(&[ix], &[pk(A), pk(PAYER)]).is_err());
    assert!(none(&w));
    // Forged: the asset without its transfer guard; an asset of another
    // collection; a resident record of another asset.
    let keep = w.h.get(&pk(ASSET)).unwrap().clone();
    w.h.accounts.get_mut(&pk(ASSET)).unwrap().data = asset_bytes(&A, false);
    assert!(w.join(A, 0).is_err(), "unguarded asset");
    w.h.set(pk(ASSET), keep.clone());
    w.h.accounts.get_mut(&pk(ASSET)).unwrap().data[40] ^= 1;
    assert_eq!(w.join(A, 0), Err(cq(E::ResidentAsset)));
    w.h.set(pk(ASSET), keep);
    let keep_r = w.h.get(&pk(w.resident)).unwrap().clone();
    w.h.accounts.get_mut(&pk(w.resident)).unwrap().data[1] ^= 1;
    assert_eq!(w.join(A, 0), Err(cq(E::ResidentAccount)));
    w.h.set(pk(w.resident), keep_r);
    assert!(none(&w));
    // Forged: the asset account owned by another program than Core.
    let mut fake = w.h.get(&pk(ASSET)).unwrap().clone();
    let real = fake.clone();
    fake.owner = pk([0x66; 32]);
    w.h.set(pk(ASSET), fake);
    assert!(w.join(A, 0).is_err(), "asset not owned by Core");
    w.h.set(pk(ASSET), real);
    assert!(none(&w));
    // The correct join passes; a duplicate is refused and changes nothing.
    w.join(A, 0).expect("the correct join");
    let after = w.h.accounts.clone();
    assert!(w.join(A, 0).is_err());
    assert_eq!(w.h.accounts, after, "a refused duplicate changes nothing");
}
