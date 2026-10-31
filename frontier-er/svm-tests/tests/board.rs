//! The board program (SBPF v2 build of `frontier-er/program`) against the
//! **real** delegation program binary in LiteSVM: delegate, base writes
//! refused while delegated, the escape (request by the authority only,
//! refused before the timeout, rollback after it) and compare-and-set
//! writes resuming on the restored version. **Local results** (LiteSVM,
//! no validator, no ER): commit, finalize and undelegate are validator
//! instructions and run in the local ER stack instead.
//!
//! `ERB_SO` (default `../target/deploy/frontier_er_board.so`) and `DLP_SO`
//! (a dump of `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`) must exist;
//! the test fails, not skips, without them.

use frontier_er::board::{self, Write, PAYLOAD_LEN};
use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const WORLD: u64 = 7;
const SYSTEM: Address = Address::new_from_array([0; 32]);
const UNDELEGATION_TIMEOUT_SLOTS: u64 = 9_000;

fn dlp_id() -> Address {
    "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        .parse()
        .unwrap()
}

fn erb_id() -> Address {
    Address::new_from_array([0xE5; 32])
}

struct Fx {
    svm: LiteSVM,
    auth: Keypair,
    other: Keypair,
    validator: Keypair,
    board: Address,
}

fn pda(seeds: &[&[u8]], prog: &Address) -> Address {
    Address::find_program_address(seeds, prog).0
}

impl Fx {
    fn new() -> Fx {
        let erb = std::env::var("ERB_SO")
            .unwrap_or_else(|_| "../target/deploy/frontier_er_board.so".into());
        let dlp = std::env::var("DLP_SO").expect("DLP_SO: path of the delegation program dump");
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(erb_id(), &erb)
            .expect("board program");
        svm.add_program_from_file(dlp_id(), &dlp)
            .expect("delegation program");
        let (auth, other, validator) = (Keypair::new(), Keypair::new(), Keypair::new());
        for k in [&auth, &other, &validator] {
            svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }
        let board = pda(&[b"wylls-er-board", &WORLD.to_le_bytes()], &erb_id());
        Fx {
            svm,
            auth,
            other,
            validator,
            board,
        }
    }

    fn send(&mut self, ix: Instruction, signers: &[&Keypair]) -> Result<(), String> {
        let msg = Message::new(&[ix], Some(&signers[0].pubkey()));
        let tx = Transaction::new(signers, msg, self.svm.latest_blockhash());
        let r = self
            .svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{:?}", e.err));
        self.svm.expire_blockhash();
        r
    }

    fn ix(&self, disc: u64, args: &[u8], accounts: Vec<AccountMeta>) -> Instruction {
        let mut data = disc.to_le_bytes().to_vec();
        data.extend_from_slice(&WORLD.to_le_bytes());
        data.extend_from_slice(args);
        Instruction {
            program_id: erb_id(),
            accounts,
            data,
        }
    }

    fn init(&mut self) {
        let ix = self.ix(
            0,
            &[],
            vec![
                AccountMeta::new(self.auth.pubkey(), true),
                AccountMeta::new(self.board, false),
                AccountMeta::new_readonly(SYSTEM, false),
            ],
        );
        let a = self.auth.insecure_clone();
        self.send(ix, &[&a]).unwrap();
    }

    fn write(&mut self, w: &Write, who: &Keypair) -> Result<(), String> {
        let mut args = w.expect_seq.to_le_bytes().to_vec();
        args.extend_from_slice(&w.expect_head);
        args.extend_from_slice(&w.req_id);
        args.extend_from_slice(&w.payload);
        args.extend_from_slice(&w.bell.to_le_bytes());
        let ix = self.ix(
            1,
            &args,
            vec![
                AccountMeta::new(who.pubkey(), true),
                AccountMeta::new(self.board, false),
            ],
        );
        self.send(ix, &[who])
    }

    fn delegate(&mut self, who: &Keypair) -> Result<(), String> {
        let b = self.board;
        let ix = self.ix(
            2,
            &[],
            vec![
                AccountMeta::new(who.pubkey(), true),
                AccountMeta::new_readonly(SYSTEM, false),
                AccountMeta::new(b, false),
                AccountMeta::new_readonly(erb_id(), false),
                AccountMeta::new(pda(&[b"buffer", b.as_ref()], &erb_id()), false),
                AccountMeta::new(pda(&[b"delegation", b.as_ref()], &dlp_id()), false),
                AccountMeta::new(pda(&[b"delegation-metadata", b.as_ref()], &dlp_id()), false),
                AccountMeta::new_readonly(dlp_id(), false),
                AccountMeta::new_readonly(self.validator.pubkey(), false),
            ],
        );
        self.send(ix, &[who])
    }

    fn request(&mut self, who: &Keypair) -> Result<(), String> {
        let b = self.board;
        let ix = self.ix(
            5,
            &[],
            vec![
                AccountMeta::new(who.pubkey(), true),
                AccountMeta::new(b, false),
                AccountMeta::new_readonly(erb_id(), false),
                AccountMeta::new(
                    pda(&[b"undelegation-request", b.as_ref()], &dlp_id()),
                    false,
                ),
                AccountMeta::new_readonly(pda(&[b"delegation", b.as_ref()], &dlp_id()), false),
                AccountMeta::new(pda(&[b"delegation-metadata", b.as_ref()], &dlp_id()), false),
                AccountMeta::new_readonly(SYSTEM, false),
                AccountMeta::new_readonly(dlp_id(), false),
            ],
        );
        self.send(ix, &[who])
    }

