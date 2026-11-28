// fix-loop31 (reports/loop-play31.md, verdict line 3): page only, no rule or program change.
//   LP31-1  a nation-mate's keep capture finished the viewer's guide (web-frontier-conquest-hand.test.mjs "LP31-1").
//   LP31-2  `--demo --two`, both players on the same nation at the same moment: the second village was refused
//           Custom(45) "The village request is not in the right state." (tests below).
//   LP31-3  the defender's clash notice counted a RETREATED host as lost (452 for 68), and that clash was not on the
//           viewer's list of clash reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { fromBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { createBus } from '../../permutation-server/web/frontier/fx/bus.mjs';
import { ownClashText, ownRowAfter, withOwnClash, mountOwnClash } from '../../permutation-server/web/frontier/map/ownclash.mjs';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/uxs1-keep-two-turns.json', import.meta.url), 'utf8'));
const [P, Q] = FIX.province, HOST = FIX.viewer.host;
const rec = bell => { const r = FIX.records[bell]; return { report: r, inputs: decode('ClashInputs', fromBase64(r.inputs_b64)), before: decode('Province', fromBase64(r.province_before_b64)) }; };
const tick = () => new Promise(r => setTimeout(r, 0));

// ------------------------------------------------------------------ LP31-3
// the defender of loop-play31 C2: 452 on its own nation's keep tile, 68 lost, pushed back home (384 to the reserve)
const row = { id: '77', faction: 3, before: 452, after: 0, fate: 'Destroyed', kind: 'resident' };
const foe = { id: '88', faction: 2, before: 570, after: 446, fate: 'Stays', kind: 'arrival' };
const LATE = { resolvedNext: 122, entries: [] };   // the Province as the page read it three turns later: the host has left

test('LP31-3 a retreated host is counted with the troops it left with (the herald\'s fates), never as fallen', () => {
  const fighters = [{ id: '77', arrival: false, troops: 384000, fate: 'Retreated', engaged: true }, { id: '88', arrival: true, troops: 446000, fate: 'Stays' }];
  assert.deepEqual(ownRowAfter(row, { bell: 118, after: LATE, fighters }), { ...row, after: 384, fate: 'Retreated' });
  // an arrival of the same id is not this resident
  assert.deepEqual(ownRowAfter(row, { bell: 118, after: LATE, fighters: [{ ...fighters[0], arrival: true }] }), { ...row, after: null, fate: null });
  // without the herald's fates: gone from a Province read later than the turn right after → not known (no number said)
  assert.deepEqual(ownRowAfter(row, { bell: 118, after: LATE }), { ...row, after: null, fate: null });
  // the Province right after the turn: the scene's own reading stands (a host gone from it there fell)
  assert.deepEqual(ownRowAfter(row, { bell: 118, after: { resolvedNext: 119, entries: [] } }), row);
  const part = me => ({ tile: 7, me: [me], foes: [foe], keep: null, attacking: false });
  setLang('ja');
  assert.equal(ownClashText({}, { p: -2, q: -2, bell: 118 }, part(ownRowAfter(row, { bell: 118, after: LATE, fighters }))), '州 -2,-2で、あなたの軍勢が戦いました（ターン 118・68 兵を失いました）');
  assert.equal(ownClashText({}, { p: -2, q: -2, bell: 118 }, part(ownRowAfter(row, { bell: 118, after: LATE }))), '州 -2,-2で、あなたの軍勢が戦いました（ターン 118）');
  setLang('en');
  try {
    const t = ownClashText({}, { p: -2, q: -2, bell: 118 }, part(ownRowAfter(row, { bell: 118, after: LATE, fighters })));
    assert.match(t, /Province -2,-2/);
    assert.match(t, /\b68\b/);
    assert.doesNotMatch(t, /452|season/i);
  } finally { setLang('ja'); }
});

