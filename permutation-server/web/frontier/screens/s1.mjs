// The redesign's stage 1 (S1; docs/frontier/stage1*) on the play screens:
//
//   on a chosen tile   what stands there (a storehouse, a tower, a palisade,
//                      a fort) and what can be built there, paid from the
//                      village in hand; a raid the viewer's host has won on
//                      a caravan here, to take or to burn
//   in the village     the viewer's storehouses, caravans on the road and
//                      structures; sending a caravan to another of its own
//                      places; manning its fort in the village's province;
//                      the nation's stances, its open proposals (a vote on
//                      each) and a proposal of a stance
//
// The models are pure (tested in web-frontier-s1.test.mjs); the program
// checks every rule again (contract: the page only offers). Every action is a
// `data-act` or `data-form` of controller.mjs.
import { html, raw } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { icon } from '../hud/icons.mjs';
import { RESOURCES, RESOURCE_ORDER, errorText, factionName } from '../fi18n.mjs';
import { storesAt } from '../fland.mjs';
import { settled, shortOf } from '../hud/rulebook.mjs';
import { activeHolding } from '../fstate.mjs';
import { keepFromProvince } from '../fconquest.mjs';
import { hostParts } from '../faddr.mjs';
import { ownTag } from '../people/ui.mjs';
import { MAX_VAULTS, VAULT_COST } from '../fcaravan.mjs';
import { S1_WORDS, caravanArriveBell } from '../map/s1marks.mjs';
import { cardHead, chip, fold, label } from './parts.mjs';
import { swatch } from './shell.mjs';

// ------------------------------------------------------------------ the rules the page offers by (structure.rs, caravan.rs, nation.rs)
/** structure::KIND_*. */
export const KIND = Object.freeze({ tower: 1, palisade: 2, fort: 3 });
export const KIND_NAME = Object.freeze({ 1: 'tower', 2: 'palisade', 3: 'fort' });
/** structure::cost_units (whole units: wood, stone, arms, gold). */
export const STRUCTURE_COST = Object.freeze({ 1: Object.freeze([0, 300, 400, 0, 20, 100, 0, 0]), 2: Object.freeze([0, 200, 100, 0, 0, 20, 0, 0]), 3: Object.freeze([0, 500, 800, 0, 50, 200, 0, 0]) });
/** structure::max_of: structures of each kind a citizen may own. */
export const STRUCTURE_MAX = Object.freeze({ 1: 2, 2: 4, 3: 1 });
/** structure: entries a Province holds, forts a Province holds, whole troops a fort holds. */
export const PROVINCE_STRUCTURES = 12;
export const PROVINCE_FORTS = 2;
export const FORT_MAX_TROOPS = 2000;
/** caravan.rs: a raid's bell offset is RAID_NONE (none) or RAID_SETTLED; the raider decides within RAID_DECIDE_BELLS. */
export const RAID_NONE = 0xff;
export const RAID_SETTLED = 0xfe;
export const RAID_DECIDE_BELLS = 6;
/** structure::STANCE_*: how a nation stands toward another faction. */
export const STANCES = Object.freeze(['war', 'pass', 'ally']);
const STANCE_TEXT = { war: () => L`戦争`, pass: () => L`通行を許す`, ally: () => L`同盟` };
/** nation.rs KIND_STANCE. */
export const PROPOSE_STANCE = 1;
/** nation.rs ELIGIBLE_BELLS: a village proposes and votes once it has been in the season this long. */
export const ELIGIBLE_BELLS = 288;
/** nation.rs PROPOSALS: open proposals a nation holds at once. */
export const NATION_PROPOSALS = 4;
const NATIONS = 6;

/** caravan.rs `caravan_id`: a caravan's id in a Province's slot. */
export const caravanId = (ownerTag, seq) => (1n << 63n) | ((BigInt(ownerTag) & 0x7fffffffffffn) << 16n) | (BigInt(seq) & 0xffffn);

