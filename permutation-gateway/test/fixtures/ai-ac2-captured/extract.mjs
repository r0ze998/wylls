// PROVENANCE SCRIPT (not a test; needs the AC6a worktree's modules, which are not in this branch).
// It cut this directory out of the REAL herald files AC6a captured (test/fixtures/ai-herald-*, AC6a commit a8bf2c1, the paused m1-exit
// herald of the owner: a local test chain with M1 rule bots; no devnet, no mainnet, no humans):
//   verbatim:  clash-*.json, province-*.json (the files the herald served), events.json (raw /h/events rows, an excerpt)
//   derived:   owners.json  (AC6a owners.mjs: host id -> citizen tag, citizens' nation and holdings)
//              feed-shapes.json (what AC6a feed.prepare() hands to episodes_from_events: normalised events and shaped province/clash/clashDetail)
// Run: node extract.mjs   (from this directory; paths below are the AC2 and AC6a worktrees)
import fs from 'node:fs';
import path from 'node:path';
const W6 = '/Users/r0ze/Documents/Codex/2026-09-20/new-chat-2/outputs/.claude/worktrees/ai-ac6a/permutation-gateway';
const OUT = path.dirname(new URL(import.meta.url).pathname);
const { createFeed } = await import(`${W6}/citizens/watcher/feed.mjs`);
const { startFakeHerald, loadMeta, readJson } = await import(`${W6}/test/fixtures/ai-herald-fake.mjs`);
const meta = loadMeta();
const CASES = ['camp_single', 'camp_race', 'village_attack', 'village_attack_2'].map(id => meta.cases.find(c => c.id === id));
const h = await startFakeHerald({ pageSize: 600 });
const feed = createFeed({ herald: h.url });
await feed.poll();
const all = feed.batchSince('0').events;
const rawRows = readJson('ai-herald-events.json').events;
const rawBySeq = new Map(rawRows.map(r => [String(r.seq), r]));

// the events the AI-side producer reads: the cases' CLASH / REVEAL / DEPART / CAMP rows, and the DEPARTs near (1,4) that become `threat` episodes
const wanted = new Set();
const clashKeys = new Set(CASES.map(c => `${c.p},${c.q},${c.cb}`));
for (const e of all) {
  if (e.kind === 'CLASH' && clashKeys.has(`${e.p},${e.q},${e.clash_bell}`)) wanted.add(e.seq);
  if (e.kind === 'REVEAL' && CASES.some(c => c.p === e.p && c.q === e.q && c.cb === e.arrive)) wanted.add(e.seq);
  if (e.kind === 'DEPART' && CASES.some(c => (c.departs ?? []).includes(String(e.seq)))) wanted.add(e.seq);
}
for (const e of all) if (e.kind === 'CAMP' && all.some(c => wanted.has(c.seq) && c.kind === 'CLASH' && c.sig === e.sig && c.p === e.p && c.q === e.q)) wanted.add(e.seq);
for (const e of all) if (e.kind === 'DEPART' && e.arrive_bell >= 296 && e.arrive_bell <= 392 && Math.max(Math.abs(e.origin_p - 1), Math.abs(e.origin_q - 4)) <= 2) wanted.add(e.seq);
const seqs = [...wanted].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
fs.writeFileSync(path.join(OUT, 'events.json'), `${JSON.stringify({ v: 1, source: 'ai-herald-events.json (AC6a), raw rows verbatim', events: seqs.map(s => rawBySeq.get(s)).filter(Boolean) })}\n`);

// province and clash files the cases need (verbatim copies)
const copy = (from, to) => fs.copyFileSync(path.join(W6, 'test/fixtures', from), path.join(OUT, to));
const provNeeded = new Set();
for (const c of CASES) {
  for (const b of [c.cb - 1, c.cb]) provNeeded.add(`${c.p},${c.q}-${b}`);
  if (c.depart_bell !== null) provNeeded.add(`${c.p},${c.q}-${c.depart_bell}`);
}
for (const k of provNeeded) if (fs.existsSync(path.join(W6, 'test/fixtures', `ai-herald-province-${k}.json`))) copy(`ai-herald-province-${k}.json`, `province-${k}.json`);
for (const c of CASES) copy(`ai-herald-clash-${c.p},${c.q}-${c.cb}.json`, `clash-${c.p},${c.q}-${c.cb}.json`);
// the DEPART bells of the other armies of the village_attack clashes
for (const e of all) if (e.kind === 'REVEAL' && CASES.some(c => c.p === e.p && c.q === e.q && c.cb === e.arrive)) {
  const d = feed.departOf(e.host_id, e.arrive);
  const f = `ai-herald-province-${e.p},${e.q}-${d.depart_bell}.json`;
  if (fs.existsSync(path.join(W6, 'test/fixtures', f))) copy(f, `province-${e.p},${e.q}-${d.depart_bell}.json`);
}

// owners (derived by AC6a owners.mjs)
const owners = feed.owners;
const hostIds = new Set();
const evs = all.filter(e => wanted.has(e.seq));
for (const e of evs) if (e.host_id) hostIds.add(e.host_id);
for (const c of CASES) { const cl = await feed.clashAt(c.p, c.q, c.cb); for (const f of cl.fighters) hostIds.add(f.id); }
for (const c of CASES) for (const b of [c.cb - 1, c.cb]) { const p = await feed.provinceAt(c.p, c.q, b); for (const x of p?.hosts ?? []) hostIds.add(x.id); }
const tags = new Set();
const hostOwner = {}, hostFaction = {};
for (const id of hostIds) { const t = owners.citizenOfHost(id); hostOwner[id] = t; hostFaction[id] = owners.factionOfHost(id); if (t) tags.add(t); }
const citizens = {};
for (const t of tags) citizens[t] = { faction: owners.factionOfTag(t), home: owners.homeOf(t), holdings: owners.holdingsOf(t).map(x => ({ p: x.p, q: x.q, site: x.site })) };
fs.writeFileSync(path.join(OUT, 'owners.json'), `${JSON.stringify({ v: 1, source: 'AC6a owners.mjs over ai-herald-events.json', genesis_ts: feed.season().genesisTs, host_owner: hostOwner, host_faction: hostFaction, citizens }, null, 1)}\n`);

// feed shapes (AC6a prepare())
const prep = await feed.prepare(evs);
const shapes = { v: 1, source: 'AC6a feed.prepare() at commit a8bf2c1', events: evs, province: {}, clash: {}, clashDetail: {} };
for (const c of CASES) {
  for (const b of [c.cb - 1, c.cb]) shapes.province[`${c.p},${c.q},${b}`] = prep.province(c.p, c.q, b);
  shapes.clash[`${c.p},${c.q},${c.cb}`] = prep.clash(c.p, c.q, c.cb);
  shapes.clashDetail[`${c.p},${c.q},${c.cb}`] = prep.clashDetail(c.p, c.q, c.cb);
}
for (const e of evs) if (e.kind === 'REVEAL') { const d = feed.departOf(e.host_id, e.arrive); const k = `${e.p},${e.q},${d.depart_bell}`; shapes.province[k] = prep.province(e.p, e.q, d.depart_bell); }
fs.writeFileSync(path.join(OUT, 'feed-shapes.json'), `${JSON.stringify(shapes)}\n`);
await h.close();
console.log('events', seqs.length, 'hosts', hostIds.size, 'citizens', tags.size);
