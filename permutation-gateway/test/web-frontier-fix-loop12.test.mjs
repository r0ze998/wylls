// fix-loop12: the smaller loop-play12 findings (LP12-3, -4, -5, -7, -8), page side. Key-free, no process, no port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang, EN, normalizeKey } from '../../permutation-server/web/lang.mjs';

const src = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
const NO_JA = /[぀-ヿ一-鿿]/;

test('LP12-3: a march out whose destination is still sealed (after a reload) is said as out on a march — not 「軍勢の準備を確かめる」 — JA and EN', async () => {
  const G = await import('../../permutation-server/web/frontier/screens/conquestguide.mjs');
  const sm = marches => G.sealedMarch({ marches });
  assert.equal(sm([]), null);
  // the live shape after `--resume`: a transit row, entry null, no destination (sealed until its arrival turn)
  assert.deepEqual(sm([{ entry: null, transit: { slot: 0, hostId: 7, arriveBell: 10, state: 1 }, facts: { nowBell: 5 }, dest: null }]), { arrive: 10 });
  assert.deepEqual(sm([{ entry: null, transit: { slot: 0, hostId: 7, state: 1 }, facts: { nowBell: 5 }, dest: null }]), { arrive: null });
  assert.equal(sm([{ transit: { arriveBell: 10 }, facts: {}, dest: { p: 0, q: -1, tile: 30 } }]), null, 'a march whose destination the page knows: the usual steps');
  assert.equal(sm([{ transit: { arriveBell: 10 }, facts: { settled: { outcome: 'Withdrew' } }, dest: null }]), null, 'a settled march is not out');
  assert.equal(sm([{ dest: null, facts: {}, expedition: { stage: 'revealed', fate: null } }]), null, 'an expedition row always names its destination');
  const s = src('screens/conquestguide.mjs');
  assert.ok(s.includes('const sealedOut = !ready ? sealedMarch(FS) : null;'));
  assert.ok(s.includes("if (sealedOut && !rows.some(r => !r.inTransit && r.pending !== 1)) {"), 'only while no host is at home (the departing one stands as 出発の手続き中, pending 1)');
  assert.ok(s.includes("go = { act: 'tab', data: { tab: 'marches' }, label: L`進軍を見る` };"));
  // the new lines have English, with the arrival turn in its place
  for (const k of ['{0}軍勢は進軍に出ています。行き先は封をしたままで、到着のターン {1} に明かされます。砦に着いて勝てば、占拠のターンが数えられます。',
    '{0}軍勢は進軍に出ています。行き先は封をしたままで、到着のターンに明かされます。砦に着いて勝てば、占拠のターンが数えられます。']) {
    assert.equal(typeof EN[k], 'string', k); assert.doesNotMatch(EN[k], NO_JA);
  }
  assert.match(EN['{0}軍勢は進軍に出ています。行き先は封をしたままで、到着のターン {1} に明かされます。砦に着いて勝てば、占拠のターンが数えられます。'], /\{1\}/);
});

test('LP12-4: a departure that is SENT drops an earlier departure\'s refusal notice (and no other notice)', () => {
  const s = src('controller.mjs');
  const i = s.indexOf('      if (out?.sent) {\n        outbound.forgetOutboundReady(FS);');
  assert.ok(i > 0, 'the sent branch of sendLocalPlayDeparture');
  const body = s.slice(i, i + 1400);
  assert.ok(body.includes("if (!['failed', 'expired', 'error'].includes(out.status) && FS.notice && FS.notice.ok === false && FS.notice.unsent === 'expedition-depart') setNotice(null);"),
    'not for a run refused itself: the runner preflight answers after the post, so that run is `sent` too (fix-loop12 live: the first version dropped the notice the refused run had just set)');
  // the refusal notice it drops is the one departRefusedNotice sets
  assert.ok(s.includes("setNotice({ ok: false, busy: false, unsent: 'expedition-depart', retry: false, text: d.status === 'expired'"));
});

