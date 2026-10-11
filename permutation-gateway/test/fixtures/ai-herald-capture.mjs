// AC6a: capture real herald response shapes into test/fixtures/ai-herald-*
// by READ-ONLY GET requests (AI-CITIZENS-CONTRACT §5.2, §11.3 AC6a).
//
//   node test/fixtures/ai-herald-capture.mjs --herald http://127.0.0.1:41040 [--out <dir>]
//
// It reads /h/status, /h/season, every /h/events page, the per-bell /h/province
// and /h/clash files of the chosen cases, /h/roster/<ring>/latest.bin and
// /h/me/<wallet> of the citizens involved, and writes the files below. Every
// event row and every file is kept VERBATIM; nothing is made up, except the
// roster files when the herald does not serve the route (labelled synthetic in
// ai-herald-meta.json and in the file name). The events file is an EXCERPT:
// rows are selected by the rules in this script and the page fields (`next`,
// `full`) are those of the excerpt, not of the herald. Which shapes exist and
// which do not is recorded in ai-herald-meta.json.
//
// The source was the paused m1-exit herald of the owner's M1 run (a local test
// chain, M1 rule bots only). It is not devnet or mainnet. Nothing here posts,
// signs or writes to the herald; /h/me makes the herald ask the relay for a
// quota (a read).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as b58 from '../../../permutation-server/web/sdk/base58.mjs';
import { provinceFromIndex } from '../../../permutation-server/web/frontier/fgeo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const HERALD = (args.herald ?? 'http://127.0.0.1:41040').replace(/\/$/, '');
const OUT = args.out ?? here;
const BELL_SECS = 600;

/** The cases (clash province, clash bell). Chosen from the capture's own data, see ai-herald-meta.json. */
const CASES = [
  { id: 'camp_single', p: 1, q: -3, cb: 43, why: 'one army against the camp (a CAMP row follows); the first engaged clash of the run' },
  { id: 'arrival_bounced', p: 2, q: -3, cb: 41, why: 'an arrival that did not engage (Retreated fate, engagements 0); the residents are listed too' },
  { id: 'camp_race', p: 1, q: 4, cb: 304, why: 'two arrivals of different nations on the camp tile (stance 3)' },
  { id: 'village_attack', p: 1, q: 4, cb: 387, why: 'an arrival fights a resident army on a village tile (hostile-act shape); bell 388 is a second clash in the same province' },
  { id: 'village_attack_2', p: 1, q: 4, cb: 388, why: 'second consecutive clash of the same province' },
  { id: 'residents_only', p: 1, q: 4, cb: 405, why: 'two resident armies of different nations engage with no arrival' },
  { id: 'multi_party', p: -5, q: 6, cb: 815, why: 'three owners engaged, no arrival' },
];
const WINDOW_BEFORE = 2; // bells before the first needed bell
const WINDOW_AFTER = 3;
const NOISE = new Set(['BEACON', 'ANCHOR', 'SEED', 'CLOSE', 'ARCHIVE', 'FOLD', 'SKIP', 'GATHER', 'DIVERT', 'POOL_SWEEP']);

