// The scenario census (contract section 9.5; unit AC5). Read-only, steers nothing: it writes only under AI_DIR/census/.
//
// From the first bell at which an AI citizen has a final village, and every 12 bells after, it reads the herald's
// season, overview and province files and each AI's /h/me, and writes AI_DIR/census/<bell>.json: for each AI the
// nearest live camp inside its 12-province window (distance, troops), the visible open-field stacks of other nations
// there, its hosts and which of them can depart, and the bell at which its village shield ends. It answers the two
// questions of 9.5 before a main run: (a) does each AI have a live camp near it at the start, (c) how many bells pass
// from an AI's first final village to its first and its second host that can depart (AC3a step 0 (d) reads
// census/summary.json; census/ready.jsonl has one line per AI per bell).
//
// (b) of 9.5, whether the test preset can shorten the shield without a program edit, is not something a census can
// read: the shield is 48 game hours (72 after game day 7) in permutation-rules; the census reports each village's
// shield end and nothing else about it.
//
// `can_depart` is the rule of agents/src/policy.rs read from the public Province entry: resident (state 1), settled,
// no pending operation, ready, not a scout, not in transit, and stamina (value + 1 per bell, cap 120) of at least the
// 74 a march charges (10 + 2 x 32). It is a reading of public records, not a statement about what an AI will do.
//
//   node census.mjs --herald URL --ai-dir DIR [--roster F] [--poll-ms 15000] [--window 12] [--once]
//
// Loopback only; it binds no port.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHerald } from '../../../permutation-server/web/frontier/herald.mjs';
import { hexDistance, ringOf, tileHex } from '../../../permutation-server/web/frontier/fgeo.mjs';

/** True when this file is the program being run (symlinked temp directories, such as macOS /var, resolve to the same real path). */
function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

export const CENSUS_EVERY = 12;
export const WINDOW_PROVINCES = 12;
export const MARCH_STAMINA = 74; // travel::march_stamina(MAX_PATH_STEPS) = 10 + 2 * 32
export const STAMINA_CAP = 120; // host::STAMINA_CAP
export const SCOUT = 6;
export const STATE_ROSTER = 1;
export const SHIELD_SECS = 48 * 3600;
export const SHIELD_LATE_SECS = 72 * 3600;
export const SHIELD_LATE_FROM_DAY = 7;
export const HOLDING_FINAL = 2;
const MAX_STACKS_LISTED = 8;

/** Province (axial) distance: the hex distance on the (P, Q) lattice. */
export const provinceDistance = (p1, q1, p2, q2) => (Math.abs(p1 - p2) + Math.abs(q1 - q2) + Math.abs(p1 + q1 - p2 - q2)) / 2;
export const staminaAt = (value, stampBell, bell) => (bell <= stampBell ? value : Math.min(STAMINA_CAP, value + (bell - stampBell)));

/** policy.rs can_depart on a decoded Province Entry. */
export function canDepart(entry, bell, inTransit = new Set()) {
  return entry.state === STATE_ROSTER && entry.fromBell <= bell && entry.pendOp === 0 && entry.readyBell <= bell && entry.unit !== SCOUT
    && !inTransit.has(String(entry.id)) && staminaAt(entry.staminaValue, entry.staminaBell, bell) >= MARCH_STAMINA;
}

/** The bell a season record says it is (-1 before genesis). */
export function bellOf(seasonRecord) {
  const t = Number(seasonRecord.latestUnix), g = Number(seasonRecord.genesisTs), s = Number(seasonRecord.bellSecs);
  return t < g ? -1 : Math.floor((t - g) / s);
}
export const bellAt = (unix, seasonRecord) => Math.floor((Number(unix) - Number(seasonRecord.genesisTs)) / Number(seasonRecord.bellSecs));

/** The shield end of a holding (unix seconds): founded_ts + 48 h (72 h when founded after day 7), the rule of holding.rs. */
export const shieldUntilOf = h => Number(h.foundedTs) + (h.foundedDay > SHIELD_LATE_FROM_DAY ? SHIELD_LATE_SECS : SHIELD_SECS);

const tileDistance = (p1, q1, t1, p2, q2, t2) => {
  const a = tileHex(p1, q1, t1), b = tileHex(p2, q2, t2);
  return a && b ? hexDistance(a.q, a.r, b.q, b.r) : null;
};

