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
import { hostsIn, UNIT_ORDER, SCOUT, actionBlocks } from '../fland.mjs';
import { RULES, DEPART_STAMINA } from '../fmarch.mjs';
import { miniCardUrl, MINI_KINDS } from '../people/minis.mjs';
import { holdingName } from '../people/ui.mjs';
import { icon } from '../hud/icons.mjs';
import { provinceName } from '../hud/place.mjs';
import { cardHead, stamp, bar } from './parts.mjs';

/** Every host of the viewer's first holding in the provinces the page holds (home and destinations). */
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

/** The locked host's line (I-44). */
export const lockedText = () => L`進軍の結果を受け取るまで、この軍勢は出発・解散・探索ができません（ふつうは自動で受け取ります）。`;

/**
 * A host's state in one word for its chip: `{id, text, tone}` — on the
 * march, forming (usable from the next bell), resting until a turn,
 * short of the stamina a march needs, or ready.
 */
export function hostState(r, nowBell) {
  if (r.inTransit || r.state === 3) return { id: 'march', text: L`進軍中`, tone: 'info' };
  if (r.state === 2) return { id: 'forming', text: L`編成中（次の鐘から）`, tone: 'warn' };
  if (nowBell < r.readyBell) return { id: 'rest', text: L`ターン ${fmtNum(r.readyBell)} まで休息`, tone: 'warn' };
  if (r.stamina < DEPART_STAMINA) return { id: 'tired', text: L`体力が足りません`, tone: 'warn' };
  return { id: 'ready', text: L`出陣できる`, tone: 'ok' };
}

export function render(FS) {
  const rows = hostRows(FS);
  const h = activeHolding(FS);
  if (!rows.length) {
    return html`<section class="vcard" aria-labelledby="hosts-title">${cardHead({ id: 'hosts-title', ic: 'sword', title: L`軍勢` })}
      <p>${L`軍勢はいません。村で兵を訓練し、軍勢を編成してください。`}</p>
      ${h ? html`<div class="actions"><button type="button" class="btn primary" data-act="tab" data-tab="holding">${L`村を開く`}</button></div>` : ''}</section>`;
  }
  const bell = FS.nowBell ?? 0;
  const f = Number.isInteger(FS.citizen?.faction) ? FS.citizen.faction : 0;
  const ctx = r => ({ holding: h, province: r.province, nowBell: bell, now: FS.chain?.now() ?? 0, host: r });
  return html`<section class="bare host-list" aria-labelledby="hosts-title"><h3 id="hosts-title" class="visually-hidden">${L`軍勢`}</h3><ul class="hosts">${rows.map(r => {
    const blocks = actionBlocks('Depart', ctx(r));
    const st = hostState(r, bell);
    const home = h && r.p === h.p && r.q === h.q && r.tile === h.tile;
    const name = unitCount(UNIT_ORDER[r.unit], r.troops);
    return html`<li class="vcard host-card${r.inTransit ? ' locked' : ''}" data-unit="${r.unit}">
      <img class="unit-card f${f}" src="${miniCardUrl(f, MINI_KINDS[r.unit])}" alt="" width="60" height="75" loading="lazy" decoding="async">
      <div class="host-main">
        <div class="host-top"><strong class="host-name">${name}</strong>${stamp(st.text, st.tone)}</div>
        <div class="host-stamina"><span class="host-k">${L`体力`}</span>${bar(r.stamina, RULES.STAMINA_CAP, r.stamina < DEPART_STAMINA ? 'bar-warn' : '')}<span class="host-v">${r.stamina}/${RULES.STAMINA_CAP}</span></div>
        <p class="host-where">${r.inTransit || r.state === 3 ? L`進軍に出ています` : home ? L`${holdingName(h)}にいます` : L`${provinceName(FS, r.p, r.q)}にいます`}${r.pending ? html` · ${PENDING_TEXT[r.pending]?.() ?? ''}` : ''}</p>
      </div>
      <div class="actions host-acts">
        <button type="button" class="btn primary small" data-act="compose" data-host="${String(r.id)}" ${raw(blocks.length || r.stamina < DEPART_STAMINA ? 'disabled' : '')} data-stay="map">${icon('banner')}${L`進軍させる`}</button>
        ${r.unit === SCOUT ? html`<button type="button" class="btn small" data-act="explore-open" data-host="${String(r.id)}" ${raw(actionBlocks('Explore', ctx(r)).length ? 'disabled' : '')}>${icon('scout')}${L`探索`}</button>` : ''}
        <button type="button" class="btn small quiet" data-act="dissolve" data-host="${String(r.id)}" aria-label="${L`${name}を解散する`}" ${raw(actionBlocks('Dissolve', ctx(r)).length ? 'disabled' : '')}>${L`解散`}</button>
      </div>
      ${r.inTransit ? html`<p class="locked-note" role="note">${lockedText()}</p>` : blocks.length ? html`<p class="blocked">${blocks.map(errorText).join(' / ')}</p>` : ''}
    </li>`;
  })}</ul>
  <p class="foot-note">${L`出発には行き先にかかわらず体力 ${DEPART_STAMINA} を使います（道のりは封の中にあるため）。`}</p></section>`;
}
