// The proof behind amendment A of the banner prototype (PROTOTYPE-SPEC section 9, test 11): forty turns of the
// sample world's own play (the orders of liveworld.screen.mjs's long run: train, form, build, harvest, garrison,
// explore, march and reveal, with the neighbours marching), every record the world serves read after every turn and
// folded into one sha256. `GOLDEN` holds the digests taken from the world as it stood BEFORE the prototype was
// written (frontier/ux at 2c7e4c4b, 2026-10-10); claims.screen.mjs runs the same play on the world of today with
// the prototype off and compares.
import { createHash } from 'node:crypto';
import { createLive } from './liveworld.mjs';
import * as W from './world.mjs';
import { kernel } from './kernel.mjs';
import { tileHex, ringProvinces } from '../../permutation-server/web/frontier/fgeo.mjs';
import { pack, encodePath, commit as sealCommit, ctHash as sealCtHash } from '../../permutation-server/web/frontier/seal.mjs';

const { HOME } = W;
const RINGS = W.seasonRecord().rings.map(r => ({ ring: r.d, seed: r.seed }));
const PROVINCES = [0, 1, 2].flatMap(d => ringProvinces(d));
const text = v => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof Uint8Array ? `u8:${Buffer.from(x).toString('hex')}` : x));

/** The digest of forty turns of play on a world made with `opts` (and what it answered, for the test's own asserts). */
export async function play40(opts = {}, turns = 40) {
  const K = kernel(), v = await W.viewer(), clock = { t: 1_700_000_000_000 };
  const w = createLive({ viewer: v, stage: 'holding', wall: () => clock.t, neighbours: true, stores: [9_000, 9_000, 9_000, 9_000, 0, 9_000, 0, 0], ...opts });
  w.seen();
  w.pause(true);
  const h = createHash('sha256'), answers = [], url = new URL('http://127.0.0.1/h/events?after=0');
  const take = (what, body) => { h.update(what); h.update(text(body ?? null)); };
  const read = async () => {
    take('season', w.herald('/h/season', url)?.body);
    for (const { p, q } of PROVINCES) { take(`pv${p},${q}`, w.herald(`/h/province/${p},${q}/latest`, url)?.body); take(`pvb${p},${q}`, w.herald(`/h/province/${p},${q}/${w.turn() - 2}`, url)?.body); take(`cl${p},${q}`, w.herald(`/h/clash/${p},${q}/${w.turn() - 2}`, url)?.body); }
    for (let r = 0; r < 16; r++) take(`bell${r}`, w.herald(`/h/bell/${w.turn() - 1}/region/${r}`, url)?.body);
    take('me', w.herald(`/h/me/${v.wallet}`, url)?.body);
    take('events', w.herald('/h/events', url)?.body);
    take('quota', (await w.relay('GET', '/gw/f/quota', null))?.body);
    take('relay', (await w.relay('GET', '/gw/f/relay', null))?.body);
    take('proto', [w.herald('/h/proto/standings', url), w.herald('/h/proto/preview', url), await w.relay('POST', '/gw/f/proto/land', { op: 'fray', province: [HOME.p, HOME.q], slot: 0 })]);
    take('summary', w.summary());
    take('records', w.records());
  };
  const tally = (name, r) => { answers.push(`${w.turn()} ${name} ${r.ok ? 'ok' : r.code}`); return r; };
  const marches = new Map();
  await read();
  for (let i = 0; i < turns; i++) {
    w.advance();
    const m = w.summary().me, turn = w.turn();
    if (m) {
      if (i % 7 === 0) tally('Train', w.order('Train', { unit: i % 3 === 0 ? 6 : 0, n: 200 }));
      if (i % 7 === 1) tally('Muster', w.order('Muster', { unit: i % 3 === 1 ? 6 : 0, troops: 200, tile: i % 2 ? HOME.tile : 21 }));
      if (i % 11 === 0) tally('Build', w.order('Build', { item: i % 6 }));
      if (i % 13 === 0) tally('Harvest', w.order('Harvest'));
      if (i % 17 === 0) tally('Garrison', w.order('Garrison', { delta: 50n }));
      const scout = m.hosts.find(x => x.unit === 6 && x.state === 1 && !x.pending);
      if (scout && i % 5 === 2) tally('Explore', w.order('Explore', { host_id: BigInt(scout.id), n: 2, tiles: [(scout.tile + 1 + i) % 61, (scout.tile + 7 + i) % 61] }, { p: scout.province[0], q: scout.province[1] }));
      if (scout && i % 5 === 4) { const o = [1, 6, 13, 14, 8, 2, 21, 20][i % 8]; tally('Explore1', w.order('Explore', { host_id: BigInt(scout.id), n: 1, tiles: [o] }, { p: scout.province[0], q: scout.province[1] })); }
      for (const [slot, x] of marches) if (x.arrive === turn) { tally('Reveal', w.revealNow(slot, x.m.plain, x.m.salt, x.m.ctHash)); marches.delete(slot); }
      const ready = m.hosts.find(x => x.state === 1 && x.stamina >= 74 && !x.pending && !m.marches.some(z => z.host === x.id) && x.unit !== 6 && x.readyBell <= turn);
      const slot = [0, 1, 2, 3].find(x => !m.marches.some(z => z.slot === x));
      if (ready && slot !== undefined && i % 3 === 0) {
        const foes = w.province(HOME.p, HOME.q).entries.filter(e => e.state === 1 && e.faction !== 0);
        const to = i % 4 === 3 ? { p: 1, q: 1, tile: (9 + i) % 61 } : { ...HOME, tile: foes.length && i % 2 ? foes[i % foes.length].tile : (7 + i * 5) % 61 }, arrive = turn + 2 + (i % 2);
        const from = { p: ready.province[0], q: ready.province[1], tile: ready.tile };
        const plan = K.call('plan_path', { start: tileHex(from.p, from.q, from.tile), dest: tileHex(to.p, to.q, to.tile), unit: ready.unit, blocked: [], seeds: RINGS }).value;
        if (plan) {
          const path = encodePath(plan.dirs);
          const plain = pack({ version: 1, hostId: BigInt(ready.id), arriveBell: arrive, destP: to.p, destQ: to.q, destTile: to.tile, stance: i % 4, retreatBps: 0, pathLen: path.pathLen, path: path.path });
          const salt = new Uint8Array(32).fill(0x5a), seal = Uint8Array.from({ length: 165 }, (_, k) => (k === 0 ? 0x83 : (k * 11 + 5) & 0xff));
          const sm = { plain, salt, ctHash: sealCtHash(seal) };
          if (tally('Depart', w.order('Depart', { host_id: BigInt(ready.id), commit: sealCommit(plain, salt), seal, arrive_bell: arrive, tip: 14_668n, transit_slot: slot }, from)).ok) marches.set(slot, { arrive, m: sm });
        }
      }
    }
    await read();
  }
  return { digest: h.digest('hex'), answers, world: w };
}

/** The digests of the world before the prototype (see the head of this file). */
export const GOLDEN = Object.freeze({
  holding: 'aa9655d33283a33a90603399a12b384a4b2cc737060cfdc311133ba9a0ed31b7',
  provisional: 'a374ac0c936bf607964fd3cee83b8ac8a08134e34475a0aab11b821932513275',
});
export const GOLDEN_PLAYS = Object.freeze({ holding: { stage: 'holding' }, provisional: { stage: 'provisional', stores: null } });

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()) && process.argv.includes('--print')) {
  for (const [name, opts] of Object.entries(GOLDEN_PLAYS)) { const r = await play40(opts); console.log(name, r.digest, r.answers.length, r.answers.filter(x => x.endsWith(' ok')).length, [...new Set(r.answers.map(x => x.split(' ').slice(1).join(' ')))].join(' | ')); }
}
