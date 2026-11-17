// Static-audited public fixtures and synthetic LOCAL UI states only. No runtime outcomes.
// Exact guarded Node invocation only; no boot, network, worker, keys, signing or send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { encode, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as hand from '../../permutation-server/web/frontier/hud/hand.mjs';
import * as CTRL from '../../permutation-server/web/frontier/controller.mjs';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import { FS as STORE } from '../../permutation-server/web/frontier/fstate.mjs';
import { OUTBOUND_POP, OUTBOUND_CLOSED, outboundSource, openOutbound, editOutbound, clearOutbound, reconcileOutbound, outboundSketch } from '../../permutation-server/web/frontier/fexpedition-compose.mjs';
import { unpackWidePlain } from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
const source = file => readFileSync(new URL('../../permutation-server/web/frontier/' + file, import.meta.url), 'utf8');
const PROGRAM = encode(new Uint8Array(32).fill(94)), WALLET = encode(new Uint8Array(32).fill(65));
const OTHER = encode(new Uint8Array(32).fill(66));
const A = seasonAddresses(PROGRAM, '1');
const PIN = { programId: PROGRAM, cluster: 'localnet', seasonId: '1', addresses: A };
const OWNER = A.of('Citizen', { wallet: WALLET });
const HOST = hostId({ p: 128, q: 0, site: 3, gen: 1, seq: 0 }).toString();
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 1n, ...values }));
const fixture = JSON.parse(readFileSync(new URL('fixtures/frontier/season.json', import.meta.url), 'utf8'));
const SEASON = decode('Season', Buffer.from(fixture.bytes_b64, 'base64'));

function world({ village = false } = {}) {
  const h = acct('Holding', { P: 128, Q: 0, SITE: 3, GEN: 1, TILE: 60, STATE: 2, FACTION: 0, TIER: 1, HOST_SEQ: 1,
    OWNER_CITIZEN: fromB58(OWNER), RESERVE: [400, 0, 0, 0, 0, 0, 100, 0] });
  const province = acct('Province', { P: 128, Q: 0, RESOLVED_NEXT: 42, SITE_COUNT: 1,
    SITES: Uint8Array.of(60, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n,
    SITE_MIRROR: [{ STATE: 1, GEN: 1, FACTION: 0, TIER: 1 }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))],
    ENTRIES: village ? [] : [{ ID: BigInt(HOST), FACTION: 0, UNIT: 0, TILE: 60, STATE: 1, TROOPS: 600000, STAMINA_VALUE: 120, STAMINA_BELL: 42 }] });
  const fs = { mode: 'play', sample: null, proto: null, season: { ...SEASON, seasonId: 1n, programVersion: 16388, rulesetHash: new Uint8Array(32).fill(1) },
    wallet: { address: WALLET }, resident: null, session: null, meStatus: 'ready', meAnswered: true,
    citizen: acct('Citizen', { WALLET: fromB58(WALLET), FACTION: 0, FLAGS: 5, TICKET_BELL: 0xffffffff,
      HOLDING: [{ P: 128, Q: 0, SITE: 3, GEN: 1 }, { GEN: 255 }, { GEN: 255 }] }), holdings: [h], activeHolding: 0,
    selected: { kind: 'tile', p: 128, q: 0, idx: 60 }, hand: { host: village ? null : HOST, pop: OUTBOUND_POP },
    nowBell: 42, chain: { now: () => 1000 }, provinces: new Map([['128,0', { province }]]),
    view: { lod: 'tile', fog: true }, land: { stage: 'final' }, marches: [], book: [], orders: [], compose: null };
  const ctx = { pin: PIN, relay: '/gw', source: {} };
  return { fs, ctx, h, province };
}

const open = w => { openOutbound(w.fs, w.ctx); return w.fs.expeditionCompose; };
const ready = w => { open(w); editOutbound(w.fs, w.ctx, 'step', '0'); editOutbound(w.fs, w.ctx, 'arriveBell', '44'); return w.fs.expeditionCompose; };

