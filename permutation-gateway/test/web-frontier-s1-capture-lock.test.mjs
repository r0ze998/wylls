// The S1 tile card (screens/s1.mjs s1TileModel) blocks a storehouse and every structure while the village in hand is
// being captured, as the program does (proc/caravan.rs build_vault_as and proc/structure.rs build_structure_as →
// holding.rs own_province_unlocked → capture_lock → CapturePending). The page had the rule (fconquest.mjs capturePending)
// and its sentence (fi18n CapturePending) but the card offered both builds and only the send was refused (2026-11-16).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as SCR from '../../permutation-server/web/frontier/screens/s1.mjs';
import { capturePending } from '../../permutation-server/web/frontier/fconquest.mjs';
import { errorText } from '../../permutation-server/web/frontier/fi18n.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const ALL = (1n << 61n) - 1n;
const store = units => ({ value: BigInt(units) * 1000n, rate: 0n, cap: 10n ** 12n, t0: 10n ** 12n, frac: 0n });
const holding = (p, q, site, tile, units = 1000) => ({ p, q, site, tile, gen: 1, state: 2, tier: 1, faction: 1, stores: Array.from({ length: 8 }, () => store(units)), reserve: [300, 0, 0, 0, 0, 0, 0, 0], queue: [] });
const prov = (p, q, extra = {}) => ({ p, q, layoutVersion: 2, passableMask: ALL, roughMask: 0n, roadMask: 0n, siteCount: 2, sites: [5, 6], camp: { state: 1, tile: 7 }, keep: { tile: 8, holder: 1 }, resolvedNext: 10, structures: [], forts: [], caravans: [], ...extra });
const world = (extra = {}) => ({ mode: 'play', nowBell: 100, chain: { now: () => 1000 }, citizen: { faction: 1, vaults: 0, towers: 0, palisades: 0, forts: 0, caravans: 4, voted: [0, 0, 0, 0] },
  holdings: [holding(0, 0, 0, 30)], activeHolding: 0, provinces: new Map(), s1: { caravans: { moving: [], vaults: [] }, structures: { structures: [], sightings: [] }, nations: null }, ...extra });
// site 0 of province (0,0) is the village in hand (gen 1): a mirror of state 1 (holding) and gen 2 is a capture pending
const mirror = (state, gen) => [{ state, gen }, { state: 0, gen: 0 }];

test('the program locks both builds behind the capture lock, with the rule the page mirrors', () => {
  for (const [file, fn] of [['permutation-frontier/src/proc/caravan.rs', 'build_vault_as'], ['permutation-frontier/src/proc/structure.rs', 'build_structure_as']]) {
    const src = read(file), at = src.indexOf(`fn ${fn}(`);
    assert.ok(at >= 0, fn);
    assert.match(src.slice(at, at + 1600), /hold::own_province_unlocked\(/, `${fn} takes the capture lock`);
  }
  assert.match(read('permutation-frontier/src/proc/holding.rs'), /Some\(true\) => Err\(crate::CqError::CapturePending\.into\(\)\)/);
  assert.match(read('frontier-abi/src/v2/prologue.rs'), /Some\(state == SM::STATE_HOLDING && g == holding_gen\.wrapping_add\(1\)\)/);
  assert.match(read('frontier-abi/src/layout/province.rs'), /pub const STATE_HOLDING: u8 = 1;/);
  const h = holding(0, 0, 0, 30);
  const fs = m => ({ provinces: new Map([['0,0', { province: prov(0, 0, { siteMirror: m }) }]]) });
  assert.equal(capturePending(fs(mirror(1, 2)), h), true, 'state holding, next generation: locked');
  assert.equal(capturePending(fs(mirror(1, 1)), h), false, 'its own generation: not locked');
  assert.equal(capturePending(fs(mirror(3, 2)), h), false, 'not a holding state: not locked');
  assert.equal(capturePending(fs(mirror(1, 2)), { ...h, gen: 255 }), false);
  assert.equal(capturePending(fs([{ state: 1, gen: 0 }]), { ...h, gen: 255 }), true, 'the generation wraps (u8)');
});

test('while the village in hand is being captured, the tile card blocks the storehouse and every structure, and says why', () => {
  const free = world({ provinces: new Map([['0,0', { province: prov(0, 0, { siteMirror: mirror(1, 1) }) }]]) });
  const open = SCR.s1TileModel(free, { p: 0, q: 0, idx: 31 });
  assert.deepEqual(open.build.vault.blocks, []);
  assert.deepEqual(open.build.structures.map(s => s.blocks), [[], [], []], 'no lock: as before');
  const taken = world({ provinces: new Map([['0,0', { province: prov(0, 0, { siteMirror: mirror(1, 2) }) }]]) });
  const m = SCR.s1TileModel(taken, { p: 0, q: 0, idx: 31 });
  assert.deepEqual(m.build.vault.blocks, ['CapturePending']);
  assert.deepEqual(m.build.structures.map(s => s.blocks), [['CapturePending'], ['CapturePending'], ['CapturePending']]);
  // the other reasons still count beside it (a poor village: both)
  const poor = SCR.s1TileModel({ ...taken, holdings: [holding(0, 0, 0, 30, 10)] }, { p: 0, q: 0, idx: 31 });
  assert.ok(poor.build.vault.blocks.includes('CapturePending') && poor.build.vault.blocks.includes('Insufficient'));
  // the sentence the card shows for it, in both languages
  assert.equal(errorText('CapturePending'), '占領処理中です。結果が確定してから操作してください');
  setLang('en');
  try { assert.doesNotMatch(errorText('CapturePending'), /[぀-ヿ㐀-鿿]/); assert.ok(errorText('CapturePending').length > 10); } finally { setLang('ja'); }
});
