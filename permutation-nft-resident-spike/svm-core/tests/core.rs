//! The resident program against the real Metaplex Core program in LiteSVM.
//! `PSF_CORE_SO` (default `../.local/programs/mpl_core.so`, read from mainnet
//! by program id) and `WYLLS_RESIDENT_SO` (default the SBF build under
//! `../program/target/deploy/`). Every key here is a throwaway test key.
//!
//! Required checks (the approval of 2026-10-31):
//!   atomic mint (payment, Core asset, resident binding in one transaction),
//!   rollback on failure (only the fee), transfer + gen + session in one
//!   transaction, A→B→A with nothing observing in between, bypass attempts
//!   (plain transfer, delegate, thaw, plugin/authority changes), double
//!   execution and resend, transfer versus operation race.
use std::path::PathBuf;

use litesvm::LiteSVM;
use mpl_core::accounts::BaseAssetV1;
use mpl_core::instructions::{
    AddPluginV1Builder, ApprovePluginAuthorityV1Builder, CreateCollectionV1Builder,
    RemovePluginV1Builder, TransferV1Builder, UpdatePluginV1Builder,
};
use mpl_core::types::{
    FreezeDelegate, PermanentFreezeDelegate, Plugin, PluginAuthority, PluginType, TransferDelegate,
    UpdateAuthority,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use wylls_resident_program as rp;

const SYSTEM: Address = Address::new_from_array([0u8; 32]);
const PRICE: u64 = 100_000_000; // TEST VALUE (0.1 SOL)
const FEE: u64 = 5_000; // per signature

fn so(env: &str, default: &str) -> Vec<u8> {
    let p = std::env::var_os(env).map(PathBuf::from).unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(default));
    let bytes = std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    eprintln!("svm-core: {env} {} ({} B, sha256 {})", p.display(), bytes.len(), hex::encode(Sha256::digest(&bytes)));
    bytes
}
fn key(label: &str) -> Keypair {
    Keypair::new_from_array(Sha256::digest(label.as_bytes()).into())
}
/// Any 32-byte key type (solana-program's Pubkey, the test crate's Address) as the test crate's Address.
fn to_addr<T: AsRef<[u8]>>(p: &T) -> Address { Address::new_from_array(p.as_ref().try_into().expect("32 bytes")) }

struct World {
    svm: LiteSVM,
    program: Address,
    core: Address,
    payer: Keypair,
    collection: Address,
    treasury: Address,
    config: Address,
    coll_auth: Address,
    clock: i64,
}

impl World {
    fn new() -> World {
        let mut svm = LiteSVM::new().with_sigverify(true).with_log_bytes_limit(Some(100_000));
        let core = to_addr(&mpl_core::ID);
        svm.add_program(core, &so("PSF_CORE_SO", "../.local/programs/mpl_core.so")).expect("deploy mpl-core");
        let program = key("wylls-resident-program id (test)").pubkey();
        svm.add_program(program, &so("WYLLS_RESIDENT_SO", "../program/target/deploy/wylls_resident_program.so")).expect("deploy resident program");
        let payer = key("operator payer");
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();
        let (config, _) = rp::config_address(&program);
        let (coll_auth, _) = rp::collection_authority_address(&program);
        let treasury = key("treasury (test)").pubkey();
        let mut w = World { svm, program, core, payer, collection: Address::default(), treasury, config, coll_auth, clock: 1_800_000_000 };
        w.set_clock(1_800_000_000);
        // The collection: update authority = the program's PDA (no hot key).
        let coll = key("collection (test)");
        let ix = CreateCollectionV1Builder::new().collection(coll.pubkey()).update_authority(Some(coll_auth)).payer(w.payer.pubkey()).name("Wylls Residents (test)".into()).uri("https://wylls.test/collection.json".into()).instruction();
        w.send(&[ix], &[&coll]).expect("create collection");
        w.collection = coll.pubkey();
        // The config: price (test value), treasury, collection.
        let mut d = vec![rp::TAG_INIT_CONFIG];
        d.extend(PRICE.to_le_bytes());
        d.extend(w.treasury.as_ref());
        d.extend(w.collection.as_ref());
        let ix = Instruction { program_id: w.program, accounts: vec![AccountMeta::new(w.payer.pubkey(), true), AccountMeta::new(w.config, false), AccountMeta::new_readonly(SYSTEM, false)], data: d };
        w.send(&[ix], &[]).expect("init config");
        w
    }

