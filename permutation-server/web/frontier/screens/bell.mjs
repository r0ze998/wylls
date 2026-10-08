// The turn sheet (web design §6.2–§6.4; contract §5.1; UX design 11.13: it
// stands under "More → details", not on the play screen): the current turn,
// then the turns that matter to the viewer (arrivals of its marches, the
// turn of its village request) with the pipeline state of each in its
// region — open, awaiting the key of the seals (no countdown before THE
// anchor exists), revealing until A + W, awaiting the draw, resolving,
// resolved — and the local clock's offset when it is more than 2 s off the
// chain's. The line of sponsored actions left too: the strip shows it only
// when it runs low, and this sheet is where it is read at any time.
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { PIPELINE_TEXT } from '../fi18n.mjs';
import { pipeline, countdown } from '../clock.mjs';
import { timeHtml, quotaChip } from './shell.mjs';
import { termButton } from '../hud/glossary.mjs';
import { icon } from '../hud/icons.mjs';
import { cardHead, chip, fold, label } from './parts.mjs';

/**
 * The sheet's rows: `items = [{bell, region, why, facts: {anchor, archive,
 * seed, latestRound, resolvedNext}}]` → `[{bell, region, why, state, until,
 * close}]` at chain time `now`.
 */
export function sheetRows(clock, now, items) {
  return items.map(it => ({ bell: it.bell, region: it.region, why: it.why, ...pipeline(clock, it.bell, { now, ...(it.facts ?? {}) }) }));
}

const WHY = { current: () => L`いまのターン`, arrival: () => L`あなたの到着`, ticket: () => L`村の申し込み`, explore: () => L`探索`, clash: () => L`衝突` };
/** The pipeline state in a word, for the row's chip (the sentence stands under it). */
const STATE_SHORT = { open: () => L`受付中`, awaitingBeacon: () => L`開封待ち`, revealing: () => L`開封中`, awaitingSeed: () => L`決着待ち`, resolving: () => L`決着中`, resolved: () => L`決着` };
const STATE_TONE = { open: 'info', awaitingBeacon: 'warn', revealing: 'warn', awaitingSeed: 'warn', resolving: 'warn', resolved: 'ok' };
/** The sentence without its leading word ("受付中：…" → "…"). */
const sentence = s => String(s ?? '').replace(/^[^\uFF1A:]{1,24}[\uFF1A:]\s*/, '');

export function render(FS, { bare = false } = {}) {
  if (!FS.clock || !FS.chain) return bare ? '' : html`<p class="muted">${L`読み込み中…`}</p>`;
  const now = FS.chain.now() ?? 0;
  const rows = sheetRows(FS.clock, now, FS.bellItems ?? []);
  // The local clock's offset means something only on a real cluster (a localnet Clock runs scaled).
  const offset = FS.pin?.cluster === 'localnet' ? 0 : FS.chain.offset?.() ?? 0;
  const current = FS.clock ? Math.max(0, Math.floor((now - FS.clock.genesisTs) / 600)) : null;
  const started = current !== null && now >= FS.clock.genesisTs;
  // (no line that ties the bell to the turn here: the "?" beside the title opens the help's one such line)
  const body = html`${quotaChip(FS.quota) ? html`<p class="quota-line" data-quota-line>${icon('seal')}${quotaChip(FS.quota)}</p>` : ''}
    ${Math.abs(offset) > 2 ? html`<p class="muted">${L`この端末の時計はチェーンより ${Math.round(offset)} 秒ずれています`}</p>` : ''}
    <ul class="bells">${rows.map(r => html`<li><div class="bell-row"><strong>${L`ターン ${fmtNum(r.bell)}`}</strong><span class="bell-why">${WHY[r.why] ? WHY[r.why]() : ''}${Number.isInteger(r.region) ? html` · ${L`地域 ${r.region}`}` : ''}</span>${chip(STATE_SHORT[r.state]?.() ?? r.state, STATE_TONE[r.state] ?? '')}</div>
      <p class="bell-what">${sentence(PIPELINE_TEXT[r.state])}${r.until !== null && r.until !== undefined ? html` <span class="bell-until">${countdown(r.until - now)} · ${timeHtml(r.until)}</span>` : ''}</p>
      ${r.archived ? html`<p class="muted">${L`保管庫から読んでいます`}</p>` : ''}</li>`)}</ul>
    ${fold('bell-how', L`ターンのしくみ`, html`<p>${L`進軍は、到着のターンが始まる前に封をして送ります。守り手は、ターンの始まりにそこにいた軍勢で決まります。ターンが終わると封を開ける鍵（公開の乱数）が出て、誰でも封を開けられるようになります。封を開ける受付は決まった時間で終わり、そのあとに出る公開の乱数で衝突が決まります。`}</p>`)}`;
  const head = { id: 'bell-title', ic: 'bell', title: L`ターンの進み具合`, sub: started ? L`いまはターン ${fmtNum(current)}` : '', side: termButton('bell') };
  // inside "More → details" the sheet is a part of that fold (a small heading, no card of its own)
  if (bare) return html`<section class="bell-sheet" aria-labelledby="bell-title">${label(html`<span id="bell-title">${head.title}</span>${head.sub ? html` <span class="muted">${head.sub}</span>` : ''}`, head.side)}${body}</section>`;
  return html`<section class="vcard" aria-labelledby="bell-title">${cardHead(head)}${body}</section>`;
}
