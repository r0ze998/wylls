// AC6a: citizens/watcher/feed.mjs against a loopback fake herald serving the captured test/fixtures/ai-herald-* files.
// Real rows and real province/clash files unless a test says SYNTHETIC. Tests bind 127.0.0.1:0 only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeed, normalizeRow, fatesOf, troopsOf, KEPT_KINDS, MILLI, SCOUT } from '../citizens/watcher/feed.mjs';
import { parseHostId, tagFromDecimal, tagHex, citizenTagOfTag15 } from '../citizens/watcher/owners.mjs';
import { hexDistance } from '../../permutation-server/web/frontier/fgeo.mjs';
import { startFakeHerald, loadEvents, loadMeta, readJson } from './fixtures/ai-herald-fake.mjs';

const meta = loadMeta();
const rows = loadEvents().events;
const season = readJson('ai-herald-season.json');
const SEASON = { seasonAddress: season.seasonAddress, programId: season.programId };
const ATTACKER = tagFromDecimal(meta.me.find(m => m.label === 'attacker').tag); // 9b458f555eaabcbf, nation 1
const DEFENDER = tagFromDecimal(meta.me.find(m => m.label === 'defender').tag); // a51ff0cd7d92f5b6, nation 0, village (1,4) site 6
const caseOf = id => meta.cases.find(c => c.id === id);
const withHerald = async (opts, fn) => {
  const h = await startFakeHerald(opts);
  try { return await fn(h); } finally { await h.close(); }
};
const rowsOf = name => rows.filter(r => r.decoded.name === name);

test('normalizeRow: DEPART keeps the public fields, derives the host parts and drops the sealed bytes', () => {
  const r = rowsOf('DEPART')[0];
  const ev = normalizeRow(r);
  const p = r.decoded.payload, k = r.decoded.key;
  assert.equal(ev.kind, 'DEPART');
  assert.equal(ev.seq, r.seq);
  assert.equal(ev.bell, r.bell);
  assert.equal(ev.host_id, k.host_id);
  assert.deepEqual(ev.host, parseHostId(k.host_id));
  assert.deepEqual([ev.origin_p, ev.origin_q, ev.origin_tile, ev.depart_bell, ev.arrive_bell, ev.dep_mass], [p.origin_p, p.origin_q, p.origin_tile, p.depart_bell, p.arrive_bell, p.dep_mass]);
  assert.equal('seal' in ev, false, 'the 165-byte seal is not carried');
  assert.equal('dest' in ev || 'p' in ev || 'tile' in ev, false, 'DEPART has no destination: it stays sealed until the REVEAL');
  assert.equal(typeof ev.host_id, 'string', 'u64 stays a decimal string');
});

test('normalizeRow: REVEAL, TRANSIT_SETTLED, BUILD, SETTLE, JOIN, CAMP, HOLDING_FINAL, DEPARTURE_SETTLED, MUSTER on real rows', () => {
  const rv = normalizeRow(rowsOf('REVEAL')[0]);
  const d = rowsOf('REVEAL')[0].decoded;
  assert.deepEqual([rv.p, rv.q, rv.arrive, rv.faction, rv.i, rv.host_id, rv.tile, rv.stance], [d.key.p, d.key.q, d.key.arrive, d.key.faction, d.key.i, d.payload.host_id, d.payload.tile, d.payload.stance]);
  assert.equal(rv.displaced_host, null);
  assert.deepEqual(rv.host, parseHostId(d.payload.host_id));

  const ts = normalizeRow(rowsOf('TRANSIT_SETTLED')[0]);
  const td = rowsOf('TRANSIT_SETTLED')[0].decoded;
  assert.equal(ts.outcome, td.payload.outcome);
  assert.equal(ts.outcome_name, ['None', 'Stays', 'Withdrew', 'Bounced', 'Retreated', 'Destroyed', 'BouncedUnranked', 'Routed', 'BadSeal'][td.payload.outcome], 'outcomes are 1-based (frontier-abi transit_outcome)');
  assert.equal(ts.troops, td.payload.troops);
  assert.equal('tip_to' in ts || 'fee_to' in ts, false, 'payee addresses are not carried');

  const b = normalizeRow(rowsOf('BUILD')[0]);
  assert.deepEqual([b.p, b.q, b.site, b.item], [rowsOf('BUILD')[0].decoded.key.p, rowsOf('BUILD')[0].decoded.key.q, rowsOf('BUILD')[0].decoded.key.site, rowsOf('BUILD')[0].decoded.payload.item]);

  const s = normalizeRow(rowsOf('SETTLE')[0]);
  const sd = rowsOf('SETTLE')[0].decoded;
  assert.equal(s.citizen, tagFromDecimal(sd.payload.citizen_tag));
  assert.equal(s.displaced, null, 'displaced_tag 0 means nobody');
  assert.equal(s.gen, sd.payload.gen);

  const j = normalizeRow(rowsOf('JOIN')[0]);
  assert.equal(j.citizen15.length, 30);
  assert.equal(j.wallet.length, 64);
  assert.equal(typeof j.faction, 'number');
  assert.equal(citizenTagOfTag15(j.citizen15, SEASON).length, 16);

  const camp = normalizeRow(rowsOf('CAMP')[0]);
  assert.deepEqual([camp.p, camp.q, camp.tile], [rowsOf('CAMP')[0].decoded.key.p, rowsOf('CAMP')[0].decoded.key.q, rowsOf('CAMP')[0].decoded.payload.tile]);
  assert.equal(normalizeRow(rowsOf('HOLDING_FINAL')[0]).kind, 'HOLDING_FINAL');
  const ds = normalizeRow(rowsOf('DEPARTURE_SETTLED')[0]);
  assert.deepEqual(ds.host, parseHostId(ds.host_id));
  assert.equal(normalizeRow(rowsOf('MUSTER')[0]).unit, rowsOf('MUSTER')[0].decoded.payload.unit);
});