test('selected observed boundary host prepares exact 136B review from actual origin, all gates remain closed', () => {
  const w = world(), s = ready(w);
  assert.equal(s.status, 'review'); assert.equal(s.review.plainHex.length, 272);
  assert.deepEqual(s.source.origin, { p: '128', q: '0', tile: 60 });
  assert.equal(s.review.endpoint.p, '129'); assert.equal(s.review.endpoint.q, '0');
  const plain = unpackWidePlain(Buffer.from(s.review.plainHex, 'hex'));
  assert.equal(plain.host, s.source.host); assert.equal(plain.dest, s.review.endpoint.key);
  assert.equal(plain.destTile, s.review.endpoint.tile); assert.equal(plain.arriveBell, 44); assert.equal(plain.pathLen, 1);
  for (const [k, v] of Object.entries(OUTBOUND_CLOSED)) { assert.equal(v, false); assert.equal(s[k], false); assert.equal(s.review[k], false); }
  assert.equal(s.review.verification, 'geometry-only'); assert.equal(s.review.arrivalVerified, false);
  assert.ok(s.review.blockers.includes('ArrivalTravelUnverified')); assert.equal(w.fs.session, null);
  assert.equal(s.review.roles.length, 9); assert.equal(s.review.roles[0].address, WALLET); assert.equal(s.review.roles[1].address, WALLET);
});

test('village sequence, absent, forming, pending, transiting and duplicated resident cannot start a route', () => {
  const cases = [w => { w.fs.hand.host = null; }, w => { w.province.entries = []; }, w => { w.province.entries[0].state = 2; },
    w => { w.province.entries[0].pendOp = 1; }, w => { w.h.transit[0].state = 1; w.h.transit[0].hostId = BigInt(HOST); },
    w => { w.province.entries[1] = { ...w.province.entries[0] }; }, w => { w.h.hostSeq = 0; }];
  for (const mutate of cases) { const w = world(); mutate(w); const s = open(w); assert.equal(s.review, null); assert.equal(s.source, null); assert.ok(s.error); }
});

test('origin is actual remote standing province and issuer is selected host holding, not active rail', () => {
  const w = world(), other = { ...w.h, p: 127, site: 2 };
  w.fs.holdings.push(other);
  const id = hostId({ p: 127, q: 0, site: 2, gen: 1, seq: 0 }).toString();
  w.province.entries[0].id = BigInt(id); w.fs.hand.host = id;
  const s = ready(w);
  assert.equal(s.status, 'review'); assert.equal(s.source.home.p, '127'); assert.equal(s.source.origin.p, '128');
  assert.equal(s.source.hostId, id); assert.equal(w.fs.activeHolding, 0);
  assert.equal(s.review.roles.find(r => r.name === 'holding').address, A.of('Holding', other));
  assert.notEqual(s.review.roles.find(r => r.name === 'province').address, s.review.roles.find(r => r.name === 'holding_province').address);
});

test('six directions append, undo/reset clear review, and max 32 cannot overflow or mutate legacy state', () => {
  const w = world(), refs = Object.fromEntries(Object.entries(w.fs)); open(w);
  for (let i = 0; i < 32; i++) assert.equal(editOutbound(w.fs, w.ctx, 'step', String(i % 2 ? 3 : 0)), true);
  assert.equal(w.fs.expeditionCompose.directions.length, 32);
  for (const d of ['0', '6', '-1', 'x', '0.0']) assert.equal(editOutbound(w.fs, w.ctx, 'step', d), false);
  editOutbound(w.fs, w.ctx, 'undo'); assert.equal(w.fs.expeditionCompose.directions.length, 31);
  editOutbound(w.fs, w.ctx, 'reset'); assert.deepEqual(w.fs.expeditionCompose.directions, []); assert.equal(w.fs.expeditionCompose.review, null);
  assert.deepEqual(outboundSketch([0, 1, 2, 3, 4, 5]).at(-1), { q: 0, r: 0 });
  for (const [k, v] of Object.entries(refs)) assert.equal(w.fs[k], v, k);
});