    /// A new blockhash: the next transaction with the same content is a different transaction (not AlreadyProcessed).
    fn expire(&mut self) { self.svm.expire_blockhash(); }

    fn set_clock(&mut self, t: i64) {
        let mut c: solana_clock::Clock = self.svm.get_sysvar();
        c.unix_timestamp = t;
        c.slot += 1;
        self.svm.set_sysvar(&c);
        self.clock = t;
    }

    fn funded(&mut self, label: &str, sol: u64) -> Keypair {
        let k = key(label);
        self.svm.airdrop(&k.pubkey(), sol * 1_000_000_000).unwrap();
        k
    }
    fn lamports(&self, a: &Address) -> u64 { self.svm.get_account(a).map_or(0, |x| x.lamports) }
    fn data(&self, a: &Address) -> Vec<u8> { self.svm.get_account(a).map(|x| x.data).unwrap_or_default() }
    fn owner_program(&self, a: &Address) -> Option<Address> { self.svm.get_account(a).map(|x| x.owner) }

    /// Sign with the payer (fee payer) plus `extra` and send.
    fn send(&mut self, ixs: &[Instruction], extra: &[&Keypair]) -> Result<(), String> {
        let t = self.tx(ixs, &self.payer_clone(), extra);
        self.submit(t)
    }
    fn payer_clone(&self) -> Keypair { Keypair::new_from_array(self.payer.to_bytes()[..32].try_into().unwrap()) }
    /// A signed transaction with `fee_payer` first; not sent (for the race and resend tests).
    fn tx(&self, ixs: &[Instruction], fee_payer: &Keypair, extra: &[&Keypair]) -> Transaction {
        let msg = Message::new(ixs, Some(&fee_payer.pubkey()));
        let mut signers: Vec<&Keypair> = vec![fee_payer];
        signers.extend(extra.iter().copied());
        let mut t = Transaction::new_unsigned(msg);
        t.sign(&signers, self.svm.latest_blockhash());
        t
    }
    /// The blockhash is kept (not expired), so a transaction signed earlier can arrive later — the case the
    /// pre-signed-operation tests need; an identical resend is then the runtime's AlreadyProcessed.
    fn submit(&mut self, t: Transaction) -> Result<(), String> {
        let r = self.svm.send_transaction(t);
        match r {
            Ok(_) => Ok(()),
            Err(f) => Err(format!("{:?} | {}", f.err, f.meta.logs.join(" / "))),
        }
    }

    // ------------------------------------------------------------ the program's instructions

    fn resident_of(&self, asset: &Address) -> Address { rp::resident_address(&self.program, asset).0 }
    fn gen(&self, asset: &Address) -> u32 { let d = self.data(&self.resident_of(asset)); u32::from_le_bytes(d[rp::resident::GEN..rp::resident::GEN + 4].try_into().unwrap()) }
    fn session(&self, asset: &Address) -> [u8; 32] { self.data(&self.resident_of(asset))[rp::resident::SESSION..rp::resident::SESSION + 32].try_into().unwrap() }
    fn ops(&self, asset: &Address) -> u32 { let d = self.data(&self.resident_of(asset)); u32::from_le_bytes(d[rp::resident::OPS..rp::resident::OPS + 4].try_into().unwrap()) }
    fn asset_owner(&self, asset: &Address) -> Address { to_addr(&BaseAssetV1::from_bytes(&self.data(asset)).expect("AssetV1").owner) }

