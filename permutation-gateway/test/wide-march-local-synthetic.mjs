// SYNTHETIC, structure-only v4 snapshots for the browser contract tests. Never used by the demo, never served,
// never evidence of a host round trip. They are built byte-coherently so that the strict model accepts them: every
// reported number is written into the account bytes it is read from, every receipt is a canonical PSW1 body whose
// links are advanced from the accounts' own chain headers with the receipt module's chain rule, the transit record
// carries the binding's root, and a binding's route is the geometry walk of its directions. Payload facts (digests,
// troops, fees) are placeholders the browser does not replay. No key, signature or native/fixture generator is used.
import { PROTOCOL, SESSION, allowedFor, MARCH, HISTORY } from '../screens/wide-march-local/local-model.mjs';
import { encodeRecord, advance, KINDS, KIND, provinceKeyHex } from '../screens/wide-march-local/local-receipts.mjs';
import { walkDirections, provincesEntered } from '../screens/wide-march-local/local-route.mjs';
import { ringPosition } from '../../permutation-server/web/frontier/map/wide.mjs';

export const toHex = b => Buffer.from(b).toString('hex');
export const fromHex = s => Buffer.from(s, 'hex');
export const dv = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
export const WORLD = '33'.repeat(32), PROGRAM = '12'.repeat(32), ZERO = '00'.repeat(32);
/** Every tile passable (61 bits): synthetic land on which any walked route is legal. */
export const ALL_PASSABLE = ((1n << 61n) - 1n).toString();
export const SEED_ROUND = 32547581n, PROVINCE_RENT = '34744320', FUND_LAMPORTS = '200000000';
export const GENESIS = 1790444847n;
export const clockAt = (bell, off) => ({ unix: String(GENESIS + BigInt(bell * 600 + off)), bell });
export const RECORDED_DIRS = '222';
export const ROOT_RECORDED = 'a1'.repeat(32), ROOT_CHOSEN = 'b2'.repeat(32);
export const TRANSIT_KEY = '0e'.repeat(32);
/** The host reference: world, (129,0) ring 129 wedge 0 position 0, site 0, generation 1, sequence 0. */
export const HOST_REF = '01' + WORLD + '0000000000000081' + '00' + '0000000000000000' + '00' + '01' + '00000000';
function raw(n, magic, sortOffset, p, q) {
  const b = Buffer.alloc(n), d = dv(b); b.write(magic); d.setUint16(16, 3, true);
  const rp = ringPosition(BigInt(p), BigInt(q)); d.setBigUint64(sortOffset, rp.ring, false); b[sortOffset + 8] = rp.wedge; d.setBigUint64(sortOffset + 9, rp.pos, false);
  const wide = n === 1344 ? 1280 : 4736; d.setUint16(wide, 1, true); b[wide + 2] = 1; if (n === 4864) b[4739] = 15;
  b.fill(0x33, n === 1344 ? 1288 : 4740, n === 1344 ? 1320 : 4772);
  return b;
}
export const acct = (key, b, lamports = '0') => ({ keyHex: key.repeat(32), ownerHex: PROGRAM, lamports, dataHex: toHex(b) });
/** A wide province's bytes: identity, bells, mask and the ring seed record's literal seed and round in the trailer. */
export function provinceBytes(p, q, { resolvedNext, openedBell, region, funded = 0n, mask = ALL_PASSABLE }) {
  const b = raw(4864, 'PSFXWPV1', 4772, p, q), d = dv(b);
  b[70] = ringPosition(BigInt(p), BigInt(q)).wedge; b[71] = region; d.setUint32(72, resolvedNext, true); d.setUint32(76, openedBell, true);
  d.setBigUint64(264, BigInt(mask), true);
  d.setBigUint64(4792, SEED_ROUND, true); b.fill(0x81, 4800, 4832); d.setBigUint64(4832, funded, true);
  return b;
}
export const PROVENANCE = { ringSeed: 'LOCAL_SYNTHETIC_RING_SEED', rules: 'PROTOTYPE_CANDIDATE_RULES_V1', funds: 'LOCAL_FIXTURE_FUNDS', golden: 'GOLDEN_REOPEN_STATIC_FIELDS_MATCH', opened: 'REAL_HANDLER_OUTPUT_AT_SUPPLIED_TIME', resolveHistory: 'NO_RESOLVE_HISTORY', auth: 'MOCK_PAYER_SIGNER_FLAG_NO_SIGNATURE', budget: 'DEMO_BUDGET_4_EXTRA_PROVINCES' };
export const FUND_KEYS = ['07', '08', '09', '0a', '0b', '0c'];
function landAccounts(created = 3n) {
  const s = Buffer.alloc(192), sd = dv(s); s.write('PSFXWRS1'); s[18] = 2; sd.setBigUint64(20, 129n, true); sd.setBigUint64(40, SEED_ROUND, true); s.fill(0x81, 48, 80); s.fill(0x33, 80, 112); sd.setBigUint64(112, created, true);
  const c = Buffer.alloc(96); c.write('PSFXWRC1'); dv(c).setUint16(16, 1, true); c.set([1, 2, 2, 1], 18); c.fill(0x33, 24, 56); c.fill(0xaa, 56, 88);
  const funds = FUND_KEYS.map((k, w) => { const f = Buffer.alloc(128); f.write('PSF1PFND'); f[16] = w; return acct(k, f, FUND_LAMPORTS); });
  return [acct('05', s), acct('06', c), ...funds];
}
const zeroStore = () => ({ value: '0', rate: '0', cap: '0', t0: '0' });
const freeSlot = () => ({ doneAt: '0', kind: 0, arg: 0, delta: '0' });
const empty = key => ({ keyHex: key, ownerHex: ZERO, lamports: '0', dataHex: '' });
const fixtureProvince = (p, q, keyHex, resolvedNext, region) => ({ p, q, accountKeyHex: keyHex, passableMask: ALL_PASSABLE, source: 'fixture', openedBell: 1, resolvedNext, wedge: ringPosition(BigInt(p), BigInt(q)).wedge, region, history: HISTORY.FIXTURE });
/** The recorded route: the geometry walk of the recorded directions from the origin tile (2), ending at (129,-1). */
function recordedRoute() {
  const w = walkDirections({ p: '129', q: '0', tile: 2 }, RECORDED_DIRS), last = w.steps.at(-1);
  if (w.offWorld !== null || last.p !== '129' || last.q !== '-1') throw new Error('synthetic recorded route does not reach (129,-1)');
  return [{ p: '129', q: '0', tile: 2 }, ...w.steps];
}
/** A fresh SYNTHETIC v4 `ready` snapshot at revision 0 (factories only: no object is shared between calls). */
export function fixture() {
  const hb = raw(1344, 'PSFXWHL1', 1320, 129, 0), hd = dv(hb);
  hb[69] = 1; // GEN: the host reference's generation
  hb.fill(0x04, 72, 104); // OWNER_CITIZEN: the village citizen account below
  hd.setBigInt64(152, 1900000n, true); hd.setBigInt64(160, 40000n, true); hd.setBigInt64(168, 2000000n, true); hd.setBigInt64(176, 1790447367n, true);
  hd.setBigInt64(472, 40000n, true); hd.setUint32(720, 600, true);
  const ob = provinceBytes(129, 0, { resolvedNext: 5, openedBell: 1, region: 8 }), db = provinceBytes(129, -1, { resolvedNext: 20, openedBell: 1, region: 6 });
  const cb = Buffer.alloc(384); cb.write('PSF1CITZ');
  const h = acct('01', hb), a = acct('02', ob), b = acct('03', db), c = acct('04', cb);
  const route = recordedRoute();
  return {
    protocol: PROTOCOL, mode: 'local-only', auth: 'MOCK_AUTH_NO_SIGNATURE', beacon: 'PUBLIC_FIXTURES_REAL_VERIFICATION', session: SESSION, status: 'ok', error: null, refusalCode: null, command: 'get', revision: 0, phase: 'ready',
    allowed: ['depart', 'harvest', 'build_farm', 'train', 'open_province', 'reset'], clock: clockAt(6, 60),
    horizon: { model: 'PHASE_STEPS_ONLY', finalBell: 25, destinationPreparedThroughBell: 19, originResolvedNext: 5, destinationResolvedNext: 20, selectedDestinationResolvedNext: null },
    economy: { perInstantBudget: 8, usedThisInstant: 0, harvests: 0, farmBuilds: 0, trains: 0, farmItem: 0, trainUnit: 0, trainCount: 10 },
    village: { tier: 0, flags: 0, lastOwnerAction: '0', stores: [{ value: '1900000', rate: '40000', cap: '2000000', t0: '1790447367' }, ...Array.from({ length: 7 }, zeroStore)], production: ['40000', ...Array(7).fill('0')], queue: Array.from({ length: 4 }, freeSlot), reserve: [600, 0, 0, 0, 0, 0, 0, 0] },
    land: { ring: 129, budget: 4, opened: 0, provincesCreated: 3, ringSeedKeyHex: '05'.repeat(32), rulesConfigKeyHex: '06'.repeat(32), fundKeysHex: FUND_KEYS.map(k => k.repeat(32)), provenance: { ...PROVENANCE } },
    map: { worldHex: WORLD, origin: { p: '129', q: '0' }, destination: { p: '129', q: '-1' }, route, provinces: [fixtureProvince('129', '0', a.keyHex, 5, 8), fixtureProvince('129', '-1', b.keyHex, 20, 6)] },
    host: { refHex: HOST_REF, originTile: 2, destinationTile: route.at(-1).tile, initialMilli: 300000, currentMilli: 300000, transitState: 'absent', fate: null },
    holding: { accountKeyHex: h.keyHex, tile: 0, reserveUnits: 600, escrowLamports: '0', poolOwedLamports: '0', openTransits: 0 },
    combat: { engagements: 0, arrivalSurvivorMilli: null, enemyFixture: true }, returned: { creditedUnits: 0, creditedMilli: 0 }, marchBinding: null,
    evidence: { instructions: [], recordsHex: [], accounts: [h, a, b, c, ...landAccounts(), empty(TRANSIT_KEY)] }, routeQuote: null,
  };
}
// ------------------------------------------------------------------ byte edits
export const accountOf = (r, keyHex) => r.evidence.accounts.find(x => x.keyHex === keyHex);
/** Edit one account's bytes in place, by key prefix byte ('01') or full key hex. */
export function editBytes(r, key, fn) { const a = accountOf(r, key.length === 2 ? key.repeat(32) : key); const b = fromHex(a.dataHex); fn(b, dv(b)); a.dataHex = toHex(b); }
const chainOf = (r, keyHex) => { const b = fromHex(accountOf(r, keyHex).dataHex); return { seq: dv(b).getBigUint64(24, true), head: toHex(b.subarray(32, 64)) }; };
const setChain = (r, keyHex, seq, head) => editBytes(r, keyHex, (b, d) => { d.setBigUint64(24, seq, true); b.set(fromHex(head), 32); });
const le32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return toHex(b); };
const le64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return toHex(b); };
export const provinceKey = (p, q) => provinceKeyHex(WORLD, p, q);
const provinceAccount = (r, p, q) => r.map.provinces.find(x => x.p === p && x.q === q).accountKeyHex;
/** Appends one canonical receipt, advancing every chain its kind links (the province it is attributed to and/or the
 * holding) in the account headers of `r`. `at` is the attributed province {p, q}. */
