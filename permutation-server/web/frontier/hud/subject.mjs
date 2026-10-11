// Whose hand it is (UX design 14.2): which of the viewer's own things the
// selection is, from the store alone, and what each of the viewer's hosts
// may do now with the rule's reason when it may not. A leaf module: the
// drawer's one function (hud/drawer.mjs) reads `subjectOf` to stay closed
// while the action bar has the selection, and the hand (hud/hand.mjs)
// builds its bar from the rest.
import { hostsIn, SCOUT, actionBlocks, exploreTargets } from '../fland.mjs';
import { DEPART_STAMINA, freeTransitSlot } from '../fmarch.mjs';
import { whyText } from './orderparts.mjs';

const int = Number.isInteger;
const nowOf = FS => FS.chain?.now?.() ?? 0;
const bellOf = FS => FS.nowBell ?? 0;

/**
 * Every host of the viewer that stands (or is forming up) on tile (p, q, idx): `[{id, unit, troops, stamina, state,
 * readyBell, pending, inTransit, p, q, tile, holding, holdingIndex, province, home}]`, the ones that can march first.
 */
export function ownHostsAt(FS, p, q, idx) {
  const prov = FS.provinces?.get?.(`${p},${q}`)?.province ?? null;
  if (!prov?.entries || !int(idx)) return [];
  const out = [];
  (FS.holdings ?? []).forEach((holding, holdingIndex) => {
    let rows = [];
    try { rows = hostsIn(prov, holding, bellOf(FS)); } catch { rows = []; }
    for (const r of rows) if (r.tile === idx && (r.state === 1 || r.state === 2)) out.push({ ...r, id: String(r.id), p, q, holding, holdingIndex, province: prov, home: holding.p === p && holding.q === q && holding.tile === idx });
  });
  return out.sort((a, b) => Number(marchCheck(FS, b).ok) - Number(marchCheck(FS, a).ok) || b.troops - a.troops);
}

/** Every standing host of the active village wherever the page holds its province, those that can act this turn first. */
export function ownHosts(FS) {
  const h = (FS.holdings ?? [])[int(FS.activeHolding) && FS.activeHolding >= 0 && FS.activeHolding < (FS.holdings ?? []).length ? FS.activeHolding : 0] ?? null;
  if (!h) return [];
  const out = [];
  for (const env of FS.provinces?.values?.() ?? []) {
    let rows = [];
    try { rows = hostsIn(env.province, h, bellOf(FS)); } catch { rows = []; }
    for (const r of rows) if (r.state === 1 || r.state === 2) out.push({ ...r, id: String(r.id), p: env.province.p, q: env.province.q, holding: h, holdingIndex: (FS.holdings ?? []).indexOf(h), province: env.province, home: h.p === env.province.p && h.q === env.province.q && h.tile === r.tile });
  }
  const rank = r => (canAct(FS, r) ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || b.troops - a.troops || (a.id < b.id ? -1 : 1));
}

/**
 * Whether a host may march now, and why not in the rule's numbers: `{ok, code, text}`. The program's checks
 * (fland.mjs actionBlocks), the stamina a march takes (74 of 120, one point back a turn: the turn it is back is
 * said), the rest after a fight, and the village's four marches.
 */
export function marchCheck(FS, r) {
  const say = (code, x) => ({ ok: false, code, text: whyText(code, x) });
  if (!r) return say('HostBusy');
  if (r.state === 2) return say('Forming');
  if (r.inTransit) return say('HostInTransit');
  const blocks = actionBlocks('Depart', { holding: r.holding, province: r.province, nowBell: bellOf(FS), now: nowOf(FS), host: r });
  if (blocks.length) return say(blocks[0]);
  const bell = bellOf(FS);
  const back = bell + Math.max(0, DEPART_STAMINA - r.stamina);
  if (r.stamina < DEPART_STAMINA) return say('Stamina', { stamina: r.stamina, need: DEPART_STAMINA, turn: Math.max(back, r.readyBell ?? 0) });
  if (bell < r.readyBell) return say('Resting', { turn: r.readyBell });
  if (freeTransitSlot(r.holding) === null) return say('MarchSlots');
  return { ok: true, code: null, text: '' };
}

