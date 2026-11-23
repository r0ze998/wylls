// fix-loop11: loop-play11's LP11-1 (a departure the chain refused after 「送信しました」 stayed in 進軍 as a phantom), its
// audit of the other sends that can be refused after "sent" (W2 march), LP11-2 (the W2 card's wait stopped when the W2
// view was closed) and LP11-4 (the TEST cap line never came while the capped march stood beside a keep). Japanese and
// English. Key-free: no process, no port, no gateway src/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seasonPda, withSeed, seedOf, seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { canonicalOriginalHostRef, canonicalWideProvinceKey, packWidePlain } from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { revealAddresses } from '../../permutation-server/web/frontier/fexpedition-reveal.mjs';
import { fromHex } from '../../permutation-server/web/sdk/bytes.mjs';
import * as X from '../../permutation-server/web/frontier/flocalplay-expedition.mjs';
import { chainErrorCode, localDepartSent } from '../../permutation-server/web/frontier/flocalplay-depart.mjs';
import { localActRead, followLocalAct } from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import { departRefusedReason } from '../../permutation-server/web/frontier/fi18n.mjs';
import { wideHostRef, wideHostAlias } from '../../permutation-server/web/frontier/flocalplay-wide-host.mjs';
import { createWideHostPlanner } from '../../permutation-server/web/frontier/flocalplay-wide-plan.mjs';
import * as W from '../../permutation-server/web/frontier/screens/wideholding.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const WEB = new URL('../../permutation-server/web/', import.meta.url);
const src = f => readFileSync(new URL(`frontier/${f}`, WEB), 'utf8');
const JA = /[぀-ヿ一-鿿]/;
const PROGRAM = '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn';

// ------------------------------------------------------------------ LP11-1: the expedition list
const SEASON = seasonPda(PROGRAM, 11)[0];
const WORLD = worldIdOf(SEASON, PROGRAM);
const HOST = canonicalOriginalHostRef({ world: WORLD, p: '-68', q: '-60', site: 10, gen: 0, seq: 0 });
const DEST = canonicalWideProvinceKey({ world: WORLD, p: '-68', q: '-61' });
const HOLDING = withSeed(SEASON, seedOf('Holding', { p: -68, q: -60, site: 10 }), PROGRAM);
const plain = arriveBell => packWidePlain({ version: 2, host: HOST, arriveBell, dest: DEST, destTile: 55, stance: 0, retreatBps: 0, pathLen: 0, path: '00'.repeat(12), reserved: '00'.repeat(8) });
const rec = (arriveBell, more = {}) => ({ host: HOST, transitSlot: 0, commit: `${arriveBell}`.padStart(64, 'c'), arriveBell, signature: `sig${arriveBell}`, plain: plain(arriveBell), holding: HOLDING, revealed: null, ...more });
const latin = s => Uint8Array.from(s, c => c.charCodeAt(0));
const bridge = (state, arriveBell) => { const b = new Uint8Array(336); b.set(latin('PSWLEXP1')); b[8] = 2; b[17] = state; new DataView(b.buffer).setUint32(16 + 172, arriveBell, true); return { owner: PROGRAM, data: b }; };
const addrs = r => revealAddresses({ program: PROGRAM, season: SEASON, holding: HOLDING, transitSlot: 0, faction: 0, arriveBell: r.arriveBell, destKey: DEST, destRegion: 0 });

test('LP11-1: a departure the chain refused is no expedition — no 進軍 row, no reveal; the reason is the program\'s, JA and EN', () => {
  // (loop-play11: the depart of arrival 294 failed with Custom 26; the page kept a row 「この遠征の記録が見つかりません」)
  const refused = rec(294, { refused: { code: '{"InstructionError":[4,{"Custom":26}]}', programCode: 26, slot: 22440 } });
  const real = rec(388);
  const seals = () => [refused, real];
  const fs = { nowBell: 400, holdings: [] };
  assert.deepEqual(X.expeditionRows(fs, seals).map(r => r.expedition.arriveBell), [388], 'only the expedition that left');
  assert.equal(X.expeditionsAway(fs, () => [refused]), false, 'a refused departure is not a host away');
  assert.deepEqual(localDepartSent({}), [], 'the page\'s own list of sent seals starts empty');
  // the chain's error → its number; the reason in words
  assert.equal(chainErrorCode({ InstructionError: [4, { Custom: 26 }] }), 26);
  assert.equal(chainErrorCode('{"InstructionError":[4,{"Custom":26}]}'), 26);
  assert.equal(chainErrorCode('{"InstructionError":[0,"InvalidAccountData"]}'), null);
  assert.equal(chainErrorCode('not json'), null);
  setLang('ja');
  assert.equal(departRefusedReason({ programCode: 26 }), '送るあいだにターンが変わり、出発する州の前のターンの決着がまだでした（NotResident）');
  assert.match(departRefusedReason({ programCode: 58 }), /（エラー 58）$/);
  assert.equal(departRefusedReason({ code: 'X' }), '理由 X');
  setLang('en');
  const en = departRefusedReason({ programCode: 26 });
  assert.doesNotMatch(en, JA); assert.match(en, /NotResident/);
  assert.doesNotMatch(departRefusedReason({ programCode: 58 }), JA);
  setLang('ja');
});