export function emit(r, kind, bell, keyHex, at, payloadHex = '00'.repeat(KINDS[kind].payloadLen)) {
  const bwt = '82' + kind.toString(16).padStart(2, '0') + le32(bell) + keyHex + payloadHex;
  const links = KINDS[kind].links.map(e => {
    const k = e === 1 ? provinceAccount(r, at.p, at.q) : r.holding.accountKeyHex, c = chainOf(r, k);
    const l = advance(e, c.seq, c.head, bwt); setChain(r, k, l.seq, l.headHex); return l;
  });
  r.evidence.recordsHex.push(encodeRecord({ kind, bell, keyHex, payloadHex, links }));
}
const hostKey = (p, q) => HOST_REF + provinceKey(p, q);
/** Moves province i's resolve cursor consistently: bytes, summary, horizon (origin/recorded destination/selected). */
export function setCursor(r, i, v) {
  const p = r.map.provinces[i];
  editBytes(r, p.accountKeyHex, (b, d) => d.setUint32(72, v, true)); p.resolvedNext = v;
  if (i === 0) r.horizon.originResolvedNext = v;
  if (i === 1) r.horizon.destinationResolvedNext = v;
  if (r.marchBinding && r.marchBinding.destination.accountKeyHex === p.accountKeyHex) r.horizon.selectedDestinationResolvedNext = v;
}
function setTransit(r, state, { dest = null } = {}) {
  const a = accountOf(r, TRANSIT_KEY);
  if (state === null) { Object.assign(a, { ownerHex: ZERO, lamports: '0', dataHex: '' }); return; }
  const b = Buffer.alloc(288); b[0] = 1; b[1] = state; b[7] = dest ? 1 : 0;
  b.set(fromHex(r.host.refHex), 8); b.set(fromHex(provinceKey('129', '0')), 64); if (dest) b.set(fromHex(dest), 116);
  dv(b).setUint32(172, 20, true); b.set(fromHex(r.marchBinding.order.rootHex), 200);
  Object.assign(a, { ownerHex: PROGRAM, lamports: '2895360', dataHex: toHex(b) });
}
const fresh = (prev, cmd) => { const n = structuredClone(prev); Object.assign(n, { command: cmd, revision: prev.revision + 1, status: 'ok', error: null, refusalCode: null, routeQuote: null }); n.evidence.instructions = []; n.evidence.recordsHex = []; return n; };
const reallow = n => { n.allowed = allowedFor(n.phase, n.economy.usedThisInstant, n.land.opened); };
const moveClock = (n, c) => { if (c.unix !== n.clock.unix) n.economy.usedThisInstant = 0; n.clock = { ...c }; };
// ------------------------------------------------------------------ openings and economy
/** A consistent successful opening of ring-129 (p, q): the new province (opened now, fresh chain header, no
 * history, its own lamports funded), the ring seed's count + 1, one wedge fund paying the rent. */