async function getJson(p) {
  const r = await fetch(HERALD + p);
  const t = await r.text();
  if (!r.ok) return { ok: false, status: r.status, text: t };
  return { ok: true, json: JSON.parse(t), text: t };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- crawl
const status = (await getJson('/h/status')).json;
const seasonRes = await getJson('/h/season');
const season = seasonRes.json;
const rows = [];
let after = '0';
for (;;) {
  const j = (await getJson(`/h/events?after=${after}`)).json;
  rows.push(...j.events);
  if (!j.events.length || !j.full) break;
  after = j.next;
  await sleep(25);
}
const byName = n => rows.filter(r => r.decoded?.name === n);

// ---------------------------------------------------------------- owners (the same derivation as citizens/watcher/owners.mjs)
const base = Buffer.from(b58.decode(season.seasonAddress));
const prog = Buffer.from(b58.decode(season.programId));
const tag8 = hex15 => crypto.createHash('sha256').update(Buffer.concat([base, Buffer.from('ct' + hex15), prog])).digest().subarray(0, 8).readBigUInt64LE(0);
const joinOf = new Map(); // tag8 (BigInt) -> JOIN row
for (const r of byName('JOIN')) joinOf.set(tag8(r.decoded.key.citizen_tag15), r);
const settleOf = new Map(); // "p,q,site" -> SETTLE row (won)
for (const r of byName('SETTLE')) if (r.decoded.payload.outcome < 2) settleOf.set(`${r.decoded.key.p},${r.decoded.key.q},${r.decoded.key.site}`, r);
const hostParts = id => { const x = BigInt(id); const c = provinceFromIndex(Number(x >> 44n)); return { p: c.p, q: c.q, site: Number((x >> 40n) & 0xfn), gen: Number((x >> 32n) & 0xffn) }; };
const ownerRowOfHost = id => { const h = hostParts(id); return settleOf.get(`${h.p},${h.q},${h.site}`); };

// ---------------------------------------------------------------- select
const picked = new Map(); // seq -> row
const add = r => { if (r) picked.set(BigInt(r.seq), r); };
const files = {}; // name -> text
const caseMeta = [];

for (const c of CASES) {
  const clashPath = `/h/clash/${c.p},${c.q}/${c.cb}`;
  const clash = await getJson(clashPath);
  files[`ai-herald-clash-${c.p},${c.q}-${c.cb}.json`] = clash.text;
  const fighters = clash.json.decoded.fighters;
  const hostIds = new Set(fighters.map(f => f.id));
  // the arriving hosts' REVEAL and DEPART
  const reveals = byName('REVEAL').filter(r => r.decoded.key.p === c.p && r.decoded.key.q === c.q && r.decoded.key.arrive === c.cb);
  const departs = [];
  for (const rv of reveals) departs.push(...byName('DEPART').filter(x => x.decoded.key.host_id === rv.decoded.payload.host_id && x.decoded.payload.arrive_bell === c.cb));
  const dBell = departs.length ? Math.min(...departs.map(d => d.decoded.payload.depart_bell)) : null;
  const firstBell = Math.min(c.cb - 1, dBell ?? c.cb - 1);
  // province files: consecutive bells at the clash province, and at the departure bell(s)
  const provFiles = new Set([c.cb - 1, c.cb, c.cb + 1].map(b => `${c.p},${c.q},${b}`));
  for (const d of departs) provFiles.add(`${c.p},${c.q},${d.decoded.payload.depart_bell}`);
  for (const k of provFiles) {
    const [p, q, b] = k.split(',');
    const name = `ai-herald-province-${p},${q}-${b}.json`;
    if (files[name]) continue;
    const r = await getJson(`/h/province/${p},${q}/${b}`);
    if (r.ok) files[name] = r.text;
    await sleep(15);
  }
  // owners of the fighters and of every settled site in the province
  const involvedTags = new Set();
  for (const id of hostIds) { const o = ownerRowOfHost(id); if (o) { add(o); involvedTags.add(String(o.decoded.payload.citizen_tag)); } }
  for (let s = 0; s < 12; s++) { const o = settleOf.get(`${c.p},${c.q},${s}`); if (o) { add(o); involvedTags.add(String(o.decoded.payload.citizen_tag)); } }
  for (const t of involvedTags) add(joinOf.get(BigInt(t)));
  const involvedSites = new Set();
  for (const [k, o] of settleOf) if (involvedTags.has(String(o.decoded.payload.citizen_tag))) involvedSites.add(k);
  // host-specific rows
  const lo = firstBell - WINDOW_BEFORE, hi = c.cb + WINDOW_AFTER;
  for (const r of rows) {
    const n = r.decoded?.name;
    if (!n) continue;
    const hid = r.decoded.key?.host_id ?? r.decoded.payload?.host_id;
    if (hid && hostIds.has(hid) && ['DEPART', 'REVEAL', 'DEPARTURE_SETTLED', 'TRANSIT_SETTLED'].includes(n) && r.bell >= firstBell - 60 && r.bell <= hi + 2) add(r);
  }
  // the window: the departures, reveals and settlements of every nation, the case province's camp rows
  // and clashes, and the builds/finals of the citizens involved (kept small on purpose)
  for (const r of rows) {
    const n = r.decoded?.name;
    if (!n || NOISE.has(n)) continue;
    const inWin = r.bell >= lo && r.bell <= hi;
    const k = r.decoded.key;
    const siteKey = k && k.p !== undefined && k.site !== undefined ? `${k.p},${k.q},${k.site}` : null;
    if (inWin && ['DEPART', 'REVEAL', 'TRANSIT_SETTLED'].includes(n)) add(r);
    if (inWin && n === 'CAMP' && k.p === c.p && k.q === c.q) add(r);
    if (inWin && n === 'CLASH' && (r.decoded.payload.engagements > 0 || (k.p === c.p && k.q === c.q))) add(r);
    if (['BUILD', 'HOLDING_FINAL'].includes(n) && siteKey && involvedSites.has(siteKey) && r.bell <= hi) add(r);
  }
  caseMeta.push({ ...c, clash_path: clashPath, engaged: fighters.filter(f => f.engaged).length, fighters: fighters.length,
    reveals: reveals.map(r => r.seq), departs: departs.map(r => r.seq), depart_bell: dBell,
    province_files: [...provFiles].map(k => k.replace(/,(-?\d+)$/, '/$1')) });
}
// a departure that was never revealed (its destination stays sealed for good)
const revealedHosts = new Set(byName('REVEAL').map(r => `${r.decoded.payload.host_id}/${r.decoded.key.arrive}`));
const unrevealed = byName('DEPART').filter(r => !revealedHosts.has(`${r.decoded.key.host_id}/${r.decoded.payload.arrive_bell}`));
const unrevealedPick = unrevealed[0];
if (unrevealedPick) {
  add(unrevealedPick);
  const o = ownerRowOfHost(unrevealedPick.decoded.key.host_id);
  if (o) { add(o); add(joinOf.get(BigInt(o.decoded.payload.citizen_tag))); }
  for (const r of rows) if (r.decoded?.key?.host_id === unrevealedPick.decoded.key.host_id && ['DEPARTURE_SETTLED', 'TRANSIT_SETTLED'].includes(r.decoded.name)
      && r.bell >= unrevealedPick.bell && r.bell <= unrevealedPick.bell + 12) add(r);
}
// one sample row of every kind that is in the capture (the feed must tolerate or ignore them)
const seenKinds = {};
for (const r of rows) { const n = r.decoded?.name ?? `kind${r.kind}`; seenKinds[n] = (seenKinds[n] ?? 0) + 1; }
const sampled = new Set();
for (const r of rows) { const n = r.decoded?.name; if (n && !sampled.has(n)) { sampled.add(n); add(r); } }

// every SETTLE in the excerpt brings the JOIN of its holder (so the owners can resolve it)
for (const r of [...picked.values()]) if (r.decoded.name === 'SETTLE' && r.decoded.payload.outcome < 2) add(joinOf.get(BigInt(r.decoded.payload.citizen_tag)));
const excerpt = [...picked.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, r]) => r);
const last = excerpt[excerpt.length - 1];
files['ai-herald-events.json'] = JSON.stringify({ v: 1, events: excerpt, next: last.seq, full: false });

