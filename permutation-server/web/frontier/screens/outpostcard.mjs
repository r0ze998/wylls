// DEVNET PLAY (devnet-page-outpost) — the village screen's card for the SECOND and THIRD village (FileOutpost) on a
// devnet season the page plays itself (fdevnetplay.mjs, the gateway listed FileOutpost). Wallet-paid, two presses:
//
//   1. 「近くの州を調べる」 (outpost-scan)  the herald's record of each nearby province is read (one read each): open or
//                                          not opened yet (the herald has no Province there: the chain has none).
//   2. 「ここに村を出す」 (outpost-preview) what the wallet will pay, in SOL — the rent deposit of the village's account
//                                          (one Holding rent, the gateway's word for this cluster) and the fee — and the
//                                          settler cost from the first home's stores; nothing is signed yet.
//   3. 「署名して送る」 (outpost-send)      the connected wallet signs ONE transaction; the gateway forwards it once.
//   Then the result is read back: the ticket waiting for the turn's end, and the new village once keeper A settled it.
//
// The candidates are the program's own: rings past the heartland (> heartland_max_ring 3), within outpost_range (3) of
// the first home, inside the legacy disk (ring ≤ 128). FOG (map/fog.mjs, DEVNET_FOG): whether a province is open is the
// map's own shape (the inspector says 「まだ開かれていない」 the same way); WHICH site is free is told only as the
// viewer may see it — live where the site's tile is in sight now, the last-known record where it was seen before, and
// not at all where it was never seen. The legality check (fconquest.mjs outpostOffer) reads the raw records, as every
// order check of the page does.
import { html, raw } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { RESOURCES, RESOURCE_ORDER } from '../fi18n.mjs';
import { cardHead } from './parts.mjs';
import { ringOf, hexDistance } from '../fgeo.mjs';
import { outpostOffer } from '../fconquest.mjs';
import { devnetOutpostOn } from '../fdevnetplay.mjs';
import { OUTPOST_HEARTLAND_MAX_RING, OUTPOST_RANGE, solText } from '../fdevnet-outpost.mjs';
import { viewOverviews, viewTile, fogNow } from '../map/fog.mjs';
import { L2, L3 } from '../map/survey.mjs';

/** At most this many nearby provinces are listed (nearest first). */
export const OUTPOST_LIST_MAX = 8;
/** A preview is good for this long (ms); the send re-reads everything anyway. */
export const OUTPOST_PREVIEW_MS = 120_000;

const paramsOf = FS => {
  const c = FS?.season?.conquestParams ?? FS?.season ?? {};
  return { heartland: Number(c.heartlandMaxRing ?? OUTPOST_HEARTLAND_MAX_RING), range: Number(c.outpostRange ?? OUTPOST_RANGE) };
};

/**
 * The nearby provinces a FileOutpost may name from `home`: past the heartland, within range, inside the legacy disk, and
 * not the home's own province (the program lists the anchor's Province read-only and a target's writable: the same
 * Province in both is always BadAccount — fdevnet-outpost.mjs); nearest first.
 */
export function outpostCandidates(home, { heartland = OUTPOST_HEARTLAND_MAX_RING, range = OUTPOST_RANGE, max = OUTPOST_LIST_MAX } = {}) {
  const out = [];
  for (let dp = -range; dp <= range; dp++) for (let dq = Math.max(-range, -dp - range); dq <= Math.min(range, -dp + range); dq++) {
    const p = home.p + dp, q = home.q + dq, ring = ringOf(p, q);
    if (ring > heartland && ring <= 128 && (dp !== 0 || dq !== 0)) out.push({ p, q, ring, d: hexDistance(p, q, home.p, home.q) });
  }
  return out.sort((a, b) => a.d - b.d || a.ring - b.ring || a.p - b.p || a.q - b.q).slice(0, max);
}

const overviewRec = (FS, p, q) => { for (const o of viewOverviews(FS)?.values?.() ?? []) { const r = o?.provinces?.find?.(x => x.p === p && x.q === q); if (r) return r; } return null; };

/**
 * The free site the card names in province (p, q), as the viewer may know it (see the head): the first site free in
 * the live record whose tile is in sight now, else the first the last-known record shows free where it was seen before.
 * → `{site, seen: 'sight' | 'memory'}` or null.
 */
