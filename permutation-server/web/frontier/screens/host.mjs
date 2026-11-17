// The hosts drawer (web design §7.5; contract §5.10–§5.11, I-44; UX design
// sections 1 and 6): one short card per host of the viewer's village — its
// portrait, unit and troops, a state chip (ready, resting, forming, on the
// march), the stamina as a bar (cap 120, +1 per bell) — with the common
// action first: "march" (the order is then written on the map), "explore"
// for scouts, "dissolve" as the quiet one. A host whose march's result is
// not collected yet is locked (HostInTransit) and says so in words.
import { activeHolding } from '../fstate.mjs';
import { html, raw } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { unitCount, errorText } from '../fi18n.mjs';
import { hostsIn, UNIT_ORDER, SCOUT, actionBlocks, ticketTimes } from '../fland.mjs';
import { countdown } from '../clock.mjs';
import { RULES, DEPART_STAMINA } from '../fmarch.mjs';
import { miniCardUrl, MINI_KINDS } from '../people/minis.mjs';
import { holdingName } from '../people/ui.mjs';
import { icon } from '../hud/icons.mjs';
import { provinceName } from '../hud/place.mjs';
import { cardHead, stamp, bar } from './parts.mjs';

/** Every host of the viewer's first holding in the provinces the page holds (home and destinations). */
/**
 * (workstream 07) The village's own province not read yet (or its read failed): its hosts come from that record, so
 * "no host" is not known. The troops screen and the guide say so instead of "none" (and offer no Train or Muster).
 */
export const homeProvinceUnread = (FS, h = activeHolding(FS)) => !!h && !FS?.provinces?.has?.(`${h.p},${h.q}`);

export function hostRows(FS) {
  const h = activeHolding(FS);
  if (!h) return [];
  const out = [];
  for (const env of FS.provinces?.values() ?? []) {
    for (const row of hostsIn(env.province, h, FS.nowBell ?? 0)) out.push({ ...row, p: env.province.p, q: env.province.q, province: env.province });
  }
  return out;
}

const PENDING_TEXT = { 0: () => '', 1: () => L`出発の手続き中`, 2: () => L`分割待ち`, 3: () => L`合流待ち`, 4: () => L`合流される`, 5: () => L`解散待ち（決着のあと控えに戻る）`, 6: () => L`封が正しくなかったため失われます` };

/** A village's own mark, as the controller writes it (holdingRef): place, site, generation. */
const refOf = h => (h ? `${h.p},${h.q},${h.site},${h.gen ?? 0}` : '');
/**
 * (2026-11-17, ⑦ the hosts screen) The viewer's OTHER villages, each with the hosts the page can list for it now:
 * `[{name, hosts, p, q, site, gen}]`. The count is of the provinces the page holds — a host in a province that is not
 * read is not in it (unreadHostPlaces says which those are).
 */
export function otherVillages(FS) {
  const active = activeHolding(FS) ?? null, bell = FS.nowBell ?? 0;
  return (FS.holdings ?? []).filter(o => o !== active).map(o => {
    let hosts = 0;
    for (const env of FS.provinces?.values() ?? []) hosts += hostsIn(env.province, o, bell).length;
    return { name: holdingName(o), hosts, p: o.p, q: o.q, site: o.site, gen: o.gen ?? 0 };
  });
}
/**
 * The provinces the viewer's record says its hosts stand in (controller `FS.hostPlaces`) that the page does NOT hold:
 * `{known, places: [{p, q, state, code}]}` — `state`: how the last read of that province went (FS.provinceReads:
 * 'loading' | 'waiting' | 'failed' | 'missing'), or 'idle' when none is recorded. `known: false` when the record's
 * list is not there or belongs to another context (another viewer, herald or pinned world): then nothing is claimed.
 * A host in such a province is NOT "no host": the screen lists hosts only from provinces it holds.
 */