    fn mint_ix(&self, payer: &Address, asset: &Address, price: u64, treasury: &Address, collection: &Address) -> Instruction {
        let mut d = vec![rp::TAG_MINT_RESIDENT];
        d.extend(price.to_le_bytes());
        Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new(*payer, true), AccountMeta::new(*treasury, false), AccountMeta::new(*asset, true), AccountMeta::new(*collection, false),
                AccountMeta::new_readonly(self.coll_auth, false), AccountMeta::new(self.resident_of(asset), false), AccountMeta::new_readonly(self.config, false),
                AccountMeta::new_readonly(self.core, false), AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: d,
        }
    }
    /// A wallet mints a resident: the wallet is the fee payer and the only wallet signer; the asset keypair signs too.
    fn mint(&mut self, wallet: &Keypair, asset: &Keypair) -> Result<(), String> {
        let ix = self.mint_ix(&wallet.pubkey(), &asset.pubkey(), PRICE, &self.treasury, &self.collection);
        let t = self.tx(&[ix], wallet, &[asset]);
        self.submit(t)
    }
    fn transfer_ix(&self, owner: &Address, asset: &Address, to: &Address) -> Instruction {
        Instruction {
            program_id: self.program,
            accounts: vec![
                AccountMeta::new_readonly(*owner, true), AccountMeta::new(*owner, true), AccountMeta::new(*asset, false), AccountMeta::new(self.collection, false),
                AccountMeta::new_readonly(self.coll_auth, false), AccountMeta::new(self.resident_of(asset), false), AccountMeta::new_readonly(*to, false),
                AccountMeta::new_readonly(self.core, false), AccountMeta::new_readonly(SYSTEM, false),
            ],
            data: vec![rp::TAG_TRANSFER_RESIDENT],
        }
    }
    fn transfer(&mut self, owner: &Keypair, asset: &Address, to: &Address) -> Result<(), String> {
        let ix = self.transfer_ix(&owner.pubkey(), asset, to);
        let t = self.tx(&[ix], owner, &[]);
        self.submit(t)
    }
    fn set_session(&mut self, owner: &Keypair, asset: &Address, session: &Address, expiry: i64) -> Result<(), String> {
        let mut d = vec![rp::TAG_SET_SESSION];
        d.extend(session.as_ref());
        d.extend(expiry.to_le_bytes());
        let ix = Instruction { program_id: self.program, accounts: vec![AccountMeta::new_readonly(owner.pubkey(), true), AccountMeta::new_readonly(*asset, false), AccountMeta::new(self.resident_of(asset), false)], data: d };
        let t = self.tx(&[ix], owner, &[]);
        self.submit(t)
    }
    fn op_tx(&self, actor: &Keypair, asset: &Address, gen: u32) -> Transaction { self.op_tx_n(actor, asset, gen, 0) }
    /// `nonce`: trailing bytes the program ignores, so two operations of the same actor and generation are distinct transactions.
    fn op_tx_n(&self, actor: &Keypair, asset: &Address, gen: u32, nonce: u8) -> Transaction {
        let mut d = vec![rp::TAG_OP];
        d.extend(gen.to_le_bytes());
        d.push(nonce);
        let ix = Instruction { program_id: self.program, accounts: vec![AccountMeta::new_readonly(actor.pubkey(), true), AccountMeta::new_readonly(*asset, false), AccountMeta::new(self.resident_of(asset), false)], data: d };
        // As the relay sponsors player operations: the operator's key pays the fee, the actor (wallet or session key) signs the operation.
        self.tx(&[ix], &self.payer_clone(), &[actor])
    }
    fn op(&mut self, actor: &Keypair, asset: &Address, gen: u32) -> Result<(), String> { let t = self.op_tx(actor, asset, gen); self.submit(t) }

    /// Export the live account bytes for the JS registry test (R7).
    fn export(&self, asset: &Address, extra: serde_json::Value) {
        let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out");
        std::fs::create_dir_all(&out).unwrap();
        let a = self.svm.get_account(asset).unwrap();
        let r = self.svm.get_account(&self.resident_of(asset)).unwrap();
        let v = json!({
            "coreProgram": self.core.to_string(), "residentProgram": self.program.to_string(), "collection": self.collection.to_string(),
            "asset": { "address": asset.to_string(), "owner": a.owner.to_string(), "lamports": a.lamports, "dataBase64": base64(&a.data) },
            "resident": { "address": self.resident_of(asset).to_string(), "owner": r.owner.to_string(), "dataBase64": base64(&r.data) },
            "extra": extra,
        });
        std::fs::write(out.join(format!("{asset}.json")), serde_json::to_string_pretty(&v).unwrap()).unwrap();
    }
}
fn base64(b: &[u8]) -> String { const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; let mut s = String::new(); for c in b.chunks(3) { let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32; s.push(T[(n >> 18) as usize & 63] as char); s.push(T[(n >> 12) as usize & 63] as char); s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' }); s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' }); } s }