test('normalizeRow: noise kinds and undecodable rows are skipped, a kind mismatch is refused', () => {
  for (const name of ['BEACON', 'ANCHOR', 'SEED', 'CLOSE', 'FOLD', 'SKIP', 'GATHER']) assert.equal(normalizeRow(rowsOf(name)[0]), null, name);
  assert.equal(normalizeRow({ seq: '1', kind: 30, bell: 1, decoded: null }), null);
  const r = structuredClone(rowsOf('DEPART')[0]);
  r.kind = 31;
  assert.equal(normalizeRow(r), null, 'row.kind and decoded.kind disagree');
  assert.ok(KEPT_KINDS.includes('CLASH') && !KEPT_KINDS.includes('ANCHOR'));
});

test('CLASH rows: the 24 three-bit fates equal the clash report fates of every captured case, and `real` follows arrivals or engagements', () => {
  let real = 0, quiet = 0;
  for (const c of meta.cases) {
    const rep = readJson(`ai-herald-clash-${c.p},${c.q}-${c.cb}.json`);
    const row = rowsOf('CLASH').find(r => r.decoded.key.p === c.p && r.decoded.key.q === c.q && r.decoded.key.bell === c.cb);
    assert.ok(row, `CLASH row of ${c.id}`);
    const ev = normalizeRow(row);
    assert.deepEqual(ev.fates, rep.decoded.fates, c.id);
    assert.equal(ev.engagements, rep.decoded.engagements);
    assert.equal(ev.clash_bell, c.cb);
    assert.equal(ev.bell, row.bell);
    assert.ok(ev.bell > ev.clash_bell, 'a CLASH record is logged after the bell it resolves');
  }
  for (const r of rowsOf('CLASH')) { const ev = normalizeRow(r); if (ev.real) real++; else { quiet++; assert.equal(ev.arrivals, 0); assert.equal(ev.engagements, 0); } }
  assert.ok(real >= 7 && quiet >= 1, `real ${real}, quiet ${quiet}`);
  assert.deepEqual(fatesOf('000000000000040000').filter(Boolean), [4]);
  assert.equal(fatesOf('000000000000040000')[16], 4);
});

test('poll: pages of 7 rows are followed to the end, the cursor and the head advance, a second poll adds nothing', async () => {
  await withHerald({ pageSize: 7 }, async h => {
    const feed = createFeed({ herald: h.url });
    assert.equal(feed.completeThrough(), -1, 'nothing read yet');
    const r = await feed.poll();
    assert.equal(r.ok, true, r.error);
    assert.equal(feed.stats.rows, rows.length);
    assert.equal(feed.stats.pages, Math.ceil(rows.length / 7) + (rows.length % 7 === 0 ? 1 : 0));
    assert.equal(feed.cursor(), rows[rows.length - 1].seq);
    const expectKept = rows.filter(x => normalizeRow(x)).length;
    assert.equal(feed.stats.kept, expectKept);
    assert.equal(feed.batchSince('0').events.length, expectKept);
    const head = Math.max(...rows.map(x => x.bell).filter(b => b < 0xffffffff));
    assert.equal(feed.headBell(), head);
    assert.ok(feed.completeThrough() >= head - 1, 'every record of a bell before the head bell is in hand (integ-A: or before the bell of the herald\'s latest indexed time)');
    const eventReqs = () => h.requests.filter(r => r.startsWith('/h/events')).length;
    const before = eventReqs();
    const again = await feed.poll();
    assert.equal(again.added, 0);
    assert.equal(eventReqs(), before + 1, 'one /h/events request: the empty page after the cursor');
    // real CLASH rows of the excerpt whose report was not captured (404 NotYet) are retried, a bounded number of times
    assert.ok(feed.stats.clash_fetched >= 7);
  });
});