test('LP12-5: a tab press (or closing the drawer) keeps the boundary card\'s road; other presses still drop it', () => {
  const s = src('app.mjs');
  const looks = /const OUTBOUND_LOOKS = Object\.freeze\(\[([^\]]*)\]\);/.exec(s);
  assert.ok(looks, 'the presses that only look');
  const kept = looks[1].split(',').map(x => x.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(kept, ['tab', 'drawer-close']);
  for (const a of ['hand-close', 'hand-info', 'compose', 'cg-go']) assert.ok(!kept.includes(a), `${a} starts something else: the draft goes`);
  const line = s.split('\n').find(l => l.includes('if (FS.hand?.pop === OUTBOUND_POP && !LOCAL_REVEAL_ACTS.includes(el.dataset.act)'));
  assert.ok(line.trimEnd().endsWith(".includes(el.dataset.act) && !OUTBOUND_LOOKS.includes(el.dataset.act)) clearOutbound(FS);"));
});

test('LP12-7: the map\'s hidden live line follows the language — a refusal said in Japanese is said in English after the switch, or not at all', () => {
  const s = src('app.mjs');
  assert.ok(s.includes("import { L, fmtNum, mountLangToggle, onLangChange, lang, t as tKey, EN, normalizeKey } from '../lang.mjs';"));
  assert.ok(s.includes("  const at = lang();\n  if (why) summary(() => (lang() === at ? why : at === 'ja' && EN[normalizeKey(why)] !== undefined ? tKey(why) : ''));"));
  assert.ok(s.includes("onLangChange(() => { if (summarySay) setText('map-summary', summarySay()); });"), 'the switch says the line again');
  // the same thunk, run here: the loop-play12 line has its English
  const say = (why, at, now) => (now === at ? why : at === 'ja' && EN[normalizeKey(why)] !== undefined ? (setLang('en'), EN[normalizeKey(why)]) : '');
  try {
    const ja = '軍勢・所有者・接続情報が変わりました。カードを開き直してください。';
    assert.equal(say(ja, 'ja', 'en'), 'The host, owner or connection changed. Reopen this card.');
    assert.equal(say('どこにもない文', 'ja', 'en'), '', 'no entry: nothing, never the Japanese');
    assert.equal(say('The host, owner or connection changed. Reopen this card.', 'en', 'ja'), '', 'English said, page now Japanese: nothing stale');
    assert.equal(say(ja, 'ja', 'ja'), ja);
  } finally { setLang('ja'); }
});

test('LP12-8: the seized storehouse chip and the count read apart (「奪われた 10 / 枠 50」, not 「奪われた10」)', () => {
  const s = src('screens/custody.mjs');
  assert.ok(s.includes("${e.seized ? html`${chip(L`奪われた`, 'warn')} ` : ''}<span class=\"muted\">${L`${fmtNum(e.held)} / 枠 ${fmtNum(e.quota)}`}</span>"));
  assert.ok(src('screens/rights.mjs').includes('${kind === \'vault\' ? L`貯蔵庫（${c.dst.p}, ${c.dst.q} · マス ${at}）へ` : villageTo(FS, c.dst, at)}'));
  for (const k of ['村（{0}, {1} · マス {2}）へ', '村（{0}, {1}）へ']) { assert.equal(typeof EN[k], 'string', k); assert.doesNotMatch(EN[k], NO_JA); }
});

test('LP12-2: before a fresh world\'s first control snapshot the keep card says why it waits, JA and EN; the 404 is asked again after 30 s only then', () => {
  const s = src('hud/keephand.mjs');
  assert.ok(s.includes("const firstRecords = km.state === 'loading' && FS.conquest?.status === 'loading' && !FS.conquest?.control;"));
  const k = '始まったばかりの世界では、最初のターンの決着がそろうまで（数分）届く砦の一覧は出ません。';
  assert.ok(s.includes(k)); assert.equal(typeof EN[k], 'string'); assert.doesNotMatch(EN[k], NO_JA);
  const c = src('controller.mjs');
  assert.ok(c.includes('const FRESH_MISS_RETRY_MS = 30_000;'));
  assert.ok(c.includes("} else if (control?.code === 'NotFound' && nowBell() <= 1 + Math.ceil(Number(FS.season.revealWindow ?? 600) / Number(FS.season.bellSecs ?? 600)) && !cq.control) {"), 'the same window says loading');
});
