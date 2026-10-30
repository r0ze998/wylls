// Builds the fixed scenario inputs (scenarios/*.json). Run
// `node scenarios/build.mjs` to rewrite them; test/fixtures.test.mjs checks
// that the committed files equal this output, so an input cannot change
// without the change showing in a diff.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from '../src/canon.mjs';
import { baseState, Script, init } from './world.mjs';

const P = 'P-north';
const J = 'J-north-fort';

/** The cooperative north fort: n1 leads, n2 and n3 supply by caravan, n1 and n2 garrison it. */
function coop(s, { n3WoodAt = 40, n3Travel = 15, n3Verified = 'chain', n2StoneVerified = 'chain', complete = 100, uses = [[110, 'n1-1'], [120, 'n2-1']], raidN2Stone = false } = {}) {
  s.add(20, 'project.open', { project: P, goal: J, structure: 'fort', steward: 'n1-0' }, { stream: 'ws01' });
  s.give(25, P, 'n1-0', init('n1-0', 'wood'), 300);
  s.give(25, P, 'n1-0', init('n1-0', 'stone'), 300);
  s.give(25, P, 'n1-0', init('n1-0', 'arms'), 30);
  s.give(25, P, 'n1-0', init('n1-0', 'gold'), 100);
  if (raidN2Stone) {
    s.add(30, 'ship.send', { ship: 'c-n2-stone', from: 'n2-0', to: `project:${P}`, resource: 'stone', qty: 300 });
    s.add(35, 'ship.raid', { ship: 'c-n2-stone', raider: 'n0-2', taken: 300, burned: 0 });
  } else s.ship(30, 'c-n2-stone', 'n2-0', `project:${P}`, 'stone', 300, { verified: n2StoneVerified });
  s.ship(30, 'c-n2-gold', 'n2-0', `project:${P}`, 'gold', 50);
  s.ship(n3WoodAt, 'c-n3-wood', 'n3-0', `project:${P}`, 'wood', 200, { travel: n3Travel, verified: n3Verified });
  s.ship(40, 'c-n3-stone', 'n3-0', `project:${P}`, 'stone', 200, { travel: 15 });
  s.ship(40, 'c-n3-arms', 'n3-0', `project:${P}`, 'arms', 20, { travel: 15 });
  s.ship(40, 'c-n3-gold', 'n3-0', `project:${P}`, 'gold', 50, { travel: 15 });
  if (raidN2Stone) s.ship(60, 'c-n1-stone', 'n1-1', `project:${P}`, 'stone', 300);
  if (complete !== null) s.add(complete, 'build.complete', { project: P, structure: 'S-north-fort' });
  for (const [at, who] of uses) s.add(at, 'use', { structure: 'S-north-fort', actor: who, how: 'garrison', qty: 200 });
  return s;
}

/** Keeps change hands: n1 takes two of n0's keeps at `at` (n0 4→2, n1 3→5). */
const n1Overtakes = (s, at = 300) => s.add(at, 'keep.set', { keep: 'k0', nation: 'n1' }).add(at, 'keep.set', { keep: 'k1', nation: 'n1' });

const S = {};
const def = (name, description, state, script) => { S[name] = { name, description, state, events: script.events }; };

def('coop-north-fort', '協力の基本形。n1 が計画を開き、n2・n3 が隊商で材料を送り、完成後に n1 と n2 の人が守備に入る。要塞の数は動かない',
  baseState(), coop(new Script()));

{
  const s = coop(new Script());
  for (let i = 0; i < 5; i++) {
    s.ship(130 + 4 * i, `wash-${i}-a`, 'n2-2', 'n3-2', 'wood', 100, { travel: 1 });
    s.ship(132 + 4 * i, `wash-${i}-b`, 'n3-2', 'n2-2', 'wood', 100, { travel: 1 });
  }
  s.ship(160, 'self-a', 'n2-2', 'alt-n2-2', 'wood', 300, { travel: 1 });
  s.ship(162, 'self-b', 'alt-n2-2', 'n2-2', 'wood', 300, { travel: 1 });
  // After all that, n2-2 puts 100 wood into a palisade of its own nation (needs wood 200, stone 100, gold 20).
  s.add(170, 'project.open', { project: 'P-pal', goal: 'own', structure: 'palisade', steward: 'n2-1' }, { stream: 'ws01' });
  s.ship(171, 'c-wash-wood', 'n2-2', 'project:P-pal', 'wood', 100, { travel: 2 });
  s.give(175, 'P-pal', 'n2-1', init('n2-1', 'wood'), 100);
  s.give(175, 'P-pal', 'n2-1', init('n2-1', 'stone'), 100);
  s.give(175, 'P-pal', 'n2-1', init('n2-1', 'gold'), 20);
  s.add(180, 'build.complete', { project: 'P-pal', structure: 'S-pal' });
  s.add(185, 'use', { structure: 'S-pal', actor: 'n4-0', how: 'pass' });
  def('round-trip-wash', '往復取引と自己取引。n2-2 と n3-2 が木材100を5往復（取引10件、配送1,000）、n2-2 は自分の別アカウントとも往復した後、100だけを国の柵に入れる',
    baseState({ extraActors: [{ id: 'alt-n2-2', nation: 'n2', cluster: 'n2-2', stock: false }] }), s);
}