    fn rollback(&mut self, payer: &Keypair) -> Result<(), String> {
        let b = self.board;
        let ix = self.ix(
            6,
            &[],
            vec![
                AccountMeta::new(b, false),
                AccountMeta::new_readonly(erb_id(), false),
                AccountMeta::new(
                    pda(&[b"undelegation-request", b.as_ref()], &dlp_id()),
                    false,
                ),
                AccountMeta::new(pda(&[b"delegation", b.as_ref()], &dlp_id()), false),
                AccountMeta::new(pda(&[b"delegation-metadata", b.as_ref()], &dlp_id()), false),
                AccountMeta::new(self.auth.pubkey(), false),
                AccountMeta::new(pda(&[b"state-diff", b.as_ref()], &dlp_id()), false),
                AccountMeta::new(pda(&[b"commit-state-record", b.as_ref()], &dlp_id()), false),
                AccountMeta::new(self.validator.pubkey(), false),
                AccountMeta::new_readonly(dlp_id(), false),
            ],
        );
        self.send(ix, &[payer])
    }

    fn board_acct(&self) -> Account {
        self.svm.get_account(&self.board).expect("board")
    }

    fn slot(&self) -> u64 {
        self.svm.get_sysvar::<solana_clock::Clock>().slot
    }
}

/// A write built on the board's current base bytes.
fn w(f: &Fx, p: u8) -> Write {
    Write::on(
        &f.board.to_bytes(),
        &f.board_acct().data,
        [p; PAYLOAD_LEN],
        1,
    )
    .unwrap()
}

#[test]
fn delegate_then_the_escape_restores_the_last_base_state() {
    let mut f = Fx::new();
    f.init();
    let auth = f.auth.insecure_clone();
    let other = f.other.insecure_clone();

    // Base writes with compare-and-set.
    let w1 = w(&f, 1);
    f.write(&w1, &other).unwrap();
    let (w2, rival) = (w(&f, 2), w(&f, 3));
    f.write(&w2, &other).unwrap();
    assert!(
        f.write(&w2, &other).unwrap_err().contains("Custom(5)"),
        "duplicate"
    );
    assert!(
        f.write(&rival, &other).unwrap_err().contains("Custom(4)"),
        "stale"
    );
    let before = f.board_acct();
    assert_eq!(board::header(&before.data).unwrap().0, 2);

    // Only the authority delegates.
    assert!(f.delegate(&other).unwrap_err().contains("Custom(3)"));
    f.delegate(&auth).unwrap();
    let a = f.board_acct();
    assert_eq!(
        a.owner,
        dlp_id(),
        "owned by the delegation program on the base"
    );
    assert_eq!(a.data, before.data, "the base keeps the last state");
    let record = f
        .svm
        .get_account(&pda(&[b"delegation", f.board.as_ref()], &dlp_id()));
    assert!(record.is_some_and(|r| r.owner == dlp_id()));
    // Delegating again is refused (not program-owned).
    assert!(f.delegate(&auth).is_err());
    // Base writes are refused while delegated.
    let w3 = w(&f, 4);
    assert!(f.write(&w3, &other).unwrap_err().contains("Custom(8)"));
    // A rollback without a request is refused.
    assert!(f.rollback(&other).is_err());

    // The escape: only the authority (the rent payer) requests.
    assert!(f.request(&other).is_err());
    f.request(&auth).unwrap();
    let req = f.svm.get_account(&pda(
        &[b"undelegation-request", f.board.as_ref()],
        &dlp_id(),
    ));
    assert!(req.is_some(), "request PDA");
    // Refused before the timeout…
    assert!(f.rollback(&other).is_err());
    let s = f.slot();
    f.svm.warp_to_slot(s + UNDELEGATION_TIMEOUT_SLOTS - 10);
    assert!(f.rollback(&other).is_err(), "still early");
    // …permissionless after it.
    f.svm.warp_to_slot(s + UNDELEGATION_TIMEOUT_SLOTS + 1);
    f.rollback(&other).unwrap();
    let back = f.board_acct();
    assert_eq!(back.owner, erb_id());
    assert_eq!(board::header(&back.data), board::header(&before.data));
    assert_eq!(board::rolled_back_at(&back.data), Some(2));
    for tag in [
        &b"delegation"[..],
        b"delegation-metadata",
        b"undelegation-request",
    ] {
        assert!(
            f.svm
                .get_account(&pda(&[tag, f.board.as_ref()], &dlp_id()))
                .is_none_or(|a| a.lamports == 0),
            "{:?} closed",
            std::str::from_utf8(tag)
        );
    }
    // Writes resume on the restored version; the world goes on.
    f.write(&w3, &other).unwrap();
    assert_eq!(board::header(&f.board_acct().data).unwrap().0, 3);
    // And it can be delegated again (a new session).
    f.delegate(&auth).unwrap();
    assert_eq!(f.board_acct().owner, dlp_id());
}