test('LP11-1: a bridge transit of another arrival turn (a later expedition of the same host and slot) is not this seal\'s', () => {
  // (loop-play11: the refused seal was read as 「到着しました…」 off the second expedition's transit — same account)
  const phantom = rec(294), a = addrs(phantom);
  const at = [a.transit, a.inputs, ...a.slots];
  const facts = accounts => X.expeditionFacts(phantom, PROGRAM, 0, new Map(at.map((x, i) => [x, accounts[i] ?? null])), at);
  assert.equal(facts([bridge(1, 294)]).transit, 'open', 'its own transit');
  const other = facts([bridge(1, 388)]);
  assert.equal(other.transit, 'gone', 'another arrival turn: not its transit');
  assert.notEqual(X.expeditionStage(phantom, other, 300), 'arrived');
});

test('LP11-1: the run marks its seal refused on the chain\'s `failed`, and the march list asks by itself (source)', () => {
  const d = src('flocalplay-depart.mjs');
  assert.match(d, /if \(x\.signature === r\.sent\.signature && !x\.refused\) x\.refused = Object\.freeze\(\{ code: s\.err, programCode, slot: s\.slot \}\);/);
  assert.match(d, /export const localDepartSent = fs => localDepartReveals\(fs\)\.filter\(x => x\.signature && !x\.refused\);/);
  assert.match(src('flocalplay-reveal.mjs'), /filter\(r => r\.signature && !r\.revealed && !r\.refused\)/, 'the reveal strip lets it go');
  const c = src('controller.mjs');
  const at = c.indexOf("if (localPlay && localDepart.localDepartReveals(FS).some(r => r.signature)) {");
  const body = c.slice(at, c.indexOf('marches.push(...localExpedition.expeditionRows(FS));', at));
  assert.ok(at > 0 && body.includes("['submitted', 'unknown'].includes(localDepart.localDepartOf(FS).status)") && body.includes('localDepart.reconcileLocalDepart(FS'), 'an unsettled departure is asked about on each march-list read');
  assert.match(c, /const localDepartChanged = \(\) => \{ departRefusedNotice\(\); invalidate\('map', 'panel'\); \};/, 'and said once as a notice');
  // (live: the toast's "what was not done" line came from the last control pressed — 「編成はまだ命じられていません。」 — and
  //  its 「もう一度」 would have re-run the muster: the notice names its own action and offers no retry)
  assert.match(c, /setNotice\(\{ ok: false, busy: false, unsent: 'expedition-depart', retry: false, text:/);
  assert.match(readFileSync(new URL('frontier/hud/status.mjs', WEB), 'utf8'), /'expedition-depart': \(\) => L`遠征は出発していません。`,/);
  // (a runner's preflight rejection never reached the chain: the card does not say 「チェーンで断られました」 for it)
  assert.match(readFileSync(new URL('frontier/hud/hand.mjs', WEB), 'utf8'), /d\.chain === 'rejected' \? L`出発は送る前の確かめで断られました（チェーンには届いていません）：/);
});

test('LP11-1 audit: a local act the chain refused carries the program\'s number (the W2 card then waits a turn after NotResident)', async () => {
  const post = async (o, p, b) => ({ signature: b.signature, status: 'failed', err: { InstructionError: [3, { Custom: 26 }] } });
  const read = localActRead({ allowed: () => ({ ok: true, relay: 'http://127.0.0.1:41600' }), post });
  assert.deepEqual(await read('s'), { ok: true, state: 'failed', code: 'TransactionFailed', programCode: 26 });
  assert.deepEqual(await followLocalAct('s', { origin: 'http://127.0.0.1:41600', still: () => true, post, tries: 1, wait: async () => {} }), { state: 'failed', code: 'TransactionFailed', programCode: 26 });
  // a W2 march sent and not confirmed counts, and is taken back when the chain refuses it (controller wideHostStep)
  const c = src('controller.mjs');
  const step = c.slice(c.indexOf('async function wideHostStep('), c.indexOf('function wideHostSayOf('));
  assert.ok(step.includes('if (mem.departHeld) {') && step.includes('mem.wideDeparts = h.wideDeparts; mem.lastWideDepart = h.lastWideDepart;'));
  setLang('ja');
  assert.match(W.wideHostSayText({ kind: 'wait', wait: 'refused', programCode: 26 }), /^前の進軍はチェーンで断られました（送るあいだにターンが変わりました。NotResident）/);
  assert.match(W.wideHostSayText({ kind: 'wait', wait: 'refused', programCode: 41 }), /進軍の回数には数えません/);
  setLang('en');
  assert.doesNotMatch(W.wideHostSayText({ kind: 'wait', wait: 'refused', programCode: 26 }), JA);
  assert.doesNotMatch(W.wideHostSayText({ kind: 'wait', wait: 'refused', programCode: 41 }), JA);
  setLang('ja');
});

// ------------------------------------------------------------------ LP11-2: the W2 wait off-view
test('LP11-2: the W2 card\'s own wait follows its wide village while another village is open (source)', () => {
  const c = src('controller.mjs');
  const a = c.slice(c.indexOf("'wide-host-step': async (d = {}) => {"), c.indexOf("'wide-host-stop':"));
  assert.ok(a.includes('const e = d.auto === true && Number.isInteger(mem0.slot) ? (fwide.wideSlots(FS).find(x => x.inventorySlot === mem0.slot) ?? null) : fwide.selectedWide(FS);'), 'the timer reads the village it was started for');
  assert.ok(a.includes('if (d.auto !== true) mem0.slot = e.inventorySlot;'), 'a press binds the wait to the village on screen');
  assert.ok(!a.includes('if (!e?.holding || !localPlay?.wideLand) { wideHostStopWait(mem0); return; }'), 'no silent stop because the W2 view is closed');
  assert.ok(a.includes('if (d.auto === true && mem0.waiting) wideHostWait(mem0, mem0.waiting);'), 'an unread inventory asks again next turn');
});

// ------------------------------------------------------------------ LP11-4: the cap line while the capped march stands
const SEASON_ID = '11', S2 = seasonAddresses(PROGRAM, SEASON_ID).season, W2 = worldIdOf(S2, PROGRAM);
const village = { p: '130', q: '-1', site: 4 };
const GENESIS = 1_000_000, ASTER = 3;
const season = { seasonId: SEASON_ID, genesisTs: GENESIS, drandGenesis: 0, drandPeriod: 3, seedMargin: 0, endBell: 100000 };
const herald = { season: async () => ({ ok: true, season, record: {} }) };
const holdingBytes = () => { const hb = new Uint8Array(1344), hv = new DataView(hb.buffer); hb[69] = 1; hb[70] = 17; hb[71] = 2; hb[112] = ASTER; hv.setUint32(132, 2, true); return hb; };
const provinceBytes = (resolvedNext, { hosts = [], keep = null } = {}) => {
  const pv = new Uint8Array(4864), v = new DataView(pv.buffer); v.setUint32(72, resolvedNext, true); pv[4480] = 0xff;
  hosts.forEach((h, i) => { const o = 1064 + i * 48; v.setBigUint64(o, wideHostAlias(wideHostRef({ world: W2, ...village, gen: 1, seq: h.seq })), true); pv[o + 8] = ASTER; pv[o + 10] = 30; pv[o + 11] = 1; v.setUint32(o + 12, h.troops, true); });
  if (keep) { pv[4480] = 30; pv[4481] = keep.holder; pv[4482] = keep.contender ?? 0xff; pv[4483] = keep.progress ?? 0; pv[4484] = 72; v.setUint32(4488, keep.troops ?? 100, true); }
  return pv;
};
test('LP11-4: the TEST cap line comes after the 2nd march while it still stands beside a keep it does not take, JA and EN', async () => {
  const nowBell = 500, TO = { p: '-68', q: '-62', tile: 30, holder: 5 };
  const dest = provinceBytes(nowBell, { hosts: [{ seq: 1, troops: 60_000 }], keep: { holder: 5, troops: 61 } });
  const planner = createWideHostPlanner({ herald, chainNow: async () => GENESIS + nowBell * 600 + 1,
    read: async a => (a.length === 1 ? [dest] : a.map((_, i) => (i === 0 ? holdingBytes() : i === 1 ? provinceBytes(nowBell - 1) : null))) });
  const w = await planner.decide({ programId: PROGRAM, seasonAddress: S2 }, { decisions: 9, wideHostUntil: 3, wideDeparts: 2, lastWideDepart: { to: TO, arrive: 492, troops: 60 } }, { wideTargets: [], villages: [village] });
  assert.equal(w.wait, 'march'); assert.equal(w.march.phase, 'stands'); assert.equal(w.cap, 2, 'the cap rides along');
  const say = { kind: 'wait', wait: w.wait, march: w.march, cap: w.cap };
  setLang('ja');
  const ja = W.wideHostSayText(say);
  assert.match(ja, /^結果：軍勢（兵 60）は州 -68,-62 に立っています。/);
  assert.match(ja, /テスト世界では 2 回までです。/);
  setLang('en');
  assert.doesNotMatch(W.wideHostSayText(say), JA);
  setLang('ja');
  // (no cap: the march line alone, as before)
  assert.doesNotMatch(W.wideHostSayText({ ...say, cap: undefined }), /回までです/);
});