test('events(bell) and batchSince: the events of a bell in seq order; a cursor in the middle returns the rest', async () => {
  await withHerald({ pageSize: 50 }, async h => {
    const feed = createFeed({ herald: h.url });
    await feed.poll();
    const c = caseOf('village_attack');
    const clash = rowsOf('CLASH').find(r => r.decoded.key.p === c.p && r.decoded.key.q === c.q && r.decoded.key.bell === c.cb);
    const atBell = feed.events(clash.bell);
    assert.ok(atBell.some(e => e.kind === 'CLASH' && e.seq === clash.seq));
    assert.deepEqual(atBell.map(e => BigInt(e.seq)), [...atBell.map(e => BigInt(e.seq))].sort((a, b) => (a < b ? -1 : 1)));
    assert.deepEqual(feed.eventsFor(clash.bell), atBell);
    assert.ok(atBell.every(e => e.bell === clash.bell));
    const all = feed.batchSince('0');
    const mid = all.events[100].seq;
    const rest = feed.batchSince(mid);
    assert.equal(rest.events.length, all.events.length - 101);
    assert.equal(rest.cursor, all.cursor);
    assert.equal(feed.batchSince(all.cursor).events.length, 0);
    assert.deepEqual(feed.events(999999), []);
  });
});

test('provinceAt: consecutive per-bell files show the camp before and after the clash and the hosts with their owners', async () => {
  await withHerald({}, async h => {
    const feed = createFeed({ herald: h.url });
    await feed.poll();
    const pre = await feed.provinceAt(1, 4, 303), post = await feed.provinceAt(1, 4, 304);
    assert.equal(pre.bell, 303);
    assert.equal(post.bell, 304);
    assert.deepEqual([pre.camp.state, pre.camp.troops, pre.camp.tile], [1, 224, 54], 'the camp lives before the clash (224 troops on tile 54)');
    assert.deepEqual([post.camp.state, post.camp.troops], [0, 0], 'and is cleared in it');
    assert.equal(pre.inputs, null, 'no clash inputs at a quiet bell');
    assert.equal(post.inputs.arrivals.length, 2);
    const [a, b] = post.inputs.arrivals;
    assert.notEqual(a.faction, b.faction, 'two nations arrived on the camp tile');
    assert.deepEqual(post.inputs.arrivals.map(x => x.tile), [54, 54]);
    for (const x of post.inputs.arrivals) assert.equal(feed.owners.citizenOfHost(x.host_id), x.citizen);
    const winner = post.hosts.find(x => x.id === '705890759999490');
    assert.ok(winner && winner.tile === 54 && winner.troops === 356244, 'the surviving arrival stands on the camp tile with its post-clash troops');
    assert.equal(winner.owner, tagFromDecimal('12980953007865483833'));
    assert.equal(post.summary.bell, 304);
    assert.equal(post.sites.filter(s => s.state === 1).every(s => s.owner), true, 'every village of the province has a known holder');
    assert.equal(feed.owners.holdersIn(1, 4).length, post.sites.filter(s => s.state === 1).length);
  });
});

test('provinceAt: NotYet is null (not cached, not an error); a wrong-bell file is refused', async () => {
  await withHerald({}, async h => {
    const feed = createFeed({ herald: h.url });
    assert.equal(await feed.provinceAt(9, 9, 5), null);
    assert.equal(await feed.provinceAt(9, 9, 5), null);
    assert.equal(h.requests.filter(r => r === '/h/province/9,9/5').length, 2, 'a miss is asked again');
    const ok = await feed.provinceAt(1, 4, 304);
    assert.ok(ok);
    const n = h.requests.length;
    assert.equal(await feed.provinceAt(1, 4, 304), ok);
    assert.equal(h.requests.length, n, 'a hit is served from the cache');
  });
  // a herald that answers bell 304's file for bell 305: parseEnvelope's bell check throws
  const wrong = { get: async path => (path === '/h/season' ? { status: 200, json: readJson('ai-herald-season.json') } : { status: 200, json: readJson('ai-herald-province-1,4-304.json') }) };
  const feed = createFeed({ herald: wrong });
  await assert.rejects(feed.provinceAt(1, 4, 305), /asked for bell 305/);
});

test('clashAt: report shape, owners and nations of the fighters, heraldCheck carried; no request for a bell with no CLASH record', async () => {
  await withHerald({}, async h => {
    const feed = createFeed({ herald: h.url });
    await feed.poll();
    const c = caseOf('village_attack');
    const rep = await feed.clashAt(c.p, c.q, c.cb);
    assert.equal(rep.bell, c.cb);
    assert.equal(rep.engagements, readJson(`ai-herald-clash-${c.p},${c.q}-${c.cb}.json`).decoded.engagements);
    assert.equal(rep.fighters.filter(f => f.engaged).length, 2, 'two armies engaged in one engagement');
    assert.equal(rep.herald_check, 'match');
    assert.equal(rep.fighters.length, readJson(`ai-herald-clash-${c.p},${c.q}-${c.cb}.json`).decoded.fighters.length);
    for (const f of rep.fighters) { assert.ok(f.owner, `owner of ${f.id}`); assert.equal(typeof f.faction, 'number'); }
    const engaged = rep.fighters.filter(f => f.engaged);
    assert.equal(engaged.length, 2);
    assert.deepEqual(new Set(engaged.map(f => f.owner)), new Set([ATTACKER, DEFENDER]));
    assert.equal(engaged.find(f => f.owner === ATTACKER).arrival, true);
    assert.equal(engaged.find(f => f.owner === DEFENDER).arrival, false);
    assert.equal('inputs_b64' in rep, false, 'the big base64 blobs are not part of the view');
    // a bell with no CLASH record: answered from the log, no request
    const n = h.requests.length;
    assert.equal(await feed.clashAt(c.p, c.q, c.cb + 50), null);
    assert.equal(h.requests.length, n, 'no request');
  });
});

