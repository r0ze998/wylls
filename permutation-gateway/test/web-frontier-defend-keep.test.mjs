// A defender's way to its own contested keep (pair trial 1, 2026-11-14: the defender's own keep was not in 「届く砦」 and its
// player had to type the coordinates). The list now also offers the viewer's OWN nation's keep that another nation is
// contesting, as a row to go and defend it. The rule is the program's (keep.rs: a defender of the holding nation on the tile
// breaks the count); nothing about it changes here, and the row opens the same order paper (`cq-march`).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { defendableKeeps, reachableKeeps, contestableKeeps } from '../../permutation-server/web/frontier/fkeepreach.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import * as K from '../../permutation-server/web/frontier/hud/keephand.mjs';
import { handModel, renderPop } from '../../permutation-server/web/frontier/hud/hand.mjs';

afterEach(() => setLang('ja'));
const plain = s => String(s).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, '\'').replace(/\s+/g, ' ');
const CJK = /[぀-ヿ㐀-鿿]/;
const BANNED_EN = /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i;
const NO = 255;
const keep = (p, q, extra = {}) => ({ p, q, tile: 18, holder: 1, troops: 0, heartland: false, consolidatedUntil: 0, contender: NO, progress: 0, requiredBells: 72, asOfBell: 50, ...extra });

test('defendable: the viewer\'s own nation\'s keep with ANOTHER nation counting; nothing else', () => {
  const keeps = new Map([
    ['-2,4', keep(-2, 4, { contender: 0, progress: 3 })],    // own (1), contested by 0: yes
    ['-1,4', keep(-1, 4)],                                    // own, nobody counting: no
    ['0,4', keep(0, 4, { holder: 2, contender: 0 })],         // another nation's: no (that one is for attack)
    ['1,3', keep(1, 3, { contender: 1 })],                    // "contested" by the holder itself: no
    ['2,2', keep(2, 2, { contender: 6 })],                    // not a nation: no
    ['1,2', keep(1, 2, { tile: 61, contender: 0 })],          // no keep tile: no
  ]);
  assert.deepEqual(defendableKeeps(keeps, { faction: 1 }).map(k => `${k.p},${k.q}`), ['-2,4']);
  assert.deepEqual(defendableKeeps(keeps, { faction: undefined }), [], 'no nation known: nothing');
  assert.deepEqual(defendableKeeps(keeps, { faction: 0 }), [], 'the attacker\'s side never sees it as its own');
  // never both: the contestable list keeps excluding the viewer's own keeps
  assert.ok(!contestableKeeps(keeps, { faction: 1, nowBell: 50 }).some(k => k.holder === 1));
});

const at = (p, q, tile) => { const h = tileHex(p, q, tile); return `${h.q},${h.r}`; };
function kernel(table) {
  const k = { calls: [], call(name, args) { k.calls.push(args); return { ok: true, value: table[`${args.start.q},${args.start.r}>${args.dest.q},${args.dest.r}`] ?? null }; } };
  return k;
}
const answer = (hexes, nProv, secs) => ({ dirs: new Array(hexes).fill(0), pathLen: hexes, path: [], secs, hexes, provinces: Array.from({ length: nProv }, (_, i) => ({ p: i, q: 0 })) });

test('the reach list: the own contested keep is a row with defend: true, routed by the same planner; attack rows unchanged', () => {
  const B = { p: 0, q: 2, tile: 55, unit: 0, host: '9', troops: 300 };
  const keeps = new Map([['-2,4', keep(-2, 4, { contender: 0, progress: 3 })], ['0,4', keep(0, 4, { holder: 2 })], ['-1,4', keep(-1, 4)]]);
  const table = { [`${at(0, 2, 55)}>${at(-2, 4, 18)}`]: answer(15, 3, 1500), [`${at(0, 2, 55)}>${at(0, 4, 18)}`]: answer(9, 2, 900) };
  const r = reachableKeeps({ kernel: kernel(table), keeps, origins: [B], seeds: [], faction: 1, nowBell: 50 });
  assert.deepEqual(r.rows.map(x => [`${x.p},${x.q}`, x.holder, x.defend ?? false]), [['0,4', 2, false], ['-2,4', 1, true]]);
  assert.equal('defend' in r.rows[0], false, 'an attack row has exactly its old shape');
  // no route to the own keep: it is named unreachable like any other, never silently dropped
  const none = reachableKeeps({ kernel: kernel({}), keeps, origins: [B], seeds: [], faction: 1, nowBell: 50 });
  assert.deepEqual(none.rows, []); assert.deepEqual(none.unreachable, ['0,4', '-2,4']);
});