test('fifth entered province is refused without replacing the prior trace, never shown as valid', () => {
  const w = world(); open(w); let refused = false;
  for (let i = 0; i < 32; i++) {
    const before = [...w.fs.expeditionCompose.directions], trace = w.fs.expeditionCompose.trace;
    if (!editOutbound(w.fs, w.ctx, 'step', '0')) {
      assert.equal(w.fs.expeditionCompose.error, 'PathProvinces');
      assert.deepEqual(w.fs.expeditionCompose.directions, before); assert.equal(w.fs.expeditionCompose.trace, trace);
      assert.equal(w.fs.expeditionCompose.review, null); refused = true; break;
    }
  }
  assert.equal(refused, true);
});

test('inner destination is not outbound; arrival accepts only canonical u32 proposal and never proves travel', () => {
  const w = world(); open(w); editOutbound(w.fs, w.ctx, 'step', '3');
  assert.equal(w.fs.expeditionCompose.error, 'WideDestinationRequired'); assert.equal(w.fs.expeditionCompose.review, null);
  ready(w);
  for (const bad of ['', '044', '-0', '-1', ' 44', '1e2', '4294967296']) {
    editOutbound(w.fs, w.ctx, 'arriveBell', bad); assert.equal(w.fs.expeditionCompose.review, null); assert.equal(w.fs.expeditionCompose.error, 'ArrivalRequired');
  }
  for (const proposed of ['0', '44', '4294967295']) {
    editOutbound(w.fs, w.ctx, 'arriveBell', proposed); assert.equal(w.fs.expeditionCompose.review.arriveBell, Number(proposed));
    assert.equal(w.fs.expeditionCompose.review.arrivalVerified, false);
  }
});

test('existing four stances, retreat presets/custom and exactly three season tip presets are proposals only', () => {
  const w = world(); ready(w);
  for (const stance of ['0', '1', '2', '3']) { editOutbound(w.fs, w.ctx, 'stance', stance); assert.equal(w.fs.expeditionCompose.review.stance, Number(stance)); }
  for (const [id, bps] of [['never', 0], ['x2', 20000], ['x1.5', 15000], ['x1', 10000], ['x0.5', 5000]]) {
    editOutbound(w.fs, w.ctx, 'retreat', id); assert.equal(w.fs.expeditionCompose.review.retreatBps, bps);
  }
  editOutbound(w.fs, w.ctx, 'retreat', 'custom'); assert.equal(w.fs.expeditionCompose.review, null);
  for (const bad of ['0x2', '1e0', ' 1', '1 ', '01', '1.00001']) { editOutbound(w.fs, w.ctx, 'ratio', bad); assert.equal(w.fs.expeditionCompose.review, null); }
  editOutbound(w.fs, w.ctx, 'ratio', '1.25'); assert.equal(w.fs.expeditionCompose.review.retreatBps, 12500);
  for (const tip of ['standard', 'decisive', 'maximum']) { editOutbound(w.fs, w.ctx, 'tip', tip); assert.equal(w.fs.expeditionCompose.review.tip.id, tip); }
  assert.equal(editOutbound(w.fs, w.ctx, 'tip', '0'), false);
});

test('repeated edits rebuild immutable reviews; close/reopen starts empty and stale edit after close is ignored', () => {
  const w = world(), first = ready(w).review;
  editOutbound(w.fs, w.ctx, 'arriveBell', '45'); assert.notEqual(w.fs.expeditionCompose.review, first); assert.equal(first.arriveBell, 44);
  assert.equal(Object.isFrozen(first), true);
  clearOutbound(w.fs); w.fs.hand.pop = null; assert.equal(editOutbound(w.fs, w.ctx, 'step', '0'), false);
  w.fs.hand.pop = OUTBOUND_POP; open(w); assert.deepEqual(w.fs.expeditionCompose.directions, []); assert.equal(w.fs.expeditionCompose.arriveBell, '');
});