export function unreadHostPlaces(FS) {
  const hp = FS.hostPlaces ?? null;
  if (!hp || !Array.isArray(hp.places) || (Number.isInteger(hp.ctx) && Number.isInteger(FS.contextSeq) && hp.ctx !== FS.contextSeq)) return { known: false, places: [] };
  return { known: true, places: hp.places.filter(x => !FS.provinces?.has?.(`${x.p},${x.q}`)).map(x => { const st = FS.provinceReads?.get?.(`${x.p},${x.q}`) ?? null; return { p: x.p, q: x.q, state: st?.state ?? 'idle', code: st?.code ?? null }; }) };
}
/** The lines under the list: the provinces not read (with the existing pure re-read of each), and the other villages with the way to each. */
function hostsAround(FS, h) {
  const play = (FS.mode ?? null) === 'play', ctx = Number.isInteger(FS.contextSeq) ? FS.contextSeq : null;
  const un = unreadHostPlaces(FS), others = otherVillages(FS);
  const unread = un.places.length ? html`<div class="hosts-unread" role="status"><p class="notice error">${L`あなたの軍勢がいる州のうち、${fmtNum(un.places.length)} 州の記録を読めていません。そこにいる軍勢は、この一覧に出ていません（いない、という意味ではありません）。`}</p>
    <ul class="list">${un.places.slice(0, 6).map(x => html`<li>${provinceName(FS, x.p, x.q)} <span class="muted">${x.state === 'loading' ? L`読み込んでいます…` : x.state === 'waiting' ? L`読み込みの順番を待っています` : x.state === 'failed' ? L`読み込めませんでした（${x.code}）`
      : x.state === 'missing' ? L`記録がまだ届いていません` : L`まだ読み込んでいません`}</span>${play && x.state !== 'loading' && x.state !== 'waiting' ? html` <button type="button" class="btn small" data-act="province-reread" data-p="${x.p}" data-q="${x.q}">${icon('return')}${L`もう一度読み込む`}</button>` : ''}</li>`)}</ul></div>` : '';
  const other = others.length ? html`<div class="hosts-others"><p class="muted">${L`ほかの村の軍勢`}</p><ul class="list">${others.map(o => html`<li>${icon('home')}<strong>${o.name}</strong> <span class="muted">${L`軍勢 ${fmtNum(o.hosts)}`}</span>
    ${play && ctx !== null ? html`<button type="button" class="btn small" data-act="hosts-village" data-ctx="${ctx}" data-p="${o.p}" data-q="${o.q}" data-site="${o.site}" data-gen="${o.gen}">${L`この村の軍勢を見る`}</button>` : ''}</li>`)}</ul>
    <p class="muted">${L`数は、いま読めている州にいる軍勢だけです。`}</p></div>` : '';
  const of = h && (FS.holdings ?? []).length > 1 ? html`<p class="muted hosts-of" data-village="${refOf(h)}">${L`${holdingName(h)}の軍勢を出しています。`}</p>` : '';
  return html`${of}${unread}${other}`;
}

/** The locked host's line (I-44). */
export const lockedText = () => L`進軍の結果を受け取るまで、この軍勢は出発・解散・探索ができません（ふつうは自動で受け取ります）。`;

/**
 * A host's state in one word for its chip: `{id, text, tone}` — on the
 * march, forming (usable from the next bell), resting until a turn,
 * short of the stamina a march needs, or ready.
 */
export function hostState(r, nowBell) {
  if (r.inTransit || r.state === 3) return { id: 'march', text: L`進軍中`, tone: 'info' };
  if (r.state === 2) return { id: 'forming', text: L`編成の反映待ち`, tone: 'warn' };
  if (nowBell < r.readyBell) return { id: 'rest', text: L`ターン ${fmtNum(r.readyBell)} まで休息`, tone: 'warn' };
  if (r.stamina < DEPART_STAMINA) return { id: 'tired', text: L`体力が足りません`, tone: 'warn' };
  return { id: 'ready', text: L`出陣できる`, tone: 'ok' };
}