/** The viewer's citizen tag (bigint) or null (people/ui.mjs ownTag). */
export const viewerTag = FS => ownTag(FS);
const isMine = (tag, mine) => mine !== null && mine !== undefined && BigInt(tag) === BigInt(mine);

/** Whole units the village in hand holds now, by resource. */
function haveOf(FS, h) {
  if (!h) return Array(8).fill(0);
  const now = FS.chain?.now?.() ?? 0;
  return storesAt(settled(h, now), now, RESOURCE_ORDER).map(s => s.value);
}

/**
 * Why a tile takes no storehouse or structure (the program's VaultSite /
 * StructureSite rule): `'Impassable' | 'Site' | 'Keep' | 'Camp'`, or null
 * when it may.
 */
export function siteProblem(prov, idx) {
  if (!prov || !Number.isInteger(idx) || idx < 0 || idx >= 61) return 'Unknown';
  if ((BigInt(prov.passableMask ?? 0) & (1n << BigInt(idx))) === 0n) return 'Impassable';
  const n = Math.min(Number(prov.siteCount ?? 0), 12);
  if (Array.from(prov.sites ?? []).slice(0, n).includes(idx)) return 'Site';
  if (keepFromProvince(prov)?.tile === idx) return 'Keep';
  if (prov.camp?.state === 1 && prov.camp.tile === idx) return 'Camp';
  return null;
}

/**
 * What S1 has on a chosen tile and what can be built there:
 * `{vault, structure, build: {vault: {cost, blocks}, structures: [{kind, cost, blocks}]}, raids}`.
 * `blocks` are error names (fi18n errorText) or the page's own (`NoHolding`, `Taken`).
 */
export function s1TileModel(FS, sel) {
  if (!sel || !Number.isInteger(sel.idx)) return null;
  const { p, q, idx } = sel;
  const s1 = FS.s1 ?? {}, mine = viewerTag(FS);
  const prov = FS.provinces?.get?.(`${p},${q}`)?.province ?? null;
  const at = x => x.p === p && x.q === q && x.tile === idx;
  const vault = (s1.caravans?.vaults ?? []).find(at) ?? null;
  const structure = (s1.structures?.structures ?? []).find(at) ?? null;
  const h = activeHolding(FS), have = haveOf(FS, h);
  const site = siteProblem(prov, idx), siteBlock = site === 'Unknown' ? 'Unknown' : site ? 'Site' : null;
  const c = FS.citizen ?? {};
  const common = [...(h ? [] : ['NoHolding']), ...(siteBlock ? [siteBlock] : [])];
  const vaultBlocks = [...common, ...(vault ? ['Taken'] : []), ...(Number(c.vaults ?? 0) >= MAX_VAULTS ? ['VaultLimit'] : []), ...(shortOf(VAULT_COST, have).length ? ['Insufficient'] : [])];
  const live = (prov?.structures ?? []).filter(e => Number(e.kind) !== 0);
  const forts = (prov?.forts ?? []).filter(f => Number(f.state) !== 0);
  const owned = { 1: Number(c.towers ?? 0), 2: Number(c.palisades ?? 0), 3: Number(c.forts ?? 0) };
  const structures = [1, 2, 3].map(kind => ({
    kind, name: KIND_NAME[kind], cost: STRUCTURE_COST[kind],
    blocks: [...common, ...(structure ? ['Taken'] : []), ...(owned[kind] >= STRUCTURE_MAX[kind] ? ['StructureLimit'] : []),
      ...(live.length >= PROVINCE_STRUCTURES || (kind === 3 && forts.length >= PROVINCE_FORTS) ? ['StructureFull'] : []),
      ...(shortOf(STRUCTURE_COST[kind], have).length ? ['Insufficient'] : [])],
  }));
  return {
    p, q, idx, site,
    vault: vault && { ...vault, mine: isMine(vault.ownerTag, mine) },
    structure: structure && { ...structure, name: KIND_NAME[structure.kind], mine: isMine(structure.ownerTag, mine) },
    build: { vault: { cost: VAULT_COST, blocks: vaultBlocks }, structures },
    raids: raidOffers(FS).filter(r => r.p === p && r.q === q && r.tile === idx),
  };
}

