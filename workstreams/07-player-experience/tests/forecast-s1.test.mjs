// Workstream 07, claim 1 of the brief: does the march forecast hold the rules
// the program fights by? Reproduced with the S1 rules module the page loads
// (wasm/frontier-v3.wasm) and a clash recorded on a local chain
// (fixtures/uxs1-keep-two-turns.json, turn 619: a host of 500 on a keep of
// 100; the chain recorded 488.122 left).
//
// `REPRO` tests pin the defect as the page has it now (they pass while the
// defect is there, and fail once a fix lands: then delete them). The others
// pin the model forecast of src/forecast-model.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Kernel } from '../../../permutation-server/web/frontier/wasm.mjs';
import { decode } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { fromBase64 } from '../../../permutation-server/web/sdk/bytes.mjs';
import { decodeClashOut } from '../../../permutation-server/web/frontier/screens/report.mjs';
import { forecast } from '../../../permutation-server/web/frontier/hud/forecast.mjs';
import { LAYOUTS } from '../../../permutation-server/web/sdk/frontier/abi-v2-layouts.mjs';
import { modelForecast, inputsBytes, withoutEntry, DESTROYED_BELOW } from '../src/forecast-model.mjs';
import { marchWatch, watchOf, wearBps, wear, KIND_TOWER } from '../src/s1walk.mjs';

const WEB = new URL('../../../permutation-server/web/frontier/', import.meta.url);
const FIX = JSON.parse(readFileSync(new URL('../../../permutation-gateway/test/fixtures/uxs1-keep-two-turns.json', import.meta.url), 'utf8'));
const REC = FIX.records['619'];
const PB = fromBase64(REC.province_before_b64), IB = fromBase64(REC.inputs_b64);
const PV = decode('Province', PB), CI = decode('ClashInputs', IB);
const ARR = CI.arrivals.find(a => a.present === 1);
const s1 = (async () => new Kernel((await WebAssembly.instantiate(readFileSync(new URL('wasm/frontier-v3.wasm', WEB)), {})).instance.exports))();
const seed = i => Uint8Array.from({ length: 32 }, (_, k) => (i * 31 + k) & 0xff);

/** The composed march the card would forecast for the recorded arrival (its host, tile, stance, stamina). */
const composed = (over = {}) => ({
  host: { id: String(ARR.hostId), unit: ARR.unit, troops: Math.floor(ARR.troops / 1000), staminaValue: ARR.stamina + 10, staminaBell: 619 },
  dest: { p: PV.p, q: PV.q, tile: ARR.tile }, arriveBell: 619, stance: ARR.stance, retreat: 'never', ratio: null, route: { dirs: [] }, ...over,
});

test('the synthesised ClashInputs is the gathered one: the kernel resolves both to the same outcome', async () => {
  const k = await s1;
  const ours = inputsBytes({ hostId: ARR.hostId, faction: ARR.faction, unit: ARR.unit, troops: ARR.troops, stamina: ARR.stamina, tile: ARR.tile, stance: ARR.stance, retreat: ARR.retreat, dealt: ARR.dealt }, { p: PV.p, q: PV.q, bell: 619 });
  for (let i = 0; i < 4; i++) {
    const a = k.call('resolve_from_inputs', { province: PB, inputs: IB, bell: 619, seed: seed(i) });
    const b = k.call('resolve_from_inputs', { province: PB, inputs: ours, bell: 619, seed: seed(i) });
    assert.ok(a.ok && b.ok);
    assert.equal(decodeClashOut(b.value).digest, decodeClashOut(a.value).digest, `seed ${i}`);
  }
});

test('the model forecast counts the keep as the program does: fewer than 500 left, the recorded 488 within a turn\'s rolls', async () => {
  const k = await s1;
  const fc = modelForecast(k, composed(), PB, ARR.faction);
  assert.equal(fc.ok, true, JSON.stringify(fc));
  assert.ok(fc.troops.max < 500, `max ${fc.troops.max}`);
  assert.ok(fc.troops.min <= 488 && 488 <= fc.troops.max + 2, `range ${fc.troops.min}–${fc.troops.max} around the recorded 488`);
  assert.deepEqual(fc.worn, { bps: 0, before: 500, after: 500 });
});