test('clashAt: a CLASH record whose file is not served yet is null and is asked again later', async () => {
  let hidden = true;
  await withHerald({ hide: p => hidden && p === '/h/clash/1,4/387' }, async h => {
    const feed = createFeed({ herald: h.url, roster: { ai: [{ tag: DEFENDER }, { tag: ATTACKER }] } });
    await feed.poll();
    assert.equal(await feed.clashAt(1, 4, 387), null);
    assert.equal(feed.wakeEvents(DEFENDER, 389).length, 0, 'no W-CLASH from a report that is not there');
    hidden = false;
    await feed.poll(); // retries the pending report
    assert.ok(await feed.clashAt(1, 4, 387));
    assert.equal(feed.wakeEvents(DEFENDER, 389).length, 1, 'the wake appears once the report is served');
  });
});

test('clashDetail: troops before and after per fighter; the report province_before agrees with the previous bell file', async () => {
  await withHerald({}, async h => {
    const feed = createFeed({ herald: h.url });
    await feed.poll();
    const c = caseOf('village_attack');
    const d = await feed.clashDetail(c.p, c.q, c.cb);
    assert.equal(d.pre_source, 'report');
    const att = d.fighters.find(f => f.owner === ATTACKER), def = d.fighters.find(f => f.owner === DEFENDER && f.engaged);
    assert.equal(att.before_source, 'arrival');
    assert.equal(att.troops_before, 500000);
    assert.equal(att.troops_after, 396756);
    assert.equal(att.lost, 103244);
    assert.equal(def.before_source, 'report');
    assert.equal(def.troops_before, 300000);
    assert.equal(def.lost, 130675);
    assert.equal(troopsOf(att.lost), 103);
    assert.equal(MILLI, 1000);
    assert.equal(def.fate, 'Bounced');
    // the previous bell's province file gives the same pre-clash troops for every resident that stood there
    const prev = await feed.provinceAt(c.p, c.q, c.cb - 1);
    let compared = 0;
    for (const f of d.fighters.filter(x => x.before_source === 'report')) {
      const ph = prev.hosts.find(x => x.id === f.id);
      if (!ph) continue;
      assert.equal(ph.troops, f.troops_before, `host ${f.id}: file ${c.cb - 1} vs the report's province_before`);
      compared++;
    }
    assert.ok(compared >= 5, `residents compared: ${compared}`);
    // nobody lost troops that did not engage
    for (const f of d.fighters.filter(x => !x.engaged && x.fate === 'Stays')) assert.equal(f.lost, 0, `${f.id} did not fight`);
  });
});

test('clashDetail: falls back to the previous bell file when the report has no province_before', async () => {
  const c = caseOf('village_attack');
  const rep = readJson(`ai-herald-clash-${c.p},${c.q}-${c.cb}.json`);
  delete rep.province_before_b64;
  const pages = { rows };
  await withHerald({}, async h => {
    const wrapped = {
      get: async path => {
        if (path === `/h/clash/${c.p},${c.q}/${c.cb}`) return { status: 200, json: rep };
        const r = await fetch(h.url + path);
        const text = await r.text();
        let json = null; try { json = JSON.parse(text); } catch { /* */ }
        return { status: r.status, json, text, bytes: Buffer.from(text) };
      },
    };
    const feed = createFeed({ herald: wrapped });
    await feed.poll();
    const d = await feed.clashDetail(c.p, c.q, c.cb);
    assert.equal(d.pre_source, 'province_file');
    const def = d.fighters.find(f => f.owner === DEFENDER && f.engaged);
    assert.equal(def.troops_before, 300000, 'same answer as the exact path');
    assert.ok(pages.rows.length);
  });
});