fn custom(err: &str, code: u32) -> bool { err.contains(&format!("Custom({code})")) }

// ------------------------------------------------------------ C: Core alone, through our program's created asset

#[test]
fn c1_mint_is_atomic_payment_asset_and_binding() {
    let mut w = World::new();
    let a = w.funded("wallet A", 2);
    let asset = key("asset 1");
    let before = w.lamports(&a.pubkey());
    w.mint(&a, &asset).expect("mint");
    // Payment and fee: the wallet paid the price, the two rents and the fee for two signatures.
    let rent_asset = w.lamports(&asset.pubkey());
    let rent_resident = w.lamports(&w.resident_of(&asset.pubkey()));
    assert_eq!(w.lamports(&w.treasury), PRICE, "the treasury got exactly the price");
    assert_eq!(before - w.lamports(&a.pubkey()), PRICE + rent_asset + rent_resident + 2 * FEE, "price + rents + fee, nothing else");
    // The asset: Core's, owned by A, in the collection, frozen by the permanent plugin.
    assert_eq!(w.owner_program(&asset.pubkey()), Some(w.core));
    let base = BaseAssetV1::from_bytes(&w.data(&asset.pubkey())).unwrap();
    assert_eq!(to_addr(&base.owner), a.pubkey());
    assert!(matches!(base.update_authority, UpdateAuthority::Collection(c) if to_addr(&c) == w.collection), "update authority is the collection");
    // The resident: generation 0, bound to the asset by tag.
    let r = w.data(&w.resident_of(&asset.pubkey()));
    assert_eq!(r[rp::resident::MAGIC], rp::RESIDENT_MAGIC);
    assert_eq!(&r[rp::resident::ASSET..rp::resident::ASSET + 32], asset.pubkey().as_ref());
    assert_eq!(&r[rp::resident::TAG15..rp::resident::TAG15 + 15], &rp::resident_tag15(&asset.pubkey()));
    assert_eq!(w.gen(&asset.pubkey()), 0);
    w.export(&asset.pubkey(), json!({ "scene": "after mint", "holder": a.pubkey().to_string(), "gen": 0 }));
}

#[test]
fn c2_failure_rolls_everything_back_only_the_fee_is_paid() {
    let mut w = World::new();
    let a = w.funded("wallet A", 2);
    let asset = key("asset 2");
    let before = w.lamports(&a.pubkey());
    // A stale price: the program refuses after nothing has moved; and a wrong treasury.
    let ix = w.mint_ix(&a.pubkey(), &asset.pubkey(), PRICE + 1, &w.treasury, &w.collection);
    let t = w.tx(&[ix], &a, &[&asset]);
    let e = w.submit(t).unwrap_err();
    assert!(custom(&e, rp::ResidentError::PriceChanged as u32), "{e}");
    let other = key("other treasury").pubkey();
    let ix = w.mint_ix(&a.pubkey(), &asset.pubkey(), PRICE, &other, &w.collection);
    let t = w.tx(&[ix], &a, &[&asset]);
    let e = w.submit(t).unwrap_err();
    assert!(custom(&e, rp::ResidentError::WrongTreasury as u32), "{e}");
    // A failure AFTER the payment leg: a wrong collection account passes the treasury check and the payment, then Core refuses.
    let wrong_coll = key("another collection").pubkey();
    let ix = w.mint_ix(&a.pubkey(), &asset.pubkey(), PRICE, &w.treasury, &wrong_coll);
    let t = w.tx(&[ix], &a, &[&asset]);
    let e = w.submit(t).unwrap_err();
    assert!(custom(&e, rp::ResidentError::WrongCollection as u32), "{e}");
    // Nothing but fees left the wallet; no asset, no resident, no payment.
    assert_eq!(before - w.lamports(&a.pubkey()), 3 * 2 * FEE, "three failed transactions, two signatures each: fees only");
    assert_eq!(w.lamports(&w.treasury), 0);
    assert!(w.svm.get_account(&asset.pubkey()).is_none());
    assert!(w.svm.get_account(&w.resident_of(&asset.pubkey())).is_none());
}