/**
 * The pure core. Everything is already fetched and decoded:
 *   season  the /h/season record (`latestUnix`, `genesisTs`, `bellSecs`)
 *   ais     [{entry: {index, tag, faction}, holdings: [decoded Holding], hosts: [/h/me host rows], transits: [/h/me transit rows]}]
 *   overview(p, q) → the overview province record {owners, sites, hosts} or null
 *   province(p, q) → the decoded Province or null
 *   window  radius in provinces (12)
 * Returns the census object of one bell.
 */
export function censusOf({ season, ais, overview, province, window = WINDOW_PROVINCES, bell = bellOf(season), provincesNear }) {
  const rows = [];
  for (const a of ais) {
    const { entry } = a;
    const final = (a.holdings ?? []).filter(h => h.state === HOLDING_FINAL).sort((x, y) => Number(x.finalTs) - Number(y.finalTs))[0] ?? null;
    const transit = new Set((a.transits ?? []).map(t => String(t.host)));
    const hostRows = (a.hosts ?? []).map(r => {
      const pv = province(r.province[0], r.province[1]);
      const e = pv?.entries?.find(x => String(x.id) === String(r.id)) ?? null;
      const can = e ? canDepart(e, bell, transit) : false;
      return { id: String(r.id), unit: r.unit, troops: Math.floor(Number(r.troops) / 1000), province: r.province, tile: r.tile, can_depart: can, stamina: e ? staminaAt(e.staminaValue, e.staminaBell, bell) : null };
    });
    const row = {
      index: entry.index, tag: entry.tag, faction: entry.faction,
      final_village: null,
      hosts: { total: hostRows.length, can_depart: hostRows.filter(h => h.can_depart).length, rows: hostRows },
      camps: { in_window: 0, within_3_provinces: 0, nearest: null },
      field_stacks: { in_window: 0, nearest: [] },
    };
    if (final) {
      const until = shieldUntilOf(final);
      row.final_village = {
        p: final.p, q: final.q, site: final.site, tile: final.tile, tier: final.tier, founded_ts: Number(final.foundedTs), final_ts: Number(final.finalTs),
        final_bell: bellAt(final.finalTs, season), shield_until: until, shield_end_bell: Math.ceil((until - Number(season.genesisTs)) / Number(season.bellSecs)),
        shielded: Number(season.latestUnix) < until,
      };
      const camps = [];
      const stacks = [];
      for (const [p, q] of provincesNear(final.p, final.q, window)) {
        const ov = overview(p, q);
        if (!ov) continue;
        const d = provinceDistance(final.p, final.q, p, q);
        if (ov.sites.some(s => s === 2)) {
          const pv = province(p, q);
          const c = pv?.camp;
          if (c && c.state === 1 && c.troops > 0) camps.push({ p, q, tile: c.tile, troops: c.troops, distance_provinces: d, distance_tiles: tileDistance(final.p, final.q, final.tile, p, q, c.tile) });
        }
        const others = ov.hosts.slice(0, 6).some((n, f) => n > 0 && f !== entry.faction);
        if (others) {
          const pv = province(p, q);
          const siteTiles = new Set(Array.from(pv?.sites ?? []));
          for (const e of pv?.entries ?? []) {
            if (!e.id || e.faction >= 6 || e.faction === entry.faction || e.unit === SCOUT || e.state !== STATE_ROSTER || siteTiles.has(e.tile)) continue;
            stacks.push({ p, q, tile: e.tile, faction: e.faction, troops: Math.floor(e.troops / 1000), distance_provinces: d, distance_tiles: tileDistance(final.p, final.q, final.tile, p, q, e.tile) });
          }
        }
      }
      const byDist = (x, y) => x.distance_provinces - y.distance_provinces || (x.distance_tiles ?? 1e9) - (y.distance_tiles ?? 1e9) || x.p - y.p || x.q - y.q || x.tile - y.tile;
      camps.sort(byDist);
      stacks.sort(byDist);
      row.camps = { in_window: camps.length, within_3_provinces: camps.filter(c => c.distance_provinces <= 3).length, nearest: camps[0] ?? null };
      row.field_stacks = { in_window: stacks.length, nearest: stacks.slice(0, MAX_STACKS_LISTED) };
    }
    rows.push(row);
  }
  const withFinal = rows.filter(r => r.final_village);
  return {
    v: 1, bell, season: String(season.season), window_provinces: window,
    ai: rows,
    summary: {
      ai: rows.length,
      with_final_village: withFinal.length,
      with_camp_in_window: withFinal.filter(r => r.camps.nearest).length,
      with_camp_within_3_provinces: withFinal.filter(r => r.camps.within_3_provinces > 0).length,
      with_field_stack_in_window: withFinal.filter(r => r.field_stacks.in_window > 0).length,
      with_can_depart_host: rows.filter(r => r.hosts.can_depart > 0).length,
    },
  };
}