test('W-CLASH (§3.2): the attacker is woken by its own arrival, the defender by the fight at its village, a village owner by the fight in its province, nobody else', async () => {
  await withHerald({}, async h => {
    const bystander = '46773bc19067b9ee'; // resident army of a third citizen with a village in (1,4); not engaged in 387
    const elsewhere = tagFromDecimal(rowsOf('SETTLE').find(r => r.decoded.key.p === -5 && r.decoded.key.q === 6).decoded.payload.citizen_tag);
    const feed = createFeed({ herald: h.url, roster: { ai: [{ tag: ATTACKER }, { tag: DEFENDER }, { tag: bystander }, { tag: elsewhere }] } });
    await feed.poll();
    const c = caseOf('village_attack');
    const logBell = rowsOf('CLASH').find(r => r.decoded.key.p === c.p && r.decoded.key.q === c.q && r.decoded.key.bell === c.cb).bell;
    const [wa] = feed.wakeEvents(ATTACKER, logBell).filter(w => w.code === 'W-CLASH' && w.clash_bell === c.cb);
    assert.ok(wa, 'attacker wake');
    assert.equal(wa.weight, 4);
    assert.equal(wa.own_arrival, true);
    assert.equal(wa.own_engaged, true);
    assert.equal(wa.village, false, 'the attacker has no village in (1,4)');
    const [wd] = feed.wakeEvents(DEFENDER, logBell).filter(w => w.code === 'W-CLASH' && w.clash_bell === c.cb);
    assert.ok(wd && wd.village === true && wd.own_arrival === false && wd.own_engaged === true);
    const [wb] = feed.wakeEvents(bystander, logBell).filter(w => w.code === 'W-CLASH' && w.clash_bell === c.cb);
    assert.ok(wb, 'a village owner is woken by a real clash in its province');
    assert.deepEqual([wb.village, wb.own_engaged, wb.own_hosts.length > 0], [true, false, true]);
    assert.equal(feed.wakeEvents(elsewhere, logBell).filter(w => w.clash_bell === c.cb).length, 0, 'a citizen of another province is not woken');
    // the wake belongs to the bell the record became public, not to the clash bell
    assert.equal(feed.wakeEvents(DEFENDER, c.cb).filter(w => w.clash_bell === c.cb).length, 0);
    const s = feed.wakeSummary(DEFENDER, logBell);
    assert.ok(s.codes.includes('W-CLASH') && s.weight >= 4);
  });
});

test('W-CLASH: the arrival that did not engage (Retreated, engagements 0) still wakes its owner', async () => {
  await withHerald({}, async h => {
    const c = caseOf('arrival_bounced');
    const rep = readJson(`ai-herald-clash-${c.p},${c.q}-${c.cb}.json`);
    const arriving = rep.decoded.fighters.find(f => f.arrival);
    const owner = (() => { const f = createFeed({ herald: h.url }); return f; })();
    await owner.poll();
    const tag = owner.owners.citizenOfHost(arriving.id);
    assert.ok(tag);
    const feed = createFeed({ herald: h.url, roster: { ai: [{ tag }] } });
    await feed.poll();
    const logBell = rowsOf('CLASH').find(r => r.decoded.key.p === c.p && r.decoded.key.q === c.q && r.decoded.key.bell === c.cb).bell;
    const w = feed.wakeEvents(tag, logBell).filter(x => x.code === 'W-CLASH' && x.clash_bell === c.cb);
    assert.equal(w.length, 1);
    assert.deepEqual([w[0].engagements, w[0].own_arrival, w[0].own_engaged], [0, true, false]);
  });
});

test('W-CLASH: a CLASH with no arrival and no engagement (a resident roll call) is not a wake in the default mode; the literal reading wakes every village owner', async () => {
  await withHerald({}, async h => {
    const quiet = rowsOf('CLASH').map(normalizeRow).filter(e => !e.real);
    assert.ok(quiet.length >= 1, 'the capture holds quiet CLASH rows');
    const probe = createFeed({ herald: h.url });
    await probe.poll();
    // a watched village owner in the province of a quiet CLASH row
    const ev = quiet.find(e => probe.owners.holdersIn(e.p, e.q).length);
    assert.ok(ev, 'a quiet CLASH in a province with a captured village');
    const tag = probe.owners.holdersIn(ev.p, ev.q)[0].tag;
    const real = createFeed({ herald: h.url, roster: { ai: [{ tag }] } });
    const literal = createFeed({ herald: h.url, roster: { ai: [{ tag }] }, clashMode: 'literal' });
    await real.poll(); await literal.poll();
    const mine = real.wakeEvents(tag, ev.bell).filter(w => w.seq === ev.seq);
    assert.equal(mine.length, 0, 'default mode: quiet clash, no wake');
    const lit = literal.wakeEvents(tag, ev.bell).filter(w => w.seq === ev.seq);
    assert.equal(lit.length, 1, 'literal mode: wake');
    assert.deepEqual([lit[0].real, lit[0].village, lit[0].own_hosts.length], [false, true, 0]);
  });
});