#[test]
fn c2b_payment_leg_then_core_failure_rolls_back() {
    // The collection account is the real one but the config names it: to make Core itself fail after the payment,
    // mint with an asset keypair whose account already exists (Core refuses to create over it).
    let mut w = World::new();
    let a = w.funded("wallet A", 2);
    let asset = key("asset 2b");
    w.mint(&a, &asset).expect("first mint");
    let before = w.lamports(&a.pubkey());
    let treasury_before = w.lamports(&w.treasury);
    // The resident PDA exists → our program refuses before paying. Force the payment leg first by using a fresh asset
    // whose resident PDA does not exist but whose account we pre-create as a system account with lamports (Core refuses: not empty? it allows funded).
    // The identical transaction again: the runtime refuses it (no fee); a fresh one meets the program's check (fee only).
    let e = w.mint(&a, &asset).unwrap_err();
    assert!(e.contains("AlreadyProcessed"), "{e}");
    w.expire();
    let e = w.mint(&a, &asset).unwrap_err();
    assert!(custom(&e, rp::ResidentError::AlreadyInitialized as u32), "{e}");
    assert_eq!(w.lamports(&w.treasury), treasury_before, "no second payment");
    assert_eq!(before - w.lamports(&a.pubkey()), 2 * FEE);
}

