// Display state is derived from validated shared records; commands still
// recompute accounts from raw Province/Holding bytes before signing.
import { L } from '../lang.mjs';
import { ringOf, hexDistance } from './fgeo.mjs';
import { projectedHolding } from './fland.mjs';

export const conquestEnabled = season => Number(season?.layoutVersion) === 2 && Number(season?.programVersion) >= 3;

export function territoryStandings(data) {
  if (data?.scoring !== 'territory-time' || data?.scoreUnit !== 'province-bell' || !Number.isInteger(data.bell) || data.bell < 0 || data.factions?.length !== 6) return null;
  const seen = new Set();
  const rows = [];
  for (const r of data.factions) {
    if (!Number.isInteger(r.faction) || r.faction < 0 || r.faction > 5 || seen.has(r.faction) || !Number.isSafeInteger(r.provinces) || r.provinces < 0) return null;
    if (!['string', 'number', 'bigint'].includes(typeof r.territoryBells) || (typeof r.territoryBells === 'string' && !/^\d+$/.test(r.territoryBells)) || (typeof r.territoryBells === 'number' && !Number.isSafeInteger(r.territoryBells))) return null;
    let score;
    try { score = BigInt(r.territoryBells); } catch { return null; }
    if (score < 0n || score > 0xffffffffffffffffn) return null;
    seen.add(r.faction); rows.push({ faction: r.faction, provinces: r.provinces, provinceBells: score.toString() });
  }
  return { metric: 'province-bells', bell: data.bell, rows };
}

/** The keep events the records list: a contest's start, its end without a capture, a capture. */
export const KEEP_EVENT_KINDS = Object.freeze(['keep_contest', 'keep_broken', 'keep_taken']);

/** Add a conquest day's keep events to the known ones: no duplicates, oldest first (bell, then seq). */
export function mergeKeepEvents(known, events) {
  const out = new Map((known ?? []).map(e => [`${e.seq}:${e.kind}`, e]));
  for (const e of events ?? []) {
    if (!KEEP_EVENT_KINDS.includes(e.kind) || !Number.isInteger(e.p) || !Number.isInteger(e.q)) continue;
    out.set(`${e.seq}:${e.kind}`, { seq: String(e.seq), kind: e.kind, bell: e.bell, p: e.p, q: e.q, from: e.from, to: e.to, troops: Number.isFinite(e.detail?.troops) ? e.detail.troops : null });
  }
  return [...out.values()].sort((a, b) => a.bell - b.bell || (BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0));
}

/** The viewer's side of a keep event: 'gain' | 'loss' | 'attack' | 'defend' | null. */
export function keepEventSide(e, faction) {
  if (!Number.isInteger(faction) || faction < 0 || faction > 5) return null;
  // keep_contest: from the holder, to the contender; keep_broken: from the contender, to the holder; keep_taken: from the old holder, to the new
  const [holder, other] = e.kind === 'keep_broken' ? [e.to, e.from] : [e.from, e.to];
  if (e.kind === 'keep_taken') return other === faction ? 'gain' : holder === faction ? 'loss' : null;
  return other === faction ? 'attack' : holder === faction ? 'defend' : null;
}

export function keepFromProvince(p) {
  const k = p?.keep;
  if (Number(p?.layoutVersion) !== 2 || !k || k.tile === 255 || k.tile >= 61 || k.holder > 5) return null;
  return { p: p.p, q: p.q, tile: k.tile, holder: k.holder, troops: k.troops,
    heartland: !!(k.flags & 1), consolidatedUntil: k.consolidatedUntilBell, contender: k.contender,
    progress: k.progress, requiredBells: k.required, asOfBell: Math.max(0, p.resolvedNext - 1) };
}

export function applyControl(overviews, control) {
  const byKey = new Map((control?.provinces ?? []).map(p => [`${p.p},${p.q}`, p]));
  for (const o of overviews.values()) for (const p of o.provinces) {
    const c = byKey.get(`${p.p},${p.q}`);
    if (c) Object.assign(p, { control: c.control, contender: c.contender, contestProgress: c.progress, contestRequired: c.required, heartland: c.heartland });
  }
}

function storeAt(store, now) {
  if (!store) return 0;
  const raw = BigInt(store.value) + (BigInt(store.rate) * BigInt(Math.max(0, Math.floor(now) - Number(store.t0))) + BigInt(store.frac ?? 0)) / 3600n;
  return Number(raw < 0n ? 0n : raw > BigInt(store.cap) ? BigInt(store.cap) : raw);
}

/** Match Citizen::lowest_free_slot, including slots reserved by a capture. */
export function nextOutpostSlot(citizen, holdings = []) {
  for (const slot of [2,3]) {
    const ref = citizen?.holding?.[slot-1];
    const occupied = ref ? ref.gen !== 255 : holdings.some(h => h.order === slot);
    if (!occupied && (citizen?.slots & 3) !== slot && !(citizen?.slots & (1 << slot))) return slot;
  }
  return null;
}