export function outpostSiteOf(FS, p, q) {
  const prov = FS.provinces?.get?.(`${p},${q}`)?.province ?? null;
  if (!prov) return null;
  const n = Number(prov.siteCount ?? 0), tiles = FS.terrainOf?.(p, q)?.sites ?? null, fog = fogNow().on === true;
  const level = j => (!fog ? L3 : tiles && Number.isInteger(tiles[j]) ? (viewTile(p, q, tiles[j], L3) ? L3 : viewTile(p, q, tiles[j], L2) ? L2 : 1) : 1);
  for (let j = 0; j < n; j++) if (level(j) === L3 && [0, 3].includes(prov.siteMirror?.[j]?.state)) return { site: j, seen: 'sight' };
  const rec = overviewRec(FS, p, q);
  if (rec && rec.fog !== 'unseen') for (let j = 0; j < n; j++) if (level(j) === L2 && rec.sites?.[j] === 0) return { site: j, seen: 'memory' };
  return null;
}

/**
 * The card's model for the village `m` (screens/holding.mjs holdingModel), or null when the card is not shown: not a
 * devnet page that carries FileOutpost, not the first home, a wide village. `{home, rows, own, pending, full, preview}`:
 *   rows[i] = {p, q, ring, d, state: 'unknown' | 'unopened' | 'open', site, seen, offer}  (offer: fconquest outpostOffer)
 *   own     the Citizen's later villages (order 2, 3) as the page knows them
 *   pending the ticket filed and not settled yet (the Citizen's ticket slot)
 */
export function outpostCardModel(FS, m) {
  if (!FS?.devnetPlay || FS.localPlay || !devnetOutpostOn(FS.devnetPlay) || !m?.holding) return null;
  const h = m.holding;
  if (Number(h.order ?? 1) !== 1 || ringOf(h.p, h.q) > 128) return null;
  const { heartland, range } = paramsOf(FS);
  const own = (FS.holdings ?? []).filter(x => Number(x.order) >= 2).map(x => ({ p: x.p, q: x.q, site: x.site, order: Number(x.order), state: x.state }));
  const pending = !!(Number(FS.citizen?.slots ?? 0) & 3);
  const rows = outpostCandidates({ p: h.p, q: h.q }, { heartland, range }).map(c => {
    const key = `${c.p},${c.q}`, prov = FS.provinces?.get?.(key)?.province ?? null, read = FS.provinceReads?.get?.(key) ?? null;
    if (!prov) return { ...c, state: read?.state === 'missing' ? 'unopened' : 'unknown', site: null, seen: null, offer: null };
    const s = outpostSiteOf(FS, c.p, c.q);
    let offer = null;
    if (s) { try { offer = outpostOffer(FS, { p: c.p, q: c.q, site: s.site }); } catch { offer = null; } }
    return { ...c, state: 'open', site: s?.site ?? null, seen: s?.seen ?? null, offer };
  });
  const pv = FS.outpostPreview ?? null;
  return { home: { p: h.p, q: h.q, site: h.site }, heartland, range, rows, own, pending, full: (FS.holdings ?? []).length >= 3, preview: pv };
}

const costLine = cost => cost.map((n, i) => (n > 0 ? `${RESOURCES[RESOURCE_ORDER[i]]} ${fmtNum(n)}` : null)).filter(Boolean).join(' · ');

function rowHtml(r, busy) {
  const where = L`州 ${r.p},${r.q}`;
  const meta = html`<span class="muted">${L`第${r.ring}輪・最初の村から${r.d}州`}</span>`;
  if (r.state === 'unknown') return html`<li data-outpost="${r.p},${r.q}" data-state="unknown"><span>${where} ${meta}</span> <span class="muted">${L`まだ調べていません`}</span></li>`;
  if (r.state === 'unopened') return html`<li data-outpost="${r.p},${r.q}" data-state="unopened"><span>${where} ${meta}</span> <span class="blocked">${L`この州はまだ開かれていません。開かれるまで村は出せません（人のいる州の近くから順に、自動で開かれます）。`}</span></li>`;
  if (r.site === null) return html`<li data-outpost="${r.p},${r.q}" data-state="nosite"><span>${where} ${meta}</span> <span class="muted">${L`見えている空きマスがありません（視界に入った場所だけ選べます）。`}</span></li>`;
  const ok = r.offer?.eligible === true;
  return html`<li data-outpost="${r.p},${r.q}" data-state="${ok ? 'ready' : 'blocked'}"><span>${where} ${meta} <span class="muted">${L`村の場所 ${fmtNum(r.site + 1)}`}${r.seen === 'memory' ? L`（前に見たときの様子）` : ''}</span></span>
    ${ok ? '' : html` <span class="blocked">${r.offer?.reason ?? L`いまは村を出せません。`}</span>`}
    <button type="button" class="btn small" data-act="outpost-preview" data-p="${r.p}" data-q="${r.q}" data-site="${r.site}" aria-label="${L`ここに村を出す`}: ${L`州 ${r.p},${r.q}`} ${L`村の場所 ${fmtNum(r.site + 1)}`}" ${raw(busy || !ok ? 'disabled' : '')}>${L`ここに村を出す`}</button></li>`;
}

