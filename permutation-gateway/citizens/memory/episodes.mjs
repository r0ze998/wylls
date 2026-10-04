// Episodes (contract §5.2): code-templated facts derived from PUBLIC records.
//
//   episodes_from_events(batch, ctx) -> {episodes, deltas, collisions, unknown}
//
// A pure, deterministic function: no clock, no randomness, no network, no
// file access of its own (every record it reads is handed over). The same
// batch and ctx give the same bytes, which is what the audit (M11) replays.
//
// batch = {
//   events:  /h/events rows {seq, slot, sig, kind, bell, tx, decoded:{name,key,payload}} OR the events normalised by
//            watcher/feed.mjs (AC6a: {seq, sig, bell, kind: 'DEPART'|..., host_id, ...}); only DEPART, REVEAL, CLASH,
//            CAMP and BUILD are read, other rows are ignored,
//   talk:    accepted talk records of the social service (GET /f/ai/talk shape): {id, bell, wallet, tag, channel,
//            target, kind, ref, origin, inner}. Only the sender TAG, the bell, the channel, the target, the kind and
//            the ref are read. The text and the `name` field are never read.
//   council: council files of the AI's nation (faction, period, close_bell, adopted, strike_bell, open{p,q,tile,option},
//            options[{option,kind}]).
// }
// ctx = {
//   ai: {tag, wallet, faction, home:{p,q}, holdings:[{p,q,site}], observed?:[{p,q}]},
//   bellNow,                   // only episodes with created_bell < bellNow are produced (Infinity in a full replay)
//   owners: {citizenOfHost(id) -> tag|null, holdingsOf(tag) -> [{p,q,site}]},   // AC6a owners.mjs (§11.6)
//   province(p,q,bell) -> /h/province envelope | decoded account | watcher/feed.mjs shapeProvince output | null,
//   clash(p,q,bell)    -> /h/clash file | watcher/feed.mjs shapeClash output | null,
//   clashDetail?(p,q,bell) -> feed.mjs clashDetail (exact troops before per fighter); preferred over clash() when present,
//   config: {genesis_ts, redactions?: Set|[inner...], openGrievances?: [{id, against, nation?, bell}]},
//   names?: {nameOf, nationName}      // default: persona/names.mjs
// }
//
// Idempotent by design: calling it again over a larger batch gives a superset
// with the same ids; the stores dedupe by id (episodes) and by delta id
// (ledger). Only rows with bell <= ref + 14 are used for an event whose
// reference bell is `ref` (the 12-bell wait of §6.4 plus the evaluation lag),
// so a late row cannot make a replay differ from the live run.
import {
  BELL_SECS, DM_PER_DAY, DM_WINDOW_BELLS, EPISODE_VERSION, GRIEVANCE_WEIGHT, HOSTILE_EVAL_LAG, HOSTILE_WAIT,
  IMPORTANCE, NATION_MATE_RADIUS, THREAT_RADIUS, TRUST_CODE_ADOPTED_MOVER, TRUST_CODE_HOSTILE_ACT,
  TRUST_CODE_NATION_MATE, canonical, dayOf, readJson, sha256hex, u32le,
} from './config.mjs';
import { nameOf as defaultNameOf, nationName as defaultNationName, tagHex } from '../persona/names.mjs';
import { NEUTRAL, normClash, normProvince, provDist, siteOfHostId, siteOfTile, toTroops } from './herald-view.mjs';
import { safeText } from './safe.mjs';

const TPL = { en: readJson(new URL('./templates.en.json', import.meta.url)), ja: readJson(new URL('./templates.ja.json', import.meta.url)) };
const LANGS = ['en', 'ja'];
const WAIT = HOSTILE_WAIT + HOSTILE_EVAL_LAG;
const PRE_GENESIS = 0xffffffff;

const fill = (tpl, vals) => tpl.replace(/\{(\w+)\}/g, (m, k) => {
  if (!(k in vals)) throw new Error(`episode template: no value for {${k}}`);
  return String(vals[k]);
});