/** Independent expectation of W-THREAT from the raw rows: another nation's DEPART whose origin is <= 3 provinces from the watcher's home. */
function expectedThreats(tag, homeSite) {
  const joins = new Map(rowsOf('JOIN').map(r => [citizenTagOfTag15(r.decoded.key.citizen_tag15, SEASON), r.decoded.payload.faction]));
  const holder = new Map(rowsOf('SETTLE').filter(r => r.decoded.payload.outcome < 2).map(r => [`${r.decoded.key.p},${r.decoded.key.q},${r.decoded.key.site}`, tagFromDecimal(r.decoded.payload.citizen_tag)]));
  const myFaction = joins.get(tag);
  const out = [];
  for (const r of rowsOf('DEPART')) {
    const hp = parseHostId(r.decoded.key.host_id);
    const actor = holder.get(`${hp.p},${hp.q},${hp.site}`);
    const f = actor && joins.get(actor);
    if (f === undefined || f === myFaction) continue;
    const dist = hexDistance(r.decoded.payload.origin_p, r.decoded.payload.origin_q, homeSite.p, homeSite.q);
    if (dist <= 3) out.push({ seq: r.seq, bell: r.bell, dist, nation: f });
  }
  return out;
}

test('W-THREAT (§3.2): other nations\' departures within 3 provinces of the home, nothing for own nation or farther origins, no destination in the wake', async () => {
  await withHerald({}, async h => {
    const feed = createFeed({ herald: h.url, roster: { ai: [{ tag: DEFENDER }, { tag: ATTACKER }] } });
    await feed.poll();
    for (const tag of [DEFENDER, ATTACKER]) {
      const home = feed.owners.homeOf(tag);
      const want = expectedThreats(tag, home);
      assert.ok(want.length >= 3, `the excerpt holds departures near ${tag}'s home (${want.length})`);
      const got = [];
      for (let b = 0; b <= feed.headBell(); b++) for (const w of feed.wakeEvents(tag, b)) if (w.code === 'W-THREAT') got.push(w);
      assert.deepEqual(got.map(w => w.seq).sort(), want.map(w => w.seq).sort(), `threat seqs for ${tag}`);
      for (const w of got) {
        const e = want.find(x => x.seq === w.seq);
        assert.deepEqual([w.bell, w.distance, w.nation], [e.bell, e.dist, e.nation]);
        assert.ok([2, 3].includes(w.weight));
        assert.equal(w.weight, w.big ? 3 : 2);
        for (const k of ['dest', 'destination', 'tile', 'p', 'q', 'arrive']) assert.equal(k in w, false, `a threat carries no ${k}: the destination is sealed`);
        assert.equal(typeof w.arrive_bell, 'number');
        assert.equal(typeof w.dep_mass, 'number');
      }
    }
    // the +1 weight rule: dep_mass at least half of the estimated home troops
    const w0 = [...Array(feed.headBell() + 1).keys()].flatMap(b => feed.wakeEvents(DEFENDER, b)).filter(w => w.code === 'W-THREAT');
    for (const w of w0) if (w.home_troops_est !== null) assert.equal(w.big, w.dep_mass * 2 >= w.home_troops_est && w.home_troops_est > 0);
    assert.ok(w0.some(w => w.home_troops_est > 0), 'the estimate is filled from the home province file');
    for (const w of w0.filter(x => x.home_troops_bell !== null)) assert.ok(w.home_troops_bell <= w.depart_bell && w.home_troops_bell >= w.depart_bell - 4, 'the file used is the newest served one at or before the departure bell');
  });
});

test('W-THREAT: a departure that was never revealed is a threat with no destination, ever', async () => {
  await withHerald({}, async h => {
    const u = meta.unrevealed_depart;
    const row = rows.find(r => r.seq === u.seq);
    assert.equal(row.decoded.name, 'DEPART');
    assert.equal(rowsOf('REVEAL').some(r => r.decoded.payload.host_id === u.host_id && r.decoded.key.arrive === u.arrive_bell), false, 'no REVEAL for it in the capture');
    const feed = createFeed({ herald: h.url });
    await feed.poll();
    const ev = feed.events(row.bell).find(e => e.seq === u.seq);
    assert.ok(ev);
    assert.equal(ev.arrive_bell, u.arrive_bell);
    assert.equal('p' in ev, false);
    // a watcher whose home is near the origin gets the wake with no destination
    const home = { p: ev.origin_p, q: ev.origin_q };
    const actor = feed.owners.citizenOfHost(ev.host_id);
    const nation = feed.owners.factionOfTag(actor);
    const near = rowsOf('SETTLE').map(r => ({ tag: tagFromDecimal(r.decoded.payload.citizen_tag), p: r.decoded.key.p, q: r.decoded.key.q })).find(s => hexDistance(s.p, s.q, home.p, home.q) <= 3 && feed.owners.factionOfTag(s.tag) !== nation && feed.owners.homeOf(s.tag));
    assert.ok(near, 'the excerpt holds a neighbour of another nation within 3 provinces of the origin');
    const f2 = createFeed({ herald: h.url, roster: { ai: [{ tag: near.tag }] } });
    await f2.poll();
    const wake = f2.wakeEvents(near.tag, row.bell).find(w => w.seq === u.seq);
    assert.ok(wake, 'the neighbour is warned by the departure');
    for (const k of ['p', 'q', 'tile', 'dest']) assert.equal(k in wake, false);
    assert.equal(wake.arrive_bell, u.arrive_bell);
  });
});