// the host's bar (hud/hand.mjs) for a defender of nation 1 standing at (2,0)
const HOME = { p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 1, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n };
const entry = { id: hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 1 }), unit: 0, state: 1, tile: 20, troops: 300000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10 };
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 96, bellSecs: 600, dormantAfterSecs: 86400, releaseAfterSecs: 172800, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
const state = keeps => ({ mode: 'play', season: SEASON, citizen: { faction: 1 }, holdings: [HOME], nowBell: 10, chain: { now: () => 1000 }, land: { stage: 'final' }, inFlight: 0,
  provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: 10, entries: [entry], ticketCohorts: [] } }]]),
  conquest: { status: 'ready', keeps, history: new Map(), standings: null, final: null, events: [] },
  selected: { p: 2, q: 0, idx: 20 }, hand: { host: String(entry.id), pop: 'keeps' } });

test('the host\'s bar: offered for a defender whose only keep in play is its own contested one; the row says defend, no odds', () => {
  const keeps = new Map([['-2,4', keep(-2, 4, { contender: 0, progress: 3 })], ['2,2', keep(2, 2, { heartland: true, holder: 3 })]]);
  const s = state(keeps);
  assert.equal(K.noContestableKeep(s), false, 'something to defend: the list is offered');
  assert.ok(handModel(s).buttons.some(b => b.id === 'keeps'));
  // without the contest the same world has nothing to take or defend: hidden as before
  const quiet = state(new Map([['-2,4', keep(-2, 4)], ['2,2', keep(2, 2, { heartland: true, holder: 3 })]]));
  assert.equal(K.noContestableKeep(quiet), true);
  s.conquest.hostReach = { key: 'k', host: String(entry.id), ok: true, unreachable: [], rows: [{ p: -2, q: 4, tile: 18, holder: 1, troops: 0, defend: true, route: { hexes: 15, provinces: [0, 1, 2], secs: 1500 } }] };
  const m = handModel(s);
  const km = K.keepsModel(s, m.host);
  assert.deepEqual(km.rows.map(x => [x.key, x.defend, x.odds, x.contender, x.progress]), [['-2,4', true, null, 0, 3]]);
  const out = String(renderPop(s, m));
  assert.match(out, /class="kh-row kh-n1 kh-row-defend" data-act="cq-march" data-host="[0-9]+" data-p="-2" data-q="4" data-tile="18"/, 'the same order paper as any row');
  const ja = plain(out);
  assert.match(ja, /あなたの国が保持/); assert.match(ja, /守りに向かう マスに残れば占拠を止めます/); assert.match(ja, /3\/72/);
  assert.match(out, /aria-label="[^"]*の砦を守りに向かう：[^"]*が占拠中 3\/72、到着はターン/);
  const rowHtml = /<li>[\s\S]*?<\/li>/.exec(out)[0];
  assert.doesNotMatch(plain(rowHtml), /勝ち目/, 'no odds against its own garrison'); assert.match(rowHtml, /kh-odds-defend/);
  setLang('en');
  const en = plain(renderPop(s, m));
  assert.match(en, /Held by your nation/); assert.match(en, /Defend staying on the tile stops their hold/);
  assert.match(String(renderPop(s, m)), /aria-label="Go and defend the keep of [^"]*: [^"]* holds the tile 3\/72, arrival on turn/);
  assert.doesNotMatch(en, CJK); assert.doesNotMatch(en, BANNED_EN);
});