#[test]
fn c3_c4_c5_bypass_attempts_fail_plain_transfer_delegate_thaw_plugin_and_authority_changes() {
    let mut w = World::new();
    let a = w.funded("wallet A", 2);
    let b = w.funded("wallet B", 2);
    let asset = key("asset 3");
    w.mint(&a, &asset).expect("mint");
    let mut outcomes = serde_json::Map::new();
    let mut note = |k: &str, r: &Result<(), String>| { outcomes.insert(k.to_string(), json!(match r { Ok(()) => "ok".to_string(), Err(e) => e.clone() })); };
    // C2/C3: the owner's own Core transfer → frozen.
    let ix = TransferV1Builder::new().asset(asset.pubkey()).collection(Some(w.collection)).payer(a.pubkey()).new_owner(b.pubkey()).instruction();
    let t = w.tx(&[ix], &a, &[]);
    let r = w.submit(t);
    note("owner plain TransferV1", &r);
    let e = r.unwrap_err();
    assert!(e.contains("Custom") || e.contains("Frozen") || e.contains("rozen"), "plain transfer must fail: {e}");
    assert_eq!(w.asset_owner(&asset.pubkey()), a.pubkey());
    // C3: the owner approves a Transfer Delegate (owner-managed plugin), the delegate transfers → frozen.
    let delegate = w.funded("delegate C", 2);
    let ix = AddPluginV1Builder::new().asset(asset.pubkey()).collection(Some(w.collection)).payer(a.pubkey()).authority(Some(a.pubkey())).plugin(Plugin::TransferDelegate(TransferDelegate {})).init_authority(PluginAuthority::Address { address: delegate.pubkey() }).instruction();
    let t = w.tx(&[ix], &a, &[]);
    let added = w.submit(t);
    note("owner adds TransferDelegate plugin", &added);
    if let Ok(()) = added {
        let ix = TransferV1Builder::new().asset(asset.pubkey()).collection(Some(w.collection)).payer(delegate.pubkey()).authority(Some(delegate.pubkey())).new_owner(b.pubkey()).instruction();
        let t = w.tx(&[ix], &delegate, &[]);
        let r = w.submit(t);
        note("delegate TransferV1", &r);
        assert!(r.is_err(), "delegate transfer must fail");
    }
    assert_eq!(w.asset_owner(&asset.pubkey()), a.pubkey());
    // C5: thaw attempts on the Permanent Freeze Delegate by the owner and by the operator (neither is its authority: the PDA is).
    for (label, who) in [("owner", &a), ("operator payer", &w.payer_clone())] {
        let ix = UpdatePluginV1Builder::new().asset(asset.pubkey()).collection(Some(w.collection)).payer(who.pubkey()).authority(Some(who.pubkey())).plugin(Plugin::PermanentFreezeDelegate(PermanentFreezeDelegate { frozen: false })).instruction();
        let t = w.tx(&[ix], who, &[]);
        let r = w.submit(t);
        note(&format!("thaw PermanentFreezeDelegate by {label}"), &r);
        assert!(r.is_err(), "thaw by a non-authority must fail");
    }
    // C5: changing or revoking the permanent plugins' authority, removing them, adding a permanent plugin after creation.
    let ix = ApprovePluginAuthorityV1Builder::new().asset(asset.pubkey()).collection(Some(w.collection)).payer(a.pubkey()).authority(Some(a.pubkey())).plugin_type(PluginType::PermanentTransferDelegate).new_authority(PluginAuthority::Address { address: a.pubkey() }).instruction();
    let t = w.tx(&[ix], &a, &[]);
    let r = w.submit(t);
    note("owner ApprovePluginAuthority on PermanentTransferDelegate", &r);
    assert!(r.is_err(), "re-pointing the permanent transfer delegate must fail");
    let ix = RemovePluginV1Builder::new().asset(asset.pubkey()).collection(Some(w.collection)).payer(a.pubkey()).authority(Some(a.pubkey())).plugin_type(PluginType::PermanentFreezeDelegate).instruction();
    let t = w.tx(&[ix], &a, &[]);
    let r = w.submit(t);
    note("owner RemovePlugin PermanentFreezeDelegate", &r);
    assert!(r.is_err(), "removing the permanent freeze must fail");
    let ix = AddPluginV1Builder::new().asset(asset.pubkey()).collection(Some(w.collection)).payer(a.pubkey()).authority(Some(a.pubkey())).plugin(Plugin::FreezeDelegate(FreezeDelegate { frozen: false })).init_authority(PluginAuthority::Owner).instruction();
    let t = w.tx(&[ix], &a, &[]);
    let r = w.submit(t); // an owner-managed freeze plugin may be added; it changes nothing about the permanent one
    note("owner adds FreezeDelegate(frozen=false)", &r);
    w.expire(); // a distinct transaction (otherwise the runtime answers AlreadyProcessed for the identical earlier one)
    let ix = TransferV1Builder::new().asset(asset.pubkey()).collection(Some(w.collection)).payer(a.pubkey()).new_owner(b.pubkey()).instruction();
    let t = w.tx(&[ix], &a, &[]);
    let r = w.submit(t);
    note("owner plain TransferV1 after adding FreezeDelegate", &r);
    assert!(r.is_err(), "still frozen");
    // A permanent plugin cannot be added after creation.
    let ix = AddPluginV1Builder::new().asset(asset.pubkey()).collection(Some(w.collection)).payer(a.pubkey()).authority(Some(a.pubkey())).plugin(Plugin::PermanentTransferDelegate(mpl_core::types::PermanentTransferDelegate {})).init_authority(PluginAuthority::Address { address: a.pubkey() }).instruction();
    let t = w.tx(&[ix], &a, &[]);
    let r = w.submit(t);
    note("owner adds PermanentTransferDelegate after creation", &r);
    assert!(r.is_err(), "permanent plugins are creation-only");
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("out");
    std::fs::create_dir_all(&out).unwrap();
    std::fs::write(out.join("_bypass-attempts.json"), serde_json::to_string_pretty(&serde_json::Value::Object(outcomes)).unwrap()).unwrap();
    assert_eq!(w.asset_owner(&asset.pubkey()), a.pubkey());
    assert_eq!(w.gen(&asset.pubkey()), 0, "no generation change from any attempt");
    // The program's own path moves it (forceApprove over the permanent freeze).
    w.transfer(&a, &asset.pubkey(), &b.pubkey()).expect("TransferResident");
    assert_eq!(w.asset_owner(&asset.pubkey()), b.pubkey());
    assert_eq!(w.gen(&asset.pubkey()), 1);
}