/** The provinces within `d` of (p, q), on the lattice (including itself). */
export function provincesWithin(p, q, d) {
  const out = [];
  for (let dp = -d; dp <= d; dp++) for (let dq = Math.max(-d, -dp - d); dq <= Math.min(d, -dp + d); dq++) out.push([p + dp, q + dq]);
  return out;
}

// ------------------------------------------------------------------ the run: read the herald, write the files
const writeAtomic = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
};
const numbered = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).map(n => /^(\d+)\.json$/.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b) : []);

/** Fetch what `censusOf` needs for `roster.ai` from the herald (a createHerald client) and build the census of this bell. */
export async function collectCensus({ herald, roster, window = WINDOW_PROVINCES, concurrency = 6 }) {
  const s = await herald.season();
  if (!s.ok) throw new Error(`/h/season: ${s.code}`);
  const season = s.record;
  const bell = bellOf(season);
  const ais = [];
  for (const entry of roster.ai) {
    const me = await herald.me(entry.wallet);
    if (!me.ok) { ais.push({ entry, holdings: [], hosts: [], transits: [] }); continue; }
    ais.push({ entry, holdings: me.holdings, hosts: me.record.hosts ?? [], transits: me.record.transits ?? [] });
  }
  // Overviews of the rings the windows touch, then the provinces that matter (a camp, another nation's host, one of ours).
  const rMax = Number(season.rMax ?? 16);
  const rings = new Set();
  const finals = ais.map(a => a.holdings.find(h => h.state === HOLDING_FINAL)).filter(Boolean);
  for (const h of finals) for (let r = Math.max(0, ringOf(h.p, h.q) - window); r <= Math.min(rMax, ringOf(h.p, h.q) + window); r++) rings.add(r);
  const ov = new Map();
  for (const r of [...rings].sort((a, b) => a - b)) {
    const o = await herald.overview(r);
    if (o.ok) for (const rec of o.provinces) ov.set(`${rec.p},${rec.q}`, rec);
  }
  const want = new Map();
  const wantProvince = (p, q) => want.set(`${p},${q}`, [p, q]);
  for (const a of ais) {
    for (const r of a.hosts) wantProvince(r.province[0], r.province[1]);
    const f = a.holdings.find(h => h.state === HOLDING_FINAL);
    if (!f) continue;
    for (const [p, q] of provincesWithin(f.p, f.q, window)) {
      const rec = ov.get(`${p},${q}`);
      if (rec && (rec.sites.some(x => x === 2) || rec.hosts.slice(0, 6).some((n, i) => n > 0 && i !== a.entry.faction))) wantProvince(p, q);
    }
  }
  const pv = new Map();
  const queue = [...want.values()];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const r = await herald.province(item[0], item[1], 'latest');
      if (r.ok) pv.set(`${item[0]},${item[1]}`, r.province);
    }
  }));
  return censusOf({ season, ais, overview: (p, q) => ov.get(`${p},${q}`) ?? null, province: (p, q) => pv.get(`${p},${q}`) ?? null, window, bell, provincesNear: provincesWithin });
}

/** The first and the second bell at which each AI had a host that can depart, and the bells since its first final village (ready.jsonl lines in, summary out). */
export function summarizeReady(readyLines, census0) {
  const per = new Map();
  for (const l of readyLines) {
    let a = per.get(l.tag);
    if (!a) { a = { tag: l.tag, first_final_bell: null, first_can_depart_bell: null, second_can_depart_bell: null }; per.set(l.tag, a); }
    if (l.final_bell !== null && l.final_bell !== undefined && a.first_final_bell === null) a.first_final_bell = l.final_bell;
    if (l.can_depart >= 1 && a.first_can_depart_bell === null) a.first_can_depart_bell = l.bell;
    if (l.can_depart >= 2 && a.second_can_depart_bell === null) a.second_can_depart_bell = l.bell;
  }
  const rows = [...per.values()].map(a => ({
    ...a,
    bells_to_first_can_depart: a.first_final_bell !== null && a.first_can_depart_bell !== null ? a.first_can_depart_bell - a.first_final_bell : null,
    bells_to_second_can_depart: a.first_final_bell !== null && a.second_can_depart_bell !== null ? a.second_can_depart_bell - a.first_final_bell : null,
  }));
  return { v: 1, first_census: census0 ?? null, ai: rows };
}

