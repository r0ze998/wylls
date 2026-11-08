// A long continuous world, generated deterministically (fixed seed): many
// evaluation windows, caravans that cross window boundaries, projects that
// take several windows, raids and keep changes. For checking that a world
// which never ends stays balanced and that the cost of judging one window
// does not grow with the history before it (test/long-run.mjs).
import { baseState, Script, NATIONS } from './world.mjs';

export function longWorld({ windows = 120, windowBells = 96, seed = 7 } = {}) {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = xs => xs[Math.floor(rnd() * xs.length)];
  const state = { ...baseState(), period: undefined, at: 0 };
  const actors = state.actors.map(x => x.id);
  const s = new Script();
  let ship = 0;
  let project = 0;
  const open = [];
  for (let w = 0; w < windows; w++) {
    const t0 = w * windowBells;
    // Production: some members make goods each window (the world keeps producing).
    for (let i = 0; i < 6; i++) {
      const who = pick(actors);
      for (const r of ['wood', 'stone', 'gold', 'food']) s.add(t0 + 1, 'lot.produce', { lot: `p${w}.${i}.${r}`, owner: who, resource: r, qty: 120 });
    }
    // Caravans, some leaving just before the window ends (they arrive in the next one).
    for (let i = 0; i < 4; i++) {
      const from = pick(actors), to = pick(actors.filter(x => x !== from));
      const at = t0 + (i === 3 ? windowBells - 3 : 10 + Math.floor(rnd() * 60));
      const id = `s${ship++}`;
      s.add(at, 'ship.send', { ship: id, from, to, resource: 'food', qty: 30 });
      if (rnd() < 0.15) s.add(at + 2, 'ship.raid', { ship: id, raider: pick(actors), taken: 20, burned: 10 });
      else s.add(at + 6, 'ship.arrive', { ship: id, qty: 30 });
    }
    // A palisade project every other window, finished in the next one.
    if (w % 2 === 0) {
      const steward = pick(actors);
      const id = `pr${project++}`;
      s.add(t0 + 5, 'project.open', { project: id, goal: 'own', structure: 'palisade', steward }, { stream: 'ws01' });
      open.push({ id, steward, at: t0 });
    }
    for (const p of open.filter(p => p.at === t0 - windowBells)) {
      const helper = pick(actors.filter(x => x !== p.steward));
      for (const [r, q] of [['wood', 200], ['stone', 100], ['gold', 20]]) {
        const lot = `p${w}.k.${r}`;
        s.add(t0 + 2, 'lot.produce', { lot, owner: helper, resource: r, qty: q });
        s.give(t0 + 3, p.id, helper, lot, q);
      }
      s.add(t0 + 20, 'build.complete', { project: p.id, structure: `S-${p.id}` });
      s.add(t0 + 30, 'use', { structure: `S-${p.id}`, actor: pick(actors), how: 'pass' });
    }
    if (rnd() < 0.3) s.add(t0 + 50, 'keep.set', { keep: `k${Math.floor(rnd() * 12)}`, nation: pick(NATIONS) });
  }
  const ws = Array.from({ length: windows }, (_, w) => ({ id: `W${w}`, opensAt: w * windowBells, endsAt: (w + 1) * windowBells }));
  return { name: 'long', state, events: s.events, windows: ws };
}
