// ② RIGHTS (owner decision ② A) on the village screen — TEST-ONLY, a COEXIST local world only (flocalplay-lane.mjs
// COEXIST_LANE; the controller sets `FS.rights.on` only there, and every other world draws nothing of this).
//
//   issue      one of your workshop villages (the facility) grants another player's storehouse in the SAME Province (the
//              station) a stock swap: they may exchange their ore and wood there for the arms your workshops have made,
//              within a number of swaps and arms and until a time. Wallet-only; costs 25 gold from the facility.
//   swap       the grantee reserves units (ore and wood leave its storehouse, arms leave the facility into the Grant),
//              then executes (the arms land in its storehouse — they leave it only by caravan, which can be raided)
//   release / revoke / close   undo an open reservation (grantee) · end the Grant (issuer) · take back its rent (issuer)
//
// FOG RULE: the card lists only Grants the viewer is a party to (issuer or grantee) — the herald's rows are filtered again
// here (flocalplay-rights.mjs partyGrants) — and offers as stations only storehouses the page already shows (its own
// S1 feed) in the facility's Province; it never shows another player's storehouse stock or a Grant between others.
// The model is pure; the program checks every rule again.
import { html, raw } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { icon } from '../hud/icons.mjs';
import { factionName } from '../fi18n.mjs';
import { bellAt } from '../clock.mjs';
import { cardHead, chip, fold, label } from './parts.mjs';
import { grantOptions, partyGrants, rowGrant, issuerTagOf, GRANT_ISSUE_COST, MAX_GRANT_SECS, MAX_UNITS_PER_SWAP, STATE_ACTIVE, STATE_REVOKED } from '../flocalplay-rights.mjs';

/** frontier-abi arms.rs: ore and wood per arm (the workshop ratio a swap is made at). */
export const ORE_PER_ARM = 2, WOOD_PER_ARM = 1;
export const DEFAULT_DAYS = 1;

const stateWord = (g, now, closed = false) => (closed ? L`閉じた` : g.state === STATE_REVOKED ? L`取り消し済み` : g.state === STATE_ACTIVE && BigInt(Math.floor(now)) >= BigInt(g.expiresTs) ? L`期限切れ` : g.state === STATE_ACTIVE ? L`有効` : L`終了`);

/**
 * The card's model: `{on, viewer, read, grants: [{address, grant, role, can, unitsLeft, seq, facility, station}], facilities:
 * [{p, q, site, stations: [{p, q, tile, gen, granteeCitizen, faction}]}], nextNonce}`. `FS.rights` (the controller's):
 * `{on, viewer (Citizen base58), read: 'unread'|'loading'|'ok'|'unavailable'|'failed', rows (herald), live: Map(address →
 * decoded Grant), issued: [{address, issuerTag, nonce}]}`.
 */
/**
 * (fix-loop6, LP6-14) Whether the provinces a caravan crossed have settled past its arrival, as the page holds them: the
 * program refuses the delivery (CaravanEarly) while any of them is resolved only up to a bell the caravan stood there
 * (caravan.rs settle: RESOLVED_NEXT ≤ its last bell). Its arrival's bell bounds every such bell. → `{settled: true}` (every
 * province read and past it), `{settled: false, waitP, waitQ, waitBell}` (one read and not past it), or `{settled: null}`
 * (not every province read: the press is offered, the program decides). loop-play6: offered, refused, works later.
 */