{
  const s = coop(new Script());
  // A second, own-nation palisade by n1: n1-0's input of the same lot again, and a send of it.
  s.add(130, 'project.open', { project: 'P-pal-n1', goal: 'own', structure: 'palisade', steward: 'n1-0' }, { stream: 'ws01' });
  s.give(131, 'P-pal-n1', 'n1-0', init('n1-0', 'wood'), 200); // only 100 left after 300 went into the fort: refused
  s.give(132, 'P-pal-n1', 'n1-0', init('n1-0', 'wood'), 100); // the remaining 100: accepted
  s.add(133, 'ship.send', { ship: 'c-again', from: 'n1-0', to: 'n4-0', resource: 'wood', qty: 1, lot: init('n1-0', 'wood') }); // nothing left: refused
  def('double-spend', '同じ荷の二重消費。n1-0 の木材400のうち300は砦に入った。残り100を超えて別の計画に入れる・送ることは拒否される',
    baseState(), s);
}

def('late-arrival', '期限後の到着。n3 の木材が戦期の終わり（480）より後に着く。完成もその後',
  baseState(), coop(new Script(), { n3WoodAt: 470, n3Travel: 12, complete: 485, uses: [[486, 'n1-1'], [487, 'n2-1']] }));

def('unverified-storehouse', '未検証量。n3 の木材は倉あてで、着いた量がチェーンで確かめられない（①：倉あては未検証）。n2 の石材は村あてで、積荷を下限として数える',
  baseState(), coop(new Script(), { n3Verified: 'unverified', n2StoneVerified: 'chain_lower_bound' }));

{
  const s = new Script();
  s.add(10, 'project.open', { project: P, goal: J, structure: 'fort', steward: 'n0-0' }, { stream: 'ws01' });
  const need = { wood: 500, stone: 800, arms: 50, gold: 200 };
  for (const [r, q] of Object.entries(need)) {
    let left = q;
    for (let i = 0; left > 0; i++) { const g = Math.min(left, r === 'arms' ? 40 : r === 'gold' ? 150 : 400); s.give(15, P, `n0-${i}`, init(`n0-${i}`, r), g); left -= g; }
  }
  s.add(60, 'build.complete', { project: P, structure: 'S-north-fort' });
  s.add(70, 'use', { structure: 'S-north-fort', actor: 'n0-1', how: 'garrison' });
  s.add(72, 'use', { structure: 'S-north-fort', actor: 'n5-0', how: 'garrison' });
  n1Overtakes(s);
  def('rush-solo', '優勢な国の単独の早期終了。要塞で先行する n0 が、自国だけの材料で砦を急いで建て、n5 の一人に使わせる。n1 は 300 で逆転する',
    baseState(), s);
}