// roster files of the rings in use
const rings = new Set();
for (const c of CASES) rings.add((Math.abs(c.p) + Math.abs(c.q) + Math.abs(c.p + c.q)) / 2);
const rosterBins = {};
const rosterNotes = {};
for (const ring of [...rings].sort((a, b) => a - b)) {
  const r = await fetch(`${HERALD}/h/roster/${ring}/latest.bin`);
  if (r.ok) { rosterBins[`ai-herald-roster-${ring}.bin`] = Buffer.from(await r.arrayBuffer()); rosterNotes[`ai-herald-roster-${ring}.bin`] = { synthetic: false }; continue; }
  // The paused herald's binary predates the /h/roster route (404 NotFound). SYNTHETIC file in the layout of
  // frontier-node/crates/herald/src/roster.rs, built from the real SETTLE rows (owner = citizen_tag; founded_bell from
  // final_ts; tier 0 = unknown). Used only to test the roster decoder path; ownership itself comes from events.
  const provs = byName('PROVINCE_OPEN').filter(x => x.decoded.payload.ring === ring).map(x => ({ p: x.decoded.key.p, q: x.decoded.key.q, n: x.decoded.payload.site_count }))
    .sort((a, b) => a.p - b.p || a.q - b.q);
  const recs = [];
  for (const pr of provs) {
    const rec = Buffer.alloc(196);
    rec.writeInt16LE(pr.p, 0); rec.writeInt16LE(pr.q, 2);
    for (let site = 0; site < Math.min(12, pr.n); site++) {
      const o = settleOf.get(`${pr.p},${pr.q},${site}`);
      if (!o) continue;
      const at = 4 + site * 16;
      rec.writeBigUInt64LE(BigInt(o.decoded.payload.citizen_tag), at);
      rec.writeUInt32LE(Math.max(0, Math.floor((Number(o.decoded.payload.final_ts) - season.genesisTs) / BELL_SECS)), at + 8);
    }
    recs.push(rec);
  }
  const head = Buffer.alloc(32);
  head.write('PSFRS1\0\0', 0, 'latin1');
  head.writeBigUInt64LE(BigInt(season.season), 8);
  head.writeUInt16LE(ring, 16);
  head.writeUInt16LE(recs.length, 18);
  head.writeUInt32LE(0, 20);
  head.writeBigUInt64LE(BigInt(season.latestSlot), 24);
  const name = `ai-herald-roster-synthetic-${ring}.bin`;
  rosterBins[name] = Buffer.concat([head, ...recs]);
  rosterNotes[name] = { synthetic: true, why: `GET /h/roster/${ring}/latest.bin answered 404 NotFound on the paused herald (its binary predates the route)`, layout: 'frontier-node/crates/herald/src/roster.rs', owner: 'SETTLE.citizen_tag (outcome 0/1)', founded_bell: 'floor((SETTLE.final_ts - genesis_ts)/600)', tier: 0, header_bell: 0 };
}