test('wakes are deterministic: two feeds over the same rows give identical batches and wakes; the roster kinds follow the roster only', async () => {
  await withHerald({ pageSize: 33 }, async h => {
    const mk = () => createFeed({ herald: h.url, roster: { ai: [{ tag: DEFENDER }, { tag: ATTACKER }], seat: { tag: '46773bc19067b9ee' } } });
    const a = mk(), b = mk();
    await a.poll(); await b.poll();
    assert.equal(JSON.stringify(a.batchSince('0')), JSON.stringify(b.batchSince('0')));
    for (const tag of [DEFENDER, ATTACKER]) for (let bell = 0; bell <= a.headBell(); bell++) assert.equal(JSON.stringify(a.wakeEvents(tag, bell)), JSON.stringify(b.wakeEvents(tag, bell)));
    assert.equal(a.kindOfTag(DEFENDER), 'ai');
    assert.equal(a.kindOfTag('46773bc19067b9ee'), 'seat');
    const sb = a.owners.walletOf('dc8e36181e9f8b51');
    a.setRoster({ ai: [], script: { wallets: [sb] } });
    assert.equal(a.kindOfTag('dc8e36181e9f8b51'), 'script', 'a wallet in the script list is a script bot');
    assert.equal(a.kindOfTag('0000000000000001'), null);
  });
});

test('subscribe: a poll with new events tells its subscribers once; stop() and unsubscribe are quiet', async () => {
  await withHerald({ pageSize: 100 }, async h => {
    const feed = createFeed({ herald: h.url });
    const seen = [];
    const off = feed.subscribe(m => seen.push(m));
    await feed.poll();
    assert.equal(seen.length, 1);
    assert.equal(seen[0].events.length, feed.stats.kept);
    assert.equal(seen[0].through_bell, feed.completeThrough());
    await feed.poll();
    assert.equal(seen.length, 1, 'nothing new, nothing sent');
    off();
    feed.stop();
  });
});

test('SYNTHETIC rows: ingest() takes rows from anywhere (a replay) through the same path, in the herald row shape', async () => {
  const feed = createFeed({ herald: { get: async () => ({ status: 404, json: null, text: '' }) }, season: { ...SEASON, season: season.season } });
  const fresh = await feed.ingest(rows.filter(r => ['JOIN', 'SETTLE', 'DEPART'].includes(r.decoded.name)));
  assert.ok(fresh.length > 40);
  assert.equal(feed.completeThrough(), -1, 'rows from elsewhere do not prove the feed is current');
  assert.ok(feed.owners.homeOf(DEFENDER));
});

test('guards: a herald that is not on loopback is refused; an unreachable herald makes poll() report, not throw, and the feed stays not-current', async () => {
  assert.throws(() => createFeed({ herald: 'http://10.1.2.3:41940' }), /loopback/);
  assert.throws(() => createFeed({ herald: 'http://example.com' }), /loopback/);
  assert.throws(() => createFeed({ herald: '' }), /herald URL/);
  createFeed({ herald: 'http://127.0.0.1:1' });
  createFeed({ herald: 'http://localhost:1' });
  const h = await startFakeHerald();
  const url = h.url;
  await h.close();
  const feed = createFeed({ herald: url, timeoutMs: 500 });
  const r = await feed.poll();
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(feed.completeThrough(), -1);
  assert.ok(feed.stats.errors >= 1);
});

test('a herald that stops answering after a good poll: completeThrough drops to -1 until a poll reaches the end again', async () => {
  const h = await startFakeHerald({ pageSize: 500 });
  const feed = createFeed({ herald: h.url, timeoutMs: 500 });
  assert.equal((await feed.poll()).ok, true);
  assert.ok(feed.completeThrough() > 0);
  await h.close();
  assert.equal((await feed.poll()).ok, false);
  assert.equal(feed.completeThrough(), -1, 'the mind sees feed_lag instead of a stale feed');
});