/** n0 rushes with two client nations: their inputs are n0's goods (`laundered`) or their own goods paid for with food. */
function rushClients(laundered) {
  const s = new Script();
  s.add(10, 'project.open', { project: P, goal: J, structure: 'fort', steward: 'n0-0' }, { stream: 'ws01' });
  if (laundered) {
    s.ship(11, 'gift-n4', 'n0-3', 'n4-0', 'stone', 200, { travel: 2 });
    s.ship(11, 'gift-n5', 'n0-4', 'n5-0', 'wood', 100, { travel: 2 });
    s.ship(14, 'c-n4-stone', 'n4-0', `project:${P}`, 'stone', 200, { travel: 2, lot: 'gift-n4#0' });
    s.ship(14, 'c-n5-wood', 'n5-0', `project:${P}`, 'wood', 100, { travel: 2, lot: 'gift-n5#0' });
  } else {
    s.ship(11, 'pay-n4', 'n0-3', 'n4-0', 'food', 300, { travel: 2 });
    s.ship(11, 'pay-n5', 'n0-4', 'n5-0', 'food', 300, { travel: 2 });
    s.ship(14, 'c-n4-stone', 'n4-0', `project:${P}`, 'stone', 200, { travel: 2 });
    s.ship(14, 'c-n5-wood', 'n5-0', `project:${P}`, 'wood', 100, { travel: 2 });
  }
  s.give(15, P, 'n0-0', init('n0-0', 'wood'), 400);
  s.give(15, P, 'n0-0', init('n0-0', 'stone'), 400);
  s.give(15, P, 'n0-1', init('n0-1', 'stone'), 200);
  s.give(15, P, 'n0-0', init('n0-0', 'arms'), 40);
  s.give(15, P, 'n0-1', init('n0-1', 'arms'), 10);
  s.give(15, P, 'n0-0', init('n0-0', 'gold'), 150);
  s.give(15, P, 'n0-1', init('n0-1', 'gold'), 50);
  s.add(60, 'build.complete', { project: P, structure: 'S-north-fort' });
  s.add(70, 'use', { structure: 'S-north-fort', actor: 'n0-1', how: 'garrison' });
  s.add(72, 'use', { structure: 'S-north-fort', actor: 'n5-0', how: 'garrison' });
  n1Overtakes(s);
  return s;
}
def('rush-clients-laundered', '従う2国を使った早期終了（その1）。n0 が自国の材料を n4・n5 に送り、それを砦に入れさせる', baseState(), rushClients(true));
def('rush-clients-own', '従う2国を使った早期終了（その2）。n4・n5 は自分の材料を入れ、n0 は見返りに食料を送る', baseState(), rushClients(false));

/** n0-0's alternate accounts in n4 and n5 supply the fort; labelled as one person or not. */
function sybil(labelled) {
  const s = new Script();
  s.add(10, 'project.open', { project: P, goal: J, structure: 'fort', steward: 'n0-0' }, { stream: 'ws01' });
  s.ship(12, 'c-alt4', 'alt-n4', `project:${P}`, 'stone', 200, { travel: 2 });
  s.ship(12, 'c-alt5', 'alt-n5', `project:${P}`, 'wood', 100, { travel: 2 });
  s.give(15, P, 'n0-0', init('n0-0', 'wood'), 400);
  s.give(15, P, 'n0-0', init('n0-0', 'stone'), 400);
  s.give(15, P, 'n0-1', init('n0-1', 'stone'), 200);
  s.give(15, P, 'n0-0', init('n0-0', 'arms'), 40);
  s.give(15, P, 'n0-1', init('n0-1', 'arms'), 10);
  s.give(15, P, 'n0-0', init('n0-0', 'gold'), 150);
  s.give(15, P, 'n0-1', init('n0-1', 'gold'), 50);
  s.add(60, 'build.complete', { project: P, structure: 'S-north-fort' });
  s.add(70, 'use', { structure: 'S-north-fort', actor: 'n0-1', how: 'garrison' });
  s.add(72, 'use', { structure: 'S-north-fort', actor: 'alt-n5', how: 'garrison' });
  n1Overtakes(s);
  const c = labelled ? { cluster: 'n0-0' } : {};
  return [baseState({ extraActors: [{ id: 'alt-n4', nation: 'n4', ...c }, { id: 'alt-n5', nation: 'n5', ...c }] }), s];
}
def('sybil-unlabelled', '本人識別（その1）。n0-0 が n4・n5 に作った別アカウントで材料を入れる。模型に同一人物の印がない', ...sybil(false));
def('sybil-labelled', '本人識別（その2）。同じ別アカウントに、模型が同一人物の印（cluster）を付けている', ...sybil(true));