test('owner, generation, issuance, movement, viewer/source/season/session/pin changes invalidate preparation', () => {
  const changes = [w => { w.h.ownerCitizen = fromB58(OTHER); }, w => { w.h.gen++; }, w => { w.h.hostSeq++; },
    w => { w.province.entries[0].tile--; }, w => { w.province.entries[0].troops++; }, w => { w.fs.selected.idx--; },
    w => { w.fs.wallet = { address: WALLET }; }, w => { w.fs.wallet.address = OTHER; }, w => { w.fs.session = { publicKey: OTHER }; },
    w => { w.ctx.source = {}; }, w => { w.ctx.relay = '/new'; }, w => { w.ctx.pin = { ...PIN, cluster: 'testnet' }; },
    w => { w.fs.season.programVersion++; }, w => { w.fs.season.endBell++; }, w => { w.fs.season.rulesetHash[0]++; },
    w => { w.fs.activeHolding++; }, w => { w.fs.meStatus = 'error'; }, w => { w.fs.resident = {}; }, w => { w.fs.compose = {}; },
    w => { w.h.transit[0].state = 1; }];
  for (const change of changes) { const w = world(); ready(w); change(w); assert.equal(reconcileOutbound(w.fs, w.ctx), false); assert.equal(w.fs.expeditionCompose.review, null); assert.deepEqual(w.fs.expeditionCompose.directions, []); }
});

test('semantically unchanged decoded account polling preserves route and irrelevant season counters do not reset it', () => {
  const w = world(), review = ready(w).review;
  w.fs.holdings = structuredClone(w.fs.holdings); w.fs.citizen = structuredClone(w.fs.citizen); w.fs.provinces = structuredClone(w.fs.provinces);
  w.fs.season = { ...w.fs.season, provinceCount: 999 };
  assert.equal(reconcileOutbound(w.fs, w.ctx), true); assert.equal(w.fs.expeditionCompose.review, review);
});

test('clock settings and other sources drop the draft; the clock running on keeps the steps and fields and works the review out again; equal copies change nothing', () => {
  // hard: another chain object, another clock policy, another season schedule or beacon setting is another source
  const hard = [w => { w.fs.chain = { now: () => 1000 }; }, w => { w.fs.chain.accelerated = true; }, w => { w.fs.chain.declared = 0; }, w => { w.fs.clock = { genesisTs: 2 }; },
    w => { w.fs.season.drandGenesis = 2; }, w => { w.fs.season.drandPeriod = Number(w.fs.season.drandPeriod ?? 0) + 1; },
    w => { w.fs.season.seedMargin = Number(w.fs.season.seedMargin ?? 0) + 1; }, w => { w.fs.season.revealWindow = Number(w.fs.season.revealWindow ?? 0) + 1; },
    w => { w.fs.season.windowFromBell = Number(w.fs.season.windowFromBell ?? 0) + 1; },
    w => { w.fs.season.windowNext = Number(w.fs.season.windowNext ?? 0) + 1; }, w => { w.fs.season.quicknetPkHash = new Uint8Array(32).fill(3); }];
  for (const change of hard) { const w = world(); ready(w); change(w); assert.equal(reconcileOutbound(w.fs, w.ctx), false); assert.equal(w.fs.expeditionCompose.review, null); assert.equal(w.fs.expeditionCompose.error, 'SourceChanged'); assert.deepEqual(w.fs.expeditionCompose.directions, []); }
  // freshness: the turn, the last slot and its time, the measured rate. Forward: the draft stands, the review is another one
  const forward = [w => { w.fs.nowBell++; }, w => { w.fs.chain.last = { slot: 11, unix: 1001 }; }, w => { w.fs.chain.rate = 2; }];
  for (const change of forward) {
    const w = world(), before = ready(w), review = before.review, directions = [...before.directions], arriveBell = before.arriveBell;
    change(w);
    assert.equal(reconcileOutbound(w.fs, w.ctx), true);
    const s = w.fs.expeditionCompose;
    assert.equal(s, before, 'the same draft'); assert.deepEqual(s.directions, directions); assert.equal(s.arriveBell, arriveBell); assert.equal(s.error, null); assert.equal(s.status, 'review');
    assert.notEqual(s.review, review, 'worked out again'); assert.deepEqual({ ...s.review }, { ...review }, 'from the same source and fields: the same content');
    const again = s.review; assert.equal(reconcileOutbound(w.fs, w.ctx), true); assert.equal(s.review, again, 'once for a move of the clock, not on every look');
  }
  const w = world(); w.fs.chain.last = { slot: 10, unix: 1000 }; w.fs.clock = { genesisTs: 0 };
  const review = ready(w).review; w.fs.chain.last = { slot: 10, unix: 1000, at: 99999 }; w.fs.clock = { genesisTs: 0 };
  assert.equal(reconcileOutbound(w.fs, w.ctx), true); assert.equal(w.fs.expeditionCompose.review, review);
});