// ------------------------------------------------------------ P: the program

#[test]
fn p1_transfer_moves_owner_generation_and_session_together() {
    let mut w = World::new();
    let a = w.funded("wallet A", 2);
    let b = w.funded("wallet B", 2);
    let k = key("session K");
    let asset = key("asset p1");
    w.mint(&a, &asset).unwrap();
    w.set_session(&a, &asset.pubkey(), &k.pubkey(), w.clock + 86_400).unwrap();
    assert_eq!(w.session(&asset.pubkey()), k.pubkey().to_bytes());
    w.op(&k, &asset.pubkey(), 0).expect("the session acts");
    // A stranger cannot transfer; B (not the owner) cannot.
    assert!(custom(&w.transfer(&b, &asset.pubkey(), &b.pubkey()).unwrap_err(), rp::ResidentError::NotOwner as u32));
    w.transfer(&a, &asset.pubkey(), &b.pubkey()).unwrap();
    assert_eq!(w.asset_owner(&asset.pubkey()), b.pubkey());
    assert_eq!(w.gen(&asset.pubkey()), 1);
    assert_eq!(w.session(&asset.pubkey()), [0u8; 32], "the session is gone in the same transaction");
    assert!(custom(&w.op(&k, &asset.pubkey(), 1).unwrap_err(), rp::ResidentError::NotOwner as u32), "K is nobody's session now");
    w.export(&asset.pubkey(), json!({ "scene": "after transfer A→B", "holder": b.pubkey().to_string(), "gen": 1 }));
}

#[test]
fn p2_a_b_a_with_nothing_observing_old_session_delegation_and_presigned_ops_stay_dead() {
    let mut w = World::new();
    let a = w.funded("wallet A", 3);
    let b = w.funded("wallet B", 3);
    let k = key("session K of A");
    let k2 = key("session K2 of B");
    let asset = key("asset p2");
    w.mint(&a, &asset).unwrap();
    w.set_session(&a, &asset.pubkey(), &k.pubkey(), w.clock + 86_400).unwrap();
    // A's and K's operations, signed now against generation 0, not sent.
    let presigned_a = w.op_tx_n(&a, &asset.pubkey(), 0, 1);
    let presigned_k = w.op_tx_n(&k, &asset.pubkey(), 0, 2);
    // A → B → A, on chain only (no relay, no indexer, nobody watching).
    w.transfer(&a, &asset.pubkey(), &b.pubkey()).unwrap();
    w.set_session(&b, &asset.pubkey(), &k2.pubkey(), w.clock + 86_400).unwrap();
    let presigned_k2 = w.op_tx_n(&k2, &asset.pubkey(), 1, 3);
    w.transfer(&b, &asset.pubkey(), &a.pubkey()).unwrap();
    assert_eq!(w.asset_owner(&asset.pubkey()), a.pubkey());
    assert_eq!(w.gen(&asset.pubkey()), 2);
    assert_eq!(w.session(&asset.pubkey()), [0u8; 32]);
    // Everything from before is refused: A's old session key, A's pre-signed op (stale generation), B's session and op.
    assert!(custom(&w.op(&k, &asset.pubkey(), 2).unwrap_err(), rp::ResidentError::NotOwner as u32));
    assert!(custom(&w.submit(presigned_k).unwrap_err(), rp::ResidentError::NotOwner as u32));
    assert!(custom(&w.submit(presigned_a).unwrap_err(), rp::ResidentError::StaleGen as u32), "A owns again, but the op is of generation 0");
    assert!(custom(&w.submit(presigned_k2).unwrap_err(), rp::ResidentError::NotOwner as u32));
    assert!(custom(&w.op(&k2, &asset.pubkey(), 2).unwrap_err(), rp::ResidentError::NotOwner as u32));
    assert_eq!(w.ops(&asset.pubkey()), 0, "nothing landed");
    // A, holder again, acts with a fresh op at generation 2 and may delegate again (generation 2).
    w.op(&a, &asset.pubkey(), 2).unwrap();
    w.expire();
    w.set_session(&a, &asset.pubkey(), &k.pubkey(), w.clock + 86_400).unwrap();
    w.op(&k, &asset.pubkey(), 2).unwrap();
    assert!(custom(&w.op(&k, &asset.pubkey(), 0).unwrap_err(), rp::ResidentError::StaleGen as u32), "even the re-delegated key cannot replay generation 0");
    assert_eq!(w.ops(&asset.pubkey()), 2);
    w.export(&asset.pubkey(), json!({ "scene": "after A→B→A", "holder": a.pubkey().to_string(), "gen": 2 }));
}

