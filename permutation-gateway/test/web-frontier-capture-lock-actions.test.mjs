// The program's capture lock (MC §5.8, CapturePending) on every action the page pre-checks, action by action, with the
// Province each one actually names (2026-11-16): the page had the rule (fconquest capturePending) but fland.mjs
// actionBlocks, the S1 caravan source and the fort form never asked it, so those offers stayed open and only the send was
// refused. Rust conditions are pinned as text; nothing here changes a rule, a cost or a permission.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { actionBlocks, captureLocked, CAPTURE_LOCKED_ACTIONS } from '../../permutation-server/web/frontier/fland.mjs';
import { capturePending } from '../../permutation-server/web/frontier/fconquest.mjs';
import * as SCR from '../../permutation-server/web/frontier/screens/s1.mjs';
import { errorText } from '../../permutation-server/web/frontier/fi18n.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const read = rel => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const body = (file, fn) => { const s = read(file), at = s.indexOf(`fn ${fn}(`); assert.ok(at >= 0, `${file} ${fn}`); const end = s.indexOf('\n}\n', at); return s.slice(at, end); };

test('the program: which actions take the lock, and on which Province (pinned as text)', () => {
  const H = 'permutation-frontier/src/proc/holding.rs', HO = 'permutation-frontier/src/proc/host.rs';
  for (const fn of ['build_as', 'train_as', 'harvest_body']) assert.match(body(H, fn), /\n    own_province_unlocked\(p, &?pl, &hh, province\)\?;/, `${fn}: always, own Province`);
  assert.match(body(H, 'harvest_as'), /harvest_body\(p, &pl, a\)/, 'Harvest goes through harvest_body');
  for (const fn of ['muster_as', 'garrison_as']) assert.match(body(HO, fn), /\n    own_province\(p, &pl, &hh, province\)\?;\n    lock_own\(province, &hh\)\?;/, `${fn}: always, own Province`);
  assert.match(body(H, 'explore_as'), /if \*province\.key\.as_array\(\) == pl\.ctx\.province\(hh\.p as i32, hh\.q as i32\) \{\n        own_province_unlocked\(p, &pl, &hh, province\)\?;/, 'Explore: only when the Scout stands in the own Province');
  assert.match(body(HO, 'dissolve_as'), /if \(rh\.p, rh\.q\) == \(hh\.p, hh\.q\) \{\n        lock_own\(province, &hh\)\?;/, 'Dissolve: only in the own Province');
  assert.match(body(HO, 'depart_as'), /if \(pp, pq\) == \(hh\.p, hh\.q\) \{\n        lock_own\(province, &hh\)\?;/, 'Depart: only from the own Province');
  assert.match(body('permutation-frontier/src/proc/caravan.rs', 'send_caravan_as'), /if s\.kind == PL::KIND_HOLDING \{\n        let hh = hold::owned_holding\(p, &pl, src, citizen\)\?;\n        hold::own_province_unlocked\(p, &pl, &hh, first\)\?;/, 'SendCaravan: a village source only');
  assert.match(body('permutation-frontier/src/proc/structure.rs', 'fort_garrison_as'), /hold::own_province_unlocked\(p, &pl, &hh, province\)\?;/, 'FortGarrison: always');
  assert.match(read(HO), /fn lock_own\(province: &AccountInfo, hh: &HoldingHdr\) -> R<\(\)> \{\n    let pd = province\.try_borrow_data\(\)\?;\n    capture_lock\(&pd, hh\.site, hh\.gen\)/);
  assert.match(read('frontier-abi/src/v2/prologue.rs'), /Some\(state == SM::STATE_HOLDING && g == holding_gen\.wrapping_add\(1\)\)/);
  assert.deepEqual([...CAPTURE_LOCKED_ACTIONS].sort(), ['Build', 'Depart', 'Dissolve', 'Explore', 'Garrison', 'Harvest', 'Muster', 'Train']);
});

// the village in hand: (2,0) site 1, generation 7; the Province's mirror of site 1 says whether a capture is pending
const village = (gen = 7) => ({ p: 2, q: 0, site: 1, tile: 30, gen, state: 2, explore: null, finalTs: '0' });
const province = (p, q, mirrorGen, { state = 1, resolvedNext = 99 } = {}) => ({ p, q, resolvedNext, siteMirror: [{ state: 0, gen: 0 }, { state, gen: mirrorGen }], entries: [], ticketCohorts: [] });
const host = (extra = {}) => ({ id: 5n, unit: 0, tile: 12, state: 1, pending: 0, inTransit: false, ...extra });
const ctx = (prov, h = village(), extra = {}) => ({ holding: h, province: prov, now: 1, nowBell: 100, host: host(), ...extra });

test('the rule: state holding and the next generation, on the village\'s own Province only (u8 wraps)', () => {
  assert.equal(captureLocked(province(2, 0, 8), village(7)), true);
  assert.equal(captureLocked(province(2, 0, 7), village(7)), false, 'its own generation');
  assert.equal(captureLocked(province(2, 0, 8, { state: 3 }), village(7)), false, 'not a holding state');
  assert.equal(captureLocked(province(2, 0, 0), village(255)), true, '255 + 1 wraps to 0');
  assert.equal(captureLocked(province(3, 0, 8), village(7)), false, 'another Province never locks');
  assert.equal(captureLocked(null, village(7)), false, 'no Province read yet');
  // fconquest's capturePending is the same rule (one definition)
  const fs = prov => ({ provinces: new Map([['2,0', { province: prov }]]) });
  assert.equal(capturePending(fs(province(2, 0, 8)), village(7)), true);
  assert.equal(capturePending(fs(province(2, 0, 7)), village(7)), false);
});

test('actions on the village\'s own Province (Harvest, Build, Train, Muster, Garrison): locked first, else as before', () => {
  for (const name of ['Harvest', 'Build', 'Train', 'Muster', 'Garrison']) {
    assert.equal(actionBlocks(name, ctx(province(2, 0, 8)))[0], 'CapturePending', `${name} locked`);
    assert.ok(!actionBlocks(name, ctx(province(2, 0, 7))).includes('CapturePending'), `${name} unlocked`);
    assert.equal(actionBlocks(name, ctx(province(2, 0, 0), village(255)))[0], 'CapturePending', `${name} wraps`);
  }
  // beside another block: Muster on a province behind the turn says both, the lock first
  assert.deepEqual(actionBlocks('Muster', ctx(province(2, 0, 8, { resolvedNext: 10 }))), ['CapturePending', 'NotResident']);
});

test('Explore, Dissolve and Depart: locked only when the host stands in the village\'s own Province (the Province the page passes is the host\'s)', () => {
  for (const name of ['Explore', 'Dissolve', 'Depart']) {
    const scout = name === 'Explore' ? { host: host({ unit: 6 }) } : {};
    assert.equal(actionBlocks(name, ctx(province(2, 0, 8), village(), scout))[0], 'CapturePending', `${name} at home, locked`);
    assert.ok(!actionBlocks(name, ctx(province(3, 0, 8), village(), scout)).includes('CapturePending'), `${name} in another Province: not locked`);
    assert.ok(!actionBlocks(name, ctx(province(2, 0, 7), village(), scout)).includes('CapturePending'), `${name} at home, unlocked`);
  }
  // beside the host's own blocks: a busy host at home while locked says both
  assert.deepEqual(actionBlocks('Depart', ctx(province(2, 0, 8), village(), { host: host({ pending: 1 }) })), ['CapturePending', 'HostBusy']);
  assert.deepEqual(actionBlocks('Explore', ctx(province(2, 0, 8))), ['CapturePending', 'NotScout']);
});

test('actions the lock does not cover keep their blocks unchanged', () => {
  assert.ok(!CAPTURE_LOCKED_ACTIONS.has('Promote'));
  assert.deepEqual(actionBlocks('Promote', ctx(province(2, 0, 8))), []);
});

// ------------------------------------------------------------------ S1: the caravan source and the fort form
const ALL = (1n << 61n) - 1n;
const store = units => ({ value: BigInt(units) * 1000n, rate: 0n, cap: 10n ** 12n, t0: 10n ** 12n, frac: 0n });
const s1holding = gen => ({ p: 0, q: 0, site: 0, tile: 30, gen, state: 2, tier: 1, faction: 1, ownerCitizen: new Uint8Array(32).fill(7), stores: Array.from({ length: 8 }, () => store(1000)), reserve: [300, 0, 0, 0, 0, 0, 0, 0], queue: [] });
const s1prov = mirrorGen => ({ p: 0, q: 0, layoutVersion: 2, passableMask: ALL, roughMask: 0n, roadMask: 0n, siteCount: 2, sites: [5, 6], camp: { state: 0, tile: 7 }, keep: { tile: 8, holder: 1 }, resolvedNext: 99, structures: [], forts: [{ tile: 40, state: 1, troops: 0n }], caravans: [], siteMirror: [{ state: 1, gen: mirrorGen }, { state: 0, gen: 0 }] });
const s1world = (gen, mirrorGen) => {
  const base = { mode: 'play', nowBell: 100, chain: { now: () => 1000 }, citizen: { faction: 1, vaults: 1, towers: 0, palisades: 0, forts: 1, caravans: 4, voted: [0, 0, 0, 0] },
    holdings: [s1holding(gen)], activeHolding: 0, provinces: new Map([['0,0', { province: s1prov(mirrorGen) }]]) };
  const tag = SCR.viewerTag(base);
  return { ...base, s1: { caravans: { moving: [], vaults: [{ p: 1, q: 0, tile: 9, ownerTag: tag, faction: 1, gen: 1, stores: [500, 0, 0, 0, 0, 0, 0, 0], cap: 1000 }] },
    structures: { structures: [{ p: 0, q: 0, tile: 40, kind: 3, faction: 1, ownerTag: tag, gen: 1 }], sightings: [] }, nations: null } };
};

test('S1: a village source being captured cannot send a caravan; a storehouse source still can; the fort form is closed and says why', () => {
  const locked = SCR.s1VillageModel(s1world(7, 8)), open = SCR.s1VillageModel(s1world(7, 7));
  const vil = m => m.sources.find(s => s.kind === 'holding'), vault = m => m.sources.find(s => s.kind === 'vault');
  const dst = { kind: 'vault', p: 1, q: 0, tile: 9, gen: 1 }, cargo = [10, 0, 0, 0, 0, 0, 0, 0];
  assert.equal(SCR.caravanProblem(vil(locked), dst, cargo), 'CapturePending');
  assert.equal(SCR.caravanProblem(vil(locked), null, cargo), 'NoPlace', 'no place first, as before');
  assert.equal(SCR.caravanProblem(vil(open), dst, cargo), null, 'unlocked: as before');
  assert.equal(SCR.caravanProblem(vault(locked), { kind: 'holding', p: 0, q: 0, site: 0, tile: 30, gen: 7 }, cargo), null, 'a storehouse source is not locked');
  assert.deepEqual(locked.fortBlocks, ['CapturePending']);
  assert.deepEqual(open.fortBlocks, []);
  assert.equal(SCR.s1VillageModel(s1world(255, 0)).fortBlocks[0], 'CapturePending', 'wraps');
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    try {
      const html = String(SCR.renderS1Village(s1world(7, 8)));
      const form = html.slice(html.indexOf('data-form="s1-fort"'), html.indexOf('</form>', html.indexOf('data-form="s1-fort"')));
      assert.match(form, /<button type="submit" class="btn" disabled>/, `${lang}: the fort button is disabled`);
      assert.ok(form.includes(errorText('CapturePending').replace(/'/g, '&#39;')), `${lang}: the form says why`);
      assert.ok(html.includes(errorText('CapturePending').replace(/'/g, '&#39;')), `${lang}: the village source option says why`);
      const openHtml = String(SCR.renderS1Village(s1world(7, 7)));
      const openForm = openHtml.slice(openHtml.indexOf('data-form="s1-fort"'), openHtml.indexOf('</form>', openHtml.indexOf('data-form="s1-fort"')));
      assert.doesNotMatch(openForm, /disabled/, `${lang}: unlocked, the fort button is open`);
      if (lang === 'en') assert.doesNotMatch(errorText('CapturePending'), /[぀-ヿ㐀-鿿]/);
    } finally { setLang('ja'); }
  }
});

// (fix-loop6, LP6-13) loop-play6: Vault → 「ここから隊商を送る」 opened the form with the Vault as source AND destination, and
// the amounts' bound was the village's stock (food 629) instead of the Vault's (wood 19).
test('LP6-13: a storehouse chosen as the caravan\'s source is not also its destination; the amounts are bounded by its own stock', async () => {
  setLang('ja');
  const w = s1world(7, 7);
  w.pin = { programId: 'P', cluster: 'localnet', gen: 0, addresses: { season: 'S' } }; w.wallet = { address: 'W' };
  w.s1Plan = { id: 1, role: 'src', p: 1, q: 0, tile: 9, world: '0|localnet|P|S', viewer: 'W' };
  const m = SCR.s1VillageModel(w);
  assert.equal(m.plan?.src, 1, 'the storehouse is the planned source');
  const html = String(SCR.renderS1Village(w));
  const form = html.slice(html.indexOf('data-form="s1-caravan"'));
  const selected = name => { const sel = form.slice(form.indexOf(`name="${name}"`)); return sel.slice(0, sel.indexOf('</select>')).match(/<option value="(\d+)"[^>]*selected/)?.[1]; };
  assert.equal(selected('src'), '1');
  assert.notEqual(m.destinations[Number(selected('dst'))].kind, 'vault', 'the first destination is not the storehouse it leaves from');
  assert.equal(m.destinations[Number(selected('dst'))].kind, 'holding');
  // food: the storehouse holds 500 (the village 1000): the bound is 500; wood: the storehouse 0 (the village 1000): 0
  assert.match(form, /name="c0" type="number" min="0" max="500"/); assert.match(form, /name="c1" type="number" min="0" max="0"/);
  assert.match(form, /<option value="0" data-have="1000,1000,1000,1000,1000,1000"/);
  // a change of source in the form moves the bounds (app.mjs capCaravanAmounts)
  const { capCaravanAmounts } = await import('../../permutation-server/web/frontier/app.mjs').catch(() => ({}));
  if (capCaravanAmounts) {
    const inputs = [{ name: 'c0', max: '500', value: '700' }, { name: 'c1', max: '0', value: '0' }];
    capCaravanAmounts({ selectedOptions: [{ dataset: { have: '1000,900,0,0,0,0' } }], form: { querySelectorAll: () => inputs } });
    assert.deepEqual(inputs.map(i => [i.max, i.value]), [['1000', '700'], ['900', '0']]);
    capCaravanAmounts({ selectedOptions: [{ dataset: { have: '500,0,0,0,0,0' } }], form: { querySelectorAll: () => inputs } });
    assert.deepEqual(inputs.map(i => [i.max, i.value]), [['500', '500'], ['0', '0']], 'an amount over the new bound comes down to it');
  }
});