function previewHtml(pv, busy) {
  const t = pv.target;
  return html`<div class="outpost-preview" data-step="preview" role="group" aria-label="${L`送る前の確認`}">
    <p><b>${pv.slot === 3 ? L`州 ${t.p},${t.q} の村の場所 ${fmtNum(t.site + 1)} に3つめの村を申し込みます。` : L`州 ${t.p},${t.q} の村の場所 ${fmtNum(t.site + 1)} に2つめの村を申し込みます。`}</b></p>
    <p>${L`ウォレットから払う額: 最大 ${solText(pv.cost.total)} SOL`} <span class="muted">${L`（新しい村の家賃の預け入れ ${solText(pv.cost.deposit)} SOL ＋ 手数料 ${solText(pv.cost.fee)} SOL。devnet の SOL で、価値はありません）`}</span></p>
    <p class="muted">${L`最初の村の蔵から: ${costLine(pv.settler)}`}</p>
    <p class="muted">${L`申し込みはターンの終わりに決まります（同じ場所を選んだ人がいれば抽選）。`}</p>
    <div class="actions"><button type="button" class="btn" data-act="outpost-send" data-p="${t.p}" data-q="${t.q}" data-site="${t.site}" ${raw(busy ? 'disabled' : '')}>${L`署名して送る`}</button>
    <button type="button" class="btn small" data-act="outpost-cancel">${L`やめる`}</button></div></div>`;
}

/** The card (html), or '' when the model is null. */
export function outpostCard(FS, m, busy) {
  const o = outpostCardModel(FS, m);
  if (!o) return '';
  const pv = o.preview;
  const ownLine = o.own.length ? html`<p data-outpost-own="${o.own.length}">${o.own.map(x => (x.order === 3 ? L`3つめの村: 州 ${x.p},${x.q} の村の場所 ${fmtNum(x.site + 1)}` : L`2つめの村: 州 ${x.p},${x.q} の村の場所 ${fmtNum(x.site + 1)}`)).join(' / ')}</p>` : '';
  const sent = pv?.step === 'sent' ? html`<p data-outpost-sent="${pv.target.p},${pv.target.q},${pv.target.site}">${L`州 ${pv.target.p},${pv.target.q} への申し込みを送りました。`} <span class="muted">${L`署名 ${pv.signature}`}</span></p>` : '';
  const body = o.full ? html`<p class="muted">${L`村はもう3つあります。`}</p>`
    : o.pending ? html`<p data-outpost-pending="1">${L`申し込みの結果を待っています。ターンの終わりに決まると、ここに新しい村が出ます。`}</p>`
    : pv?.step === 'preview' ? previewHtml(pv, busy)
    : html`<ul class="build-list">${o.rows.map(r => rowHtml(r, busy))}</ul>
      <div class="actions"><button type="button" class="btn small" data-act="outpost-scan" ${raw(busy ? 'disabled' : '')}>${L`近くの州を調べる`}</button></div>`;
  return html`<section class="vcard" id="hp-outpost" aria-labelledby="hp-outpost-h">
    ${cardHead({ id: 'hp-outpost-h', ic: 'flag', title: L`2つめ・3つめの村を出す` })}
    <p>${L`本国（第${o.heartland}輪まで）の外で、最初の村から${o.range}州以内の州に村を出せます。ウォレットが1回署名し、手数料と家賃の預け入れを払います。`}</p>
    ${ownLine}${sent}${body}</section>`;
}