// ---------------------------------------------------------------- a manned fort (S1 1e)
const FORT_TILE = (() => { for (let t = 0; t < 61; t++) if (![...PV.sites].includes(t) && t !== ARR.tile && t !== PV.camp?.tile) return t; return -1; })();
/** The recorded Province with one live fort of another nation (FortRecord, layout v2 FORTS) on FORT_TILE. */
function withFort(troopsWhole, faction = 4) {
  const pv = V2.Province, rec = R2.FortRecord;
  const forts = pv.fields.find(f => f.name === 'FORTS'), b = Uint8Array.from(PB), v = new DataView(b.buffer);
  const at = name => forts.off + rec.fields.find(f => f.name === name).off;
  b[at('TILE')] = FORT_TILE; b[at('FACTION')] = faction; b[at('GEN')] = 1; b[at('STATE')] = 1;
  v.setUint32(at('TROOPS'), troopsWhole * 1000, true);
  return b;
}
const V2 = Object.fromEntries(LAYOUTS.accounts.map(x => [x.kind, x]));
const R2 = Object.fromEntries(LAYOUTS.records.map(x => [x.name, x]));

test('the model forecast fights the fort: a walled garrison of 300 wears the host of 500', async () => {
  const k = await s1;
  const fc = modelForecast(k, composed({ dest: { p: PV.p, q: PV.q, tile: FORT_TILE } }), withFort(300), ARR.faction);
  assert.equal(fc.ok, true, JSON.stringify(fc));
  assert.ok(fc.troops.max < 500, `max ${fc.troops.max}`);
  // the same tile without the fort: nobody there, the host arrives whole
  const empty = modelForecast(k, composed({ dest: { p: PV.p, q: PV.q, tile: FORT_TILE } }), PB, ARR.faction);
  assert.deepEqual([empty.troops.min, empty.troops.max], [500, 500]);
});

// ---------------------------------------------------------------- tower wear (S1 1d)

test('the model forecast wears the arrival by the towers its road crosses, as Reveal and the gather do', async () => {
  const k = await s1;
  // an enemy tower (nation 4, at war with the walker's 2 in a fresh season) covering three flat steps of the road
  const origin = { p: PV.p, q: PV.q, tile: 30 };
  const lands = [{ p: PV.p, q: PV.q, rough: 0n, road: 0n, watch: watchOf([{ kind: KIND_TOWER, tile: 30, faction: 4 }], null, ARR.faction, false) }];
  const secs = marchWatch(origin, [0, 0], lands, false);
  assert.equal(typeof secs, 'number');
  const bps = wearBps(secs);
  assert.ok(bps > 0 && bps <= 3000);
  const fc = modelForecast(k, composed({ dest: { p: PV.p, q: PV.q, tile: FORT_TILE } }), PB, ARR.faction, { wornBps: bps });
  assert.deepEqual(fc.worn, { bps, before: 500, after: Math.floor(wear(500_000, bps) / 1000) });
  assert.deepEqual([fc.troops.min, fc.troops.max], [fc.worn.after, fc.worn.after], 'nobody on the tile: the worn host arrives');
  // the cap: 30% at most, whatever the walk
  assert.equal(modelForecast(k, composed({ dest: { p: PV.p, q: PV.q, tile: FORT_TILE } }), PB, ARR.faction, { wornBps: wearBps(99_999) }).worn.after, 350);
});

test('a march inside its own Province leaves its place among the residents (withoutEntry clears its entry only)', () => {
  const ids = PV.entries.filter(e => e.state !== 0).map(e => String(e.id));
  if (!ids.length) return;
  const cleared = decode('Province', withoutEntry(PB, ids[0]));
  assert.equal(cleared.entries.filter(e => e.state !== 0).length, ids.length - 1);
  assert.ok(!cleared.entries.some(e => e.state !== 0 && String(e.id) === ids[0]));
});

test('the gather\'s destroyed-below is host.rs\'s', () => {
  const rs = readFileSync(new URL('../../../permutation-rules/src/frontier/host.rs', import.meta.url), 'utf8');
  assert.equal(DESTROYED_BELOW, Number(rs.match(/pub const DESTROYED_BELOW: MilliTroops = (\d+);/)[1]));
});