test('prepare(): synchronous readers over a batch for the pure episodes function; departOf/revealOf link a march', async () => {
  await withHerald({}, async h => {
    const feed = createFeed({ herald: h.url });
    await feed.poll();
    const c = caseOf('village_attack');
    const batch = feed.batchSince('0').events.filter(e => (e.kind === 'CLASH' && e.p === c.p && e.q === c.q && e.clash_bell === c.cb) || (e.kind === 'REVEAL' && e.p === c.p && e.q === c.q && e.arrive === c.cb));
    assert.equal(batch.length, 2);
    const ctx = await feed.prepare(batch);
    assert.deepEqual(ctx.missing, [], 'every file the batch needs was served');
    assert.equal(ctx.province(c.p, c.q, c.cb - 1).bell, c.cb - 1);
    assert.equal(ctx.province(c.p, c.q, c.cb).bell, c.cb);
    assert.equal(ctx.province(c.p, c.q, c.depart_bell).bell, c.depart_bell, 'the destination province at the departure bell (the sender\'s view)');
    assert.equal(ctx.clash(c.p, c.q, c.cb).bell, c.cb);
    assert.equal(ctx.clashDetail(c.p, c.q, c.cb).fighters.find(f => f.owner === ATTACKER).lost, 103244);
    assert.equal(ctx.province(9, 9, 9), null, 'not prepared: null, never a fetch');
    assert.equal(ctx.owners, feed.owners);
    const rv = batch.find(e => e.kind === 'REVEAL');
    const dep = feed.departOf(rv.host_id, rv.arrive);
    assert.equal(dep.depart_bell, c.depart_bell);
    assert.equal(feed.revealOf(rv.host_id, rv.arrive).seq, rv.seq);
    assert.equal(feed.departOf('1', 1), null);
    // a batch that needs files the herald lacks says so
    const camp = caseOf('camp_race');
    const evs = feed.batchSince('0').events.filter(e => e.kind === 'CLASH' && e.real && !(e.p === camp.p && e.q === camp.q && e.clash_bell === camp.cb));
    const ctx2 = await feed.prepare(evs.slice(0, 40));
    assert.ok(ctx2.missing.length > 0 && ctx2.missing.every(m => /^(province|clash):/.test(m)));
  });
});

test('provinceBefore: the newest served file at or before a bell, none beyond `back`', async () => {
  await withHerald({}, async h => {
    const feed = createFeed({ herald: h.url });
    await feed.poll();
    assert.equal((await feed.provinceBefore(1, 4, 304)).bell, 304);
    assert.equal((await feed.provinceBefore(1, 4, 302, 4)).bell, 300, '302, 301 absent; 300 present');
    assert.equal(await feed.provinceBefore(1, 4, 350, 4), null);
  });
});

test('start() polls on a timer and stop() ends it', async () => {
  await withHerald({ pageSize: 100 }, async h => {
    const feed = createFeed({ herald: h.url });
    feed.start({ intervalMs: 5 });
    feed.start({ intervalMs: 5 }); // idempotent
    const t0 = Date.now();
    while (feed.stats.polls < 3 && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 10));
    feed.stop();
    const n = feed.stats.polls;
    assert.ok(n >= 3, `polls: ${n}`);
    await new Promise(r => setTimeout(r, 60));
    assert.ok(feed.stats.polls <= n + 1, 'stopped');
    assert.ok(feed.completeThrough() > 0);
  });
});

test('constants of the unit: scouts are unit 6 and troops are milli-troops', () => {
  assert.equal(SCOUT, 6);
  assert.equal(troopsOf(103244), 103);
  assert.equal(troopsOf(499), 0);
  assert.equal(troopsOf(500), 1);
  assert.equal(tagHex(1n), '0000000000000001');
  assert.equal(parseHostId('1150093457620992').site, 6);
});

test('integ-A: completeThrough follows the herald\'s indexed time, so a bell with no record yet does not make the feed lag; a row at or before a claimed bell is counted late', async () => {
  const G = 1_800_000_000;
  const rowAt = (seq, bell) => ({ seq: String(seq), slot: seq, sig: 's', kind: 99, bell, decoded: { name: 'BEACON', key: {}, payload: {} } });
  let latestUnix = G + 5 * 600 + 30; // the herald has indexed into bell 5
  let events = [rowAt(1, 3), rowAt(2, 4)]; // but only bells 3 and 4 have a kept-or-not record yet
  const herald = {
    async get(p) {
      if (p === '/h/season') return { status: 200, json: { seasonAddress: 'GuNY5CXJGCmdf6dtXDEJF3eBn4n6XwcqTSRZwSGaWpdC', programId: 'CMRiagDSYZNhyA2yxrEhLxLnKTm4fkJvjsE7v4ZHcP5r', season: '41', genesisTs: G, bellSecs: 600, latestUnix } };
      if (p.startsWith('/h/events')) { const after = Number(new URL('http://x' + p).searchParams.get('after') ?? 0); return { status: 200, json: { events: events.filter(e => Number(e.seq) > after), full: false } }; }
      return { status: 404, json: null };
    },
  };
  const feed = createFeed({ herald });
  assert.equal((await feed.poll()).ok, true);
  assert.equal(feed.headBell(), 4);
  assert.equal(feed.completeThrough(), 4, 'bell 5 is under way (indexed to bell 5): everything through bell 4 is in hand, not only through head - 1 = 3');
  assert.equal(feed.stats.late_rows, 0);
  events = [...events, rowAt(3, 4)]; // a record of bell 4 arriving after the claim: the assumption failed, and it is counted
  assert.equal((await feed.poll()).ok, true);
  assert.equal(feed.stats.late_rows, 1);
  latestUnix = G + 3 * 600; // an index that is behind the rows must never raise the claim above the head rule
  assert.ok(feed.completeThrough() >= 3);
});