export function openStep(prev, p, q, { key = '10', wedge = 0, region = 3, mask = ALL_PASSABLE } = {}) {
  const n = fresh(prev, 'open_province');
  n.evidence.instructions = ['WideOpenProvince'];
  const bell = n.clock.bell;
  n.evidence.accounts.push(acct(key, provinceBytes(p, q, { resolvedNext: bell, openedBell: bell, region, funded: BigInt(PROVINCE_RENT), mask }), PROVINCE_RENT));
  n.map.provinces.push({ p, q, accountKeyHex: key.repeat(32), passableMask: mask, source: 'opened', openedBell: bell, resolvedNext: bell, wedge: ringPosition(BigInt(p), BigInt(q)).wedge, region, history: HISTORY.NONE });
  n.land.opened++; n.land.provincesCreated++;
  editBytes(n, '05', (b, d) => d.setBigUint64(112, d.getBigUint64(112, true) + 1n, true));
  const f = accountOf(n, FUND_KEYS[wedge].repeat(32)); f.lamports = String(BigInt(f.lamports) - BigInt(PROVINCE_RENT));
  editBytes(n, FUND_KEYS[wedge], (b, d) => { d.setUint32(20, d.getUint32(20, true) + 1, true); d.setUint32(44, d.getUint32(44, true) + 1, true); });
  reallow(n);
  return n;
}
const ACTION = { harvest: '000000000000', build_farm: '010000000000', train: '02000a000000' };
/** A consistent economy reply: bytes and the reported village moved together, one Economy receipt on the holding. */
export function economyStep(prev, kind, { reserveDelta = kind === 'train' ? 10 : 0, storeValue = '1890000' } = {}) {
  const n = fresh(prev, kind);
  n.economy.usedThisInstant++; n.economy[{ harvest: 'harvests', build_farm: 'farmBuilds', train: 'trains' }[kind]]++;
  reallow(n);
  n.evidence.instructions = [{ harvest: 'Harvest', build_farm: 'BuildFarm', train: 'Train' }[kind]];
  editBytes(n, '01', (b, d) => { d.setBigInt64(152, BigInt(storeValue), true); d.setUint32(720, d.getUint32(720, true) + reserveDelta, true); });
  editBytes(n, '04', b => { b[160] ^= 1; });
  n.village.stores[0] = { ...n.village.stores[0], value: storeValue }; n.village.reserve[0] += reserveDelta; n.holding.reserveUnits += reserveDelta;
  emit(n, KIND.ECONOMY, n.clock.bell, HOST_REF, { p: '129', q: '0' }, '01' + ACTION[kind] + le64(n.clock.unix) + '00' + '11'.repeat(32) + '22'.repeat(32));
  return n;
}
// ------------------------------------------------------------------ the marches
const CHOSEN_DEPART_TRAIL = ['RECORDED_ORDER_REPRODUCED', 'REBUILT_FROM_PUBLIC_MATERIAL_T20', 'REAL_DEPART', 'REVEAL_REHEARSED_ON_DROPPED_COPY'];
/** The binding a chosen departure along `dirs` produces on `prev` (the walk's end must be an opened province). */
export function chosenBinding(prev, dirs) {
  const w = walkDirections({ p: prev.map.origin.p, q: prev.map.origin.q, tile: prev.host.originTile }, dirs);
  const end = w.steps.at(-1), dest = prev.map.provinces.find(p => p.p === end.p && p.q === end.q);
  const entered = provincesEntered(w.steps);
  return {
    kind: 'chosen', directions: dirs, arriveBell: 20, departedMilli: prev.host.currentMilli,
    destination: { p: end.p, q: end.q, tile: end.tile, accountKeyHex: dest.accountKeyHex, source: dest.source },
    steps: w.steps, provincesEntered: entered,
    pathProvinces: entered.filter(e => !(e.p === end.p && e.q === end.q)).map(e => ({ p: e.p, q: e.q, accountKeyHex: provinceAccount(prev, e.p, e.q) })),
    order: { source: MARCH.orderRebuilt, commitHex: 'c3'.repeat(32), rootHex: ROOT_CHOSEN, labels: [...MARCH.orderLabels] },
    preparation: null, accounts: [], trail: [...CHOSEN_DEPART_TRAIL],
  };
}
function recordedBinding(prev) {
  const steps = prev.map.route.slice(1), entered = provincesEntered(steps);
  return {
    kind: 'recorded', directions: RECORDED_DIRS, arriveBell: 20, departedMilli: prev.host.currentMilli,
    destination: { p: '129', q: '-1', tile: prev.host.destinationTile, accountKeyHex: prev.map.provinces[1].accountKeyHex, source: 'fixture' },
    steps, provincesEntered: entered,
    pathProvinces: entered.filter(e => e.q !== '-1').map(e => ({ p: e.p, q: e.q, accountKeyHex: provinceAccount(prev, e.p, e.q) })),
    order: { source: MARCH.orderRecorded, commitHex: 'c1'.repeat(32), rootHex: ROOT_RECORDED, labels: [] },
    preparation: null, accounts: [], trail: [...MARCH.recordedTrail],
  };
}
const destIndex = n => n.map.provinces.findIndex(p => p.accountKeyHex === n.marchBinding.destination.accountKeyHex);
const destAt = n => ({ p: n.marchBinding.destination.p, q: n.marchBinding.destination.q });
let synthKey = 0x40;
const newAccount = (n, role) => {
  if (synthKey > 0xd0) synthKey = 0x40; // 0x40..0xd0: never a fixture, opened-province or test-forged key
  const k = (synthKey++).toString(16).padStart(2, '0').repeat(32);
  n.evidence.accounts.push({ keyHex: k, ownerHex: PROGRAM, lamports: '1000000', dataHex: toHex(Buffer.from(`SYNTHETIC ${role}`)) });
  n.marchBinding.accounts.push({ role, keyHex: k });
};
/**
 * One SYNTHETIC phase step (or departure) of whichever march is (or becomes) bound, byte-coherent:
 *  depart / depart_route (opts.dirs) → departed; settle_departure → travelling (origin resolves 5, 6);
 *  post_reveal → revealed (a chosen destination prepared from its opened bell through 19, then Revealed);
 *  resolve_arrival → resolved (Gathered, Resolve 20); settle_transit → settled; dissolve_return → returned.
 * The chosen arrival has no enemy: zero engagements, every departed troop stays.
 */
