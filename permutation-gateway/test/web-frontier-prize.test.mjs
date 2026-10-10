// The prize pool on the page (テストUSDC, local test chain): the model of
// the relay's pool view, the join screen's terms (only for a season with a
// pool), the 賞金 panel (pool, area and winner from the chain, achievements,
// the split labelled 試算), the paid Join through the SDK's x402 helper, and
// the controller's periodic read.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { tokenUnits, prizeModel, ledgerModel, loadPrize, loadLedger, payAndJoin } from '../../permutation-server/web/frontier/fprize.mjs';
import { render as panel, renderJoinTerms } from '../../permutation-server/web/frontier/screens/prize.mjs';
import { render as join } from '../../permutation-server/web/frontier/screens/join.mjs';
import { setRelay } from '../../permutation-server/web/frontier/fchainio.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import { refreshPrize, usePrize } from '../../permutation-server/web/frontier/controller.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { signTalk } from '../client/src/talk-node.mjs';
import { parseTransaction, wireTransaction } from '../client/src/solana-tx.mjs';
import { FrontierAddresses } from '../client/src/frontier/addresses.mjs';
import { classifyPaidJoin, prizeAddresses, x402Decode, x402Encode } from '../client/src/frontier/prize.mjs';

afterEach(() => { setLang('ja'); setRelay(''); usePrize(null); FS.prize = null; FS.prizeLedger = null; });
const plain = s => String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const site = { p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0 };
const fs = (extra = {}) => ({ mode: 'play', season: { programVersion: 3, joinGate: new Uint8Array(32).fill(1) }, meStatus: 'ready', citizen: null, holdings: [], provinces: new Map(), nowBell: 10,
  chain: { now: () => 1000 }, land: { stage: 'none' }, ui: { dismissed: [] }, homeChoice: { candidates: [site], selected: site }, ...extra });
const WALLET = Keypair.generate().publicKey.toBase58();
const pool = (extra = {}) => ({ testAssetsOnly: true, decimals: 6, fee: '25000000', opsBps: 2000, prizeBps: 8000, entries: 2, collected: '50000000', prize: '40000000', ops: '10000000',
  state: 'open', expectedKeeps: 54, counted: 0, area: null, winners: null, shares: null, ...extra });
const ledger = () => ({ provisional: true, provisionalRules: ['tie'], kinds: { capture: { derivable: true }, reinforcement: { derivable: true }, defence: { derivable: false, reason: 'r', missingRecord: 'm' } },
  lines: [
    { kind: 'capture', wallet: WALLET, nation: 1, province: { p: 4, q: 0 }, quantity: 1, unit: 'province', bell: 240, points: 10, eligible: true, signatures: ['5capSig1111111111'] },
    { kind: 'reinforcement', wallet: 'SupporterWallet1111', nation: 1, province: { p: 4, q: 0 }, quantity: 400, unit: 'troops', bell: 166, points: 4, eligible: true, signatures: ['3supSig2222222222'] }],
  shares: { mode: 'shares' },
  estimate: { split: [{ wallet: WALLET, nation: 1, points: 10, amount: '28571428' }, { wallet: 'SupporterWallet1111', nation: 1, points: 4, amount: '11428571' }] } });

test('amounts are whole test USDC; the model carries the 80/20 split of one fee and of the pool', () => {
  assert.deepEqual(['25000000', '7500000', '1', '0', '28571428'].map(v => tokenUnits(v)), ['25', '7.5', '0.000001', '0', '28.571428']);
  const m = prizeModel(pool({ wallet: { address: WALLET, balance: '100000000', faction: null, entry: null } }));
  assert.deepEqual([m.fee, m.feeToPrize, m.feeToOps, m.prizePct, m.opsPct, m.collected, m.prize, m.ops, m.entries], ['25', '20', '5', 80, 20, '50', '40', '10', 2]);
  assert.deepEqual([m.wallet.balance, m.wallet.paid, m.wallet.canPay, m.final, m.area], ['100', false, true, false, null]);
  assert.equal(prizeModel(null), null);
  const done = prizeModel(pool({ state: 'final', counted: 54, area: [8, 10, 9, 9, 9, 9], winners: [1] }));
  assert.deepEqual([done.final, done.winners, done.area[1], done.area[0].winner], [true, [1], { faction: 1, provinces: 10, winner: true }, false]);
});