export function render(FS) {
  const rows = hostRows(FS);
  const h = activeHolding(FS);
  // (2026-11-17, ⑦: which village this is, the provinces not read, the other villages — under every state of the screen)
  const around = hostsAround(FS, h), unreadPlaces = unreadHostPlaces(FS).places.length;
  if (!rows.length && homeProvinceUnread(FS, h)) {
    return html`<section class="vcard" aria-labelledby="hosts-title">${cardHead({ id: 'hosts-title', ic: 'sword', title: L`軍勢` })}
      <p role="status"><strong>${L`記録をまだ読み込めていません`}</strong> ${L`通信の状態を確かめてください。読み込み直すと、もう一度試します。`}</p>
      <div class="actions"><button type="button" class="btn" data-act="reload">${L`読み込み直す`}</button></div></section>${around}`;
  }
  // (round 43, seen in live33: a host on the march is in no province record the page holds until its arrival is read;
  // "no host, train some" was said then. The viewer's own marches say otherwise: the host is away, see Marches)
  if (!rows.length && (FS.marches ?? []).length) {
    return html`<section class="vcard" aria-labelledby="hosts-title">${cardHead({ id: 'hosts-title', ic: 'sword', title: L`軍勢` })}
      <p role="status">${L`あなたの軍勢は進軍に出ています。到着と結果は「進軍」で確かめられます。`}</p>
      <div class="actions"><button type="button" class="btn primary" data-act="tab" data-tab="marches">${L`進軍を開く`}</button></div></section>${around}`;
  }
  if (!rows.length) {
    return html`<section class="vcard" aria-labelledby="hosts-title">${cardHead({ id: 'hosts-title', ic: 'sword', title: L`軍勢` })}
      <p${unreadPlaces ? html` role="status" data-hosts="unread"` : ''}>${unreadPlaces ? L`いま読めている州には、この村の軍勢はいません。読めていない州があるので、軍勢がいない、という意味ではありません。` : L`軍勢はいません。村で兵を訓練し、軍勢を編成してください。`}</p>
      ${h ? html`<div class="actions"><button type="button" class="btn primary" data-act="tab" data-tab="holding">${L`村を開く`}</button></div>` : ''}</section>${around}`;
  }
  const bell = FS.nowBell ?? 0;
  const f = Number.isInteger(FS.citizen?.faction) ? FS.citizen.faction : 0;
  const ctx = r => ({ holding: h, province: r.province, nowBell: bell, now: FS.chain?.now() ?? 0, host: r });
  const play = (FS.mode ?? null) === 'play', ctxNow = Number.isInteger(FS.contextSeq) ? FS.contextSeq : null;
  // (round 49, the owner's decision of 2026-11-15: while the host's province is still resolving the last turn —
  // NotResident, and only that — its March opens the order card, as the action bar's March always did; the card's send
  // waits for the province as it already does (the local waiting send; the chain's wait for the turn). The reason line
  // still says so. Every other block — rest, stamina, another refusal — keeps the button closed)
  return html`<section class="bare host-list" aria-labelledby="hosts-title"><h3 id="hosts-title" class="visually-hidden">${L`軍勢`}</h3><ul class="hosts">${rows.map(r => {
    const blocks = actionBlocks('Depart', ctx(r));
    const st = hostState(r, bell);
    const locked = FS.inFlight > 0 || !!FS.homeActionBusy;
    const due = r.state === 2 && FS.clock && Number.isInteger(r.fromBell) && r.fromBell > 0 ? ticketTimes(FS.clock, r.fromBell - 1).resultAbout : null;
    const formWait = due === null ? null : Math.max(0, due - (FS.chain?.now?.() ?? 0));
    const home = h && r.p === h.p && r.q === h.q && r.tile === h.tile;
    const name = unitCount(UNIT_ORDER[r.unit], r.troops);
    // (2026-11-17, ⑦ the ways on from a host — each only OPENS something that exists: its march's tracker, the plan of a
    //  march home, its place on the map; app.mjs asks hostStill first: the context number and the village this list
    //  was drawn for must still be the ones in hand, and the host must still be in this list)
    const moving = r.inTransit || r.state === 3, away = !moving && !home && r.state === 1;
    const tok = h && play && ctxNow !== null ? html`data-ctx="${ctxNow}" data-p="${h.p}" data-q="${h.q}" data-site="${h.site}" data-gen="${h.gen ?? 0}" data-host="${String(r.id)}"` : null;
    const ways = tok ? html`<div class="actions host-ways">
        ${moving ? html`<button type="button" class="btn small" data-act="host-track" ${tok}>${icon('banner')}${L`この進軍の追跡を見る`}</button>` : ''}
        ${away ? html`<button type="button" class="btn small" data-act="host-return" ${tok} ${raw(locked || bell < r.readyBell || blocks.some(b => b !== 'NotResident') || r.stamina < DEPART_STAMINA ? 'disabled' : '')}>${icon('return')}${L`村へ戻す計画を開く`}</button>` : ''}
        <button type="button" class="btn small" data-act="host-show" ${tok}>${L`地図で見る`}</button></div>` : '';
    const drafted = FS.compose?.host && String(FS.compose.host.id) === String(r.id) && !FS.compose.sending;
    const draft = drafted && play ? html`<p class="muted" data-host-draft="${String(r.id)}">${L`この軍勢の、書きかけの進軍の計画があります。まだ送っていません。`} <button type="button" class="btn small" data-act="tab" data-tab="marches">${L`計画を開く`}</button></p>` : '';
    return html`<li class="vcard host-card${r.inTransit ? ' locked' : ''}" data-unit="${r.unit}">
      <img class="unit-card f${f}" src="${miniCardUrl(f, MINI_KINDS[r.unit])}" alt="" width="60" height="75" loading="lazy" decoding="async">
      <div class="host-main">
        <div class="host-top"><strong class="host-name">${name}</strong>${stamp(st.text, st.tone)}</div>
        <div class="host-stamina"><span class="host-k">${L`体力`}</span>${bar(r.stamina, RULES.STAMINA_CAP, r.stamina < DEPART_STAMINA ? 'bar-warn' : '')}<span class="host-v">${r.stamina}/${RULES.STAMINA_CAP}</span></div>
        <p class="host-where">${r.inTransit || r.state === 3 ? L`進軍に出ています` : home ? L`${holdingName(h)}にいます` : L`${provinceName(FS, r.p, r.q)}にいます`}${r.pending ? html` · ${PENDING_TEXT[r.pending]?.() ?? ''}` : ''}</p>
      </div>
      ${r.state === 2 ? html`<p class="muted">${formWait > 0 ? L`編成の反映の目安まで ${countdown(formWait)}（ゲーム内）` : L`世界の処理で編成が反映されるのを待っています。`}</p>` : ''}
      <div class="actions host-acts">
        <button type="button" class="btn primary small" data-act="compose" data-host="${String(r.id)}" ${raw(locked || bell < r.readyBell || blocks.some(b => b !== 'NotResident') || r.stamina < DEPART_STAMINA ? 'disabled' : '')} data-stay="map">${icon('banner')}${L`進軍させる`}</button>
        ${r.unit === SCOUT ? html`<button type="button" class="btn small" data-act="explore-open" data-host="${String(r.id)}" ${raw(locked || actionBlocks('Explore', ctx(r)).length ? 'disabled' : '')}>${icon('scout')}${L`探索`}</button>` : ''}
        <button type="button" class="btn small quiet" data-act="dissolve" data-host="${String(r.id)}" aria-label="${L`${name}を解散する`}" ${raw(locked || actionBlocks('Dissolve', ctx(r)).length ? 'disabled' : '')}>${L`解散`}</button>
      </div>
      ${ways}${draft}
      ${r.inTransit ? html`<p class="locked-note" role="note">${lockedText()}</p>` : blocks.length ? html`<p class="blocked">${blocks.map(errorText).join(' / ')}${blocks.includes('NotResident') && !FS.localPlay ? html` <button type="button" class="btn small" data-act="nudge" data-p="${r.p}" data-q="${r.q}" ${raw(locked ? 'disabled' : '')}>${L`追いつかせる`}</button>` : ''}</p>` : ''}
    </li>`;
  })}</ul>
  <p class="foot-note">${L`出発には行き先にかかわらず体力 ${DEPART_STAMINA} を使います（道のりは封の中にあるため）。`}</p></section>${around}`;
}