export function step(prev, cmd, opts = {}) {
  const n = fresh(prev, cmd);
  const resolve = (i, bell, at) => { emit(n, KIND.RESOLVE, bell, provinceKey(at.p, at.q), at); n.evidence.instructions.push('Resolve'); setCursor(n, i, bell + 1); };
  switch (cmd) {
    case 'depart': case 'depart_route': {
      n.phase = 'departed';
      n.marchBinding = cmd === 'depart' ? recordedBinding(prev) : chosenBinding(prev, opts.dirs);
      if (cmd === 'depart_route') n.combat.enemyFixture = false;
      n.horizon.selectedDestinationResolvedNext = n.map.provinces[destIndex(n)].resolvedNext;
      emit(n, KIND.DEPARTED, n.clock.bell, hostKey('129', '0'), { p: '129', q: '0' }); n.evidence.instructions.push('Depart');
      setTransit(n, 1); n.host.transitState = 'departed';
      break;
    }
    case 'settle_departure': {
      moveClock(n, clockAt(8, 60)); n.phase = 'travelling';
      for (let bell = prev.horizon.originResolvedNext; bell < (opts.originTo ?? 7); bell++) resolve(0, bell, { p: '129', q: '0' });
      emit(n, KIND.DEPARTURE_SETTLED, 8, hostKey('129', '0'), { p: '129', q: '0' }); n.evidence.instructions.push('SettleDeparture');
      setTransit(n, 2); n.host.transitState = 'settled';
      break;
    }
    case 'post_reveal': {
      moveClock(n, clockAt(21, 300)); n.phase = 'revealed';
      const i = destIndex(n), at = destAt(n), b = n.marchBinding;
      if (b.kind === 'chosen') {
        const from = n.map.provinces[i].resolvedNext;
        for (let bell = from; bell < 20; bell++) resolve(i, bell, at);
        n.map.provinces[i].history = HISTORY.PREPARED;
        b.preparation = { fromBell: from, toBell: 19, resolvedNext: 20, scoreNextBell: 20, atUnix: clockAt(21, 213).unix, resolves: 20 - from, region: n.map.provinces[i].region, pairsAliased: 0, provenance: MARCH.preparationProvenance, labels: [...MARCH.preparationLabels] };
        b.trail.push('DESTINATION_PREPARED_THROUGH_BELL_19', 'REAL_POSTANCHOR_PUBLIC_SIG_T20', 'BEACON_LOG_LOCAL_FIXTURE_STAGED_FOR_REVEAL', 'REAL_REVEAL');
        for (const role of ['arrival_anchor', 'day', 'slot_0_0']) newAccount(n, role);
      }
      n.evidence.instructions.push('PostAnchor');
      emit(n, KIND.REVEALED, 21, hostKey(at.p, at.q), at); n.evidence.instructions.push('Reveal');
      setTransit(n, 2);
      break;
    }
    case 'resolve_arrival': {
      moveClock(n, clockAt(22, 300)); n.phase = 'resolved';
      const i = destIndex(n), at = destAt(n), b = n.marchBinding;
      n.evidence.instructions.push('PostSeed');
      emit(n, KIND.GATHERED, 22, provinceKey(at.p, at.q), at); n.evidence.instructions.push('Gather');
      resolve(i, 20, at);
      if (b.kind === 'chosen') {
        for (const role of ['arrival_cache', 'inputs_20', 'roster']) newAccount(n, role);
        b.trail.push('REAL_POSTSEED_PUBLIC_SIG_S20', 'REAL_GATHER', 'REAL_ARRIVAL_RESOLVE');
        n.combat.engagements = 0; n.combat.arrivalSurvivorMilli = opts.survivors ?? b.departedMilli;
      } else { n.combat.engagements = 3; n.combat.arrivalSurvivorMilli = opts.survivors ?? 297633; }
      n.host.currentMilli = n.combat.arrivalSurvivorMilli; n.host.fate = 0;
      setTransit(n, 4, { dest: provinceKey(at.p, at.q) });
      break;
    }
    case 'settle_transit': {
      moveClock(n, clockAt(23, 300)); n.phase = 'settled';
      const at = destAt(n);
      emit(n, KIND.TRANSIT_SETTLED, 23, hostKey(at.p, at.q), at, '00'.repeat(32) + provinceKey(at.p, at.q)); n.evidence.instructions.push('SettleTransit');
      if (n.marchBinding.kind === 'chosen') n.marchBinding.trail.push('REAL_SETTLE_TRANSIT');
      setTransit(n, null); n.host.transitState = 'closed';
      break;
    }
    case 'dissolve_return': {
      moveClock(n, clockAt(25, 60)); n.phase = 'returned';
      const i = destIndex(n), at = destAt(n);
      resolve(i, 21, at);
      emit(n, KIND.DISSOLVE, 23, hostKey(at.p, at.q), at); n.evidence.instructions.push('Dissolve');
      resolve(i, 22, at); resolve(i, 23, at);
      emit(n, KIND.RETURN, 25, hostKey(at.p, at.q), at); n.evidence.instructions.push('Return');
      if (n.marchBinding.kind === 'chosen') n.marchBinding.trail.push('PAIRS_21_23_SYNTHETIC_STAGED_PER_DISPATCH', 'REAL_DISSOLVE', 'REAL_RETURN');
      const credited = Math.floor(n.combat.arrivalSurvivorMilli / 1000);
      n.returned = { creditedUnits: credited, creditedMilli: credited * 1000 };
      editBytes(n, '01', (b, d) => d.setUint32(720, d.getUint32(720, true) + credited, true));
      n.village.reserve[0] += credited; n.holding.reserveUnits += credited; n.host.currentMilli = credited * 1000;
      break;
    }
    default: throw new Error(`synthetic step ${cmd}`);
  }
  reallow(n);
  return n;
}
export const MARCH_STEPS = Object.freeze(['settle_departure', 'post_reveal', 'resolve_arrival', 'settle_transit', 'dissolve_return']);
/** A SYNTHETIC session that opened (129,-2) at bell 6 and is ready to send a 12-step direction-2 march into it. */
export function openedSession() { return openStep(fixture(), '129', '-2', { key: '10', wedge: 5, region: 3 }); }
export const CHOSEN_DIRS = '2'.repeat(12);
/** The whole chosen flow on the opened session: [opened, departed, travelling, revealed, resolved, settled, returned]. */
export function chosenFlow() {
  const out = [openedSession()];
  out.push(step(out[0], 'depart_route', { dirs: CHOSEN_DIRS }));
  for (const c of MARCH_STEPS) out.push(step(out.at(-1), c));
  return out;
}
/** The whole recorded flow: [ready, departed, ..., returned]. */
export function recordedFlow(start = fixture()) {
  const out = [start, step(start, 'depart')];
  for (const c of MARCH_STEPS) out.push(step(out.at(-1), c));
  return out;
}
/** The command for a step from `prev`. */
export const cmdOf = (prev, kind, extra = {}) => ({ kind, rev: prev.revision, ...extra });
/** A route-quote reply over `state`, as the host renders a read-only `quote_route`: every piece of state, the
 * revision and the accounts unchanged, status ok, and NO instructions or receipts (the host renders evidence only for
 * the mutation that produced it, never for a read). */