/**
 * The raids the viewer's hosts have won and may decide (caravan.rs
 * `raid_open`, within RAID_DECIDE_BELLS of the raid): `[{p, q, tile, slot,
 * raidBell, decideBy, raider: {p, q, site, gen}, caravan}]` — `caravan` the
 * feed's entry (its owner and sequence name the account).
 */
export function raidOffers(FS) {
  const out = [];
  const moving = FS.s1?.caravans?.moving ?? [];
  const bell = Number(FS.nowBell ?? 0);
  for (const env of FS.provinces?.values?.() ?? []) {
    const prov = env.province;
    (prov?.caravans ?? []).forEach((s, slot) => {
      const id = BigInt(s.id ?? 0), off = Number(s.raidOff);
      if (id === 0n || off === RAID_NONE || off === RAID_SETTLED) return;
      const hp = hostParts(s.raider);
      const raider = hp && (FS.holdings ?? []).find(h => h.p === hp.p && h.q === hp.q && h.site === hp.site && h.gen === hp.gen);
      if (!raider) return;
      const caravan = moving.find(c => caravanId(c.ownerTag, c.seq) === id);
      if (!caravan) return;
      const raidBell = Number(s.firstBell) + off;
      out.push({ p: prov.p, q: prov.q, tile: Number(s.tiles?.[off] ?? s.tiles?.[String(off)]), slot, raidBell, decideBy: raidBell + RAID_DECIDE_BELLS, open: bell <= raidBell + RAID_DECIDE_BELLS,
        raider: { p: raider.p, q: raider.q, site: raider.site, gen: raider.gen }, caravan });
    });
  }
  return out;
}

/**
 * The village's S1 view: the viewer's storehouses, caravans and structures,
 * where a caravan may go from the village in hand, its forts in the
 * village's province, and the nation (stances, proposals, the viewer's
 * votes).
 */
export function s1VillageModel(FS) {
  const s1 = FS.s1 ?? {}, mine = viewerTag(FS), h = activeHolding(FS);
  const vaults = (s1.caravans?.vaults ?? []).filter(v => isMine(v.ownerTag, mine));
  const caravans = (s1.caravans?.moving ?? []).filter(c => isMine(c.ownerTag, mine)).map(c => ({ ...c, arriveBell: caravanArriveBell(c) }));
  const structures = (s1.structures?.structures ?? []).filter(s => isMine(s.ownerTag, mine)).map(s => ({ ...s, name: KIND_NAME[s.kind] }));
  // where a caravan may leave from: the village in hand (its stores now) or one of the viewer's storehouses (the stores
  // the herald read from its account; a storehouse whose stores are not known yet offers nothing to send)
  const sources = [
    ...(h ? [{ kind: 'holding', p: h.p, q: h.q, site: h.site, gen: h.gen ?? 0, tile: h.tile, have: haveOf(FS, h) }] : []),
    ...vaults.map(v => ({ kind: 'vault', p: v.p, q: v.q, tile: v.tile, gen: v.gen, known: Array.isArray(v.stores), have: Array.isArray(v.stores) ? v.stores.map(Number) : Array(8).fill(0), cap: Number(v.cap ?? 0) })),
  ];
  const destinations = [
    ...(FS.holdings ?? []).map(o => ({ kind: 'holding', p: o.p, q: o.q, site: o.site, gen: o.gen ?? 0, tile: o.tile })),
    ...vaults.map(v => ({ kind: 'vault', p: v.p, q: v.q, tile: v.tile, gen: v.gen })),
  ];
  const prov = h ? FS.provinces?.get?.(`${h.p},${h.q}`)?.province ?? null : null;
  const forts = h ? structures.filter(s => s.kind === KIND.fort && s.p === h.p && s.q === h.q).map(s => {
    const r = (prov?.forts ?? []).find(f => Number(f.tile) === s.tile && Number(f.state) !== 0);
    const troops = r ? Math.floor(Number(r.troops) / 1000) + Number(r.pend ?? 0) : 0;
    return { ...s, troops, room: Math.max(0, FORT_MAX_TROOPS - troops) };
  }) : [];
  const spearmen = Number(h?.reserve?.[0] ?? 0);
  const faction = FS.citizen?.faction;
  const n = s1.nations;
  const voted = Array.from(FS.citizen?.voted ?? [], Number);
  // nation.rs `eligible`: in the season ELIGIBLE_BELLS, not expelled
  const joinBell = Number(FS.citizen?.joinBell ?? NaN);
  const eligibleAt = Number.isFinite(joinBell) ? joinBell + ELIGIBLE_BELLS : null;
  const open = (n?.proposals ?? []).filter(x => x.faction === faction && x.state === 'open');
  const nation = Number.isInteger(faction) && n ? {
    faction, eligibleAt, eligible: eligibleAt !== null && eligibleAt <= Number(FS.nowBell ?? 0), full: open.length >= NATION_PROPOSALS,
    stances: Array.from({ length: NATIONS }, (_, f) => (f === faction ? null : { faction: f, stance: STANCES[n.stances?.[faction]?.[f] ?? 0] })).filter(Boolean),
    toward: Array.from({ length: NATIONS }, (_, f) => (f === faction ? null : { faction: f, stance: STANCES[n.stances?.[f]?.[faction] ?? 0] })).filter(Boolean),
    proposals: open.map(x => ({ ...x, voted: voted[x.slot] === x.id, closesIn: x.closeBell - Number(FS.nowBell ?? 0) })),
    decided: (n.proposals ?? []).filter(x => x.faction === faction && (x.state === 'passed' || x.state === 'failed')).slice(-4).reverse(),
    expelled: !!(FS.citizen?.expelledSince && BigInt(FS.citizen.expelledSince) !== 0n),
  } : null;
  return { vaults, caravans, structures, sources, destinations, forts, spearmen, nation, have: haveOf(FS, h), holding: h };
}