export const effectiveTier = (h, now) => Math.min(3, h.tier + (h.queue ?? []).filter(q => q.kind === 3 && Number(q.doneAt) > 0 && Number(q.doneAt) <= now).length);

/** Same mirror-generation check as the program's capture_locked. */
export function capturePending(fs, h) {
  const m = fs.provinces?.get(`${h.p},${h.q}`)?.province?.siteMirror?.[h.site];
  return m?.state === 1 && m.gen === ((h.gen + 1) & 255);
}

/** Filing uses full strength weights, not the rounded display snapshots. */
export function provinceWeights(pv, faction, bell) {
  let mine = 0, total = 0;
  for (const m of pv.siteMirror.slice(0,pv.siteCount)) {
    if (![1,5].includes(m.state)) continue;
    const tier = m.state === 1 && m.tierNext !== undefined && m.tierNext !== 255 && m.tierNextBell <= bell ? m.tierNext : m.tier;
    const weight = Math.floor([100,130,160,200][tier] * Math.min(15000, 10000 + Math.floor(m.garrison/200)) * (m.state === 5 || m.order <= 1 ? 4 : m.order === 2 ? 2 : 1) / 4);
    total += weight; if (m.state === 1 && m.faction === faction) mine += weight;
  }
  return { mine, total };
}

// Mirrors the published OutpostCheck for immediate, useful reasons; the
// program re-checks race-sensitive occupancy/capture locks and land gates.
export function outpostOffer(fs, target) {
  const hs = fs.holdings ?? [], home = hs.find(h => h.order === 1), pv = fs.provinces.get(`${target.p},${target.q}`)?.province;
  const n = hs.length, season = fs.season, params = season.conquestParams ?? season, citizen = fs.citizen;
  const cost = [800,800,400,0,0,200,0,0].map(x => Math.floor(x * (2 + Math.max(0,n-1)**2) / 2) * 1000);
  const base = { target, cost: cost.map(x => x/1000), eligible: false, pending: false };
  const no = reason => ({ ...base, reason });
  if (!citizen || !home) return no(L`最初の村を築いてください。`);
  if (citizen.slots & 3) return { ...no(L`入植の結果を待っています。`), pending: true };
  // A pending capture can raise the filing price when it settles. The
  // instruction has no maximum-cost field, so wait before quoting again.
  if (citizen.slots & 12) return { ...no(L`占領の処理が進んでいます。結果が確定してから前哨を申請してください。`), code:'CapturePending' };
  const slot = nextOutpostSlot(citizen, hs), now = fs.chain?.now?.() ?? 0;
  if (n >= 3) return no(L`村は3つまで所有できます。`);
  if (slot === null) return no(L`入植できる枠は占領の処理で予約されています。`);
  if (home.state !== 2 || effectiveTier(home, now) < Number(params.outpostTierMin ?? 1)) return no(L`最初の村を町に昇格させてください。`);
  if (slot === 3 && !hs.some(h => h.order === 2 && h.state === 2)) return no(L`2つ目の村の確定を待ってください。`);
  if ([home, ...(slot === 3 ? hs.filter(h => h.order === 2) : [])].some(h => capturePending(fs,h))) return no(L`村の占領結果が確定するまで入植できません。`);
  if (!pv) return no(L`この州の情報を読み込み中です。`);
  if (!Number.isInteger(target.site) || target.site < 0 || target.site >= pv.siteCount || ![0,3].includes(pv.siteMirror[target.site]?.state)) return no(L`空いている入植区画を選んでください。`);
  const rec = pv.conquest?.[target.site];
  if (rec && Object.values(rec).some(v => (typeof v === 'number' || typeof v === 'bigint') && v != 0)) return no(L`この区画の争奪が確定するまで入植できません。`);
  if (ringOf(target.p,target.q) <= Number(params.heartlandMaxRing ?? 3)) return no(L`保護された本国の外に入植してください。`);
  if (hexDistance(target.p,target.q,home.p,home.q) > Number(params.outpostRange ?? 3)) return no(L`最初の村から3州以内を選んでください。`);
  if (fs.nowBell >= season.endBell - Number(params.outpostCloseBells ?? 24)) return no(L`今シーズンの入植受付は終了しました。`);
  const { mine, total } = provinceWeights(pv, citizen.faction, fs.nowBell);
  if (total && mine*10000 >= total*Number(params.outpostShareBps ?? 5000)) return no(L`自国の村が優勢な州には入植できません。`);
  const open = Number(fs.record?.openSites), occupied = Number(fs.record?.occupiedSites);
  if (open > 0 && Number.isFinite(occupied) && (open-occupied)*5 < open) return no(L`世界の空き区画が少ないため、入植は一時停止中です。`);
  const projectedHome = projectedHolding(home,now);
  if (cost.some((x,i) => x > storeAt(projectedHome.stores[i],now))) return no(L`最初の村に入植用の資源を蓄えてください。`);
  return { ...base, eligible: true };
}