test('proposed roles use an observed free slot and remain unavailable for full or inconsistent slot data', () => {
  for (const malformed of [false, true]) {
    const w = world(); w.h.transit.forEach(t => { t.state = 1; t.hostId = 0n; });
    if (malformed) w.h.transit[3].state = 4;
    const s = ready(w); assert.equal(s.status, 'review'); assert.equal(s.review.roles, null); assert.equal(s.review.transitSlot, null);
    assert.ok(s.review.blockers.includes('CanonicalRolesUnavailable'));
  }
  const w = world(); w.h.transit[0].state = 1; w.h.transit[0].hostId = 0n;
  const s = ready(w); assert.equal(s.review.transitSlot, 1); assert.equal(s.review.roles.length, 9);
  assert.ok(s.review.blockers.includes('TransitSlotObservationUnverified'));
});

test('actual controller open/edit/bind/reconcile/applyMeResult lifecycle preserves unchanged polls and clears failures', () => {
  const saved = { ...STORE };
  try {
    const w = world(); io.setPin({ programId: PROGRAM, cluster: 'localnet', seasonId: '1' }); CTRL.useHerald({});
    Object.assign(STORE, w.fs, { agentWallet: false, sessionProblem: null });
    CTRL.openOriginalOutbound(); CTRL.editOriginalOutbound('step', '0'); CTRL.bind('outbound-arriveBell', '44');
    assert.equal(STORE.expeditionCompose.status, 'review'); const review = STORE.expeditionCompose.review;
    const poll = () => ({ ok: true, citizen: structuredClone(w.fs.citizen), holdings: [structuredClone(w.h)], slots: [], record: {} });
    assert.equal(CTRL.applyMeResult(poll()), 'found'); assert.equal(STORE.expeditionCompose.review, review);
    const changed = poll(); changed.holdings[0].gen++; CTRL.applyMeResult(changed); assert.equal(STORE.expeditionCompose.review, null);
    for (const code of ['NotFound', 'Unavailable']) {
      CTRL.applyMeResult(poll()); CTRL.openOriginalOutbound(); CTRL.editOriginalOutbound('step', '0'); CTRL.bind('outbound-arriveBell', '44');
      assert.equal(STORE.expeditionCompose.status, 'review'); CTRL.applyMeResult({ ok: false, code }); assert.equal(STORE.expeditionCompose.review, null);
    }
    CTRL.applyMeResult(poll()); CTRL.openOriginalOutbound(); CTRL.editOriginalOutbound('step', '0'); CTRL.bind('outbound-arriveBell', '44');
    CTRL.useHerald({}); assert.equal(STORE.expeditionCompose.review, null);
  } finally { CTRL.useHerald(null); for (const k of Object.keys(STORE)) delete STORE[k]; Object.assign(STORE, saved); }
});