/** Two places are the same (a caravan cannot go where it starts). */
export const samePlace = (a, b) => !!a && !!b && a.kind === b.kind && a.p === b.p && a.q === b.q && (a.kind === 'vault' ? a.tile === b.tile : a.site === b.site);

/**
 * What stops a caravan from `src` to `dst` with `cargo` (whole units by
 * resource), as the page's own codes: `NoPlace`, `SamePlace`, `NoCargo`,
 * `Insufficient`; or null. The program checks again (caravan.rs).
 */
export function caravanProblem(src, dst, cargo) {
  if (!src || !dst) return 'NoPlace';
  if (samePlace(src, dst)) return 'SamePlace';
  if (!cargo.some(v => v > 0)) return 'NoCargo';
  if (cargo.some((v, i) => v > Math.floor(src.have?.[i] ?? 0))) return 'Insufficient';
  return null;
}

// ------------------------------------------------------------------ words
const S1_BLOCK = { NoHolding: () => L`村を選んでください（費用は選んだ村から払います）`, Taken: () => L`このマスにはもう建っています`, Unknown: () => L`この州のようすをまだ読み込んでいません`,
  Site: () => errorText('StructureSite') };
const blockText = b => (S1_BLOCK[b] ?? (() => errorText(b)))();
const costLine = cost => cost.map((v, r) => (v ? html`<span class="nowrap">${RESOURCES[RESOURCE_ORDER[r]]} ${fmtNum(v)}</span>` : '')).filter(Boolean).reduce((a, x) => html`${a}${a ? ' · ' : ''}${x}`, '');
const btn = (act, data, text, { primary = false, disabled = false } = {}) => html`<button type="button" class="btn small${primary ? ' primary' : ''}" data-act="${act}" ${raw(Object.entries(data).map(([k, v]) => `data-${k}="${String(v).replace(/[^\w.-]/g, '')}"`).join(' '))} ${raw(disabled ? 'disabled' : '')}>${text}</button>`;
const kindWord = kind => S1_WORDS[KIND_NAME[kind] ?? kind]?.() ?? '';
export const stanceText = s => STANCE_TEXT[s]?.() ?? s;

