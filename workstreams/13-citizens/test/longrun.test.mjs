// Long-run growth, apart from boundary crossing: 30 game days with recurring trade. The present state (state file,
// journal, what one step reads) must stay bounded while the history (episodes, decisions, the world's events)
// grows with what happened; a step must not get slower as the world gets older.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import path from 'node:path';
import { small, run } from './helpers.mjs';
import { decisionsOf } from '../demo/report.mjs';

// 45 days: long enough for the agent ledger's own history (500 lines, its cap) to fill, so the plateau is seen.
const DAYS = 45, BELLS_PER_DAY = 144;

test(`${DAYS} game days: bounded present state and reads, history grows with events only, steady step time`, { timeout: 600_000 }, async () => {
  const env = await small({
    residents: [
      { id: 'asa', goal: 'village-first', pos: { q: 0, r: 0 }, deposit: '20000000', budget: { total: '20000000', perDay: '600000' }, limits: { maxTurns: 5000 } },
      { id: 'ren', goal: 'surplus-use', pos: { q: 5, r: -2 }, deposit: '20000000', budget: { total: '20000000', perDay: '600000' }, limits: { maxTurns: 5000 } },
    ],
    people: [{ name: 'Kou', pos: { q: 3, r: 1 },
      async script(bell, me) {
        const ids = Object.values(me.world.s.citizens).filter(c => c.name !== 'Kou').map(c => c.id);
        if (bell % 48 === 5) await me.post({ kind: 'request', to: ids[(bell / 48 | 0) % ids.length], want: { Food: 60 }, offer: { Ore: 40 }, deadlineBell: bell + 30 });
        for (const r of me.board.requests({ status: 'open' })) {
          if (r.from === me.citizen || !(r.openTo.includes('*') || r.to === me.citizen) || !r.offer.Ore) continue;
          const mine = me.world.view(me.address).villages.find(v => v.citizen === me.citizen);
          if (Object.entries(r.want).some(([n, v]) => mine.stores[n] < v + 50)) continue;
          if ((await me.post({ kind: 'reply', re: r.id, decision: 'accept' })).ok) await me.send('SendCaravan', { to: r.from, goods: r.want });
        }
        for (const r of me.board.requests({ status: 'fulfilled' })) {
          if (r.from === me.citizen && ['due', 'not-returned'].includes(r.returned) && !(me.paid ??= new Set()).has(r.id)) { me.paid.add(r.id); await me.send('SendCaravan', { to: r.by, goods: r.offer }); }
        }
      } }],
  });
  // What each step reads: wrap the observe port.
  const reads = { asa: [], ren: [] };
  for (const r of Object.values(env.rs)) {
    const inner = r.ports.observe;
    r.ports.observe = async (a, since) => { const o = await inner(a, since); reads[r.id].push({ bell: o.world.bell, events: o.world.events.length, requests: o.board.requests.length }); return o; };
  }
  const size = r => statSync(path.join(r.dir, 'state.json')).size;
  const samples = [];
  const times = [];
  for (let day = 0; day < DAYS; day++) {
    const t0 = process.hrtime.bigint();
    await run(env, BELLS_PER_DAY);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if ((day + 1) % 5 === 0) samples.push({ day: day + 1, ...Object.fromEntries(Object.values(env.rs).map(r => [r.id, { state: size(r), journal: Object.keys(r.state.journal).length, cooldown: Object.keys(r.state.cooldown).length, episodes: r.ports.memory.all().length, decisions: decisionsOf(r).length, ledgerHistory: r.ledger.get(r.id).history.length }])) });
  }
  const posts = env.board.s.posts.length, events = env.world.s.events.length;
  console.log(JSON.stringify({ samples, msPerDay: { first3: times.slice(0, 3).map(Math.round), last3: times.slice(-3).map(Math.round) }, posts, events, maxRead: Object.fromEntries(Object.entries(reads).map(([k, v]) => [k, { events: Math.max(...v.slice(10).map(x => x.events)), requests: Math.max(...v.slice(10).map(x => x.requests)) }])) }));

  for (const id of ['asa', 'ren']) {
    const series = samples.map(s => s[id]);
    const [last2, last] = series.slice(-2);
    // Present state: bounded by caps (the journal keeps one game day, the ledger's history 500 lines), so it levels off.
    // Measured 2026-10-31: about 148 KB at the plateau, most of it the agent ledger's own history (patches/README).
    assert.ok(last.state < 192 * 1024, `${id} state ${last.state} B`);
    assert.ok(last.ledgerHistory === 500 && last2.ledgerHistory === 500, `${id} ledger history at its cap: ${series.map(x => x.ledgerHistory)}`);
    assert.ok(Math.abs(last.state - last2.state) < 4096, `${id} state levels off: ${series.map(x => x.state)}`);
    assert.ok(Math.max(...series.map(x => x.journal)) <= 60, `${id} journal ${series.map(x => x.journal)}`);
    // History: grows, and keeps everything (no reset at any point).
    for (let i = 1; i < series.length; i++) {
      assert.ok(series[i].episodes > series[i - 1].episodes, `${id} episodes ${series.map(x => x.episodes)}`);
      assert.ok(series[i].decisions > series[i - 1].decisions);
    }
    // Reads: one step reads only what is new or still moving.
    const late = reads[id].filter(x => x.bell > BELLS_PER_DAY * (DAYS - 5));
    assert.ok(Math.max(...late.map(x => x.events)) < 50, `${id} read ${Math.max(...late.map(x => x.events))} events in one step`);
    assert.ok(Math.max(...late.map(x => x.requests)) < 30, `${id} read ${Math.max(...late.map(x => x.requests))} requests in one step`);
    assert.deepEqual(env.rs[id].ledger.check(), []);
  }
  assert.ok(events > 1000 && posts > 50, `the world kept going: ${events} events, ${posts} posts`);
  // Step time: the last days are not much slower than the first (generous: shared CI machines are noisy).
  const avg = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  // Once the present state has levelled off, so has the cost of a day.
  assert.ok(avg(times.slice(-3)) <= 1.3 * avg(times.slice(-6, -3)) + 150, `ms/day ${times.map(Math.round)}`);
});