export function settledFor(FS, provinces, arriveTs) {
  const g = Number(FS.clock?.genesisTs), t = Number(arriveTs);
  if (!Number.isFinite(g) || !Number.isFinite(t) || !provinces?.length) return { settled: null };
  const arriveBell = bellAt(g, t);
  if (arriveBell === null) return { settled: null };
  let unknown = false;
  for (const x of provinces) {
    const rn = Number(FS.provinces?.get?.(`${x.p},${x.q}`)?.province?.resolvedNext);
    if (!Number.isFinite(rn)) { unknown = true; continue; }
    if (rn <= arriveBell) return { settled: false, waitP: x.p, waitQ: x.q, waitBell: arriveBell };
  }
  return { settled: unknown ? null : true };
}
export function rightsModel(FS, nowTs = FS.chain?.now?.() ?? 0) {
  const r = FS.rights;
  if (!r?.on || !r.viewer) return { on: false };
  const viewer = r.viewer, myTag = issuerTagOf(viewer);
  const rows = partyGrants(r.rows, viewer) ?? [];
  const byAddr = new Map();
  for (const row of rows) byAddr.set(row.address, { address: row.address, row, grant: r.live?.get(row.address) ?? rowGrant(row) });
  for (const x of r.issued ?? []) if (!byAddr.has(x.address)) byAddr.set(x.address, { address: x.address, row: null, grant: r.live?.get(x.address) ?? null });
  const grants = [...byAddr.values()].filter(e => e.grant).map(e => {
    const o = grantOptions(e.grant, viewer, nowTs);
    // (a CLOSED Grant — the herald's record, or an account the chain no longer holds — has nothing left to do: its last
    //  bytes say "revoked" or "spent", so its offers are dropped here and its state word is "closed")
    const closed = e.row?.state === 'closed' || r.gone?.has?.(e.address) === true;
    if (closed) { o.can = new Set(); o.closed = true; }
    return { ...e, ...o, seq: e.grant.swaps,
      facility: { p: e.grant.p, q: e.grant.q, site: e.grant.facilitySite }, station: { p: e.grant.p, q: e.grant.q, tile: e.grant.stationTile } };
  }).filter(e => e.role !== null);   // (fog: a Grant the viewer is no party to is not drawn)
  // the next nonce: one past every nonce of a Grant this viewer issued that the page knows of
  const mine = [...rows.filter(x => String(x.issuer_tag) === myTag).map(x => Number(x.nonce)), ...(r.issued ?? []).map(x => x.nonce)];
  const nextNonce = mine.length ? Math.max(...mine) + 1 : 1;
  // facilities: the viewer's villages with workshops; stations: OTHER players' storehouses the page shows, same Province
  const vaults = FS.s1?.caravans?.vaults ?? [];
  const facilities = (FS.holdings ?? []).filter(h => Number(h.production?.[4] ?? 0) > 0 || Number(h.workshops ?? 0) > 0).map(h => ({
    p: h.p, q: h.q, site: h.site,
    stations: vaults.filter(v => v.p === h.p && v.q === h.q && typeof v.ownerCitizen === 'string' && v.ownerCitizen !== viewer && String(v.ownerTag) !== myTag)
      .map(v => ({ p: v.p, q: v.q, tile: v.tile, gen: v.gen, granteeCitizen: v.ownerCitizen, faction: v.faction })),
  }));
  // (deliveries: the viewer's OWN caravans past their arrival — local play has no keeper that delivers S1 caravans, so the
  //  sender delivers them itself, SettleCaravan; the program checks the arrival, the resolved bells and any raid again)
  const moving = FS.s1?.caravans?.moving ?? [];
  // (⑩ preview: the viewer's CUSTODY caravans are delivered into their lot by the custody card, SettleCustody — never here)
  // (fix-9-10-followups: also a caravan the viewer TOOK in a raid — the herald names it holder (`holderTag`); its address
  //  keeps its sender's seed, so the delivery names that tag — flocalplay-rights.mjs SettleCaravan `owner_tag`)
  const own = c => String(c.ownerTag) === myTag && !c.raided && !FS.custody?.custodySeqs?.has?.(Number(c.seq));
  const took = c => c.raided && c.holderTag !== undefined && c.holderTag !== null && String(c.holderTag) === myTag && String(c.ownerTag) !== myTag;
  const deliveries = moving.filter(c => myTag !== null && Number(c.arriveTs) <= nowTs && (own(c) || took(c)))
    .map(c => ({ seq: Number(c.seq), ownerTag: took(c) ? String(c.ownerTag) : null, dst: c.dst, provinces: (c.provinces ?? []).map(x => (Array.isArray(x) ? { p: x[0], q: x[1] } : { p: x.p, q: x.q })), cargo: c.cargo ?? [], arriveTs: c.arriveTs }))
    .map(c => ({ ...c, ...settledFor(FS, c.provinces, c.arriveTs) }));
  // (fix-loop9, LP9-6: a caravan the viewer TOOK that is still on its way to the viewer's village — loop-play9, the raider
  //  saw nothing of it for ~65 turns, then 「奪った隊商 … 隊商を届ける」 appeared: its new route is the raider's own)
  const genesis = FS.season ? Number(FS.season.genesisTs) : null;
  const takenOnWay = moving.filter(c => myTag !== null && took(c) && Number(c.arriveTs) > nowTs)
    .map(c => ({ seq: Number(c.seq), cargo: c.cargo ?? [], dst: c.dst, arriveBell: Number.isFinite(genesis) ? bellAt(genesis, Number(c.arriveTs)) : null }));
  return { on: true, viewer, read: r.read ?? 'unread', grants, facilities, nextNonce, deliveries, takenOnWay };
}

const btn = (act, data, text, { disabled = false } = {}) => html`<button type="button" class="btn small" data-act="${act}" ${raw(Object.entries(data).map(([k, v]) => `data-${k}="${String(v).replace(/"/g, '')}"`).join(' '))} ${raw(disabled ? 'disabled' : '')}>${text}</button>`;
const costText = () => L`金 ${fmtNum(GRANT_ISSUE_COST[5])}`;