/** A tile's S1 section in the inspector (hud/inspect.mjs). */
export function renderS1Tile(FS, sel) {
  const m = s1TileModel(FS, sel);
  if (!m) return '';
  const here = [];
  if (m.vault) here.push(html`<li>${icon('crate')}${S1_WORDS.vault()} ${swatch(m.vault.faction)}${m.vault.mine ? chip(L`あなたの`, 'you') : factionName(m.vault.faction)}</li>`);
  if (m.structure) here.push(html`<li>${icon('shield')}${kindWord(m.structure.kind)} ${swatch(m.structure.faction)}${m.structure.mine ? chip(L`あなたの`, 'you') : factionName(m.structure.faction)}${m.structure.kind === KIND.fort && m.structure.sent ? html` <span class="muted">${L`送った兵 ${fmtNum(m.structure.sent)}`}</span>` : ''}</li>`);
  const raids = m.raids.map(r => html`<div class="s1-raid">${label(L`略奪の決定（ターン ${fmtNum(r.decideBy)} まで）`)}
    <p>${L`あなたの軍勢がこの隊商に勝ちました。荷を奪って自分の村へ運ぶか、焼き払うかを決めてください。`}</p>
    <div class="actions">${btn('s1-raid', { p: r.p, q: r.q, slot: r.slot, choice: 'take' }, L`奪って運ぶ`, { primary: true, disabled: !r.open })}${btn('s1-raid', { p: r.p, q: r.q, slot: r.slot, choice: 'burn' }, L`焼き払う`, { disabled: !r.open })}</div></div>`);
  const offer = (act, data, text, o) => html`<li class="s1-offer">${btn(act, data, text, { disabled: o.blocks.length > 0 })}<span class="muted">${costLine(o.cost)}</span>${o.blocks.length ? html`<span class="blocked">${o.blocks.map(blockText).join(' / ')}</span>` : ''}</li>`;
  const build = m.site === 'Unknown' ? '' : html`${fold('s1-build', html`${icon('hammer')}${L`ここに建てる`}`, html`<ul class="list s1-offers">
    ${offer('s1-vault', { p: m.p, q: m.q, tile: m.idx }, L`${S1_WORDS.vault()}を建てる`, m.build.vault)}
    ${m.build.structures.map(o => offer('s1-structure', { p: m.p, q: m.q, tile: m.idx, kind: o.kind }, L`${kindWord(o.kind)}を建てる`, o))}</ul>
    <p class="muted">${L`費用は選んでいる村の蔵から払います。物見櫓はまわりの動きを知らせ、柵と要塞は通る敵を止めます。`}</p>`)}`;
  return html`<div class="s1-tile">${here.length ? html`<ul class="list s1-here">${here}</ul>` : ''}${raids}${build}</div>`;
}