export function quoteReply(state, routeQuote) { const r = structuredClone(state); Object.assign(r, { command: 'quote_route', status: 'ok', error: null, refusalCode: null, routeQuote }); r.evidence.instructions = []; r.evidence.recordsHex = []; return r; }
/** The host quote of `dirs` on `state` as the host would report it (synthetic: all land passable, all held). */
export function hostQuote(state, dirs) {
  const w = walkDirections({ p: state.map.origin.p, q: state.map.origin.q, tile: state.host.originTile }, dirs);
  const held = new Set(state.map.provinces.map(p => `${p.p},${p.q}`));
  const steps = w.steps.map(s => ({ ...s, known: held.has(`${s.p},${s.q}`), passable: held.has(`${s.p},${s.q}`) ? true : null }));
  const blocked = steps.findIndex(s => !s.known);
  const start = { p: state.map.origin.p, q: state.map.origin.q, tile: state.host.originTile };
  if (blocked >= 0) return { start, reachable: false, reason: 'UNKNOWN_PROVINCE', blockedStep: blocked, steps, end: null, provincesEntered: [] };
  return { start, reachable: true, reason: null, blockedStep: null, steps, end: w.steps.at(-1), provincesEntered: provincesEntered(w.steps) };
}
/** A refused reply of `cmd` on `state`: nothing changed. */
export function refused(state, command, error, { refusalCode = null, routeQuote = null } = {}) {
  const r = structuredClone(state); Object.assign(r, { command, status: 'refused', error, refusalCode, routeQuote }); r.evidence.instructions = []; r.evidence.recordsHex = []; return r;
}