/** Whether a Scout host may explore now, its targets, and why not. */
export function exploreCheck(FS, r) {
  const say = (code, x) => ({ ok: false, code, text: whyText(code, x), targets: [] });
  if (!r || r.unit !== SCOUT) return say('NotScout');
  if (r.state === 2) return say('Forming');
  if (r.inTransit) return say('HostInTransit');
  const blocks = actionBlocks('Explore', { holding: r.holding, province: r.province, nowBell: bellOf(FS), now: nowOf(FS), host: r });
  if (blocks.length) return say(blocks[0]);
  let targets = [];
  try { targets = exploreTargets(r.province, r); } catch { targets = []; }
  if (!targets.length) return say('NoTargets');
  return { ok: true, code: null, text: '', targets };
}

/** Whether a host may be dissolved now. */
export function dissolveCheck(FS, r) {
  const say = code => ({ ok: false, code, text: whyText(code) });
  if (!r) return say('HostBusy');
  if (r.state === 2) return say('Forming');
  if (r.inTransit) return say('HostInTransit');
  const blocks = actionBlocks('Dissolve', { holding: r.holding, province: r.province, nowBell: bellOf(FS), now: nowOf(FS), host: r });
  return blocks.length ? say(blocks[0]) : { ok: true, code: null, text: '' };
}

/** A host that can be given an order this turn (a march, or for a Scout an exploration). */
export const canAct = (FS, r) => marchCheck(FS, r).ok || (r.unit === SCOUT && exploreCheck(FS, r).ok);

/**
 * What the hand holds (UX design 14.2), from the store alone: null, or
 *   {kind: 'village', holding, holdingIndex, hosts: [the viewer's hosts standing on the village's tile]}
 *   {kind: 'host', host, hosts: [every own host on that tile], holding, holdingIndex}
 * The selection is a tile (`FS.selected` with `idx`). On the village's tile the village has the hand until a host
 * standing there is chosen (`FS.hand.host`: its chip in the bar, its figures on the board, 次の軍勢); on any other
 * tile the first host that can march has it.
 */
export function subjectOf(FS) {
  if ((FS.mode ?? 'play') !== 'play') return null;
  const s = FS.selected;
  if (!s || !int(s.idx) || !int(s.p) || !int(s.q)) return null;
  const holdingIndex = (FS.holdings ?? []).findIndex(h => h.p === s.p && h.q === s.q && h.tile === s.idx);
  const hosts = ownHostsAt(FS, s.p, s.q, s.idx);
  const want = FS.hand?.host !== undefined && FS.hand?.host !== null ? hosts.find(r => r.id === String(FS.hand.host)) : null;
  if (want) return { kind: 'host', host: want, hosts, holding: want.holding, holdingIndex: want.holdingIndex };
  if (holdingIndex >= 0) return { kind: 'village', holding: FS.holdings[holdingIndex], holdingIndex, hosts };
  if (hosts.length) return { kind: 'host', host: hosts[0], hosts, holding: hosts[0].holding, holdingIndex: hosts[0].holdingIndex };
  return null;
}

/** The pop that stands open for the subject (a card of the other kind of subject is not carried over). */
export function popOf(FS, sub = subjectOf(FS)) {
  const pop = FS.hand?.pop ?? null;
  if (!sub || !pop) return null;
  // (the card 旗 belongs to the prototype rule "banners": it exists only while the sample world serves it)
  // (the card 砦へ進軍 belongs to a conquest season, program version 3: hud/keephand.mjs)
  const mine = sub.kind === 'village' ? ['build', 'train', 'muster', 'promote'] : ['explore', 'dissolve', 'march', ...(FS.proto ? ['banner'] : []), ...(Number(FS.season?.programVersion ?? 0) >= 3 && !FS.sample ? ['keeps'] : [])];
  return mine.includes(pop) ? pop : null;
}