// /h/me of the attacker and the defender of the village_attack case (current state, not time-travelled)
const meOut = [];
{
  const vc = CASES.find(c => c.id === 'village_attack');
  const cl = JSON.parse(files[`ai-herald-clash-${vc.p},${vc.q}-${vc.cb}.json`]);
  const eng = cl.decoded.fighters.filter(f => f.engaged);
  for (const [label, f] of [['attacker', eng.find(f => f.arrival)], ['defender', eng.find(f => !f.arrival)]]) {
    if (!f) continue;
    const o = ownerRowOfHost(f.id);
    const j = joinOf.get(BigInt(o.decoded.payload.citizen_tag));
    const wallet = b58.encode(Uint8Array.from(Buffer.from(j.decoded.payload.wallet, 'hex')));
    const me = await getJson(`/h/me/${wallet}`);
    if (me.ok) { files[`ai-herald-me-${label}.json`] = me.text; meOut.push({ label, wallet, tag: String(o.decoded.payload.citizen_tag), host: f.id, file: `ai-herald-me-${label}.json` }); }
  }
}

files['ai-herald-season.json'] = seasonRes.text;
// which record kinds of frontier-abi/src/log.rs the capture never saw (read from the ABI source, not typed here)
const abiKinds = [...fs.readFileSync(path.join(here, '../../../frontier-abi/src/log.rs'), 'utf8').matchAll(/^\s{4}([A-Z_]+) = (\d+); key \[/gm)].map(m => m[1]);
const absentKinds = abiKinds.filter(k => !(k in seenKinds));
const meRoutes = meOut.map(m => JSON.parse(files[m.file]));
const shapes = {
  events_page: 'real rows {seq, slot, sig, kind, bell, tx, body_b64, decoded}; the page envelope {v, events, next, full} is the herald\'s (500 rows a page, `full` true when the page is full); the committed file is an excerpt of verbatim rows',
  province_envelope: 'real /h/province/<p>,<q>/<bell> files (v, key, bell, slot, seq, head, bytes, slots, day, inputs): consecutive bells and the departure bell of each case; the file of bell b is the province AFTER bell b resolved (it exists only once resolved: the paused herald serves none past its resolved bell)',
  clash_report: 'real /h/clash/<p>,<q>/<bell> reports of 7 cases (incl. province_before_b64 and inputs_b64); a bell with no CLASH record has no file (404)',
  me: 'real /h/me/<wallet> of an attacker and a defender: citizen, holdings, hosts, seals (8 for the attacker), quota; transits and slots are empty (nothing in flight in a paused run)',
  season: 'real /h/season',
  roster: 'NOT served by this herald (404): synthetic files in the roster.rs layout',
  decoded_events_kinds_present: Object.keys(seenKinds),
};
const absent = {
  record_kinds: absentKinds,
  routes: ['/h/roster/{ring}/latest.bin (404 NotFound on this herald)'],
  states: [
    'SETTLE outcome 1 (displace): none in the capture (outcomes seen: 0 fresh, 2 taken, 3 expired)',
    'RELEASE: none',
    'a /h/me with a transit in flight or an open ArrivalSlot (transits and slots are empty in both captured files)',
    'a /h/events page of exactly 500 rows is not committed (300 KB); the fake herald pages the excerpt instead',
  ],
  meRoutesChecked: meRoutes.map(m => ({ hosts: m.hosts.length, transits: m.transits.length, slots: m.slots.length, seals: m.seals.length })),
};
const meta = {
  v: 1,
  captured_at: new Date().toISOString(),
  source: { herald: HERALD, kind: 'paused m1-exit herald of the owner (local test chain, M1 rule bots; not devnet, not mainnet)', season: season.season, program: season.programId, season_address: season.seasonAddress, bell_secs: season.bellSecs, status },
  method: 'read-only GET; rows and files are verbatim; ai-herald-events.json is an excerpt (rows chosen by ai-herald-capture.mjs, one sample row of every kind present)',
  events: { crawled: rows.length, kinds: seenKinds, excerpt_rows: excerpt.length, excerpt_first_seq: excerpt[0].seq, excerpt_last_seq: last.seq },
  shapes,
  absent,
  cases: caseMeta,
  me: meOut,
  rosters: rosterNotes,
  unrevealed_depart: unrevealedPick ? { seq: unrevealedPick.seq, host_id: unrevealedPick.decoded.key.host_id, arrive_bell: unrevealedPick.decoded.payload.arrive_bell, count_in_capture: unrevealed.length } : null,
};
files['ai-herald-meta.json'] = JSON.stringify(meta, null, 2) + '\n';

fs.mkdirSync(OUT, { recursive: true });
for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), content);
for (const [name, content] of Object.entries(rosterBins)) fs.writeFileSync(path.join(OUT, name), content);
let total = 0;
for (const n of [...Object.keys(files), ...Object.keys(rosterBins)]) total += fs.statSync(path.join(OUT, n)).size;
console.log(JSON.stringify({ files: Object.keys(files).length + Object.keys(rosterBins).length, bytes: total, excerpt_rows: excerpt.length, crawled: rows.length }));