test('direct hand model/render has directions, full plaintext, local sketch and warnings, but no working seal/send form', () => {
  setLang('en');
  try {
    const w = world(); ready(w); const model = hand.handModel(w.fs), markup = String(hand.renderPop(w.fs, model));
    assert.equal(model.pop, OUTBOUND_POP); assert.equal(model.armed, false);
    assert.equal((markup.match(/data-act="outbound-step"/g) ?? []).length, 6);
    assert.match(markup, /Prepare a boundary route/); assert.match(markup, /Sealing, signing and sending are all disabled/); assert.match(markup, /136-byte/);
    assert.ok(markup.includes(w.fs.expeditionCompose.review.plainHex)); assert.match(markup, /<svg/);
    assert.doesNotMatch(markup, /<form|data-act="(?:march-send|dissolve|hand-return|seal|send)"/);
    w.fs.expeditionCompose.arriveBell = '"><img src=x onerror=x>'; w.fs.expeditionCompose.error = '<script>oops</script>';
    const escaped = String(hand.renderPop(w.fs, model)); assert.match(escaped, /&lt;script&gt;/); assert.doesNotMatch(escaped, /<script|<img src=x/);
    w.fs.hand.pop = null; assert.equal(hand.handModel(w.fs).armed, true);
    for (const version of [3, 32768, -1, 65536]) { w.fs.season.programVersion = version; w.fs.hand.pop = OUTBOUND_POP; assert.equal(hand.popOf(w.fs), null); }
    const village = world({ village: true }); assert.equal(hand.handModel(village.fs).buttons.some(x => x.id === OUTBOUND_POP), false);
  } finally { setLang('ja'); }
});

test('source-bound DOM integration disables legacy map/far/keep/search routes and preserves inspection guards', () => {
  const app = source('app.mjs'), controller = source('controller.mjs'), core = source('fexpedition-compose.mjs');
  assert.match(app, /function actionsNow\(\)[^]*?FS\.hand\?\.pop === OUTBOUND_POP\) return null/);
  assert.match(app, /model\.pop !== OUTBOUND_POP && model\.pop !== EXPEDITION_POP && keephand/);
  assert.match(app, /FS\.hand\?\.pop !== OUTBOUND_POP && FS\.hand\?\.pop !== EXPEDITION_POP && !Number\.isInteger\(hit\.idx\)/);
  assert.match(app, /hit0\?\.keep[^\n]*FS\.hand\?\.pop !== OUTBOUND_POP/);
  assert.match(app, /sub\?\.kind === 'host' && FS\.hand\?\.pop !== OUTBOUND_POP[^\n]*hand\.marchCheck/);
  assert.match(app, /if \(next === OUTBOUND_POP\) openOriginalOutbound\(\)/);
  for (const name of ['step', 'undo', 'reset']) assert.ok(app.includes(`'outbound-${name}':`));
  assert.match(app, /data-bind\^="outbound-/); assert.match(app, /clearInspection\(FS\); clearOutbound\(FS\)/);
  assert.match(controller, /export const reconcileExpedition[^\n]*outbound\.reconcileOutbound/);
  assert.match(controller, /name\.startsWith\('outbound-'\)/);
  assert.doesNotMatch(core, /(?:planRoute\(|plan_path|sealMarch|sealRequest|randomBytes|randomUUID|tx\.submit|fetch\(|new Worker|sendMarch\(|handOrder\(|\.sign\()/);
  assert.doesNotMatch(core, /fs\.(?:selected|provinces|compose|marches|book|session)\s*=/);
});
