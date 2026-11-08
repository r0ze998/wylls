// REPRO (workstream 07): these tests pin a defect AS THE BASE PAGE HAS IT (a997a756, before patches/). They pass
// on the base and are EXPECTED TO FAIL once the patch that fixes the defect is applied. They are evidence, not part of
// any regular suite: the regular tests are ../*.test.mjs here and permutation-gateway/test/web-frontier-ws07-*.test.mjs
// in the patches (INTEGRATION.ja.md §2).
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
import { Kernel } from '../../../../permutation-server/web/frontier/wasm.mjs';
import { decode } from '../../../../permutation-server/web/frontier/fcodec.mjs';
import { fromBase64 } from '../../../../permutation-server/web/sdk/bytes.mjs';
import { decodeClashOut } from '../../../../permutation-server/web/frontier/screens/report.mjs';
import { forecast } from '../../../../permutation-server/web/frontier/hud/forecast.mjs';
import { LAYOUTS } from '../../../../permutation-server/web/sdk/frontier/abi-v2-layouts.mjs';
import { modelForecast, inputsBytes, withoutEntry, DESTROYED_BELOW } from '../../src/forecast-model.mjs';
import { marchWatch, watchOf, wearBps, wear, KIND_TOWER } from '../../src/s1walk.mjs';

const WEB = new URL('../../../../permutation-server/web/frontier/', import.meta.url);
const FIX = JSON.parse(readFileSync(new URL('../../../../permutation-gateway/test/fixtures/uxs1-keep-two-turns.json', import.meta.url), 'utf8'));
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

// ---------------------------------------------------------------- tower wear (S1 1d)

test('REPRO: the page\'s forecast of a march on a keep\'s tile counts no keep garrison (the host of 500 keeps 500)', async () => {
  const k = await s1;
  const fc = forecast(k, composed(), PV, ARR.faction);
  assert.equal(fc.ok, true);
  assert.deepEqual([fc.troops.min, fc.troops.max], [500, 500], 'the page says the host comes out whole');
  // the chain, on the same arrival, recorded 488.122 left
  assert.equal(REC.decoded.fighters[0].troops, 488122);
});

test('REPRO: a manned fort on the destination tile is not in the page\'s forecast', async () => {
  const k = await s1;
  const pb = withFort(300);
  const fc = forecast(k, composed({ dest: { p: PV.p, q: PV.q, tile: FORT_TILE } }), decode('Province', pb), ARR.faction);
  assert.equal(fc.ok, true);
  assert.deepEqual([fc.troops.min, fc.troops.max], [500, 500], 'the page says nobody defends the fort\'s tile');
});

test('REPRO: the page\'s forecast inputs carry the host\'s full troops whatever towers its road crosses', async () => {
  const { forecastInputs } = await import('../../../../permutation-server/web/frontier/hud/forecast.mjs');
  // (the input has no place for the structures at all: a road under a tower and one under none give the same arrival)
  const a = forecastInputs(composed({ route: { dirs: [0, 0, 0] } }), ARR.faction).arrivals[0];
  assert.equal(a.troops, 500_000);
});