test('the join screen states the fee, the x402 payment and the pool only for a season with a pool; an invite is asked only without one', () => {
  const without = String(join(fs()));
  assert.doesNotMatch(without, /テストUSDC|賞金/);
  assert.match(without, /name="invite"/, 'a gated season without a pool still asks for the invite');
  const withPool = plain(join(fs({ prize: pool({ wallet: { address: WALLET, balance: '0', faction: null, entry: null } }) })));
  assert.match(withPool, /参加費は 25 テストUSDC です/);
  assert.match(withPool, /x402/);
  assert.match(withPool, /賞金プールへ（80%） 20/);
  assert.match(withPool, /運営へ（20%） 5/);
  assert.match(withPool, /いまの賞金プール 40/);
  assert.match(withPool, /このウォレットのテストUSDC：0/);
  assert.match(withPool, /価値はありません/);
  assert.doesNotMatch(String(join(fs({ prize: pool() }))), /name="invite"/);
  assert.match(String(join(fs({ prize: pool({ wallet: { address: WALLET, balance: '0', faction: null, entry: null } }) }))), /data-act="prize-faucet"/);
  assert.equal(String(renderJoinTerms(fs())), '');
  // The old sentence is replaced only where a pool exists (and stays truthful where none does).
  const src = readFileSync(new URL('../../permutation-server/web/frontier/screens/join.mjs', import.meta.url), 'utf8');
  assert.match(src, /FS\.prize \? html`[^]*?: html`<p class="muted">\$\{L`M1 では賞金はありません。/);
  setLang('en');
  const en = plain(join(fs({ prize: pool() })));
  assert.match(en, /The entry fee is 25 test USDC/);
  assert.doesNotMatch(plain(renderJoinTerms(fs({ prize: pool() }))), /[぀-ヿ㐀-鿿]/);
});

test('the 賞金 panel: the pool while open; after the end the chain\'s area and winner, attackers and supporters with signatures, and the split as 試算', () => {
  assert.equal(String(panel(fs())), '');
  const open = plain(panel(fs({ prize: pool() })));
  assert.match(open, /集まった参加費 50/);
  assert.match(open, /賞金プール（80%） 40/);
  assert.match(open, /運営（20%） 10/);
  assert.match(open, /最も多くの州（砦）を持つ国/);
  assert.doesNotMatch(open, /試算/);
  const counting = plain(panel(fs({ prize: pool({ counted: 16, area: [3, 3, 3, 3, 2, 2] }) })));
  assert.match(counting, /集計中です（16 \/ 54 州）/);
  const done = fs({ wallet: { address: WALLET }, prize: pool({ state: 'final', counted: 54, area: [8, 10, 9, 9, 9, 9], winners: [1] }), prizeLedger: ledger() });
  const text = plain(panel(done));
  assert.match(text, /結果は確定しました/);
  assert.match(text, /攻略した人/);
  assert.match(text, /増援した人/);
  assert.match(text, /兵 400/);
  assert.match(text, /第240ターン/);
  assert.doesNotMatch(text, /鐘/);
  // An AI citizen's or a script bot's line is labelled, and the page says its land still counts for the nation.
  const withBot = { ...done, prizeLedger: { ...ledger(), lines: [...ledger().lines, { kind: 'capture', wallet: 'BotWallet11111111', nation: 1, province: { p: 3, q: 1 }, quantity: 1, unit: 'province', bell: 300, points: 0, eligible: false, player: 'operatorInvited', signatures: ['4botSig'] }] } };
  assert.match(plain(panel(withBot)), /AI市民・ボット（賞金の対象外）/);
  assert.match(plain(panel(withBot)), /その国の州の数に入ります/);
  assert.doesNotMatch(text, /AI市民/);
  assert.match(text, /（あなた）/);
  assert.match(String(panel(done)), /title="5capSig1111111111"/);
  assert.match(text, /これは試算です。送金は行われていません。/);
  assert.match(text, /試算 28\.571428 テストUSDC/);
  assert.match(text, /防衛：いまのチェーンの記録からは求められません。/);
  assert.match(plain(panel({ ...done, prizeLedger: null })), /功績の記録はまだ公開されていません/);
  // Shares posted and claims paid (the deferred step): the panel no longer says that nothing was transferred.
  const paid = plain(panel({ ...done, prize: pool({ state: 'shares', counted: 54, area: [8, 10, 9, 9, 9, 9], winners: [1], shares: { mode: 'shares', claims: 2, claimed: '39999999' } }) }));
  assert.match(paid, /受け取りは 2 件・合計 39\.999999 テストUSDC/);
  assert.doesNotMatch(paid, /送金は行われていません/);
  const g = ledgerModel(ledger(), { wallet: WALLET });
  assert.deepEqual([g.attackers.length, g.supporters.length, g.attackers[0].mine, g.notDerivable.map(k => k.kind), g.estimate[0].amount], [1, 1, true, ['defence'], '28.571428']);
  setLang('en');
  const en = plain(panel(done));
  assert.match(en, /This is an estimate\. No transfer has been made\./);
  assert.match(en, /estimate 28\.571428 test USDC/);
  assert.doesNotMatch(en, /[぀-ヿ㐀-鿿]/);
});

test('reads: a season without a pool is `pool: null`, never an error; the ledger is null until published; the controller keeps both', async () => {
  setRelay('http://relay.test/gw');
  const answers = { '/f/prize': [404, { error: 'none', code: 'NoPrizePool' }], '/f/prize/ledger': [404, { code: 'LedgerNotPublished' }] };
  const f = async url => { const [status, body] = answers[new URL(url).pathname.replace('/gw', '')]; return { ok: status < 400, status, json: async () => body }; };
  assert.deepEqual(await loadPrize(null, { fetch: f }), { ok: true, pool: null });
  assert.deepEqual(await loadLedger({ fetch: f }), { ok: true, ledger: null });
  answers['/f/prize'] = [200, pool()];
  assert.equal((await loadPrize(WALLET, { fetch: f })).pool.fee, '25000000');
  let reads = 0;
  usePrize({ loadPrize: async () => { reads++; return { ok: true, pool: pool({ state: 'final', counted: 54, area: [9, 9, 9, 9, 9, 9], winners: [0] }) }; }, loadLedger: async () => ({ ok: true, ledger: ledger() }) });
  await refreshPrize({ force: true, at: 1_000_000 });
  await refreshPrize({ at: 1_000_500 });
  assert.deepEqual([reads, FS.prize.state, FS.prizeLedger.lines.length], [1, 'final', 2]);
});

test('the paid Join from the page: one 402, then the wallet-signed Pay and Join in one transaction with the X-PAYMENT header', async () => {
  setRelay('http://relay.test/gw');
  const w = Keypair.generate();
  const wallet = { address: w.publicKey.toBase58(), signTransaction: async wire => { const tx = parseTransaction(wire); return wireTransaction(tx.message, { [w.publicKey.toBase58()]: signTalk(tx.message, w) }); } };
  const session = { publicKeyBytes: Keypair.generate().publicKey.toBytes() };
  const program = Keypair.generate().publicKey.toBase58(), prizeProgram = Keypair.generate().publicKey.toBase58(), mint = Keypair.generate().publicKey.toBase58();
  const A = new FrontierAddresses({ programId: program, seasonId: 9n });
  const prize = prizeAddresses({ prizeProgram, gameProgram: program, seasonId: 9n, mint });
  const gate = Keypair.generate().publicKey.toBase58(), feePayer = Keypair.generate().publicKey.toBase58();
  const accepts = [{ scheme: 'exact', network: 'solana-localnet', maxAmountRequired: '25000000', payTo: prize.vault, asset: mint,
    extra: { feePayer, recentBlockhash: Keypair.generate().publicKey.toBase58(), programId: program, seasonId: '9', season: A.season, profile: 2, joinGate: gate, prizeProgram, pool: prize.pool } }];
  const calls = [];
  const f = async (url, init) => {
    calls.push({ path: new URL(url).pathname, payment: init.headers['X-PAYMENT'] ?? null });
    if (!init.headers['X-PAYMENT']) return { status: 402, headers: { get: () => null }, json: async () => ({ x402Version: 1, accepts }) };
    const tx = parseTransaction(Buffer.from(x402Decode(init.headers['X-PAYMENT']).payload.transaction, 'base64'));
    const c = classifyPaidJoin(tx, { programId: program, prize, profile: 2 });
    assert.equal(c.ok, true, c.problem);
    assert.deepEqual([c.wallet, c.join.data.faction, c.join.accounts.join_gate], [wallet.address, 3, gate]);
    return { status: 200, headers: { get: k => (k === 'x-payment-response' ? x402Encode({ success: true, transaction: 'sig1', network: 'solana-localnet', payer: wallet.address }) : null) },
      json: async () => ({ ok: true, signature: 'sig1', paid: '25000000', pool: { prize: '20000000' } }) };
  };
  const r = await payAndJoin({ wallet, faction: 3, session, sessionExpiry: 2_000_000_000n, maxFee: 25_000_000n, fetch: f });
  assert.deepEqual([r.ok, r.signature, r.paid, r.paymentResponse.payer], [true, 'sig1', '25000000', wallet.address]);
  assert.deepEqual(calls.map(c => [c.path, !!c.payment]), [['/gw/f/x402/join', false], ['/gw/f/x402/join', true]]);
  // A price above what the page showed is not paid.
  const dear = await payAndJoin({ wallet, faction: 3, session, sessionExpiry: 2_000_000_000n, maxFee: 24_000_000n, fetch: f });
  assert.deepEqual([dear.ok, dear.code], [false, 'X402TooExpensive']);
});