/** The village's S1 card (screens/holding.mjs). */
export function renderS1Village(FS) {
  const m = s1VillageModel(FS);
  if (!m.holding) return '';
  const bell = Number(FS.nowBell ?? 0);
  const placeWord = d => (d.kind === 'vault' ? L`${S1_WORDS.vault()}（${d.p}, ${d.q} · マス ${d.tile}）` : L`村（${d.p}, ${d.q}）`);
  const caravans = m.caravans.length ? html`${label(L`道中の隊商`)}<ul class="list">${m.caravans.map(c => html`<li>${icon('flag')}${c.raided ? S1_WORDS.raided() : S1_WORDS.caravan()} <span class="muted">${c.arriveBell !== null ? (c.arriveBell <= bell ? L`到着済み（決着待ち）` : L`ターン ${fmtNum(c.arriveBell)} に到着`) : ''}</span></li>`)}</ul>` : '';
  const owned = m.vaults.length || m.structures.length ? html`${label(L`あなたの貯蔵庫と建物`)}<ul class="list">${[
    ...m.vaults.map(v => html`<li>${icon('crate')}${S1_WORDS.vault()} <span class="muted">${v.p}, ${v.q} · ${v.tile}</span>${Array.isArray(v.stores)
      ? html` <span class="muted">${v.stores.some(x => Number(x) > 0) ? costLine(v.stores.map(Number)) : L`空`}${v.cap ? L`（上限 ${fmtNum(v.cap)}）` : ''}</span>` : ''}</li>`),
    ...m.structures.map(s => html`<li>${icon('shield')}${kindWord(s.kind)} <span class="muted">${s.p}, ${s.q} · ${s.tile}</span></li>`)]}</ul>` : html`<p class="muted">${L`貯蔵庫や物見櫓・柵・要塞は、地図でマスを選ぶと建てられます。`}</p>`;
  // the goods a caravan carries (caravan.rs: the first six; arms and influence stay), the most any source holds
  const most = i => Math.max(0, ...m.sources.map(s => Math.floor(s.have?.[i] ?? 0)));
  const sendable = RESOURCE_ORDER.map((r, i) => ({ r, i, have: most(i) })).filter(x => x.have > 0 && x.i < 6);
  const firstDst = m.destinations.findIndex(x => !samePlace(m.sources[0], x));
  const haveText = s => (s.kind === 'vault' && !s.known ? L`在庫はまだ読み込んでいません`
    : s.have.slice(0, 6).map((v, i) => (v > 0 ? `${RESOURCES[RESOURCE_ORDER[i]]} ${fmtNum(Math.floor(v))}` : '')).filter(Boolean).join(' · ') || L`空`);
  const send = m.vaults.length + (FS.holdings ?? []).length >= 2 ? html`<form class="vform" data-form="s1-caravan">
    <label class="field">${L`出発地`}<select name="src">${m.sources.map((s, i) => html`<option value="${i}">${placeWord(s)} — ${haveText(s)}</option>`)}</select></label>
    <label class="field">${L`行き先`}<select name="dst">${m.destinations.map((d, i) => html`<option value="${i}" ${raw(i === firstDst ? 'selected' : '')}>${placeWord(d)}</option>`)}</select></label>
    ${sendable.map(x => html`<div class="count-row"><label class="count-label" for="s1-c${x.i}">${RESOURCES[x.r]}</label><input id="s1-c${x.i}" name="c${x.i}" type="number" min="0" max="${x.have}" step="1" value="0" inputmode="numeric"></div>`)}
    <p class="muted">${L`運べる量は出発地の蔵にある分までです（出発地ごとの在庫は上の一覧のとおり）。`}</p>
    <div class="actions"><button type="submit" class="btn primary">${L`隊商を送る`}</button></div>
    <p class="muted">${L`隊商は軍勢より遅く、道の上で略奪されることがあります。物見櫓の見張る土地や味方の柵の近くを通ると安全です。`}</p></form>`
    : html`<p class="muted">${L`隊商を送れる行き先（ほかの村か貯蔵庫）がまだありません。`}</p>`;
  const fort = m.forts.length ? html`<form class="vform" data-form="s1-fort">
    <label class="field">${L`要塞`}<select name="tile">${m.forts.map(f => html`<option value="${f.tile}">${L`マス ${f.tile}（兵 ${fmtNum(f.troops)} / ${fmtNum(FORT_MAX_TROOPS)}）`}</option>`)}</select></label>
    <div class="count-row"><label class="count-label" for="s1-ft">${L`入れる槍兵（控えから）`}<span class="muted"> / ${fmtNum(m.spearmen)}</span></label><input id="s1-ft" name="troops" type="number" min="1" max="${Math.min(m.spearmen, FORT_MAX_TROOPS)}" step="1" value="${Math.min(100, m.spearmen) || 1}" inputmode="numeric"></div>
    <div class="actions"><button type="submit" class="btn" ${raw(m.spearmen > 0 ? '' : 'disabled')}>${L`要塞に兵を入れる`}</button></div>
    <p class="muted">${L`兵は次のターンから要塞を守ります。`}</p></form>` : '';
  const n = m.nation;
  const nation = n ? html`${label(L`国の方針`)}
    <ul class="list s1-stances">${n.stances.map(x => html`<li>${swatch(x.faction)}${factionName(x.faction)}: ${stanceText(x.stance)}</li>`)}</ul>
    ${n.proposals.length ? html`${label(L`投票中の議題`)}<ul class="list">${n.proposals.map(x => html`<li>${proposalText(x)} <span class="muted">${x.closesIn > 0 ? L`賛成 ${fmtNum(x.yes)} · 反対 ${fmtNum(x.no)} · あと ${fmtNum(x.closesIn)} ターン` : L`賛成 ${fmtNum(x.yes)} · 反対 ${fmtNum(x.no)} · 締め切り（集計を待っています）`}</span>
      ${x.voted ? chip(L`投票済み`, 'ok', 'check') : x.closesIn > 0 ? html`<span class="actions">${btn('s1-vote', { slot: x.slot, id: x.id, yes: 1 }, L`賛成`, { disabled: n.expelled || !n.eligible })}${btn('s1-vote', { slot: x.slot, id: x.id, yes: 0 }, L`反対`, { disabled: n.expelled || !n.eligible })}</span>` : ''}</li>`)}</ul>` : ''}
    ${n.decided.length ? html`${label(L`決まった議題`)}<ul class="list">${n.decided.map(x => html`<li>${proposalText(x)} ${x.state === 'passed' ? chip(L`可決`, 'ok', 'check') : chip(L`否決`, 'warn')} <span class="muted">${L`賛成 ${fmtNum(x.yes)} · 反対 ${fmtNum(x.no)}`}</span></li>`)}</ul>` : ''}
    ${n.expelled ? html`<p class="blocked">${L`あなたの村は国を追放されているため、投票も提案もできません。`}</p>`
      : !n.eligible ? html`<p class="blocked">${n.eligibleAt === null ? L`投票と提案は、国に加わってから ${fmtNum(ELIGIBLE_BELLS)} ターン後にできるようになります。` : L`投票と提案は、ターン ${fmtNum(n.eligibleAt)} からできます（国に加わってから ${fmtNum(ELIGIBLE_BELLS)} ターン）。`}</p>`
      : n.full ? html`<p class="blocked">${L`投票中の議題が ${fmtNum(NATION_PROPOSALS)} 件あるため、新しい提案は締め切りを待ってから出せます。`}</p>` : html`<form class="vform" data-form="s1-propose">
      <label class="field">${L`相手の国`}<select name="target">${n.stances.map(x => html`<option value="${x.faction}">${factionName(x.faction)}</option>`)}</select></label>
      <label class="field">${L`方針`}<select name="value">${STANCES.map((s, i) => html`<option value="${i}">${stanceText(s)}</option>`)}</select></label>
      <div class="actions"><button type="submit" class="btn">${L`方針の変更を提案する`}</button></div>
      <p class="muted">${L`提案は1日のあいだ投票を受け、賛成が3票以上かつ反対より多ければ決まります。`}</p></form>`}` : '';
  return html`<section class="vcard vcard-folds s1-card" aria-labelledby="s1-title">
    ${cardHead({ id: 's1-title', ic: 'flag', title: L`交易と防備` })}
    ${caravans}${owned}
    ${fold('s1-send', html`${icon('flag')}${L`隊商を送る`}`, send)}
    ${fort ? fold('s1-fort', html`${icon('shield')}${L`要塞に兵を入れる`}`, fort) : ''}
    ${nation ? fold('s1-nation', html`${icon('banner')}${L`国の議会`}`, nation) : ''}</section>`;
}

/** A proposal in words. */
export function proposalText(x) {
  if (x.kind === 'stance') return L`${factionName(x.targetFaction)}への方針を「${stanceText(STANCES[x.value] ?? 'war')}」にする`;
  if (x.kind === 'expel') return L`村をひとつ国から追放する`;
  return L`追放された村を国に戻す`;
}