/** `sha256("wylls-ai-episode/v1" ‖ tag ‖ kind ‖ u32 bell ‖ u32 created_bell ‖ canonical(src))[0..8]` as hex16 (tag as its 16 hex digits, UTF-8). */
export function episodeId(tag, kind, bell, createdBell, src) {
  return sha256hex('wylls-ai-episode/v1', tagHex(tag), kind, u32le(bell), u32le(createdBell), canonical([...src].sort())).slice(0, 16);
}
const grievanceIdOf = episodeIdValue => sha256hex('wylls-ai-grievance/v1', episodeIdValue).slice(0, 16);
const deltaId = (tag, ...parts) => sha256hex('wylls-ai-delta/v1', tagHex(tag), canonical(parts)).slice(0, 16);

/**
 * An /h/events row (with the herald's server-side `decoded` field) or an event normalised by watcher/feed.mjs (AC6a)
 * -> {seq, sig, bell, name, key, payload} for the kinds this function reads, else null. `bell` is the LOG bell
 * (the chain bell that contains the record's slot: when it became public).
 */
function toRow(r) {
  if (!r) return null;
  if (r.decoded?.name) {
    return ['DEPART', 'REVEAL', 'CLASH', 'CAMP', 'BUILD'].includes(r.decoded.name)
      ? { seq: String(r.seq), sig: r.sig, bell: r.bell, name: r.decoded.name, key: r.decoded.key ?? {}, payload: r.decoded.payload ?? {} } : null;
  }
  const base = { seq: String(r.seq), sig: r.sig, bell: r.bell, name: r.kind };
  switch (r.kind) {
    case 'DEPART': return { ...base, key: { host_id: r.host_id }, payload: { origin_p: r.origin_p, origin_q: r.origin_q, depart_bell: r.depart_bell, arrive_bell: r.arrive_bell, dep_mass: r.dep_mass } };
    case 'REVEAL': return { ...base, key: { p: r.p, q: r.q, arrive: r.arrive, faction: r.faction, i: r.i }, payload: { host_id: r.host_id, tile: r.tile } };
    case 'CLASH': return { ...base, key: { p: r.p, q: r.q, bell: r.clash_bell }, payload: { engagements: r.engagements } };
    case 'CAMP': return { ...base, key: { p: r.p, q: r.q }, payload: { tile: r.tile, troops: r.troops, day: r.day } };
    case 'BUILD': return { ...base, key: { p: r.p, q: r.q, site: r.site }, payload: { item: r.item, done_at: r.done_at } };
    default: return null;
  }
}

const rowBell = r => (r.bell === PRE_GENESIS ? null : Number(r.bell));
const within = (row, ref) => { const b = rowBell(row); return b !== null && b <= ref + WAIT; };
const pqKey = (p, q) => `${p},${q}`;
const uniqSorted = a => [...new Set(a)].sort();