{
  const s = coop(new Script());
  s.add(50, 'keep.set', { keep: 'k0', nation: 'n1' }).add(50, 'keep.set', { keep: 'k1', nation: 'n1' });
  s.add(300, 'keep.set', { keep: 'k0', nation: 'n0' }).add(300, 'keep.set', { keep: 'k1', nation: 'n0' }).add(300, 'keep.set', { keep: 'k4', nation: 'n0' });
  def('chapter-no-sabotage', '妨害の比較の基準。協力の基本形に、要塞の動き（50 で n1 が逆転、300 で n0 が再逆転）を足す', baseState(), s);
}
{
  const s = coop(new Script(), { raidN2Stone: true, uses: [] });
  s.add(105, 'structure.seized', { structure: 'S-north-fort', by: 'n0-3' });
  s.add(110, 'use', { structure: 'S-north-fort', actor: 'n1-1', how: 'garrison' });
  s.add(120, 'use', { structure: 'S-north-fort', actor: 'n2-1', how: 'garrison' });
  s.add(50, 'keep.set', { keep: 'k0', nation: 'n1' }).add(50, 'keep.set', { keep: 'k1', nation: 'n1' });
  s.add(300, 'keep.set', { keep: 'k0', nation: 'n0' }).add(300, 'keep.set', { keep: 'k1', nation: 'n0' }).add(300, 'keep.set', { keep: 'k4', nation: 'n0' });
  def('chapter-sabotage', '不利な国の妨害。50 の時点で負けている n0 が、n2 の石材の隊商を奪い（n1 が補う）、完成した砦を利用の前に奪う', baseState(), s);
}

{
  const s = new Script();
  s.add(10, 'project.open', { project: P, goal: J, structure: 'fort', steward: 'n0-0' }, { stream: 'ws01' });
  s.give(15, P, 'n0-0', init('n0-0', 'wood'), 400);
  s.give(15, P, 'n0-1', init('n0-1', 'wood'), 100);
  s.give(15, P, 'n0-0', init('n0-0', 'gold'), 150);
  s.give(15, P, 'n0-1', init('n0-1', 'gold'), 50);
  s.ship(20, 'c-n1-0-stone', 'n1-0', `project:${P}`, 'stone', 400, { travel: 10 });
  s.ship(20, 'c-n1-1-stone', 'n1-1', `project:${P}`, 'stone', 400, { travel: 10 });
  s.ship(20, 'c-n2-0-arms', 'n2-0', `project:${P}`, 'arms', 40, { travel: 10 });
  s.ship(20, 'c-n2-1-arms', 'n2-1', `project:${P}`, 'arms', 10, { travel: 10 });
  s.ship(40, 'c-n3-stone', 'n3-0', `project:${P}`, 'stone', 200, { travel: 25 });
  s.add(70, 'build.complete', { project: P, structure: 'S-north-fort' });
  s.ship(60, 'c-n4-wood', 'n4-0', `project:${P}`, 'wood', 100, { travel: 15 });
  s.add(80, 'use', { structure: 'S-north-fort', actor: 'n0-1', how: 'garrison' });
  s.add(85, 'use', { structure: 'S-north-fort', actor: 'n1-1', how: 'garrison' });
  def('coalition-exclusion', '固定連合の排除。n0・n1・n2 の連合が先に要求量を満たす。n3 の石材は余り、n4 の木材は完成後に着く',
    { ...baseState(), period: { id: 'P1', opensAt: 0, endsAt: 480, optionsAt: 100 } }, s);
}

{
  const s = coop(new Script(), { complete: null, uses: [] });
  s.add(80, 'actor.join', { actor: 'new-0', nation: 'n5' });
  s.add(81, 'lot.produce', { lot: 'new-0:food', owner: 'new-0', resource: 'food', qty: 50 });
  s.add(85, 'build.complete', { project: P, structure: 'S-north-fort' });
  def('roles-midway', '新規参加者・小国・敗者・協力しない人の選択肢。80 で new-0 が n5 に入る。85 に砦が完成し、まだ誰も使っていない。90 の時点の選択肢を見る',
    { ...baseState(), period: { id: 'P1', opensAt: 0, endsAt: 480, optionsAt: 90 } }, s);
}

{
  const s = coop(new Script());
  s.add(50, 'tower.sighting', { sighting: 'sg-1', tower: 'T-east', actor: 'n4-0', target: 'march near P-north' }, { stream: 'ws14', verified: 'derived' });
  s.add(55, 'tower.report.used', { sighting: 'sg-1', actor: 'n1-1' }, { stream: 'ws14', verified: 'derived' });
  def('coop-with-tower', '⑭の塔の入力つき。協力の基本形に、n4-0 の塔の目撃と、それを n1-1 が使った記録を足す',
    { ...baseState(), streams: { chain: { from: 0 }, ws01: { from: 0 }, ws14: { from: 0 } } }, s);
}

const dir = dirname(fileURLToPath(import.meta.url));
export const SCENARIOS = S;
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, sc] of Object.entries(S)) writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(JSON.parse(canonical(sc)), null, 1)}\n`);
  console.log(Object.keys(S).join('\n'));
}