/**
 * (fix-loop12, LP12-8) The village an arrived caravan is bound for, named as the caravan form names it — by its tile
 * (screens/s1.mjs: 「村（-1, 2 · マス 35）」). The caravan's record names a village by its SITE (`dst.at`, 0–11); this list
 * said that number bare (「村（-1, 2 · 4）」) for the same village. The tile is the viewer's own village's, or the site's tile
 * in the province record the page holds; without either, the province alone.
 */
function villageTo(FS, dst, site) {
  const p = Number(dst.p), q = Number(dst.q);
  const own = (FS.holdings ?? []).find(h => h && Number(h.p) === p && Number(h.q) === q && Number(h.site) === site);
  const tile = Number.isInteger(own?.tile) ? own.tile : Number(FS.provinces?.get?.(`${p},${q}`)?.province?.sites?.[site]);
  return Number.isInteger(tile) ? L`村（${p}, ${q} · マス ${tile}）へ` : L`村（${p}, ${q}）へ`;
}

export function renderRights(FS) {
  const m = rightsModel(FS);
  if (!m.on) return '';
  const now = FS.chain?.now?.() ?? 0;
  const readNote = m.read === 'unavailable' ? html`<p class="muted">${L`記録係から権利の一覧を読めません。このページが出した権利だけを表示しています。`}</p>`
    : m.read === 'failed' ? html`<p class="blocked">${L`権利の一覧を読めませんでした。`}</p>` : m.read === 'loading' ? html`<p class="muted">${L`権利の一覧を読み込んでいます…`}</p>` : '';
  const list = m.grants.length ? html`${label(L`あなたが当事者の権利`)}<ul class="list rights-list">${m.grants.map(e => {
    const g = e.grant, d = { address: e.address, tag: g.issuerTag, nonce: g.nonce, fp: g.p, fq: g.q, site: g.facilitySite, tile: g.stationTile, seq: e.seq };
    return html`<li data-grant="${e.address}" data-role="${e.role}">${icon('scroll')}${e.role === 'issuer' ? L`あなたが出した権利` : L`あなたが受けた権利`} ${chip(stateWord(g, now, e.closed), g.state === STATE_ACTIVE && !e.closed ? 'ok' : 'warn')}
      <span class="muted">${L`州 ${g.p}, ${g.q} · 工房の村 ${g.facilitySite} → 貯蔵庫 マス ${g.stationTile}`} · ${L`交換 ${fmtNum(g.swaps)} / ${fmtNum(g.maxSwaps)} 回 · 兵器 ${fmtNum(g.unitsSwapped)} / ${fmtNum(g.maxUnits)}`}${g.openUnits ? ` · ${L`予約中 ${fmtNum(g.openUnits)}`}` : ''}</span>
      <span class="actions">${e.can.has('ReserveSwap') ? html`<form class="vform inline" data-form="rights-reserve" ${raw(Object.entries(d).map(([k, v]) => `data-${k}="${v}"`).join(' '))}>
        <input name="units" type="number" min="1" max="${Math.min(e.unitsLeft, MAX_UNITS_PER_SWAP)}" step="1" value="1" inputmode="numeric" aria-label="${L`交換する兵器の数`}">
        <button type="submit" class="btn small">${L`交換を予約する`}</button></form>` : ''}
      ${e.can.has('ExecuteSwap') ? btn('rights-execute', d, L`交換を実行する`) : ''}${e.can.has('ReleaseSwap') ? btn('rights-release', d, L`予約を戻す`) : ''}
      ${e.can.has('RevokeGrant') ? btn('rights-revoke', d, L`権利を取り消す`) : ''}${e.can.has('CloseGrant') ? btn('rights-close', d, L`権利を閉じる`) : ''}</span></li>`;
  })}</ul>` : html`<p class="muted">${L`あなたが当事者の権利はまだありません。`}</p>`;
  const choices = m.facilities.flatMap(f => f.stations.map(s => ({ f, s })));
  const issue = choices.length ? html`<form class="vform" data-form="rights-issue" data-nonce="${m.nextNonce}">
    <label class="field">${L`工房の村と相手の貯蔵庫`}<select name="pair">${choices.map((c, i) => html`<option value="${i}" data-fp="${c.f.p}" data-fq="${c.f.q}" data-site="${c.f.site}" data-tile="${c.s.tile}" data-grantee="${c.s.granteeCitizen}">${L`州 ${c.f.p}, ${c.f.q} の村 ${c.f.site} → ${factionName(c.s.faction)} の貯蔵庫（マス ${c.s.tile}）`}</option>`)}</select></label>
    <div class="count-row"><label class="count-label" for="rg-sw">${L`交換の回数`}</label><input id="rg-sw" name="max_swaps" type="number" min="1" max="100" step="1" value="3" inputmode="numeric"></div>
    <div class="count-row"><label class="count-label" for="rg-un">${L`兵器の上限`}</label><input id="rg-un" name="max_units" type="number" min="1" max="${MAX_UNITS_PER_SWAP}" step="1" value="30" inputmode="numeric"></div>
    <div class="count-row"><label class="count-label" for="rg-d">${L`有効な日数`}</label><input id="rg-d" name="days" type="number" min="1" max="${MAX_GRANT_SECS / 86400}" step="1" value="${DEFAULT_DAYS}" inputmode="numeric"></div>
    <p class="muted">${L`費用：工房の村から ${costText()}。権利はウォレットだけが出せます（ほかの鍵や代理には任せられません）。`}</p>
    <p class="muted">${L`相手は自分の鉱石 ${fmtNum(ORE_PER_ARM)} と木材 ${fmtNum(WOOD_PER_ARM)} につき、あなたの工房がすでに作った兵器 1 を受け取れます。兵器は相手の貯蔵庫に入り、隊商でしか運び出せません。`}</p>
    <div class="actions"><button type="submit" class="btn primary">${L`権利を出す`}</button></div></form>`
    : html`<p class="muted">${m.facilities.length ? L`工房のある村の州に、ほかの人の貯蔵庫が見えていません。相手がこの州に貯蔵庫を建てると、権利を出せます。` : L`権利を出すには、工房のある村が要ります。`}</p>`;
  const RES = [L`食料`, L`木材`, L`石材`, L`鉱石`, L`兵器`, L`金`, L`学術`, L`影響力`];
  const cargoText = c => c.map((n, i) => (Number(n) > 0 ? `${RES[i]} ${fmtNum(n)}` : '')).filter(Boolean).join(' · ');
  const deliver = m.deliveries.length ? html`${label(L`着いた隊商（あなたが届けます）`)}<ul class="list rights-deliveries">${m.deliveries.map(c => {
    const kind = Number(c.dst.kind) === 2 ? 'vault' : 'holding', at = Number(c.dst.at ?? c.dst.tile ?? c.dst.site);
    const d = { seq: c.seq, kind, dp: c.dst.p, dq: c.dst.q, at, gen: c.dst.gen ?? 0, path: c.provinces.map(x => `${x.p}_${x.q}`).join('.'), ...(c.ownerTag ? { owner: c.ownerTag } : {}) };
    // (fix-loop6, LP6-14: not offered while a crossed province has not settled past the arrival — it said so only after a refused press)
    return html`<li data-caravan="${c.seq}">${icon('scroll')}${c.ownerTag ? html`${chip(L`奪った隊商`, 'warn')} ` : ''}${kind === 'vault' ? L`貯蔵庫（${c.dst.p}, ${c.dst.q} · マス ${at}）へ` : villageTo(FS, c.dst, at)} <span class="muted">${cargoText(c.cargo)}</span>
      ${c.settled === false ? html`<span class="muted rights-deliver-wait" role="status">${L`通った州 ${c.waitP},${c.waitQ} の決着が到着のターン ${fmtNum(c.waitBell)} を過ぎるのを待っています。過ぎると届けられます（数ターン）。`}</span>`
        : html`<span class="actions">${btn('rights-deliver', d, L`隊商を届ける`)}</span>`}</li>`;
  })}</ul><p class="muted">${L`この試験世界には隊商を届ける係がいないので、着いた自分の隊商は自分で届けます（手数料は戻ります）。`}</p>` : '';
  const onWay = (m.takenOnWay ?? []).length ? html`${label(L`奪った隊商（あなたの村へ向かっています）`)}<ul class="list rights-taken">${m.takenOnWay.map(c => html`<li data-taken="${c.seq}">${icon('scroll')}${chip(L`奪った隊商`, 'warn')} <span class="muted">${cargoText(c.cargo)}</span> ${Number.isInteger(c.arriveBell) ? L`ターン ${fmtNum(c.arriveBell)} に着きます。着いたら、ここで届けられます。` : L`着くターンはまだ読めていません。着いたら、ここで届けられます。`}</li>`)}</ul>` : '';
  return html`<section class="vcard vcard-folds rights-card" id="hp-rights" aria-labelledby="rights-title" data-rights-read="${m.read}">
    ${cardHead({ id: 'rights-title', ic: 'scroll', title: L`権利（保管庫）` })}
    ${readNote}${list}${onWay}${deliver}
    <div class="actions">${btn('rights-read', {}, L`権利の一覧を読み直す`)}</div>
    ${fold('rights-issue', html`${icon('scroll')}${L`権利を出す`}`, issue)}
    <p class="muted">${L`一覧に出るのは、あなたが出したか受けた権利だけです。ほかの人どうしの権利や、ほかの人の貯蔵庫の中身は表示しません。`}</p></section>`;
}