export function episodes_from_events(batch = {}, ctx = {}) {
  const ai = { ...ctx.ai, tag: tagHex(ctx.ai.tag) };
  const bellNow = ctx.bellNow ?? Infinity;
  const names = ctx.names ?? {};
  const nameOf = names.nameOf ?? defaultNameOf;
  const nationName = names.nationName ?? defaultNationName;
  const cfg = ctx.config ?? {};
  const redactions = new Set(cfg.redactions ?? []);
  const owners = ctx.owners ?? {};
  const holdings = ai.holdings ?? [];
  const observed = (ai.observed ?? observedFrom(holdings)).map(o => pqKey(o.p, o.q));
  const observedSet = new Set(observed);
  const home = ai.home ?? (holdings[0] ? { p: holdings[0].p, q: holdings[0].q } : { p: 0, q: 0 });

  const out = { episodes: new Map(), deltas: new Map(), collisions: [], unknown: [] };
  const unknown = (what, info) => out.unknown.push({ what, ...info });

  // ---------------------------------------------------------------- indexes
  const rows = (batch.events ?? []).map(toRow).filter(Boolean)
    .sort((a, b) => { const x = BigInt(a.seq), y = BigInt(b.seq); return x < y ? -1 : x > y ? 1 : 0; });
  const byName = n => rows.filter(r => r.name === n);
  const clashRows = new Map(); // "p,q,bell" -> row
  for (const r of byName('CLASH')) clashRows.set(`${r.key.p},${r.key.q},${r.key.bell}`, r);
  const revealsAt = new Map(); // "p,q,arrive" -> rows
  for (const r of byName('REVEAL')) { const k = `${r.key.p},${r.key.q},${r.key.arrive}`; (revealsAt.get(k) ?? revealsAt.set(k, []).get(k)).push(r); }
  const departs = new Map(); // host id -> rows
  for (const r of byName('DEPART')) { const k = String(r.key.host_id); (departs.get(k) ?? departs.set(k, []).get(k)).push(r); }
  const campRows = byName('CAMP');

  const ownerOfHost = id => { const t = owners.citizenOfHost?.(String(id)); return t ? tagHex(t) : null; };
  const isOwnVillage = (p, q, site) => holdings.some(h => h.p === p && h.q === q && h.site === site);

  // ---------------------------------------------------------------- emit
  function add(kind, { bell, created, entities, facts, src, textFor, redacted = false }) {
    if (!(created < bellNow)) return null;
    const id = episodeId(ai.tag, kind, bell, created, src);
    if (out.episodes.has(id)) return out.episodes.get(id);
    const text = {};
    for (const l of LANGS) text[l] = redacted ? '' : safeText(textFor(l), { kind: 'trusted' });
    const ep = {
      v: EPISODE_VERSION, id, bell, created_bell: created, kind,
      entities: redacted ? [] : uniqSorted(entities), text, importance: IMPORTANCE[kind],
      src: [...src].sort(), facts: redacted ? {} : facts,
    };
    if (redacted) ep.redacted = true;
    out.episodes.set(id, ep);
    return ep;
  }
  function addDelta(d) {
    if (!(d.created < bellNow)) return;
    const { created, ...rest } = d;
    if (!out.deltas.has(rest.id)) out.deltas.set(rest.id, rest);
  }

  const citizenLabel = (l, tag, faction, kindKey) => {
    const nation = nationName(faction)[l];
    if (tag) return fill(TPL[l].words[`${kindKey}_named`], { name: nameOf(tag)[l], nation });
    return fill(TPL[l].words[`${kindKey}_nation`], { nation });
  };

  // ---------------------------------------------------------------- clash facts
  function clashFacts(p, q, b) {
    const c = normClash(ctx.clashDetail?.(p, q, b) ?? ctx.clash?.(p, q, b));
    if (!c) return null;
    const before = c.before ?? normProvince(ctx.province?.(p, q, b - 1));
    const after = normProvince(ctx.province?.(p, q, b));
    if (!before) return null;
    const arrivals = new Map((c.inputs?.arrivals ?? []).map(a => [a.id, a]));
    const entry = id => before.entries.find(e => e.id === id);
    const fighters = c.fighters.map(f => {
      const arr = arrivals.get(f.id), ent = entry(f.id);
      const pre = f.before ?? (f.arrival ? arr?.troops : ent?.troops);
      const faction = f.faction ?? (f.arrival ? arr?.faction : ent?.faction);
      const owner = ownerOfHost(f.id) ?? f.owner ?? arr?.tag ?? null;
      return { id: f.id, arrival: f.arrival, engaged: f.engaged, fate: f.fate, post: f.troops, pre: pre ?? null, faction: faction ?? null, owner, tile: arr?.tile ?? ent?.tile ?? f.tile, lost: pre === undefined || pre === null ? null : toTroops(pre - f.troops) };
    });
    const villages = [];
    for (let k = 0; k < before.siteCount; k++) {
      const m = before.mirror[k];
      if (!m || m.state !== 1) continue;
      const a = after?.mirror[k];
      villages.push({ site: k, tile: before.sites[k], faction: m.faction, own: isOwnVillage(p, q, k), lost: a ? toTroops(m.garrison - a.garrison) : null });
    }
    let camp = null;
    if (before.camp.state === 1) {
      const sameCamp = after && after.camp.state === 1 && after.camp.gen === before.camp.gen;
      camp = { tile: before.camp.tile, troops: before.camp.troops, lost: after ? Math.max(0, before.camp.troops - (sameCamp ? after.camp.troops : 0)) : null };
    }
    return { p, q, b, fighters, villages, camp, before, after };
  }

  const clashRowAt = (p, q, b) => { const r = clashRows.get(`${p},${q},${b}`); return r && within(r, b) ? r : null; };
  const sameSig = (row, p, q) => campRows.filter(r => r.sig === row.sig && r.key.p === p && r.key.q === q && within(r, Number(row.key.bell)));

  // ---------------------------------------------------------------- clash-derived: hostile acts, own marches, camps
  for (const [key, row] of clashRows) {
    const [p, q, b] = key.split(',').map(Number);
    if (!within(row, b)) continue;
    const created0 = Math.max(rowBell(row), b + HOSTILE_EVAL_LAG);
    const f = clashFacts(p, q, b);
    if (!f) { unknown('clash_missing', { p, q, b }); continue; }
    const camps = sameSig(row, p, q);
    const cleared = camps.some(r => Number(r.payload.troops) === 0);
    const campSrc = camps.map(r => `event:${r.seq}`);
    const reveals = (revealsAt.get(key) ?? []).filter(r => within(r, b));
    const ownFighters = f.fighters.filter(x => x.owner === ai.tag);
    const ownEngaged = ownFighters.filter(x => x.engaged);
    const lostOf = list => list.reduce((s, x) => s + (x.lost ?? 0), 0);
    const anyUnknown = list => list.some(x => x.lost === null);

    // ---- hostile acts (§6.4): attacked_own, nation-mate trust, collisions
    for (const rv of reveals) {
      const host = String(rv.payload.host_id);
      const aFaction = rv.key.faction;
      if (aFaction === ai.faction) continue;
      const fa = f.fighters.find(x => x.id === host);
      if (!fa || !fa.engaged) continue; // the clash report must list A's army with engaged: true
      const aTag = fa.owner ?? ownerOfHost(host);
      const dep = (departs.get(host) ?? []).find(r => Number(r.payload.arrive_bell) === b && within(r, b));
      if (!dep) { unknown('depart_missing', { p, q, b, host }); continue; }
      const d = Number(dep.payload.depart_bell ?? rowBell(dep));
      const provD = normProvince(ctx.province?.(p, q, d));
      if (!provD) { unknown('province_missing', { p, q, d }); continue; }
      const tile = rv.payload.tile;
      const created = Math.max(created0, rowBell(rv), rowBell(dep));
      const k = siteOfTile(provD, tile);
      const occ = [];
      if (k >= 0 && provD.mirror[k]?.state === 1) occ.push({ kind: 'village', site: k, faction: provD.mirror[k].faction });
      for (const e of provD.entries) if (e.state === 1 && e.tile === tile) occ.push({ kind: 'army', id: e.id, faction: e.faction });
      const hostile = occ.filter(o => o.faction !== aFaction && o.faction !== NEUTRAL);
      const ownOcc = hostile.filter(o => (o.kind === 'village' ? isOwnVillage(p, q, o.site) : ownerOfHost(o.id) === ai.tag));
      const src = [`event:${row.seq}`, `event:${rv.seq}`, `event:${dep.seq}`];
      if (ownOcc.length) {
        const villageHit = ownOcc.find(o => o.kind === 'village');
        const ownVillageLost = lostOf(f.villages.filter(v => v.own));
        const ownLost = lostOf(ownFighters) + ownVillageLost;
        if (anyUnknown(ownFighters) || f.villages.some(v => v.own && v.lost === null)) { unknown('loss_unknown', { p, q, b }); continue; }
        if (ownLost > 0) {
          const ep = add('attacked_own', {
            bell: b, created, src,
            entities: [aTag, `nation:${aFaction}`, `pq:${p},${q}`].filter(Boolean),
            facts: { actor: aTag, nation: aFaction, p, q, lost: ownLost, target: villageHit ? 'village' : 'army' },
            textFor: l => fill(TPL[l].kinds.attacked_own[villageHit ? 'village' : 'army'], { b, actor: citizenLabel(l, aTag, aFaction, 'actor'), p, q, x: ownLost }),
          });
          if (ep) {
            addDelta({ id: deltaId(ai.tag, 'trust', 'hostile', ep.id), kind: 'trust', who: aTag ?? `nation:${aFaction}`, part: 'code', amount: TRUST_CODE_HOSTILE_ACT, bell: created, reason: 'hostile_act', episode: ep.id, created });
            addDelta({ id: grievanceIdOf(ep.id), kind: 'grievance', against: aTag ?? `nation:${aFaction}`, nation: aFaction, event: ep.id, bell: b, weight: GRIEVANCE_WEIGHT, episode: ep.id, created });
          }
        }
      } else if (ownEngaged.length && created < bellNow) {
        // A met an own army (or village) that was not there when A departed: a collision. No trust effect, no grievance, no episode.
        out.collisions.push({ p, q, bell: b, actor: aTag, nation: aFaction, host });
      }
      // nation-mates of the AI (not the AI itself) with a village within 2 provinces of the AI's home: -5 to the actor
      for (const o of hostile) {
        if (o.faction !== ai.faction) continue;
        if (ownOcc.includes(o)) continue;
        let near = false, lost = null;
        if (o.kind === 'village') { near = provDist(p, q, home.p, home.q) <= NATION_MATE_RADIUS; lost = f.villages.find(v => v.site === o.site)?.lost ?? null; }
        else {
          const btag = ownerOfHost(o.id);
          near = !!btag && (owners.holdingsOf?.(btag) ?? []).some(h => provDist(h.p, h.q, home.p, home.q) <= NATION_MATE_RADIUS);
          lost = f.fighters.find(x => x.id === o.id)?.lost ?? null;
        }
        if (near && lost !== null && lost > 0) {
          addDelta({ id: deltaId(ai.tag, 'trust', 'nation_mate', row.seq, rv.seq, o.kind, o.site ?? o.id), kind: 'trust', who: aTag ?? `nation:${aFaction}`, part: 'code', amount: TRUST_CODE_NATION_MATE, bell: created, reason: 'nation_mate', episode: null, created });
        }
      }
    }

    // ---- an own march fought (clash_own_win / clash_own_loss), a camp cleared
    const ownArrivals = ownEngaged.filter(x => x.arrival);
    const rowSrc = [`event:${row.seq}`, ...campSrc];
    const createdC = Math.max(rowBell(row), ...camps.map(rowBell));
    if (ownArrivals.length) {
      if (anyUnknown(ownArrivals)) unknown('loss_unknown', { p, q, b });
      else {
        const enemyFighters = f.fighters.filter(x => x.engaged && x.owner !== ai.tag && x.faction !== ai.faction && x.faction !== NEUTRAL);
        const enemyVillages = f.villages.filter(v => !v.own && v.faction !== ai.faction && v.lost !== null && v.lost > 0);
        const campLost = f.camp ? (cleared ? f.camp.troops : f.camp.lost ?? 0) : 0;
        const x = lostOf(ownArrivals);
        const y = lostOf(enemyFighters) + lostOf(enemyVillages) + campLost;
        const campInvolved = !!f.camp && (cleared || campLost > 0 || ownArrivals.some(a => a.tile === f.camp.tile));
        if (y > 0 || x > 0) {
          const big = [...enemyFighters].sort((a, c) => (c.pre ?? 0) - (a.pre ?? 0) || (a.id < c.id ? -1 : 1))[0];
          const targetTag = big?.owner ?? null, targetFaction = big?.faction ?? enemyVillages[0]?.faction ?? null;
          const targetFor = l => (campInvolved ? TPL[l].words.camp : (targetFaction === null ? TPL[l].words.camp : citizenLabel(l, targetTag, targetFaction, 'target')));
          const kind = y > x ? 'clash_own_win' : 'clash_own_loss';
          add(kind, {
            bell: b, created: createdC, src: [...rowSrc, ...ownArrivals.map(a => `host:${a.id}`)],
            entities: [`pq:${p},${q}`, ...(campInvolved ? [] : [targetTag, targetFaction === null ? null : `nation:${targetFaction}`])].filter(Boolean),
            facts: { p, q, lost_own: x, lost_enemy: y, camp: campInvolved, nation: campInvolved ? null : targetFaction },
            textFor: l => fill(TPL[l].kinds[kind], { b, p, q, x, y, target: targetFor(l) }),
          });
        }
      }
    }
    if (cleared && ownEngaged.length) {
      add('camp_cleared_own', { bell: b, created: createdC, src: rowSrc, entities: [`pq:${p},${q}`], facts: { p, q }, textFor: l => fill(TPL[l].kinds.camp_cleared_own, { b, p, q }) });
    }
    if (cleared && !ownEngaged.length && observedSet.has(pqKey(p, q))) {
      const cl = f.fighters.filter(x => x.engaged && x.faction !== null && x.faction !== NEUTRAL && x.faction !== ai.faction)
        .sort((a, c) => (c.pre ?? 0) - (a.pre ?? 0) || (a.id < c.id ? -1 : 1))[0];
      if (cl) {
        add('camp_taken_by', {
          bell: b, created: createdC, src: rowSrc, entities: [`nation:${cl.faction}`, `pq:${p},${q}`],
          facts: { p, q, nation: cl.faction }, textFor: l => fill(TPL[l].kinds.camp_taken_by, { b, nation: nationName(cl.faction)[l], p, q }),
        });
      }
    }
  }

  // ---------------------------------------------------------------- threat (DEPART)
  for (const r of byName('DEPART')) {
    const bell = rowBell(r);
    if (bell === null) continue;
    const { origin_p: op, origin_q: oq } = r.payload;
    if (provDist(op, oq, home.p, home.q) > THREAT_RADIUS) continue;
    const host = String(r.key.host_id);
    if (ownerOfHost(host) === ai.tag) continue;
    const d = Number(r.payload.depart_bell ?? bell);
    const prov = normProvince(ctx.province?.(op, oq, d)) ?? normProvince(ctx.province?.(op, oq, d - 1));
    let faction = owners.factionOfHost?.(host) ?? prov?.entries.find(e => e.id === host)?.faction ?? null;
    if (faction === null && prov) { const m = prov.mirror[siteOfHostId(host)]; if (m?.state === 1) faction = m.faction; }
    if (faction === null) { unknown('depart_faction', { host }); continue; }
    if (faction === ai.faction) continue;
    const m = toTroops(Number(r.payload.dep_mass));
    const a = Number(r.payload.arrive_bell);
    add('threat', {
      bell: d, created: bell, src: [`event:${r.seq}`], entities: [`nation:${faction}`, `pq:${op},${oq}`],
      facts: { p: op, q: oq, nation: faction, mass: m, arrive_bell: a },
      textFor: l => fill(TPL[l].kinds.threat, { b: d, nation: nationName(faction)[l], m, p: op, q: oq, a }),
    });
  }

  // ---------------------------------------------------------------- build_done (BUILD)
  const genesis = cfg.genesis_ts;
  if (Number.isFinite(genesis)) {
    for (const r of byName('BUILD')) {
      const { p, q, site } = r.key;
      if (!isOwnVillage(p, q, site)) continue;
      const doneBell = Math.floor((Number(r.payload.done_at) - genesis) / BELL_SECS);
      const created = Math.max(doneBell, rowBell(r) ?? doneBell);
      const item = Number(r.payload.item);
      add('build_done', {
        bell: doneBell, created, src: [`event:${r.seq}`], entities: [`pq:${p},${q}`], facts: { p, q, site, item },
        textFor: l => fill(TPL[l].kinds.build_done, { b: doneBell, item: TPL[l].items[item] ?? TPL[l].items[0] }),
      });
    }
  }

  // ---------------------------------------------------------------- answered grievances (own REVEAL on the wrongdoer)
  for (const g of cfg.openGrievances ?? []) {
    const wrongNation = g.nation ?? (String(g.against).startsWith('nation:') ? Number(String(g.against).slice(7)) : null);
    const wrongTag = String(g.against).startsWith('nation:') ? null : g.against;
    for (const rv of byName('REVEAL')) {
      const host = String(rv.payload.host_id);
      const b = Number(rv.key.arrive);
      if (b < g.bell || !within(rv, b) || ownerOfHost(host) !== ai.tag) continue;
      const dep = (departs.get(host) ?? []).find(r => Number(r.payload.arrive_bell) === b && within(r, b));
      if (!dep) continue;
      const d = Number(dep.payload.depart_bell ?? rowBell(dep));
      const provD = normProvince(ctx.province?.(rv.key.p, rv.key.q, d));
      if (!provD) continue;
      const k = siteOfTile(provD, rv.payload.tile);
      let hit = false;
      if (k >= 0 && provD.mirror[k]?.state === 1) {
        const m = provD.mirror[k];
        hit = wrongTag ? (owners.holdingsOf?.(wrongTag) ?? []).some(h => h.p === rv.key.p && h.q === rv.key.q && h.site === k) : m.faction === wrongNation;
      }
      for (const e of provD.entries) {
        if (hit || e.state !== 1 || e.tile !== rv.payload.tile) continue;
        hit = wrongTag ? ownerOfHost(e.id) === wrongTag : e.faction === wrongNation;
      }
      if (hit) addDelta({ id: deltaId(ai.tag, 'answered', g.id, rv.seq), kind: 'answered', grievance: g.id, bell: b, created: Math.max(rowBell(rv), rowBell(dep)) });
    }
  }

  // ---------------------------------------------------------------- talk: dm, motion
  const talk = [...(batch.talk ?? [])].filter(t => t && t.bell !== undefined)
    .sort((a, b) => a.bell - b.bell || String(a.id ?? a.inner).localeCompare(String(b.id ?? b.inner)));
  const channelOf = c => (c === 0 || c === 'world' ? 'world' : c === 1 || c === 'nation' ? 'nation' : c === 3 || c === 'direct' ? 'direct' : String(c));
  const senderOf = t => (t.tag ? tagHex(t.tag) : null);
  const dmSeen = new Set(), dmDay = new Map();
  const councils = batch.council ?? [];
  for (const t of talk) {
    const sender = senderOf(t);
    const key = `talk:${t.inner ?? t.id}`;
    const redacted = redactions.has(t.inner);
    if (!sender) continue;
    const ch = channelOf(t.channel);
    if (ch === 'direct' && t.target === ai.wallet && sender !== ai.tag && Number(t.kind ?? 0) === 0) {
      const wk = `${sender}|${Math.floor(t.bell / DM_WINDOW_BELLS)}`;
      if (dmSeen.has(wk)) continue;
      const day = dayOf(t.bell);
      if ((dmDay.get(day) ?? 0) >= DM_PER_DAY) continue;
      dmSeen.add(wk);
      dmDay.set(day, (dmDay.get(day) ?? 0) + 1);
      add('dm', { bell: t.bell, created: t.bell, src: [key], entities: [sender], facts: { sender }, redacted, textFor: l => fill(TPL[l].kinds.dm, { b: t.bell, name: nameOf(sender)[l] }) });
    } else if (ch === 'nation' && Number(t.target) === ai.faction && Number(t.kind) === 1) {
      const ref = Number(t.ref);
      const period = Math.floor(ref / 256), option = ref % 256;
      const opts = councils.find(c => c.faction === ai.faction && Number(c.period) === period && Array.isArray(c.options))?.options ?? [];
      const kindWord = opts.find(o => Number(o.option) === option)?.kind ?? 'unknown';
      add('motion', {
        bell: t.bell, created: t.bell, src: [key], entities: [sender, `nation:${ai.faction}`], facts: { sender, option, period }, redacted,
        textFor: l => fill(TPL[l].kinds.motion, { b: t.bell, name: nameOf(sender)[l], k: option, kind: TPL[l].words.option_kind[kindWord] ?? TPL[l].words.option_kind.unknown }),
      });
    }
  }

  // ---------------------------------------------------------------- council: council_result (close) and strike (S + 2)
  for (const c of councils) {
    if (Number(c.faction) !== ai.faction) continue;
    const period = Number(c.period);
    const closeBell = Number(c.close_bell ?? c.bell);
    if (Number.isFinite(closeBell) && c.adopted !== undefined) {
      const adopted = c.adopted === true || (!!c.adopted && c.adopted !== false);
      add('council_result', {
        bell: closeBell, created: closeBell, src: [`council:${c.faction}:${period}:close`], entities: [`nation:${ai.faction}`], facts: { period, adopted },
        textFor: l => fill(TPL[l].kinds.council_result[adopted ? 'adopted' : 'none'], { b: closeBell }),
      });
    }
    const open = c.open;
    const S = Number(c.strike_bell ?? c.S);
    if (!open || !Number.isFinite(S)) continue;
    const openBell = Math.max(S + 2, Number(c.open_bell ?? 0));
    // +2 toward the citizens who moved the adopted option (a ledger delta, not an episode text)
    for (const t of talk) {
      const sender = senderOf(t);
      if (!sender || sender === ai.tag || channelOf(t.channel) !== 'nation' || Number(t.target) !== ai.faction || Number(t.kind) !== 1) continue;
      const ref = Number(t.ref);
      if (Math.floor(ref / 256) === period && ref % 256 === Number(open.option)) {
        addDelta({ id: deltaId(ai.tag, 'trust', 'adopted_mover', c.faction, period, sender), kind: 'trust', who: sender, part: 'code', amount: TRUST_CODE_ADOPTED_MOVER, bell: openBell, reason: 'adopted_mover', episode: null, created: openBell });
      }
    }
    const p = Number(open.p), q = Number(open.q);
    const csRow = clashRowAt(p, q, S);
    let x = 0, y = 0, tookPart = false, created;
    const src = [`council:${c.faction}:${period}:open`];
    if (csRow) {
      const f = clashFacts(p, q, S);
      if (!f) { unknown('clash_missing', { p, q, b: S }); continue; }
      const mine = f.fighters.filter(z => z.engaged && z.faction === ai.faction);
      const theirs = f.fighters.filter(z => z.engaged && z.faction !== ai.faction && z.faction !== NEUTRAL);
      if ([...mine, ...theirs].some(z => z.lost === null)) { unknown('loss_unknown', { p, q, b: S }); continue; }
      const camps = sameSig(csRow, p, q);
      const campLost = f.camp ? (camps.some(r => Number(r.payload.troops) === 0) ? f.camp.troops : f.camp.lost ?? 0) : 0;
      x = lostOf2(mine) + lostOf2(f.villages.filter(v => v.faction === ai.faction && v.lost !== null));
      y = lostOf2(theirs) + lostOf2(f.villages.filter(v => v.faction !== ai.faction && v.faction !== NEUTRAL && v.lost !== null)) + campLost;
      tookPart = f.fighters.some(z => z.owner === ai.tag);
      created = Math.max(openBell, rowBell(csRow), ...camps.map(rowBell));
      src.push(`event:${csRow.seq}`);
    } else {
      if (!(bellNow > S + WAIT)) continue; // a Strike Order with no clash is remembered at S + 14 (the row could still arrive)
      created = S + WAIT;
    }
    add('strike', {
      bell: S, created, src, entities: [`nation:${ai.faction}`, `pq:${p},${q}`], facts: { p, q, lost_own: x, lost_enemy: y, took_part: tookPart, period },
      textFor: l => fill(TPL[l].kinds.strike, { b: S, p, q, x, y, took_part: TPL[l].words[tookPart ? 'took_part' : 'did_not_take_part'] }),
    });
  }

  const episodes = [...out.episodes.values()].sort(compareEpisodes);
  const deltas = [...out.deltas.values()].sort((a, b) => a.bell - b.bell || (a.id < b.id ? -1 : 1));
  return { episodes, deltas, collisions: out.collisions, unknown: out.unknown };
}

const lostOf2 = list => list.reduce((s, x) => s + (x.lost ?? 0), 0);

/** The default observed set (§4.2): the provinces of the AI's holdings and their six neighbours. */
export function observedFrom(holdings) {
  const dirs = [[0, 0], [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const seen = new Map();
  for (const h of holdings) for (const [dp, dq] of dirs) seen.set(pqKey(h.p + dp, h.q + dq), { p: h.p + dp, q: h.q + dq });
  return [...seen.values()];
}

/** The canonical order of an episode list: created_bell, bell, id. */
export function compareEpisodes(a, b) {
  return a.created_bell - b.created_bell || a.bell - b.bell || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