test('LP31-3 the viewer\'s own resident clash goes on its list of clash reports (FS.ownClashes), once, newest first', async () => {
  assert.deepEqual(withOwnClash([{ p: 1, q: 1, tile: 3, bell: 113 }], { p: -2, q: -2, tile: 60, bell: 118 }).map(x => x.bell), [118, 113]);
  assert.equal(withOwnClash([{ p: -2, q: -2, tile: 60, bell: 118 }], { p: -2, q: -2, tile: 60, bell: 118 }).length, 1);
  assert.equal(withOwnClash(Array.from({ length: 30 }, (_, i) => ({ p: 0, q: 0, bell: i })), { p: 1, q: 1, bell: 99 }).length, 24);
  // the real record of the second turn on a keep (turn 620): told by the watch, and kept on the list
  const after = rec(621).before;
  const fs = { mode: 'play', citizen: { faction: FIX.viewer.faction }, holdings: [FIX.viewer.holding], marches: [], nowBell: 622, chronicle: [], feed: [], ownClashes: [{ p: 9, q: 9, tile: 1, bell: 59 }],
    ui: { autoPan: false, battleFx: 'off' }, provinces: new Map([[`${P},${Q}`, { province: after }]]) };
  const own = mountOwnClash({ state: () => fs, bus: createBus(), clash: async (p, q, bell) => ({ ok: true, report: rec(bell).report, inputs: rec(bell).inputs }), redraw() {}, later: fn => setTimeout(fn, 0) });
  own.sync();
  fs.chronicle = [{ seq: '1', record: { name: 'CLASH', p: P, q: Q, bell: 620, engagements: 1 } }];
  own.sync(); await tick(); await tick();
  assert.equal(fs.feed.length, 1, 'the notice');
  assert.deepEqual(fs.ownClashes.map(c => [c.p, c.q, c.bell]), [[P, Q, 620], [9, 9, 59]], 'and the report list');
  own.off();
  assert.ok(HOST);
});

// ------------------------------------------------------------------ LP31-2
import { homeSiteTaken, HOME_SITE_TRIES } from '../../permutation-server/web/frontier/controller.mjs';
import { L } from '../../permutation-server/web/lang.mjs';
const CTL = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
const fnOf = head => { const at = CTL.indexOf(head); assert.ok(at >= 0, head); return CTL.slice(at, CTL.indexOf('\n}\n', at) + 2); };
const inOrder = (body, ...parts) => { let at = -1; for (const p of parts) { const i = body.indexOf(p, at + 1); assert.ok(i > at, `in order: ${p}`); at = i; } };

test('LP31-2 a first village whose place was taken under the confirm (refused 45 before sending) takes the next free place, at most HOME_SITE_TRIES', () => {
  // the refusal of loop-play31 C: the relay's 422 LocalActRejected with the program's 45, nothing sent
  assert.equal(homeSiteTaken({ ok: false, code: 'LocalActRejected', programCode: 45 }), true);
  assert.equal(homeSiteTaken({ ok: false, code: 'TicketState' }), true);
  assert.equal(homeSiteTaken({ ok: false, code: 'LocalActRejected', programCode: 45, sent: true }), false, 'sent: never sent again');
  assert.equal(homeSiteTaken({ ok: false, code: 'LocalActRejected', programCode: 52 }), false, 'AlreadyDone is not a taken place');
  assert.equal(homeSiteTaken({ ok: true }), false);
  assert.equal(homeSiteTaken(null), false);
  assert.ok(HOME_SITE_TRIES >= 2 && HOME_SITE_TRIES <= 5, 'a few places, never an endless loop');
  const ch = fnOf('export async function confirmHome() {');
  inOrder(ch, 'for (let tries = 1; ; tries++) {', "const placed = await act('PlaceHome', { v: { holding: site,", 'if (!mine()) return;',
    'const taken = homeSiteTaken(placed);', 'if (taken && tries < HOME_SITE_TRIES) {', 'const next = await nextFreeHome(FS.citizen.faction, site);', 'if (!mine()) return;',
    'if (next) { site = next; run.choice.selected = next; saveHomePatch({ selected: next }); pending(\'placing\'); continue; }',
    "if (!placed?.ok) { await refresh(); if (mine() && !FS.homeGrant) error(taken ? 'SiteUnavailable'", "pending('confirming');", 'break;');
  // the next place: the page's own reading order (pair role included), read again, never the refused place
  const nf = fnOf('async function nextFreeHome(faction, not) {');
  assert.match(nf, /planHomes\(\{[\s\S]*pair: homePairRole\(\)/);
  assert.match(nf, /!sameHome\(h, not\)/);
  assert.match(nf, /h\.faction === faction/);
  // the words, in both languages, no "season"
  setLang('en');
  try {
    for (const ja of ['その土地は、いま別の村が先に取りました。空いている別の土地を探しています…', '空いている土地が、確定のあいだに別の村で埋まりました。候補を更新して、もう一度押してください。']) {
      const en = L([ja]);
      assert.notEqual(en, ja, 'translated');
      assert.doesNotMatch(en, /[぀-ヿ㐀-鿿]|season/i);
    }
  } finally { setLang('ja'); }
});