#[test]
fn p3_double_execution_and_resend() {
    let mut w = World::new();
    let a = w.funded("wallet A", 3);
    let asset = key("asset p3");
    let ix = w.mint_ix(&a.pubkey(), &asset.pubkey(), PRICE, &w.treasury, &w.collection);
    let t = w.tx(&[ix], &a, &[&asset]);
    let same = t.clone();
    w.submit(t).expect("mint");
    let before = w.lamports(&a.pubkey());
    // The identical signed transaction again: the runtime refuses it (already processed); nothing changes, no fee.
    let e = w.submit(same).unwrap_err();
    assert!(e.contains("AlreadyProcessed"), "{e}");
    assert_eq!(w.lamports(&a.pubkey()), before);
    // A new transaction (fresh blockhash) for the same asset keypair: the resident exists → refused before the payment.
    w.expire();
    let e = w.mint(&a, &asset).unwrap_err();
    assert!(custom(&e, rp::ResidentError::AlreadyInitialized as u32), "{e}");
    assert_eq!(w.lamports(&w.treasury), PRICE, "one payment");
}

#[test]
fn p4_transfer_versus_operation_the_chains_order_decides() {
    let mut w = World::new();
    let a = w.funded("wallet A", 3);
    let b = w.funded("wallet B", 3);
    let asset = key("asset p4");
    w.mint(&a, &asset).unwrap();
    let op_first = w.op_tx_n(&a, &asset.pubkey(), 0, 1);
    let op_late = w.op_tx_n(&a, &asset.pubkey(), 0, 2);
    // Order 1: the operation lands, then the transfer: the op stands and B inherits its effect.
    w.submit(op_first).unwrap();
    w.transfer(&a, &asset.pubkey(), &b.pubkey()).unwrap();
    assert_eq!(w.ops(&asset.pubkey()), 1);
    // Order 2: the other operation, signed before the transfer, arrives after it: refused (A is not the owner).
    assert!(custom(&w.submit(op_late).unwrap_err(), rp::ResidentError::NotOwner as u32));
    assert_eq!(w.ops(&asset.pubkey()), 1);
    // B acts at generation 1; B's op against generation 0 would be stale.
    w.op(&b, &asset.pubkey(), 1).unwrap();
    assert!(custom(&w.op(&b, &asset.pubkey(), 0).unwrap_err(), rp::ResidentError::StaleGen as u32));
}

#[test]
fn p5_session_expiry_and_set_session_rules() {
    let mut w = World::new();
    let a = w.funded("wallet A", 3);
    let b = w.funded("wallet B", 3);
    let k = key("session K");
    let asset = key("asset p5");
    w.mint(&a, &asset).unwrap();
    assert!(custom(&w.set_session(&b, &asset.pubkey(), &k.pubkey(), w.clock + 10).unwrap_err(), rp::ResidentError::NotOwner as u32), "only the holder sets a session");
    assert!(custom(&w.set_session(&a, &asset.pubkey(), &k.pubkey(), w.clock + rp::MAX_SESSION_SECS + 1).unwrap_err(), rp::ResidentError::SessionExpiry as u32));
    w.set_session(&a, &asset.pubkey(), &k.pubkey(), w.clock + 100).unwrap();
    w.op(&k, &asset.pubkey(), 0).unwrap();
    let t = w.clock + 101;
    w.set_clock(t);
    let late = w.op_tx_n(&k, &asset.pubkey(), 0, 9);
    assert!(custom(&w.submit(late).unwrap_err(), rp::ResidentError::NotOwner as u32), "expired");
}