/**
 * One poll: write ready.jsonl lines for a new bell, and the census when the schedule says so (the first bell with a final
 * village, then every 12 bells). Returns `{bell, wrote: [files]}`. `state` carries the last bell and the first census bell.
 */
export async function pollOnce({ aiDir, herald, roster, window = WINDOW_PROVINCES, every = CENSUS_EVERY, force = false, state = {} }) {
  const dir = path.join(aiDir, 'census');
  const c = await collectCensus({ herald, roster, window });
  const wrote = [];
  if (c.bell < 0) return { bell: c.bell, wrote, census: c }; // before genesis there is no bell to write for, whatever --once says
  state.first ??= numbered(dir)[0] ?? null;
  if (c.bell !== state.lastBell) {
    const lines = c.ai.map(r => JSON.stringify({ bell: c.bell, tag: r.tag, index: r.index, final: !!r.final_village, final_bell: r.final_village?.final_bell ?? null, hosts: r.hosts.total, can_depart: r.hosts.can_depart }));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'ready.jsonl'), `${lines.join('\n')}\n`);
    state.lastBell = c.bell;
    wrote.push('ready.jsonl');
  }
  const anyFinal = c.summary.with_final_village > 0;
  if (anyFinal && state.first === null) state.first = c.bell;
  const due = state.first !== null && c.bell >= state.first && (c.bell - state.first) % every === 0 && !fs.existsSync(path.join(dir, `${c.bell}.json`));
  if (force || due) {
    writeAtomic(path.join(dir, `${c.bell}.json`), `${JSON.stringify(c)}\n`);
    wrote.push(`${c.bell}.json`);
  }
  if (wrote.length) {
    const ready = fs.existsSync(path.join(dir, 'ready.jsonl')) ? fs.readFileSync(path.join(dir, 'ready.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    writeAtomic(path.join(dir, 'summary.json'), `${JSON.stringify(summarizeReady(ready, state.first))}\n`);
  }
  return { bell: c.bell, wrote, census: c };
}

// ------------------------------------------------------------------ command line
function argsOf(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) throw new Error(`unexpected argument ${k}`);
    if (k === '--once') a.once = true;
    else a[k.slice(2)] = argv[++i];
  }
  return a;
}
const loopback = url => {
  const u = new URL(url);
  const host = u.hostname === '[::1]' ? '::1' : u.hostname;
  if (u.protocol !== 'http:' || !['127.0.0.1', '::1'].includes(host)) throw new Error(`${url} is not a loopback URL`);
  return `${u.protocol}//${u.host}`;
};

if (isMain()) {
  (async () => {
    const a = argsOf(process.argv.slice(2));
    if (!a.herald || !a['ai-dir']) throw new Error('usage: census.mjs --herald URL --ai-dir DIR [--roster F] [--poll-ms N] [--window N] [--once]');
    const base = loopback(a.herald);
    const aiDir = path.resolve(a['ai-dir']);
    const rosterFile = a.roster ?? path.join(aiDir, 'pub', 'roster.json');
    const herald = createHerald({ base });
    const state = {};
    let stop = false;
    for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { stop = true; });
    while (!stop) {
      try {
        if (fs.existsSync(rosterFile)) {
          const r = await pollOnce({ aiDir, herald, roster: JSON.parse(fs.readFileSync(rosterFile, 'utf8')), window: Number(a.window ?? WINDOW_PROVINCES), force: !!a.once, state });
          if (r.wrote.length) console.log(`census: bell ${r.bell} wrote ${r.wrote.join(', ')}`);
          else if (a.once) console.log(`census: bell ${r.bell}: nothing to write (before genesis)`);
          if (a.once) break;
        } else if (a.once) throw new Error(`${rosterFile} does not exist yet`);
      } catch (e) {
        if (a.once) throw e;
        console.error(`census: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, Number(a['poll-ms'] ?? 15_000)));
    }
  })().catch(e => { console.error(`census: ${e.message}`); process.exitCode = 2; });
}
